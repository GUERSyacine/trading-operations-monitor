import { FailureInjectionService } from '../../shared/services/FailureInjectionService';
import { FeatureFlagService, FEATURE_FLAG_METADATA } from '../../shared/services/FeatureFlagService';
import { InfrastructureController } from './InfrastructureController';
import { OperationsSimulationService } from './OperationsSimulationService';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario, EventCategory, WatchdogEventType } from '../../shared/types/developer';
import { prisma } from '../../shared/prisma';
import { EventBus } from '../../shared/services/EventBus';
import { QaSimulationService } from './QaSimulationService';
import { ConfigurationService } from './ConfigurationService';

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
        warning?: string;
        message?: string;
        authorizedCapabilities?: string[];
    }> {
        const versionResult = QaSimulationService.getInstance().checkVersion(payload.version);
        if (versionResult.status === 'REJECTED') {
            console.warn(`[Registration] Registration rejected: VERSION_REJECTED. Machine ID: ${payload.machineId}. Message: ${versionResult.message}`);
            return {
                success: false,
                status: 'VERSION_REJECTED',
                message: versionResult.message
            };
        }

        const warning = versionResult.status === 'DEPRECATED' ? 'DEPRECATED_VERSION' : undefined;
        const warningMessage = versionResult.status === 'DEPRECATED' ? versionResult.message : undefined;
        if (warning === 'DEPRECATED_VERSION') {
            console.warn(`[Version Negotiation] Warning: Deprecated agent version ${payload.version} in registration body. Warning returned.`);
        }
        console.log(`======================================================
REGISTRATION RECEIVED
======================================================
Hostname:      ${payload.hostname}
Machine ID:    ${payload.machineId}
License Token: ${payload.licenseToken ? payload.licenseToken.substring(0, 8) + '...' : 'None'}
======================================================`);

        // 1. Verify token exists and is active
        const token = await prisma.registrationToken.findUnique({
            where: { token: payload.licenseToken }
        });

        if (!token) {
            console.warn(`[Registration] Registration rejected: INVALID_TOKEN (token not found). Machine ID: ${payload.machineId}`);
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token not found.'
            };
        }

        if (token.status !== 'ACTIVE') {
            console.warn(`[Registration] Registration rejected: INVALID_TOKEN (token inactive: ${token.status}). Machine ID: ${payload.machineId}`);
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token is not active.'
            };
        }

        if (token.expiresAt && token.expiresAt < new Date()) {
            console.warn(`[Registration] Registration rejected: INVALID_TOKEN (token expired: ${token.expiresAt.toISOString()}). Machine ID: ${payload.machineId}`);
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Registration token has expired.'
            };
        }

        // Calculate authorized capabilities
        const capCheckResult = QaSimulationService.getInstance().checkCapabilities(payload.capabilities.join(','));
        if (!capCheckResult.success) {
            console.warn(`[Registration] Registration rejected: CAPABILITY_REJECTED. Machine ID: ${payload.machineId}. Message: ${capCheckResult.message}`);
            return {
                success: false,
                status: 'CAPABILITY_REJECTED',
                message: capCheckResult.message || 'Capabilities validation failed.'
            };
        }
        const authorizedCapabilities = capCheckResult.authorizedCapabilities;

        // 2. Check for existing agent with same machineId (idempotency)
        let agent = await prisma.agent.findUnique({
            where: { machineId: payload.machineId }
        });

        if (agent) {
            console.log(`[Registration] Agent already registered. Reusing credentials and updating capabilities.
  Agent ID:           ${agent.id}
  Hostname:           ${agent.hostname}
  Machine ID:         ${payload.machineId}
  Capabilities:       ${JSON.stringify(authorizedCapabilities)}`);
            
            agent = await prisma.agent.update({
                where: { id: agent.id },
                data: {
                    hostname: payload.hostname,
                    version: payload.version,
                    capabilities: authorizedCapabilities,
                    status: 'ONLINE',
                    lastHeartbeatAt: new Date()
                }
            });

            // Already registered - return existing credentials
            return {
                success: true,
                status: 'SUCCESS',
                agentId: agent.id,
                agentSecret: agent.agentSecret,
                warning,
                message: warningMessage,
                authorizedCapabilities
            };
        }

        // 3. Enforce maxAgents limit
        const activeAgentsCount = await prisma.agent.count({
            where: { registrationTokenId: token.token }
        });

        if (activeAgentsCount >= token.maxAgents) {
            console.warn(`[Registration] Registration rejected: LIMIT_EXCEEDED (active: ${activeAgentsCount}, max: ${token.maxAgents}). Machine ID: ${payload.machineId}`);
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
                capabilities: authorizedCapabilities,
                agentSecret,
                registrationTokenId: token.token,
                lastHeartbeatAt: new Date()
            }
        });

        console.log(`======================================================
REGISTRATION SUCCESSFUL
======================================================
Agent ID:           ${agent.id}
Hostname:           ${agent.hostname}
Machine ID:         ${agent.machineId}
Capabilities:       ${authorizedCapabilities.join(', ')}
Heartbeat Interval: 30s
Agent secret generated successfully.
======================================================`);

        return {
            success: true,
            status: 'SUCCESS',
            agentId: agent.id,
            agentSecret,
            warning,
            message: warningMessage,
            authorizedCapabilities
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
        headerSecret?: string,
        capabilitiesHeader?: string
    ): Promise<{
        success: boolean;
        status: string;
        configOverrides?: Record<string, any>;
        warning?: string;
        message?: string;
        authorizedCapabilities?: string[];
    }> {
        const versionResult = QaSimulationService.getInstance().checkVersion(payload.version);
        if (versionResult.status === 'REJECTED') {
            console.warn(`[Heartbeat] Heartbeat rejected: VERSION_REJECTED. Agent ID: ${payload.agentId}. Message: ${versionResult.message}`);
            return {
                success: false,
                status: 'VERSION_REJECTED',
                message: versionResult.message
            };
        }

        const warning = versionResult.status === 'DEPRECATED' ? 'DEPRECATED_VERSION' : undefined;
        const warningMessage = versionResult.status === 'DEPRECATED' ? versionResult.message : undefined;
        if (warning === 'DEPRECATED_VERSION') {
            console.warn(`[Version Negotiation] Warning: Deprecated agent version ${payload.version} in heartbeat body. Warning returned.`);
        }

        // 1. Look up agent by body agentId
        const agent = await prisma.agent.findUnique({
            where: { id: payload.agentId }
        });

        if (!agent) {
            console.warn(`[Heartbeat] Heartbeat rejected: INVALID_TOKEN (agent not found). Agent ID: ${payload.agentId}`);
            return {
                success: false,
                status: 'INVALID_TOKEN',
                message: 'Agent not found.'
            };
        }

        // 2. Compare stored secret vs headerSecret
        if (!headerSecret || agent.agentSecret !== headerSecret) {
            console.warn(`[Heartbeat] Heartbeat rejected: UNAUTHORIZED (secret mismatch). Agent ID: ${agent.id}, Hostname: ${agent.hostname}`);
            return {
                success: false,
                status: 'UNAUTHORIZED',
                message: 'Authentication secret mismatch.'
            };
        }

        // Resolve capabilities from header
        const capCheckResult = QaSimulationService.getInstance().checkCapabilities(capabilitiesHeader);
        const authorizedCapabilities = capCheckResult.authorizedCapabilities;

        const dbCapabilities = Array.isArray(agent.capabilities) ? (agent.capabilities as string[]) : [];
        const capChanged = dbCapabilities.length !== authorizedCapabilities.length ||
            !dbCapabilities.every((c: string) => authorizedCapabilities.includes(c));

        // 3. Update agent status & lastHeartbeatAt
        const prevStatus = agent.status;
        const prevHeartbeat = agent.lastHeartbeatAt;
        const now = new Date();

        const updatedAgent = await prisma.agent.update({
            where: { id: agent.id },
            data: {
                status: 'ONLINE',
                lastHeartbeatAt: now,
                hostname: payload.hostname,
                version: payload.version,
                ...(capChanged ? { capabilities: authorizedCapabilities } : {})
            }
        });

        let dbUpdatedRows = 0;
        if (updatedAgent) {
            dbUpdatedRows = 1;
        }

        console.log(`======================================================
HEARTBEAT RECEIVED
======================================================
Agent ID:     ${agent.id}
Hostname:     ${payload.hostname}
Machine ID:   ${agent.machineId}

CPU:          ${payload.metrics.cpuPct}%
RAM:          ${payload.metrics.memoryPct}%
Disk:         ${payload.metrics.diskPct}%

Database:     ${payload.health.databaseHealthy ? 'Healthy' : 'Unhealthy'}
Freqtrade:    ${payload.health.freqtradeHealthy ? 'Healthy' : 'Unhealthy'}

Previous status: ${prevStatus}
New status:      ${updatedAgent.status}

Rows updated: ${dbUpdatedRows}

Heartbeat acknowledged successfully.
======================================================`);

        if (prevStatus !== 'ONLINE') {
            console.log(`[Heartbeat] Agent transitioned ${prevStatus} -> ONLINE`);
        }

        if (updatedAgent.status !== 'ONLINE') {
            console.error(`======================================================
HEARTBEAT DIAGNOSTIC CONTEXT (STATUS MISMATCH)
======================================================
Heartbeat was accepted, but the persisted status is not ONLINE!
Persisted status before update:  ${prevStatus}
Persisted status after update:   ${updatedAgent.status}
Last heartbeat before update:    ${prevHeartbeat ? prevHeartbeat.toISOString() : 'None'}
Last heartbeat after update:     ${updatedAgent.lastHeartbeatAt ? updatedAgent.lastHeartbeatAt.toISOString() : 'None'}
Reason:                          Persisted status remained ${updatedAgent.status} post-update.
======================================================`);
        }

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
            configOverrides,
            warning,
            message: warningMessage,
            ...(capChanged ? { authorizedCapabilities } : {})
        };
    }

    public async getAgentsStatus(): Promise<any[]> {
        const agents = await prisma.agent.findMany({
            orderBy: { lastHeartbeatAt: 'desc' }
        });

        const results = [];
        for (const agent of agents) {
            const hb = await prisma.agentHeartbeat.findFirst({
                where: { agentId: agent.id },
                orderBy: { timestamp: 'desc' }
            });
            results.push({
                id: agent.id,
                hostname: agent.hostname,
                machineId: agent.machineId,
                version: agent.version,
                status: agent.status,
                capabilities: agent.capabilities,
                lastHeartbeatAt: agent.lastHeartbeatAt,
                latestHeartbeat: hb ? {
                    id: hb.id,
                    agentVersion: hb.agentVersion,
                    cpuPct: Number(hb.cpuPct),
                    memoryPct: Number(hb.memoryPct),
                    diskPct: Number(hb.diskPct),
                    status: hb.status,
                    uptime: Number(hb.uptime),
                    outboxPending: hb.outboxPending,
                    databaseHealthy: hb.databaseHealthy,
                    freqtradeHealthy: hb.freqtradeHealthy,
                    timestamp: hb.timestamp
                } : null
            });
        }
        return results;
    }

    public getConfig(agentId: string) {
        return ConfigurationService.getInstance().getConfig(agentId);
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
