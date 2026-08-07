import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import {
    IIncidentRepository,
    IDecisionAuditRepository,
    IIncidentOutboxRepository,
    IAlertLogRepository,
    ICircuitBreakerRepository,
    IAgentRepository,
    IncidentRecord,
    IncidentGroupRecord,
    IncidentTransitionRecord,
    DecisionAuditRecord,
    IncidentOutboxRecord,
    AlertLogRecord,
    CircuitBreakerStateRecord,
    AgentRecord,
    AgentHeartbeatRecord,
    RegistrationTokenRecord
} from './interfaces';

// Helper type for Prisma Transaction Client
type TxClient = Omit<
    typeof prisma,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

function mapIncident(record: any): IncidentRecord {
    return {
        id: record.id,
        symbol: record.symbol,
        level: record.level as any,
        source: record.source,
        reason: record.reason,
        detectedAt: BigInt(record.detectedAt),
        resolvedAt: record.resolvedAt ? BigInt(record.resolvedAt) : null,
        groupId: record.groupId
    };
}

function mapIncidentGroup(record: any): IncidentGroupRecord {
    return {
        id: record.id,
        correlationKey: record.correlationKey,
        symbol: record.symbol,
        groupType: record.groupType as any,
        openedAt: BigInt(record.openedAt),
        resolvedAt: record.resolvedAt ? BigInt(record.resolvedAt) : null,
        highestSeverity: record.highestSeverity as any
    };
}

function mapIncidentTransition(record: any): IncidentTransitionRecord {
    return {
        id: record.id,
        incidentId: record.incidentId,
        transitionType: record.transitionType as any,
        level: record.level ? (record.level as any) : null,
        reason: record.reason,
        actor: record.actor as any,
        occurredAt: BigInt(record.occurredAt)
    };
}

function mapDecisionAudit(record: any): DecisionAuditRecord {
    return {
        id: record.id,
        classification: record.classification,
        rejectionReason: record.rejectionReason,
        systemRiskState: record.systemRiskState,
        htf: record.htf,
        metadata: record.metadata,
        createdAt: record.createdAt
    };
}

function mapIncidentOutbox(record: any): IncidentOutboxRecord {
    return {
        id: record.id,
        payload: record.payload,
        status: record.status,
        attempts: record.attempts,
        nextRetryAt: record.nextRetryAt,
        lastError: record.lastError,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
    };
}

function mapAlertLog(record: any): AlertLogRecord {
    return {
        id: record.id,
        level: record.level,
        title: record.title,
        message: record.message,
        entityId: record.entityId,
        timestamp: record.timestamp
    };
}

function mapCircuitBreakerState(record: any): CircuitBreakerStateRecord {
    return {
        id: record.id,
        breakerType: record.breakerType,
        status: record.status,
        currentVal: Number(record.currentVal),
        lastUpdated: record.lastUpdated
    };
}

function mapAgent(record: any): AgentRecord {
    return {
        id: record.id,
        machineId: record.machineId,
        hostname: record.hostname,
        displayName: record.displayName,
        version: record.version,
        status: record.status,
        capabilities: record.capabilities,
        agentSecret: record.agentSecret,
        lastHeartbeatAt: record.lastHeartbeatAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        organizationId: record.organizationId,
        tenantId: record.tenantId,
        registrationTokenId: record.registrationTokenId
    };
}

function mapAgentHeartbeat(record: any): AgentHeartbeatRecord {
    return {
        id: record.id,
        agentId: record.agentId,
        agentVersion: record.agentVersion,
        cpuPct: Number(record.cpuPct),
        memoryPct: Number(record.memoryPct),
        diskPct: Number(record.diskPct),
        status: record.status,
        uptime: BigInt(record.uptime),
        outboxPending: record.outboxPending,
        databaseHealthy: record.databaseHealthy,
        freqtradeHealthy: record.freqtradeHealthy,
        timestamp: record.timestamp
    };
}

function mapRegistrationToken(record: any): RegistrationTokenRecord {
    return {
        token: record.token,
        maxAgents: record.maxAgents,
        status: record.status,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt
    };
}

