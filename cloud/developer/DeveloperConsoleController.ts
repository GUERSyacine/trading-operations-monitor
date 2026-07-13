import { FailureInjectionService } from '../../shared/services/FailureInjectionService';
import { FeatureFlagService, FEATURE_FLAG_METADATA } from '../../shared/services/FeatureFlagService';
import { InfrastructureController } from './InfrastructureController';
import { OperationsSimulationService } from './OperationsSimulationService';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario, EventCategory, WatchdogEventType } from '../../shared/types/developer';
import { prisma } from '../../shared/prisma';
import { EventBus } from '../../shared/services/EventBus';

export class DeveloperConsoleController {
    constructor(
        private failures: FailureInjectionService,
        private flags: FeatureFlagService,
        private infra: InfrastructureController,
        private operationsSim: OperationsSimulationService
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

        // 1. Clear EventBus ringbuffer
        EventBus.getInstance().clearBuffer();

        // 2. Emit LAB_RESET system event. This event will trigger subscribers in the agent context
        // (IncidentManager and OperationsWatchdogService) to clear their simulation states.
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

    public async registerAgent(payload: {
        licenseToken: string;
        machineId: string;
        hostname: string;
        version: string;
        capabilities: string[];
    }): Promise<{
        success: boolean;
        status: string;
        agentId?: string;
        agentSecret?: string;
        message?: string;
    }> {
        // 1. Verify token exists and is active
        const token = await prisma.registrationToken.findUnique({
            where: { token: payload.licenseToken }
        });

        if (!token) {
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token not found.'
            };
        }

        if (token.status !== 'ACTIVE') {
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token is not active.'
            };
        }

        if (token.expiresAt && token.expiresAt < new Date()) {
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token has expired.'
            };
        }

        // 2. Check for existing agent with same machineId (idempotency)
        let agent = await prisma.agent.findUnique({
            where: { machineId: payload.machineId }
        });

        if (agent) {
            // Already registered - return existing credentials
            return {
                success: true,
                status: 'SUCCESS',
                agentId: agent.id,
                agentSecret: agent.agentSecret
            };
        }

        // 3. Enforce maxAgents limit
        const activeAgentsCount = await prisma.agent.count({
            where: { registrationTokenId: token.token }
        });

        if (activeAgentsCount >= token.maxAgents) {
            return {
                success: false,
                status: 'LIMIT_EXCEEDED',
                message: 'Registration limit reached for this token.'
            };
        }

        // 4. Generate new secret
        const agentSecret = 'sec_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

        // 5. Create Agent record
        agent = await prisma.agent.create({
            data: {
                machineId: payload.machineId,
                hostname: payload.hostname,
                version: payload.version,
                status: 'ONLINE',
                capabilities: payload.capabilities,
                agentSecret,
                registrationTokenId: token.token,
                lastHeartbeatAt: new Date()
            }
        });

        return {
            success: true,
            status: 'SUCCESS',
            agentId: agent.id,
            agentSecret
        };
    }

    public async receiveHeartbeat(
        payload: {
            agentId: string;
            agentSecret: string;
            hostname: string;
            version: string;
            status: string;
            uptime: number;
            metrics: {
                cpuPct: number;
                memoryPct: number;
                diskPct: number;
            };
            health: {
                outboxPendingCount: number;
                databaseHealthy: boolean;
                freqtradeHealthy: boolean;
            };
        },
        headerSecret?: string
    ): Promise<{
        success: boolean;
        status: string;
        configOverrides?: Record<string, any>;
        message?: string;
    }> {
        // 1. Look up agent by body agentId
        const agent = await prisma.agent.findUnique({
            where: { id: payload.agentId }
        });

        if (!agent) {
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Agent not found.'
            };
        }

        // 2. Compare stored secret vs headerSecret
        if (!headerSecret || agent.agentSecret !== headerSecret) {
            return {
                success: false,
                status: 'UNAUTHORIZED',
                message: 'Authentication secret mismatch.'
            };
        }

        // 3. Update agent status & lastHeartbeatAt
        await prisma.agent.update({
            where: { id: agent.id },
            data: {
                status: 'ONLINE',
                lastHeartbeatAt: new Date(),
                hostname: payload.hostname,
                version: payload.version
            }
        });

        // 4. Create AgentHeartbeat record
        await prisma.agentHeartbeat.create({
            data: {
                agentId: agent.id,
                agentVersion: payload.version,
                cpuPct: payload.metrics.cpuPct,
                memoryPct: payload.metrics.memoryPct,
                diskPct: payload.metrics.diskPct,
                status: payload.status,
                uptime: payload.uptime,
                outboxPending: payload.health.outboxPendingCount,
                databaseHealthy: payload.health.databaseHealthy,
                freqtradeHealthy: payload.health.freqtradeHealthy,
                timestamp: new Date()
            }
        });

        // 5. Get configuration overrides if configured
        const configOverrides = process.env.MOCK_CONFIG_OVERRIDES 
            ? JSON.parse(process.env.MOCK_CONFIG_OVERRIDES)
            : undefined;

        return {
            success: true,
            status: 'SUCCESS',
            configOverrides
        };
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
