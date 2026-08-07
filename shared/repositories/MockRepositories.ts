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

export class MockIncidentRepository implements IIncidentRepository {
    public incidents: IncidentRecord[] = [];
    public groups: IncidentGroupRecord[] = [];
    public transitions: IncidentTransitionRecord[] = [];
    private nextIncidentId = 1;
    private nextGroupId = 1;
    private nextTransitionId = 1;

    async findActiveIncidents(): Promise<IncidentRecord[]> {
        return this.incidents.filter(i => i.resolvedAt === null);
    }

    async findUnresolvedIncident(symbol: string | null, source: string): Promise<IncidentRecord | null> {
        const found = this.incidents.find(i => i.symbol === symbol && i.source === source && i.resolvedAt === null);
        return found ? { ...found } : null;
    }

    async createIncident(data: Omit<IncidentRecord, 'id' | 'resolvedAt'>): Promise<IncidentRecord> {
        const record: IncidentRecord = {
            id: this.nextIncidentId++,
            symbol: data.symbol,
            level: data.level,
            source: data.source,
            reason: data.reason,
            detectedAt: data.detectedAt,
            resolvedAt: null,
            groupId: data.groupId
        };
        this.incidents.push(record);
        return { ...record };
    }

    async updateIncident(id: number, data: Partial<Omit<IncidentRecord, 'id'>>): Promise<IncidentRecord> {
        const idx = this.incidents.findIndex(i => i.id === id);
        if (idx === -1) throw new Error(`Incident not found: ${id}`);
        this.incidents[idx] = {
            ...this.incidents[idx],
            ...data
        } as IncidentRecord;
        return { ...this.incidents[idx] };
    }

    async updateManyIncidents(
        where: { id?: { in: number[] }; symbol?: string | null; resolvedAt?: bigint | null },
        data: Partial<Omit<IncidentRecord, 'id'>>
    ): Promise<number> {
        let count = 0;
        this.incidents = this.incidents.map(i => {
            let match = true;
            if (where.id?.in && !where.id.in.includes(i.id)) match = false;
            if (where.symbol !== undefined && i.symbol !== where.symbol) match = false;
            if (where.resolvedAt !== undefined && i.resolvedAt !== where.resolvedAt) match = false;

            if (match) {
                count++;
                return { ...i, ...data } as IncidentRecord;
            }
            return i;
        });
        return count;
    }

    async findIncidents(where: { groupId?: number; resolvedAt?: bigint | null }): Promise<IncidentRecord[]> {
        return this.incidents.filter(i => {
            if (where.groupId !== undefined && i.groupId !== where.groupId) return false;
            if (where.resolvedAt !== undefined && i.resolvedAt !== where.resolvedAt) return false;
            return true;
        });
    }

    async findUnresolvedGroup(correlationKey: string, timeThreshold: bigint): Promise<IncidentGroupRecord | null> {
        const matches = this.groups.filter(g =>
            g.correlationKey === correlationKey &&
            g.resolvedAt === null &&
            g.openedAt >= timeThreshold
        );
        if (matches.length === 0) return null;
        // order desc
        matches.sort((a, b) => (b.openedAt > a.openedAt ? 1 : -1));
        return { ...matches[0] };
    }

    async findUnresolvedOperationsGroup(timeThreshold: bigint): Promise<IncidentGroupRecord | null> {
        const matches = this.groups.filter(g =>
            g.groupType === 'OPERATIONS' &&
            g.resolvedAt === null &&
            g.openedAt >= timeThreshold
        );
        if (matches.length === 0) return null;
        matches.sort((a, b) => (b.openedAt > a.openedAt ? 1 : -1));
        return { ...matches[0] };
    }

    async createGroup(data: Omit<IncidentGroupRecord, 'id' | 'resolvedAt'>): Promise<IncidentGroupRecord> {
        const record: IncidentGroupRecord = {
            id: this.nextGroupId++,
            correlationKey: data.correlationKey,
            symbol: data.symbol,
            groupType: data.groupType,
            openedAt: data.openedAt,
            resolvedAt: null,
            highestSeverity: data.highestSeverity
        };
        this.groups.push(record);
        return { ...record };
    }

    async updateGroup(id: number, data: Partial<Omit<IncidentGroupRecord, 'id'>>): Promise<IncidentGroupRecord> {
        const idx = this.groups.findIndex(g => g.id === id);
        if (idx === -1) throw new Error(`Group not found: ${id}`);
        this.groups[idx] = {
            ...this.groups[idx],
            ...data
        } as IncidentGroupRecord;
        return { ...this.groups[idx] };
    }

    async findGroupById(id: number): Promise<IncidentGroupRecord | null> {
        const found = this.groups.find(g => g.id === id);
        return found ? { ...found } : null;
    }