export class PrismaIncidentRepository implements IIncidentRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async findActiveIncidents(): Promise<IncidentRecord[]> {
        const records = await this.client.incident.findMany({
            where: { resolvedAt: null }
        });
        return records.map(mapIncident);
    }

    async findUnresolvedIncident(symbol: string | null, source: string): Promise<IncidentRecord | null> {
        const record = await this.client.incident.findFirst({
            where: { symbol, source, resolvedAt: null }
        });
        return record ? mapIncident(record) : null;
    }

    async createIncident(data: Omit<IncidentRecord, 'id' | 'resolvedAt'>): Promise<IncidentRecord> {
        const record = await this.client.incident.create({
            data: {
                symbol: data.symbol,
                level: data.level as any,
                source: data.source,
                reason: data.reason,
                detectedAt: data.detectedAt,
                groupId: data.groupId
            }
        });
        return mapIncident(record);
    }

    async updateIncident(id: number, data: Partial<Omit<IncidentRecord, 'id'>>): Promise<IncidentRecord> {
        const record = await this.client.incident.update({
            where: { id },
            data: {
                symbol: data.symbol,
                level: data.level as any,
                source: data.source,
                reason: data.reason,
                detectedAt: data.detectedAt,
                resolvedAt: data.resolvedAt,
                groupId: data.groupId
            }
        });
        return mapIncident(record);
    }

    async updateManyIncidents(
        where: { id?: { in: number[] }; symbol?: string | null; resolvedAt?: bigint | null },
        data: Partial<Omit<IncidentRecord, 'id'>>
    ): Promise<number> {
        const result = await this.client.incident.updateMany({
            where: {
                id: where.id,
                symbol: where.symbol,
                resolvedAt: where.resolvedAt
            },
            data: {
                symbol: data.symbol,
                level: data.level as any,
                source: data.source,
                reason: data.reason,
                detectedAt: data.detectedAt,
                resolvedAt: data.resolvedAt,
                groupId: data.groupId
            }
        });
        return result.count;
    }

    async findIncidents(where: { groupId?: number; resolvedAt?: bigint | null }): Promise<IncidentRecord[]> {
        const records = await this.client.incident.findMany({
            where: {
                groupId: where.groupId,
                resolvedAt: where.resolvedAt
            }
        });
        return records.map(mapIncident);
    }

    async findUnresolvedGroup(correlationKey: string, timeThreshold: bigint): Promise<IncidentGroupRecord | null> {
        const record = await this.client.incidentGroup.findFirst({
            where: {
                correlationKey,
                resolvedAt: null,
                openedAt: { gte: timeThreshold }
            },
            orderBy: { openedAt: 'desc' }
        });
        return record ? mapIncidentGroup(record) : null;
    }

    async findUnresolvedOperationsGroup(timeThreshold: bigint): Promise<IncidentGroupRecord | null> {
        const record = await this.client.incidentGroup.findFirst({
            where: {
                groupType: 'OPERATIONS',
                resolvedAt: null,
                openedAt: { gte: timeThreshold }
            },
            orderBy: { openedAt: 'desc' }
        });
        return record ? mapIncidentGroup(record) : null;
    }

    async createGroup(data: Omit<IncidentGroupRecord, 'id' | 'resolvedAt'>): Promise<IncidentGroupRecord> {
        const record = await this.client.incidentGroup.create({
            data: {
                correlationKey: data.correlationKey,
                symbol: data.symbol,
                groupType: data.groupType as any,
                openedAt: data.openedAt,
                highestSeverity: data.highestSeverity as any
            }
        });
        return mapIncidentGroup(record);
    }

    async updateGroup(id: number, data: Partial<Omit<IncidentGroupRecord, 'id'>>): Promise<IncidentGroupRecord> {
        const record = await this.client.incidentGroup.update({
            where: { id },
            data: {
                correlationKey: data.correlationKey,
                symbol: data.symbol,
                groupType: data.groupType as any,
                openedAt: data.openedAt,
                resolvedAt: data.resolvedAt,
                highestSeverity: data.highestSeverity as any
            }
        });
        return mapIncidentGroup(record);
    }

    async findGroupById(id: number): Promise<IncidentGroupRecord | null> {
        const record = await this.client.incidentGroup.findUnique({
            where: { id }
        });
        return record ? mapIncidentGroup(record) : null;
    }

    async createTransition(data: Omit<IncidentTransitionRecord, 'id'>): Promise<IncidentTransitionRecord> {
        const record = await this.client.incidentTransition.create({
            data: {
                incidentId: data.incidentId,
                transitionType: data.transitionType as any,
                level: data.level as any,
                reason: data.reason,
                actor: data.actor as any,
                occurredAt: data.occurredAt
            }
        });
        return mapIncidentTransition(record);
    }

    async runInTransaction<T>(fn: (txRepo: IIncidentRepository) => Promise<T>): Promise<T> {
        if ('$transaction' in this.client) {
            return (this.client as any).$transaction(async (tx: any) => {
                const txRepo = new PrismaIncidentRepository(tx);
                return fn(txRepo);
            });
        }
        // If already inside a transaction, run the callback directly
        return fn(this);
    }
}

