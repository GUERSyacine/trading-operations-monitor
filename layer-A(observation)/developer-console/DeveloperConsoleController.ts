import { FailureInjectionService } from './FailureInjectionService';
import { FeatureFlagService, FEATURE_FLAG_METADATA } from './FeatureFlagService';
import { InfrastructureController } from './InfrastructureController';
import { FailureType, FailureScope, FeatureFlag, SystemCommand } from './types';

export class DeveloperConsoleController {
    constructor(
        private failures: FailureInjectionService,
        private flags: FeatureFlagService,
        private infra: InfrastructureController
    ) {}

    public injectFailure(type: FailureType, scope: FailureScope, ttlSeconds?: number, correlationId?: string): void {
        this.assertWriteAllowed();
        this.failures.injectFailure(type, scope, ttlSeconds, correlationId);
    }

    public clearFailure(type: FailureType, correlationId?: string): void {
        this.assertWriteAllowed();
        this.failures.clearFailure(type, correlationId);
    }

    public clearAllFailures(correlationId?: string): void {
        this.assertWriteAllowed();
        this.failures.clearAll(correlationId);
    }

    public setFeatureFlag(flag: FeatureFlag, enabled: boolean, reason?: string, correlationId?: string): void {
        this.assertWriteAllowed();
        this.flags.setFeatureFlag(flag, enabled, reason, correlationId);
    }

    public getAllFeatureFlags(): Record<FeatureFlag, { enabled: boolean; name: string; description: string }> {
        const result = {} as Record<FeatureFlag, { enabled: boolean; name: string; description: string }>;
        for (const flag of Object.values(FeatureFlag)) {
            const meta = FEATURE_FLAG_METADATA[flag];
            result[flag] = {
                enabled: this.flags.isFeatureEnabled(flag),
                name: meta.name,
                description: meta.description
            };
        }
        return result;
    }

    public async executeInfraCommand(command: SystemCommand, correlationId?: string): Promise<void> {
        this.assertWriteAllowed();
        switch (command) {
            case SystemCommand.START_FREQTRADE:
                await this.infra.startFreqtrade(correlationId);
                break;
            case SystemCommand.STOP_FREQTRADE:
                await this.infra.stopFreqtrade(correlationId);
                break;
            case SystemCommand.RESTART_FREQTRADE:
                await this.infra.restartFreqtrade(correlationId);
                break;
            default:
                throw new Error(`Execution of command ${command} is not supported via controller.`);
        }
    }

    public async getFreqtradeStatus(): Promise<string> {
        return this.infra.getFreqtradeStatus();
    }

    public getReadOnlyStatus(): boolean {
        return process.env.DEV_CONSOLE_READ_ONLY === 'true';
    }

    private assertWriteAllowed(): void {
        if (this.getReadOnlyStatus()) {
            throw new Error('Access denied: Developer Console is running in READ-ONLY mode.');
        }
    }
}
