/**
 * Domain-agnostic Repository Interfaces
 */

export type IncidentSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
export type IncidentTransitionType = 'DETECTED' | 'LEVEL_CHANGED' | 'RESOLVED';
export type IncidentActor = 'WATCHDOG' | 'SYSTEM' | 'USER' | 'SIMULATOR' | 'RECOVERY';
export type IncidentGroupType = 'INFRASTRUCTURE' | 'OPERATIONS';

export interface IncidentRecord {
    id: number;
    symbol: string | null;
    level: IncidentSeverity;
    source: string;
    reason: string;
    detectedAt: bigint;
    resolvedAt: bigint | null;
    groupId: number | null;
}

export interface IncidentGroupRecord {
    id: number;
    correlationKey: string;
    symbol: string | null;
    groupType: IncidentGroupType;
    openedAt: bigint;
    resolvedAt: bigint | null;
    highestSeverity: IncidentSeverity;
}

export interface IncidentTransitionRecord {
    id: number;
    incidentId: number;
    transitionType: IncidentTransitionType;
    level: IncidentSeverity | null;
    reason: string;
    actor: IncidentActor;
    occurredAt: bigint;
}

export interface DecisionAuditRecord {
    id: string;
    classification: string;
    rejectionReason: string | null;
    systemRiskState: string;
    htf?: any;
    metadata?: any;
    createdAt: Date;
}

export interface IncidentOutboxRecord {
    id: number;
    payload: any;
    status: string;
    attempts: number;
    nextRetryAt: Date;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface AlertLogRecord {
    id: number;
    level: string;
    title: string;
    message: string;
    entityId: string | null;
    timestamp: Date;
}

export interface CircuitBreakerStateRecord {
    id: number;
    breakerType: string;
    status: string;
    currentVal: number; // or Decimal / string
    lastUpdated: Date;
}

export interface AgentRecord {
    id: string;
    machineId: string;
    hostname: string;
    displayName: string | null;
    version: string;
    status: string;
    capabilities: any;
    agentSecret: string;
    lastHeartbeatAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    organizationId: string | null;
    tenantId: string | null;
    registrationTokenId: string;
}

export interface AgentHeartbeatRecord {
    id: string;
    agentId: string;
    agentVersion: string;
    cpuPct: number;
    memoryPct: number;
    diskPct: number;
    status: string;
    uptime: bigint;
    outboxPending: number;
    databaseHealthy: boolean;
    freqtradeHealthy: boolean;
    timestamp: Date;
}

export interface RegistrationTokenRecord {
    token: string;
    maxAgents: number;
    status: string;
    expiresAt: Date | null;
    createdAt: Date;
}

export interface IDatabaseHealthProvider {
    isHealthy(): Promise<boolean>;
}

export interface IIncidentRepository {
    findActiveIncidents(): Promise<IncidentRecord[]>;
    findUnresolvedIncident(symbol: string | null, source: string): Promise<IncidentRecord | null>;
    createIncident(data: Omit<IncidentRecord, 'id' | 'resolvedAt'>): Promise<IncidentRecord>;
    updateIncident(id: number, data: Partial<Omit<IncidentRecord, 'id'>>): Promise<IncidentRecord>;
    updateManyIncidents(where: { id?: { in: number[] }; symbol?: string | null; resolvedAt?: bigint | null }, data: Partial<Omit<IncidentRecord, 'id'>>): Promise<number>;
    findIncidents(where: { groupId?: number; resolvedAt?: bigint | null }): Promise<IncidentRecord[]>;
    
    findUnresolvedGroup(correlationKey: string, timeThreshold: bigint): Promise<IncidentGroupRecord | null>;
    findUnresolvedOperationsGroup(timeThreshold: bigint): Promise<IncidentGroupRecord | null>;
    createGroup(data: Omit<IncidentGroupRecord, 'id' | 'resolvedAt'>): Promise<IncidentGroupRecord>;
    updateGroup(id: number, data: Partial<Omit<IncidentGroupRecord, 'id'>>): Promise<IncidentGroupRecord>;
    findGroupById(id: number): Promise<IncidentGroupRecord | null>;
    
    createTransition(data: Omit<IncidentTransitionRecord, 'id'>): Promise<IncidentTransitionRecord>;
    
    runInTransaction<T>(fn: (txRepo: IIncidentRepository) => Promise<T>): Promise<T>;
}

export interface IDecisionAuditRepository {
    create(data: Omit<DecisionAuditRecord, 'id' | 'createdAt'> & { createdAt?: Date }): Promise<DecisionAuditRecord>;
    findFirst(args: { where: any; orderBy?: any }): Promise<DecisionAuditRecord | null>;
    findMany(args: { where?: any; orderBy?: any; take?: number; skip?: number }): Promise<DecisionAuditRecord[]>;
    update(id: string, data: Partial<Omit<DecisionAuditRecord, 'id' | 'createdAt'>>): Promise<DecisionAuditRecord>;
    deleteMany(args: { where: any }): Promise<{ count: number }>;
}


export interface IIncidentOutboxRepository {
    create(data: { payload: any; status?: string; attempts?: number; nextRetryAt?: Date; lastError?: string | null }): Promise<IncidentOutboxRecord>;
    findMany(args: { where: any; orderBy?: any; take?: number }): Promise<IncidentOutboxRecord[]>;
    update(id: number, data: Partial<Omit<IncidentOutboxRecord, 'id'>>): Promise<IncidentOutboxRecord>;
    updateMany(args: { where: any; data: any }): Promise<{ count: number }>;
    count(args: { where: any }): Promise<number>;
}

export interface IAlertLogRepository {
    create(data: Omit<AlertLogRecord, 'id' | 'timestamp'>): Promise<AlertLogRecord>;
    findMany(args: { where?: any; orderBy?: any; take?: number }): Promise<AlertLogRecord[]>;
}

export interface ICircuitBreakerRepository {
    findUnique(breakerType: string): Promise<CircuitBreakerStateRecord | null>;
    upsert(breakerType: string, status: string, currentVal: number): Promise<CircuitBreakerStateRecord>;
}

export interface IAgentRepository {
    findAgentById(id: string): Promise<AgentRecord | null>;
    findAgentByMachineId(machineId: string): Promise<AgentRecord | null>;
    createAgent(data: Omit<AgentRecord, 'createdAt' | 'updatedAt'>): Promise<AgentRecord>;
    updateAgent(id: string, data: Partial<Omit<AgentRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AgentRecord>;
    updateManyAgents(where: any, data: any): Promise<{ count: number }>;
    countAgents(where: any): Promise<number>;
    findManyAgents(args?: { orderBy?: any }): Promise<AgentRecord[]>;
    deleteManyAgents(where: any): Promise<{ count: number }>;
    
    createAgentHeartbeat(data: Omit<AgentHeartbeatRecord, 'id' | 'timestamp'>): Promise<AgentHeartbeatRecord>;
    deleteManyAgentHeartbeats(where: any): Promise<{ count: number }>;
    findFirstAgentHeartbeat(agentId: string): Promise<AgentHeartbeatRecord | null>;
    
    findRegistrationToken(token: string): Promise<RegistrationTokenRecord | null>;
    createRegistrationToken(data: Omit<RegistrationTokenRecord, 'createdAt'>): Promise<RegistrationTokenRecord>;
}
