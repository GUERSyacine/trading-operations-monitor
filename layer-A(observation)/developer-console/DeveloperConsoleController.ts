import { FailureInjectionService } from './FailureInjectionService';
import { FeatureFlagService, FEATURE_FLAG_METADATA } from './FeatureFlagService';
import { InfrastructureController } from './InfrastructureController';
import { OperationsSimulationService } from './OperationsSimulationService';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario, EventCategory, WatchdogEventType } from './types';
import { prisma } from '../../prisma';
import { IncidentManager } from '../../layer-B(Assessement)/IncidentManager';
import { OperationsWatchdogService } from '../../agent/detectors/operations/OperationsWatchdogService';
import { EventBus } from './EventBus';

export class DeveloperConsoleController {
    constructor(
        private failures: FailureInjectionService,
        private flags: FeatureFlagService,
        private infra: InfrastructureController,
        private operationsSim: OperationsSimulationService,
        private incidentManager: IncidentManager,
        private opsService: OperationsWatchdogService
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

    public async runOperationsScenario(
        scenario: OperationScenario,
        meta: { tradeId?: string; symbol?: string; timestampOffset?: number },
        correlationId?: string
    ): Promise<void> {
        this.assertWriteAllowed();
        await this.operationsSim.runScenario(scenario, meta);
    }

    public async resetSimulationLab(correlationId?: string): Promise<void> {
        this.assertWriteAllowed();
        
        // Purge synthetic simulator telemetry.
        // Production telemetry is never deleted.
        await prisma.decisionAudit.deleteMany({
            where: {
                OR: [
                    {
                        metadata: {
                            path: ['telemetrySource'],
                            equals: 'SIMULATOR'
                        }
                    },
                    {
                        metadata: {
                            path: ['lifecycleEvent', 'source'],
                            equals: 'SIMULATOR'
                        }
                    }
                ]
            }
        });

        // 2. Reset IncidentManager memory & DB state
        await this.incidentManager.clearSimulationIncidents();

        // 3. Reset OperationsWatchdogService memory state
        this.opsService.clearDetectorState();

        // 4. Clear EventBus ringbuffer
        EventBus.getInstance().clearBuffer();

        // 5. Emit LAB_RESET system event
        EventBus.getInstance().emit(
            EventCategory.SYSTEM,
            WatchdogEventType.LAB_RESET,
            'DeveloperConsoleController',
            { action: 'RESET_SIMULATION_LAB' },
            correlationId
        );
    }

    public async retryFailedOutbox(ids?: number[]): Promise<number> {
        this.assertWriteAllowed();
        
        const filter: any = { status: 'FAILED' };
        if (ids && ids.length > 0) {
            filter.id = { in: ids };
        }

        const result = await prisma.incidentOutbox.updateMany({
            where: filter,
            data: {
                status: 'PENDING',
                attempts: 0,
                nextRetryAt: new Date(),
                lastError: null
            }
        });
        return result.count;
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