    async createTransition(data: Omit<IncidentTransitionRecord, 'id'>): Promise<IncidentTransitionRecord> {
        const record: IncidentTransitionRecord = {
            id: this.nextTransitionId++,
            incidentId: data.incidentId,
            transitionType: data.transitionType,
            level: data.level,
            reason: data.reason,
            actor: data.actor,
            occurredAt: data.occurredAt
        };
        this.transitions.push(record);
        return { ...record };
    }

    async runInTransaction<T>(fn: (txRepo: IIncidentRepository) => Promise<T>): Promise<T> {
        // In-memory transaction is just direct evaluation since JS is single threaded
        return fn(this);
    }
}

export class MockDecisionAuditRepository implements IDecisionAuditRepository {
    public audits: DecisionAuditRecord[] = [];
    private nextId = 1;

    async create(data: Omit<DecisionAuditRecord, 'id' | 'createdAt'> & { createdAt?: Date }): Promise<DecisionAuditRecord> {
        const record: DecisionAuditRecord = {
            id: `audit-${this.nextId++}`,
            classification: data.classification,
            rejectionReason: data.rejectionReason,
            systemRiskState: data.systemRiskState,
            htf: data.htf,
            metadata: data.metadata,
            createdAt: data.createdAt || new Date()
        };
        this.audits.push(record);
        return { ...record };
    }

    async findFirst(args: { where: any; orderBy?: any }): Promise<DecisionAuditRecord | null> {
        // Simplified mock filtering
        let filtered = [...this.audits];
        if (args.where) {
            filtered = filtered.filter(a => {
                for (const key of Object.keys(args.where)) {
                    const matchVal = args.where[key];
                    if (matchVal === null && (a as any)[key] !== null) return false;
                    if (matchVal !== null && typeof matchVal === 'object' && !(matchVal instanceof Date)) {
                        if (matchVal.equals !== undefined) {
                            if ((a as any)[key] !== matchVal.equals) return false;
                        }
                        if (matchVal.gte !== undefined) {
                            if ((a as any)[key] < matchVal.gte) return false;
                        }
                        if (matchVal.lte !== undefined) {
                            if ((a as any)[key] > matchVal.lte) return false;
                        }
                    } else if (matchVal !== undefined && (a as any)[key] !== matchVal) {
                        return false;
                    }
                }
                return true;
            });
        }
        if (args.orderBy) {
            // Simplified sort
            if (args.orderBy.createdAt === 'desc') {
                filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            }
        }
        return filtered.length > 0 ? { ...filtered[0] } : null;
    }

    async findMany(args: { where?: any; orderBy?: any; take?: number; skip?: number }): Promise<DecisionAuditRecord[]> {
        let filtered = [...this.audits];
        if (args.where) {
            filtered = filtered.filter(a => {
                for (const key of Object.keys(args.where)) {
                    const matchVal = args.where[key];
                    if (matchVal === null && (a as any)[key] !== null) return false;
                    if (matchVal !== null && typeof matchVal === 'object' && !(matchVal instanceof Date)) {
                        if (matchVal.equals !== undefined) {
                            if ((a as any)[key] !== matchVal.equals) return false;
                        }
                        if (matchVal.gte !== undefined) {
                            if ((a as any)[key] < matchVal.gte) return false;
                        }
                        if (matchVal.lte !== undefined) {
                            if ((a as any)[key] > matchVal.lte) return false;
                        }
                    } else if (matchVal !== undefined && (a as any)[key] !== matchVal) {
                        return false;
                    }
                }
                return true;
            });
        }
        if (args.orderBy) {
            if (args.orderBy.createdAt === 'desc') {
                filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            } else if (args.orderBy.createdAt === 'asc') {
                filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            }
        }
        if (args.skip) {
            filtered = filtered.slice(args.skip);
        }
        if (args.take) {
            filtered = filtered.slice(0, args.take);
        }
        return filtered.map(a => ({ ...a }));
    }

    async update(id: string, data: Partial<Omit<DecisionAuditRecord, 'id' | 'createdAt'>>): Promise<DecisionAuditRecord> {
        const idx = this.audits.findIndex(a => a.id === id);
        if (idx === -1) throw new Error(`Decision audit record not found: ${id}`);
        this.audits[idx] = {
            ...this.audits[idx],
            ...data
        } as DecisionAuditRecord;
        return { ...this.audits[idx] };
    }

