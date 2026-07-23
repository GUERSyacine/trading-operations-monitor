export class ConfigurationService {
    private static instance?: ConfigurationService;
    private lastRaw: string = '';
    private currentRevision: number = 0;

    public static getInstance(): ConfigurationService {
        if (!ConfigurationService.instance) {
            ConfigurationService.instance = new ConfigurationService();
        }
        return ConfigurationService.instance;
    }

    public getConfig(agentId: string): { configurationRevision: number; configuration?: Record<string, any> } {
        const raw = process.env.MOCK_CONFIG_OVERRIDES || '{}';
        
        if (raw !== this.lastRaw) {
            this.lastRaw = raw;
            this.currentRevision++;
        }

        let configuration: Record<string, any> | undefined;
        try {
            configuration = JSON.parse(raw);
        } catch {
            configuration = {};
        }

        return {
            configurationRevision: this.currentRevision,
            configuration
        };
    }
}