export class PrismaDecisionAuditRepository implements IDecisionAuditRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async create(data: Omit<DecisionAuditRecord, 'id' | 'createdAt'> & { createdAt?: Date }): Promise<DecisionAuditRecord> {
        const record = await this.client.decisionAudit.create({
            data: {
                classification: data.classification,
                rejectionReason: data.rejectionReason,
                systemRiskState: data.systemRiskState,
                htf: data.htf as any,
                metadata: data.metadata as any,
                createdAt: data.createdAt
            }
        });
        return mapDecisionAudit(record);
    }

    async findFirst(args: { where: any; orderBy?: any }): Promise<DecisionAuditRecord | null> {
        const record = await this.client.decisionAudit.findFirst(args);
        return record ? mapDecisionAudit(record) : null;
    }

    async findMany(args: { where?: any; orderBy?: any; take?: number; skip?: number }): Promise<DecisionAuditRecord[]> {
        const records = await this.client.decisionAudit.findMany(args);
        return records.map(mapDecisionAudit);
    }

    async update(id: string, data: Partial<Omit<DecisionAuditRecord, 'id' | 'createdAt'>>): Promise<DecisionAuditRecord> {
        const record = await this.client.decisionAudit.update({
            where: { id },
            data: {
                classification: data.classification,
                rejectionReason: data.rejectionReason,
                systemRiskState: data.systemRiskState,
                htf: data.htf as any,
                metadata: data.metadata as any
            }
        });
        return mapDecisionAudit(record);
    }

    async deleteMany(args: { where: any }): Promise<{ count: number }> {
        return this.client.decisionAudit.deleteMany(args);
    }
}


export class PrismaIncidentOutboxRepository implements IIncidentOutboxRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async create(data: { payload: any; status?: string; attempts?: number; nextRetryAt?: Date; lastError?: string | null }): Promise<IncidentOutboxRecord> {
        const record = await this.client.incidentOutbox.create({
            data: {
                payload: data.payload,
                status: data.status,
                attempts: data.attempts,
                nextRetryAt: data.nextRetryAt,
                lastError: data.lastError
            }
        });
        return mapIncidentOutbox(record);
    }

    async findMany(args: { where: any; orderBy?: any; take?: number }): Promise<IncidentOutboxRecord[]> {
        const records = await this.client.incidentOutbox.findMany(args);
        return records.map(mapIncidentOutbox);
    }

    async update(id: number, data: Partial<Omit<IncidentOutboxRecord, 'id'>>): Promise<IncidentOutboxRecord> {
        const record = await this.client.incidentOutbox.update({
            where: { id },
            data: {
                payload: data.payload,
                status: data.status,
                attempts: data.attempts,
                nextRetryAt: data.nextRetryAt,
                lastError: data.lastError
            }
        });
        return mapIncidentOutbox(record);
    }

    async updateMany(args: { where: any; data: any }): Promise<{ count: number }> {
        return this.client.incidentOutbox.updateMany(args);
    }

    async count(args: { where: any }): Promise<number> {
        return this.client.incidentOutbox.count(args);
    }
}

export class PrismaAlertLogRepository implements IAlertLogRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async create(data: Omit<AlertLogRecord, 'id' | 'timestamp'>): Promise<AlertLogRecord> {
        const record = await this.client.alertLog.create({
            data: {
                level: data.level,
                title: data.title,
                message: data.message,
                entityId: data.entityId
            }
        });
        return mapAlertLog(record);
    }

    async findMany(args: { where?: any; orderBy?: any; take?: number }): Promise<AlertLogRecord[]> {
        const records = await this.client.alertLog.findMany(args);
        return records.map(mapAlertLog);
    }
}