    async deleteMany(args: { where: any }): Promise<{ count: number }> {
        const initialCount = this.audits.length;
        // Simple mock delete for ResetSimulationLab:
        this.audits = this.audits.filter(a => {
            if (args.where?.OR) {
                // If it matches any OR condition, we delete it (so return false)
                for (const cond of args.where.OR) {
                    if (cond.metadata?.path) {
                        const path = cond.metadata.path;
                        const value = cond.metadata.equals;
                        if (path[0] === 'telemetrySource' && a.metadata?.telemetrySource === value) return false;
                        if (path[0] === 'lifecycleEvent' && path[1] === 'source' && a.metadata?.lifecycleEvent?.source === value) return false;
                    }
                }
            }
            return true;
        });
        return { count: initialCount - this.audits.length };
    }
}


export class MockIncidentOutboxRepository implements IIncidentOutboxRepository {
    public outbox: IncidentOutboxRecord[] = [];
    private nextId = 1;

    async create(data: { payload: any; status?: string; attempts?: number; nextRetryAt?: Date; lastError?: string | null }): Promise<IncidentOutboxRecord> {
        const record: IncidentOutboxRecord = {
            id: this.nextId++,
            payload: data.payload,
            status: data.status || 'PENDING',
            attempts: data.attempts || 0,
            nextRetryAt: data.nextRetryAt || new Date(),
            lastError: data.lastError || null,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.outbox.push(record);
        return { ...record };
    }

    async findMany(args: { where: any; orderBy?: any; take?: number }): Promise<IncidentOutboxRecord[]> {
        let filtered = [...this.outbox];
        if (args.where) {
            filtered = filtered.filter(o => {
                if (args.where.status !== undefined && o.status !== args.where.status) return false;
                if (args.where.attempts?.lt !== undefined && o.attempts >= args.where.attempts.lt) return false;
                if (args.where.nextRetryAt?.lte !== undefined && o.nextRetryAt > args.where.nextRetryAt.lte) return false;
                return true;
            });
        }
        if (args.take) {
            filtered = filtered.slice(0, args.take);
        }
        return filtered.map(o => ({ ...o }));
    }

    async update(id: number, data: Partial<Omit<IncidentOutboxRecord, 'id'>>): Promise<IncidentOutboxRecord> {
        const idx = this.outbox.findIndex(o => o.id === id);
        if (idx === -1) throw new Error(`Outbox record not found: ${id}`);
        this.outbox[idx] = {
            ...this.outbox[idx],
            ...data,
            updatedAt: new Date()
        } as IncidentOutboxRecord;
        return { ...this.outbox[idx] };
    }

    async updateMany(args: { where: any; data: any }): Promise<{ count: number }> {
        let count = 0;
        this.outbox = this.outbox.map(o => {
            let match = true;
            if (args.where?.id?.in && !args.where.id.in.includes(o.id)) match = false;
            if (args.where?.status && o.status !== args.where.status) match = false;

            if (match) {
                count++;
                return { ...o, ...args.data, updatedAt: new Date() } as IncidentOutboxRecord;
            }
            return o;
        });
        return { count };
    }

    async count(args: { where: any }): Promise<number> {
        let filtered = [...this.outbox];
        if (args.where) {
            filtered = filtered.filter(o => {
                if (args.where.status !== undefined && o.status !== args.where.status) return false;
                return true;
            });
        }
        return filtered.length;
    }
}

export class MockAlertLogRepository implements IAlertLogRepository {
    public logs: AlertLogRecord[] = [];
    private nextId = 1;

    async create(data: Omit<AlertLogRecord, 'id' | 'timestamp'>): Promise<AlertLogRecord> {
        const record: AlertLogRecord = {
            id: this.nextId++,
            level: data.level,
            title: data.title,
            message: data.message,
            entityId: data.entityId,
            timestamp: new Date()
        };
        this.logs.push(record);
        return { ...record };
    }

    async findMany(args: { where?: any; orderBy?: any; take?: number }): Promise<AlertLogRecord[]> {
        let filtered = [...this.logs];
        if (args.take) {
            filtered = filtered.slice(0, args.take);
        }
        return filtered.map(l => ({ ...l }));
    }
}

export class MockCircuitBreakerRepository implements ICircuitBreakerRepository {
    public breakers = new Map<string, CircuitBreakerStateRecord>();
    private nextId = 1;

    async findUnique(breakerType: string): Promise<CircuitBreakerStateRecord | null> {
        const found = this.breakers.get(breakerType);
        return found ? { ...found } : null;
    }

    async upsert(breakerType: string, status: string, currentVal: number): Promise<CircuitBreakerStateRecord> {
        const existing = this.breakers.get(breakerType);
        const record: CircuitBreakerStateRecord = {
            id: existing ? existing.id : this.nextId++,
            breakerType,
            status,
            currentVal,
            lastUpdated: new Date()
        };
        this.breakers.set(breakerType, record);
        return { ...record };
    }
}

export class MockAgentRepository implements IAgentRepository {
    public agents = new Map<string, AgentRecord>();
    public heartbeats: AgentHeartbeatRecord[] = [];
    public tokens = new Map<string, RegistrationTokenRecord>();
    private nextHeartbeatId = 1;

