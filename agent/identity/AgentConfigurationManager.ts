export interface ConfigurationSyncStatus {
    lastUpdated?: Date;
    lastSuccessfulSync?: Date;
    syncStatus: 'INITIALIZING' | 'SUCCESS' | 'ERROR';
    consecutiveFailures: number;
    errorMessage?: string;
}

export class AgentConfigurationManager {
    private static instance?: AgentConfigurationManager;
    private currentConfig: Record<string, any> = {};
    private currentRevision: number = 0;
    
    private syncStatus: ConfigurationSyncStatus = {
        syncStatus: 'INITIALIZING',
        consecutiveFailures: 0
    };

    public static getInstance(): AgentConfigurationManager {
        if (!AgentConfigurationManager.instance) {
            AgentConfigurationManager.instance = new AgentConfigurationManager();
        }
        return AgentConfigurationManager.instance;
    }

    public getAppliedConfig(): Record<string, any> {
        return { ...this.currentConfig };
    }

    public getRevision(): number {
        return this.currentRevision;
    }

    public getSyncStatus(): ConfigurationSyncStatus {
        return { ...this.syncStatus };
    }

    public updateConfig(config: Record<string, any>, revision: number): void {
        this.currentConfig = config;
        this.currentRevision = revision;
        this.syncStatus = {
            lastUpdated: new Date(),
            lastSuccessfulSync: new Date(),
            syncStatus: 'SUCCESS',
            consecutiveFailures: 0
        };
        console.log(`[AgentConfigurationManager] Applied configuration revision ${revision}:`, JSON.stringify(config));
    }

    public markSyncSuccess(): void {
        this.syncStatus.lastSuccessfulSync = new Date();
        this.syncStatus.syncStatus = 'SUCCESS';
        this.syncStatus.consecutiveFailures = 0;
        this.syncStatus.errorMessage = undefined;
    }

    public markSyncFailed(message: string): void {
        this.syncStatus.syncStatus = 'ERROR';
        this.syncStatus.consecutiveFailures++;
        this.syncStatus.errorMessage = message;
    }
}
