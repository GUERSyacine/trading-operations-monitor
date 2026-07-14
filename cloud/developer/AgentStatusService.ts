import { prisma } from '../../shared/prisma';
import { MVP_CONFIG } from '../../shared/mvpConfig';

export class AgentStatusService {
    private intervalId?: NodeJS.Timeout;
    private isScanning = false;
    private isRunning = false;

    constructor(
        private readonly scanIntervalMs: number = 10_000, // scan database every 10s
        private readonly offlineTimeoutMs: number = MVP_CONFIG.CLOUD.OFFLINE_TIMEOUT_MS
    ) {}

    /**
     * Start the background daemon.
     */
    public start(): void {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        this.intervalId = setInterval(() => {
            this.scanAndTransitionOfflineAgents().catch((err) => {
                console.error('[AgentStatusService] Error scanning offline agents:', err?.message || err);
            });
        }, this.scanIntervalMs);

        console.log(`[AgentStatusService] Offline agent scan daemon started (Timeout: ${this.offlineTimeoutMs}ms, Interval: ${this.scanIntervalMs}ms)`);
    }

    /**
     * Stop the background daemon.
     */
    public stop(): void {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        console.log('[AgentStatusService] Offline agent scan daemon stopped.');
    }

    /**
     * Scans for ONLINE agents with lastHeartbeatAt exceeding the timeout, and sets status to OFFLINE.
     */
    public async scanAndTransitionOfflineAgents(): Promise<number> {
        if (this.isScanning) {
            return 0;
        }
        this.isScanning = true;

        console.log(`[AgentStatusService] Running offline scan...
  Current UTC: ${new Date().toISOString()}
  Timeout:     ${this.offlineTimeoutMs / 1000} seconds`);

        try {
            const cutoffTime = new Date(Date.now() - this.offlineTimeoutMs);

            // Find all ONLINE agents whose lastHeartbeatAt is older than cutoffTime
            // or who have never sent a heartbeat (lastHeartbeatAt = null) but were created before cutoff
            const offlineAgents = await prisma.agent.findMany({
                where: {
                    status: 'ONLINE',
                    OR: [
                        { lastHeartbeatAt: { lt: cutoffTime } },
                        { lastHeartbeatAt: null, createdAt: { lt: cutoffTime } }
                    ]
                },
                select: {
                    id: true,
                    hostname: true,
                    lastHeartbeatAt: true,
                    createdAt: true
                }
            });

            if (offlineAgents.length === 0) {
                console.log('[AgentStatusService] Found 0 expired agents.');
                return 0;
            }

            for (const agent of offlineAgents) {
                const lastHb = agent.lastHeartbeatAt || agent.createdAt;
                const diffSec = Math.floor((Date.now() - lastHb.getTime()) / 1000);
                const timeoutSec = Math.floor(this.offlineTimeoutMs / 1000);
                console.log(`[AgentStatusService] Agent transition: ONLINE -> OFFLINE
  Current Time:   ${new Date().toISOString()}
  Last Heartbeat: ${lastHb.toISOString()}
  Difference:     ${diffSec}s
  Timeout:        ${timeoutSec}s
  Reason:         Inactivity threshold exceeded`);
            }

            const agentIds = offlineAgents.map(a => a.id);
            const result = await prisma.agent.updateMany({
                where: {
                    id: { in: agentIds }
                },
                data: {
                    status: 'OFFLINE'
                }
            });

            console.log(`[AgentStatusService] Found ${offlineAgents.length} expired agents.`);
            return result.count;
        } finally {
            this.isScanning = false;
        }
    }
}