    async findAgentById(id: string): Promise<AgentRecord | null> {
        const found = this.agents.get(id);
        return found ? { ...found } : null;
    }

    async findAgentByMachineId(machineId: string): Promise<AgentRecord | null> {
        for (const agent of this.agents.values()) {
            if (agent.machineId === machineId) return { ...agent };
        }
        return null;
    }

    async createAgent(data: Omit<AgentRecord, 'createdAt' | 'updatedAt'>): Promise<AgentRecord> {
        const record: AgentRecord = {
            ...data,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        this.agents.set(data.id, record);
        return { ...record };
    }

    async updateAgent(id: string, data: Partial<Omit<AgentRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AgentRecord> {
        const existing = this.agents.get(id);
        if (!existing) throw new Error(`Agent not found: ${id}`);
        const updated = {
            ...existing,
            ...data,
            updatedAt: new Date()
        } as AgentRecord;
        this.agents.set(id, updated);
        return { ...updated };
    }

    async updateManyAgents(where: any, data: any): Promise<{ count: number }> {
        let count = 0;
        for (const [id, agent] of this.agents.entries()) {
            let match = true;
            if (where.id && id !== where.id) match = false;
            if (where.machineId && agent.machineId !== where.machineId) match = false;

            if (match) {
                count++;
                this.agents.set(id, { ...agent, ...data, updatedAt: new Date() });
            }
        }
        return { count };
    }

    async countAgents(where: any): Promise<number> {
        let count = 0;
        for (const agent of this.agents.values()) {
            let match = true;
            if (where.registrationTokenId && agent.registrationTokenId !== where.registrationTokenId) match = false;
            if (match) count++;
        }
        return count;
    }

    async findManyAgents(args?: { orderBy?: any }): Promise<AgentRecord[]> {
        const list = Array.from(this.agents.values()).map(a => ({ ...a }));
        if (args?.orderBy?.lastHeartbeatAt === 'desc') {
            list.sort((a, b) => {
                const ta = a.lastHeartbeatAt ? a.lastHeartbeatAt.getTime() : 0;
                const tb = b.lastHeartbeatAt ? b.lastHeartbeatAt.getTime() : 0;
                return tb - ta;
            });
        }
        return list;
    }

    async deleteManyAgents(where: any): Promise<{ count: number }> {
        let count = 0;
        for (const [id, agent] of this.agents.entries()) {
            let match = true;
            if (where.registrationTokenId && agent.registrationTokenId !== where.registrationTokenId) match = false;
            if (where.status && agent.status !== where.status) match = false;
            if (where.id?.in && !where.id.in.includes(id)) match = false;

            if (match) {
                count++;
                this.agents.delete(id);
            }
        }
        return { count };
    }

    async createAgentHeartbeat(data: Omit<AgentHeartbeatRecord, 'id' | 'timestamp'>): Promise<AgentHeartbeatRecord> {
        const record: AgentHeartbeatRecord = {
            id: `hb-${this.nextHeartbeatId++}`,
            agentId: data.agentId,
            agentVersion: data.agentVersion,
            cpuPct: data.cpuPct,
            memoryPct: data.memoryPct,
            diskPct: data.diskPct,
            status: data.status,
            uptime: data.uptime,
            outboxPending: data.outboxPending,
            databaseHealthy: data.databaseHealthy,
            freqtradeHealthy: data.freqtradeHealthy,
            timestamp: new Date()
        };
        this.heartbeats.push(record);
        return { ...record };
    }

    async deleteManyAgentHeartbeats(where: any): Promise<{ count: number }> {
        const initialCount = this.heartbeats.length;
        if (where.agentId?.in) {
            const ids = where.agentId.in;
            this.heartbeats = this.heartbeats.filter(hb => !ids.includes(hb.agentId));
        }
        return { count: initialCount - this.heartbeats.length };
    }

    async findFirstAgentHeartbeat(agentId: string): Promise<AgentHeartbeatRecord | null> {
        const filtered = this.heartbeats.filter(hb => hb.agentId === agentId);
        if (filtered.length === 0) return null;
        filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return { ...filtered[0] };
    }

    async findRegistrationToken(token: string): Promise<RegistrationTokenRecord | null> {
        const found = this.tokens.get(token);
        return found ? { ...found } : null;
    }

    async createRegistrationToken(data: Omit<RegistrationTokenRecord, 'createdAt'>): Promise<RegistrationTokenRecord> {
        const record: RegistrationTokenRecord = {
            ...data,
            createdAt: new Date()
        };
        this.tokens.set(data.token, record);
        return { ...record };
    }
}