export class PrismaCircuitBreakerRepository implements ICircuitBreakerRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async findUnique(breakerType: string): Promise<CircuitBreakerStateRecord | null> {
        const record = await this.client.circuitBreakerState.findUnique({
            where: { breakerType }
        });
        return record ? mapCircuitBreakerState(record) : null;
    }

    async upsert(breakerType: string, status: string, currentVal: number): Promise<CircuitBreakerStateRecord> {
        const record = await this.client.circuitBreakerState.upsert({
            where: { breakerType },
            update: { status, currentVal },
            create: { breakerType, status, currentVal }
        });
        return mapCircuitBreakerState(record);
    }
}

export class PrismaAgentRepository implements IAgentRepository {
    constructor(private readonly client: TxClient = prisma) {}

    async findAgentById(id: string): Promise<AgentRecord | null> {
        const record = await this.client.agent.findUnique({
            where: { id }
        });
        return record ? mapAgent(record) : null;
    }

    async findAgentByMachineId(machineId: string): Promise<AgentRecord | null> {
        const record = await this.client.agent.findUnique({
            where: { machineId }
        });
        return record ? mapAgent(record) : null;
    }

    async createAgent(data: Omit<AgentRecord, 'createdAt' | 'updatedAt'>): Promise<AgentRecord> {
        const record = await this.client.agent.create({
            data: {
                id: data.id,
                machineId: data.machineId,
                hostname: data.hostname,
                displayName: data.displayName,
                version: data.version,
                status: data.status,
                capabilities: data.capabilities,
                agentSecret: data.agentSecret,
                registrationTokenId: data.registrationTokenId,
                lastHeartbeatAt: data.lastHeartbeatAt
            }
        });
        return mapAgent(record);
    }

    async updateAgent(id: string, data: Partial<Omit<AgentRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AgentRecord> {
        const record = await this.client.agent.update({
            where: { id },
            data: {
                machineId: data.machineId,
                hostname: data.hostname,
                displayName: data.displayName,
                version: data.version,
                status: data.status,
                capabilities: data.capabilities,
                agentSecret: data.agentSecret,
                registrationTokenId: data.registrationTokenId,
                lastHeartbeatAt: data.lastHeartbeatAt
            }
        });
        return mapAgent(record);
    }

    async updateManyAgents(where: any, data: any): Promise<{ count: number }> {
        return this.client.agent.updateMany({ where, data });
    }

    async countAgents(where: any): Promise<number> {
        return this.client.agent.count({ where });
    }

    async findManyAgents(args?: { orderBy?: any }): Promise<AgentRecord[]> {
        const records = await this.client.agent.findMany(args);
        return records.map(mapAgent);
    }

    async deleteManyAgents(where: any): Promise<{ count: number }> {
        return this.client.agent.deleteMany({ where });
    }

    async createAgentHeartbeat(data: Omit<AgentHeartbeatRecord, 'id' | 'timestamp'>): Promise<AgentHeartbeatRecord> {
        const record = await this.client.agentHeartbeat.create({
            data: {
                agentId: data.agentId,
                agentVersion: data.agentVersion,
                cpuPct: data.cpuPct,
                memoryPct: data.memoryPct,
                diskPct: data.diskPct,
                status: data.status,
                uptime: data.uptime,
                outboxPending: data.outboxPending,
                databaseHealthy: data.databaseHealthy,
                freqtradeHealthy: data.freqtradeHealthy
            }
        });
        return mapAgentHeartbeat(record);
    }

    async deleteManyAgentHeartbeats(where: any): Promise<{ count: number }> {
        return this.client.agentHeartbeat.deleteMany({ where });
    }

    async findFirstAgentHeartbeat(agentId: string): Promise<AgentHeartbeatRecord | null> {
        const record = await this.client.agentHeartbeat.findFirst({
            where: { agentId },
            orderBy: { timestamp: 'desc' }
        });
        return record ? mapAgentHeartbeat(record) : null;
    }

    async findRegistrationToken(token: string): Promise<RegistrationTokenRecord | null> {
        const record = await this.client.registrationToken.findUnique({
            where: { token }
        });
        return record ? mapRegistrationToken(record) : null;
    }

    async createRegistrationToken(data: Omit<RegistrationTokenRecord, 'createdAt'>): Promise<RegistrationTokenRecord> {
        const record = await this.client.registrationToken.create({
            data: {
                token: data.token,
                maxAgents: data.maxAgents,
                status: data.status,
                expiresAt: data.expiresAt
            }
        });
        return mapRegistrationToken(record);
    }
}
