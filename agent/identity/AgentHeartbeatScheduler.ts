import * as os from 'os';
import { promises as fs } from 'fs';
import { prisma } from '../../shared/prisma';
import { AgentIdentityService } from './AgentIdentityService';
import { AgentApiClient } from './CloudAgentClient';
import { AgentHeartbeatRequest } from '../../shared/types/registration';

export class AgentHeartbeatScheduler {
    private startedAt = Date.now();
    private intervalId?: NodeJS.Timeout;
    private isExecuting = false;
    private isRunning = false;

    constructor(
        private readonly identityService: AgentIdentityService,
        private readonly client: AgentApiClient,
        private readonly heartbeatIntervalMs: number = 30_000 // default to 30s
    ) {}

    /**
     * Start the heartbeat scheduler. Subscribes to successful registrations.
     */
    public start(): void {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        console.log('[AgentHeartbeatScheduler] Heartbeat scheduler started. Waiting for identity resolution...');

        // Subscribe to registration success
        this.identityService.onRegistered((identity) => {
            this.setupHeartbeatInterval();
        });
    }

    /**
     * Stop the periodic scheduler loop.
     */
    public stop(): void {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        console.log('[AgentHeartbeatScheduler] Heartbeat scheduler stopped.');
    }

    /**
     * Setup the periodic heartbeat loop.
     */
    private setupHeartbeatInterval(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Run immediately upon resolution
        this.executeHeartbeatCycle().catch((err) => {
            console.error('[AgentHeartbeatScheduler] Initial heartbeat cycle failed:', err?.message || err);
        });

        this.intervalId = setInterval(() => {
            this.executeHeartbeatCycle().catch((err) => {
                console.error('[AgentHeartbeatScheduler] Heartbeat cycle failed:', err?.message || err);
            });
        }, this.heartbeatIntervalMs);

        console.log(`[AgentHeartbeatScheduler] Heartbeat loop configured to run every ${this.heartbeatIntervalMs}ms.`);
    }

    /**
     * Collect system metrics and publish heartbeat to the Cloud gateway.
     */
    public async executeHeartbeatCycle(): Promise<void> {
        if (this.isExecuting || !this.isRunning) {
            return;
        }

        const identity = this.identityService.getIdentity();
        if (!identity) {
            console.warn('[AgentHeartbeatScheduler] Skipping heartbeat: Identity is not resolved yet.');
            return;
        }

        this.isExecuting = true;

        try {
            // 1. Gather hardware metrics
            const cpuRaw = (os.loadavg()[0] / os.cpus().length) * 100;
            const cpuPct = Math.round(Math.min(Math.max(cpuRaw || 0, 0), 100));

            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const memoryPct = Math.round(Math.min(Math.max(((totalMem - freeMem) / totalMem) * 100 || 0, 0), 100));

            let diskPct = 0;
            try {
                // native fs.statfs exists on Node 18+
                const stats = await fs.statfs('/');
                const totalBlocks = stats.blocks * stats.bsize;
                const freeBlocks = stats.bfree * stats.bsize;
                diskPct = Math.round(Math.min(Math.max(((totalBlocks - freeBlocks) / totalBlocks) * 100 || 0, 0), 100));
            } catch {
                diskPct = 50; // default fallback if fs.statfs fails or is unsupported
            }

            // 2. Gather database health
            let databaseHealthy = true;
            try {
                await prisma.$queryRaw`SELECT 1`;
            } catch (dbErr: any) {
                databaseHealthy = false;
                console.error('[AgentHeartbeatScheduler] Database healthcheck failed:', dbErr?.message || dbErr);
            }

            // 3. Gather Freqtrade health by checking active incident alerts (HEARTBEAT, BROKER_CONNECTION)
            let freqtradeHealthy = true;
            try {
                const activeIncident = await prisma.incident.findFirst({
                    where: {
                        source: { in: ['HEARTBEAT', 'BROKER_CONNECTION'] },
                        resolvedAt: null
                    }
                });
                if (activeIncident) {
                    freqtradeHealthy = false;
                }
            } catch (err: any) {
                freqtradeHealthy = false;
                console.error('[AgentHeartbeatScheduler] Freqtrade health check failed:', err?.message || err);
            }

            // 4. Gather pending outbox backlog size
            let outboxPendingCount = 0;
            try {
                outboxPendingCount = await prisma.incidentOutbox.count({
                    where: { status: 'PENDING' }
                });
            } catch (err: any) {
                console.error('[AgentHeartbeatScheduler] Outbox count query failed:', err?.message || err);
            }

            const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);

            const req: AgentHeartbeatRequest = {
                agentId: identity.agentId,
                agentSecret: identity.agentSecret,
                hostname: os.hostname(),
                version: '1.0.0',
                status: 'ONLINE',
                uptime: uptimeSeconds,
                metrics: {
                    cpuPct,
                    memoryPct,
                    diskPct
                },
                health: {
                    outboxPendingCount,
                    databaseHealthy,
                    freqtradeHealthy
                }
            };

            console.log(`[AgentHeartbeatScheduler] Sending heartbeat. CPU: ${cpuPct}%, RAM: ${memoryPct}%, Disk: ${diskPct}%, DB Healthy: ${databaseHealthy}, FT Healthy: ${freqtradeHealthy}, Outbox size: ${outboxPendingCount}`);
            const response = await this.client.heartbeat(req);

            if (response.success) {
                console.log(`[AgentHeartbeatScheduler] Heartbeat acknowledged successfully. Status: ${response.status}`);
                if (response.configOverrides) {
                    console.log('[AgentHeartbeatScheduler] Received configuration overrides:', JSON.stringify(response.configOverrides));
                }
            } else {
                console.warn(`[AgentHeartbeatScheduler] Heartbeat rejected by server. Status: ${response.status}. Msg: ${response.message}`);
                
                if (response.status === 'UNAUTHORIZED' || response.status === 'INVALID_TOKEN') {
                    console.error('[AgentHeartbeatScheduler] Credentials revoked or token is invalid. Stopping scheduler.');
                    this.stop();
                }
            }

        } catch (error: any) {
            console.error('[AgentHeartbeatScheduler] Heartbeat submission failed with unexpected error:', error?.message || error);
        } finally {
            this.isExecuting = false;
        }
    }
}
