import { AgentIdentityService } from './AgentIdentityService';
import { AgentApiClient } from './CloudAgentClient';
import { AgentConfigurationManager } from './AgentConfigurationManager';
import { MVP_CONFIG } from '../../shared/mvpConfig';

export class AgentConfigurationScheduler {
    private intervalId?: NodeJS.Timeout;
    private isExecuting = false;
    private isRunning = false;

    constructor(
        private readonly identityService: AgentIdentityService,
        private readonly client: AgentApiClient,
        private readonly syncIntervalMs: number = MVP_CONFIG.AGENT.CONFIG_SYNC_INTERVAL_MS || 300_000
    ) {}

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;

        this.identityService.onRegistered(() => {
            this.setupSyncInterval();
        });
    }

    public stop(): void {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    private setupSyncInterval(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Run immediately upon registration
        this.syncConfig().catch(err => {
            console.error('[AgentConfigurationScheduler] Initial config sync failed:', err?.message || err);
        });

        this.intervalId = setInterval(() => {
            this.syncConfig().catch(err => {
                console.error('[AgentConfigurationScheduler] Config sync failed:', err?.message || err);
            });
        }, this.syncIntervalMs);
    }

    public async syncConfig(): Promise<void> {
        if (this.isExecuting || !this.isRunning) return;
        const identity = this.identityService.getIdentity();
        if (!identity) return;

        this.isExecuting = true;
        const manager = AgentConfigurationManager.getInstance();
        try {
            const res = await this.client.getConfig({
                agentId: identity.agentId,
                agentSecret: identity.agentSecret,
                version: MVP_CONFIG.AGENT.VERSION,
                capabilities: MVP_CONFIG.AGENT.CAPABILITIES,
                configurationRevision: manager.getRevision()
            });

            if (res.success) {
                if (res.notModified) {
                    console.log(`[AgentConfigurationScheduler] Configuration is up to date (Revision ${manager.getRevision()})`);
                    manager.markSyncSuccess();
                } else {
                    manager.updateConfig(res.configuration || {}, res.configurationRevision);
                }
            } else {
                console.warn('[AgentConfigurationScheduler] Failed to sync config:', res.message);
                manager.markSyncFailed(res.message || 'Unknown response failure');
            }
        } catch (error: any) {
            const msg = error?.message || String(error);
            console.error('[AgentConfigurationScheduler] Unexpected error during sync:', msg);
            manager.markSyncFailed(msg);
        } finally {
            this.isExecuting = false;
        }
    }
}
