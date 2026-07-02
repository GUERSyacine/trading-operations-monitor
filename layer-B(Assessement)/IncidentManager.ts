import { IncidentControllerState, IncidentSeverity, SymbolIncidentState } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/types';
import { prisma } from '../prisma';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';
import { IncidentSeverity as PrismaSeverity, IncidentTransitionType, IncidentActor, IncidentGroupType } from '@prisma/client';
import { MVP_CONFIG } from '../mvpConfig';

/**
 * Incident Manager (Step 12)
 * 
 * Responsibility: Central State Machine for System Health
 * - Ingests events
 * - Applies Playbooks
 * - Updates State (Global/Symbol)
 * - Persists to SQL
 */
export class IncidentManager {
    private state: IncidentControllerState = {
        globalLevel: 'NORMAL',
        symbols: {}
    };
    private globalIncidents = new Map<string, { level: IncidentSeverity; reason: string; since: number }>();

    constructor(private alertingService?: AlertingService) {}

    /**
     * Helper to build a composite incident key to avoid key collisions on symbol-level.
     */
    private buildIncidentKey(symbol: string, source: string): string {
        return `${symbol}:${source}`;
    }

    /**
     * Rehydrate state from database on startup to handle crashes/restarts gracefully.
     */
    async init(): Promise<void> {
        try {
            const activeIncidents = await prisma.incident.findMany({
                where: {
                    resolvedAt: null
                }
            });

            for (const record of activeIncidents) {
                const detectedAtNum = Number(record.detectedAt);
                if (record.symbol) {
                    const key = this.buildIncidentKey(record.symbol, record.source);
                    this.state.symbols[key] = {
                        symbol: record.symbol,
                        level: record.level as IncidentSeverity,
                        source: record.source,
                        reason: record.reason,
                        since: detectedAtNum
                    };
                } else {
                    this.globalIncidents.set(record.source, {
                        level: record.level as IncidentSeverity,
                        reason: record.reason,
                        since: detectedAtNum
                    });
                }
            }
            console.log(`[IncidentManager] Restored ${activeIncidents.length} unresolved incident(s) from Neon DB.`);
        } catch (error: any) {
            console.error('[IncidentManager] Failed to restore active incidents from Neon DB on initialization:', error?.message || error);
        }
    }

    /**
     * Get read-only snapshot of current state.
     * Rebuilds legacy shape dynamically to ensure 100% backward compatibility.
     */
    getState(): IncidentControllerState {
        let maxGlobalLevel: IncidentSeverity | 'NORMAL' = 'NORMAL';
        let globalReason: string | undefined = undefined;

        if (this.globalIncidents.size > 0) {
            const severityOrder: Record<string, number> = { 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'CRITICAL': 4 };
            let maxOrder = 0;
            for (const inc of this.globalIncidents.values()) {
                const order = severityOrder[inc.level] || 0;
                if (order > maxOrder) {
                    maxOrder = order;
                    maxGlobalLevel = inc.level;
                    globalReason = inc.reason;
                }
            }
        }

        return {
            globalLevel: maxGlobalLevel,
            globalReason,
            symbols: { ...this.state.symbols }
        };
    }

    /**
     * Report an incident event (Transition)
     */
    async reportIncident(incident: SymbolIncidentState | { level: IncidentSeverity, source: string, reason: string }): Promise<void> {
        const isSymbolSpecific = 'symbol' in incident && incident.symbol;

        // 1. Deduplication / Cooldown Guard (Noise Prevention based on Active Identity)
        if (isSymbolSpecific) {
            const key = this.buildIncidentKey(incident.symbol, incident.source);
            const activeSymbolIncident = this.state.symbols[key];
            if (activeSymbolIncident) {
                if (activeSymbolIncident.level === incident.level) {
                    // Level is the same, ignore duplicate report (prevent spamming/multiple writes)
                    return;
                }
                // Level is different (escalation/de-escalation), update existing in memory
                activeSymbolIncident.level = incident.level;
                activeSymbolIncident.reason = incident.reason;
            } else {
                // Not active, add it
                this.state.symbols[key] = incident as SymbolIncidentState;
            }
        } else {
            const existing = this.globalIncidents.get(incident.source);
            if (existing) {
                if (existing.level === incident.level) {
                    // Level is the same, ignore duplicate report
                    return;
                }
                // Level is different, update existing in memory
                existing.level = incident.level;
                existing.reason = incident.reason;
            } else {
                // Not active, add it
                const detectedAt = (incident as any).since || Date.now();
                this.globalIncidents.set(incident.source, {
                    level: incident.level,
                    reason: incident.reason,
                    since: detectedAt
                });
            }
        }

        // 2. State & Database persistence execution
        if (isSymbolSpecific) {
            console.warn(`[IncidentManager] Symbol Incident: ${incident.symbol} -> ${incident.level} (${incident.reason})`);
            await this.persistIncident(incident.symbol, incident.level, incident.source, incident.reason, (incident as any).since || Date.now());
        } else {
            console.warn(`[IncidentManager] GLOBAL Incident: ${incident.level} (${incident.reason}) from source ${incident.source}`);
            const existing = this.globalIncidents.get(incident.source);
            const detectedAt = existing ? existing.since : ((incident as any).since || Date.now());
            await this.persistIncident(null, incident.level, incident.source, incident.reason, detectedAt);
        }

        // 3. Dispatch Live Alerts if the service is linked
        if (this.alertingService) {
            await this.alertingService.sendAlert({
                level: incident.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
                title: isSymbolSpecific ? `Symbol ${incident.symbol} Incident` : 'Global System Incident',
                message: incident.reason,
                entityId: isSymbolSpecific ? incident.symbol : 'global'
            });
        }
    }

    /**
     * Automatic Recovery / TTL checker (Resolves old passive incidents)
     */
    async checkAutoResolutions(ttlMs: number = 5 * 60 * 1000): Promise<void> {
        const now = Date.now();

        // Check symbol-specific incidents for expiration
        for (const key of Object.keys(this.state.symbols)) {
            const incident = this.state.symbols[key];
            if (now - incident.since > ttlMs) {
                console.log(`[IncidentManager] TTL Expired. Automatically recovering symbol incident for key ${key}`);
                await this.resolveIncidentByKey(key);
            }
        }

        // Check global incidents for expiration
        for (const [source, incident] of this.globalIncidents.entries()) {
            if (!['HEARTBEAT', 'BROKER_CONNECTION'].includes(source)) {
                if (now - incident.since > ttlMs) {
                    console.log(`[IncidentManager] TTL Expired. Automatically recovering global system incident for source ${source}`);
                    await this.resolveIncidentBySource(source, null);
                }
            }
        }
    }

    private determineActor(symbol: string | null, source: string): IncidentActor {
        if (source === 'SIMULATOR' || (symbol && symbol.startsWith('sim_')) || source.startsWith('sim_')) {
            return 'SIMULATOR';
        }
        if (source === 'RECOVERY') {
            return 'RECOVERY';
        }
        if (source === 'USER') {
            return 'USER';
        }
        return 'WATCHDOG';
    }

    private async logTransition(
        tx: any,
        incidentId: number,
        transitionType: IncidentTransitionType,
        level: PrismaSeverity | null,
        reason: string,
        timestamp: number,
        actor: IncidentActor
    ) {
        await tx.incidentTransition.create({
            data: {
                incidentId,
                transitionType,
                level,
                reason,
                actor,
                occurredAt: BigInt(timestamp)
            }
        });
    }

    private static readonly INFRA_SOURCES = new Set([
        'CPU', 'MEMORY', 'DISK', 'DOCKER_CONTAINER', 
        'DNS', 'NETWORK', 'FREQTRADE_API', 'EXCHANGE',
        'VM', 'DOCKER', 'FREQTRADE'
    ]);

    private isInfrastructureSource(source: string): boolean {
        for (const prefix of IncidentManager.INFRA_SOURCES) {
            if (source.startsWith(prefix)) return true;
        }
        return source === 'INFRASTRUCTURE';
    }

    private getGroupTypeAndCorrelationKey(symbol: string | null, source: string): { groupType: IncidentGroupType; correlationKey: string } {
        if (this.isInfrastructureSource(source)) {
            return {
                groupType: 'INFRASTRUCTURE',
                correlationKey: 'INFRA:GLOBAL'
            };
        } else {
            return {
                groupType: 'OPERATIONS',
                correlationKey: `OPS:${symbol || 'GLOBAL'}`
            };
        }
    }

    private static readonly SEVERITY_ORDER: Record<PrismaSeverity, number> = {
        INFO: 1,
        LOW: 2,
        MEDIUM: 3,
        WARNING: 4,
        HIGH: 5,
        CRITICAL: 6
    };

    private async persistIncident(symbol: string | null, level: IncidentSeverity, source: string, reason: string, detectedAt: number) {
        try {
            const now = Date.now();
            const prismaLevel = level as PrismaSeverity;
            const actor = this.determineActor(symbol, source);
            const { groupType, correlationKey } = this.getGroupTypeAndCorrelationKey(symbol, source);

            await prisma.$transaction(async (tx) => {
                const existing = await tx.incident.findFirst({
                    where: {
                        symbol,
                        source,
                        resolvedAt: null
                    }
                });

                let incidentId: number;

                if (existing) {
                    await tx.incident.update({
                        where: { id: existing.id },
                        data: {
                            level: prismaLevel,
                            reason,
                            detectedAt: BigInt(detectedAt)
                        }
                    });
                    await this.logTransition(tx, existing.id, 'LEVEL_CHANGED', prismaLevel, reason, now, actor);
                    incidentId = existing.id;
                } else {
                    const timeThreshold = BigInt(detectedAt - MVP_CONFIG.INCIDENTS.GROUPING_WINDOW_MS);
                    let group = null;

                    if (groupType === 'OPERATIONS') {
                        if (symbol && symbol !== 'GLOBAL') {
                            // Symbol incident priority:
                            // 1. Exact OPS:<symbol>
                            group = await tx.incidentGroup.findFirst({
                                where: {
                                    correlationKey,
                                    resolvedAt: null,
                                    openedAt: { gte: timeThreshold }
                                },
                                orderBy: { openedAt: 'desc' }
                            });
                            // 2. Fall back to active OPS:GLOBAL group
                            if (!group) {
                                group = await tx.incidentGroup.findFirst({
                                    where: {
                                        correlationKey: 'OPS:GLOBAL',
                                        resolvedAt: null,
                                        openedAt: { gte: timeThreshold }
                                    },
                                    orderBy: { openedAt: 'desc' }
                                });
                            }
                        } else {
                            // Global incident priority:
                            // 1. Most recently opened active OPERATIONS group within window
                            group = await tx.incidentGroup.findFirst({
                                where: {
                                    groupType: 'OPERATIONS',
                                    resolvedAt: null,
                                    openedAt: { gte: timeThreshold }
                                },
                                orderBy: { openedAt: 'desc' }
                            });
                        }
                    } else {
                        // Infrastructure incident: exact match on INFRA:GLOBAL
                        group = await tx.incidentGroup.findFirst({
                            where: {
                                correlationKey,
                                resolvedAt: null,
                                openedAt: { gte: timeThreshold }
                            },
                            orderBy: { openedAt: 'desc' }
                        });
                    }

                    if (!group) {
                        group = await tx.incidentGroup.create({
                            data: {
                                correlationKey,
                                symbol,
                                groupType,
                                openedAt: BigInt(detectedAt),
                                resolvedAt: null,
                                highestSeverity: prismaLevel
                            }
                        });
                    }

                    const newIncident = await tx.incident.create({
                        data: {
                            symbol,
                            level: prismaLevel,
                            source,
                            reason,
                            detectedAt: BigInt(detectedAt),
                            groupId: group.id
                        }
                    });
                    await this.logTransition(tx, newIncident.id, 'DETECTED', prismaLevel, reason, now, actor);
                    incidentId = newIncident.id;
                }

                const incidentRecord = await tx.incident.findUnique({
                    where: { id: incidentId },
                    select: { groupId: true }
                });

                if (incidentRecord && incidentRecord.groupId) {
                    const groupId = incidentRecord.groupId;
                    const activeChildren = await tx.incident.findMany({
                        where: {
                            groupId,
                            resolvedAt: null
                        }
                    });

                    let maxSeverity: PrismaSeverity;
                    if (activeChildren.length > 0) {
                        maxSeverity = activeChildren[0].level;
                        for (const child of activeChildren) {
                            if (IncidentManager.SEVERITY_ORDER[child.level] > IncidentManager.SEVERITY_ORDER[maxSeverity]) {
                                maxSeverity = child.level;
                            }
                        }
                    } else {
                        const allChildren = await tx.incident.findMany({
                            where: { groupId }
                        });
                        maxSeverity = allChildren[0]?.level || prismaLevel;
                        for (const child of allChildren) {
                            if (IncidentManager.SEVERITY_ORDER[child.level] > IncidentManager.SEVERITY_ORDER[maxSeverity]) {
                                maxSeverity = child.level;
                            }
                        }
                    }

                    await tx.incidentGroup.update({
                        where: { id: groupId },
                        data: { highestSeverity: maxSeverity }
                    });
                }
            });
        } catch (error: any) {
            console.error('[IncidentManager] Failed to persist incident in Prisma/Neon:', error?.message || error);
        }
    }

    // Recovery Logic
    // We need methods to clear incidents, via manual intervention or TTL
    private async resolveAndLogIncidents(
        whereClause: any,
        actor: IncidentActor,
        reason: string,
        now: number
    ) {
        try {
            await prisma.$transaction(async (tx) => {
                const active = await tx.incident.findMany({ where: whereClause });
                if (active.length > 0) {
                    const ids = active.map(i => i.id);
                    await tx.incident.updateMany({
                        where: { id: { in: ids } },
                        data: { resolvedAt: BigInt(now) }
                    });
                    for (const incident of active) {
                        await this.logTransition(
                            tx,
                            incident.id,
                            'RESOLVED',
                            null,
                            reason,
                            now,
                            actor
                        );
                    }

                    const groupIds = Array.from(new Set(active.map(i => i.groupId).filter(Boolean))) as number[];
                    for (const groupId of groupIds) {
                        const activeChildren = await tx.incident.findMany({
                            where: {
                                groupId: groupId,
                                resolvedAt: null
                            }
                        });

                        if (activeChildren.length === 0) {
                            const allChildren = await tx.incident.findMany({
                                where: { groupId }
                            });

                            let peakSeverity: PrismaSeverity = 'INFO';
                            if (allChildren.length > 0) {
                                peakSeverity = allChildren[0].level;
                                for (const child of allChildren) {
                                    if (IncidentManager.SEVERITY_ORDER[child.level] > IncidentManager.SEVERITY_ORDER[peakSeverity]) {
                                        peakSeverity = child.level;
                                    }
                                }
                            }

                            await tx.incidentGroup.update({
                                where: { id: groupId },
                                data: {
                                    resolvedAt: BigInt(now),
                                    highestSeverity: peakSeverity
                                }
                            });
                            console.log(`[IncidentManager] Automatically resolved IncidentGroup #${groupId} with peak severity ${peakSeverity} as all child incidents resolved.`);
                        } else {
                            let maxSeverity = activeChildren[0].level;
                            for (const child of activeChildren) {
                                if (IncidentManager.SEVERITY_ORDER[child.level] > IncidentManager.SEVERITY_ORDER[maxSeverity]) {
                                    maxSeverity = child.level;
                                }
                            }

                            await tx.incidentGroup.update({
                                where: { id: groupId },
                                data: {
                                    highestSeverity: maxSeverity
                                }
                            });
                        }
                    }
                }
            });
        } catch (error: any) {
            console.error('[IncidentManager] Failed to resolve and log incidents:', error?.message || error);
        }
    }

    async resolveIncident(symbol: string | null): Promise<void> {
        const now = Date.now();
        if (symbol) {
            let deletedCount = 0;
            for (const key of Object.keys(this.state.symbols)) {
                if (key === symbol || key.startsWith(symbol + ':')) {
                    delete this.state.symbols[key];
                    deletedCount++;
                }
            }
            if (deletedCount > 0) {
                await this.resolveAndLogIncidents(
                    { symbol, resolvedAt: null },
                    'RECOVERY',
                    `Resolved incident for symbol: ${symbol}`,
                    now
                );
            }
        } else {
            this.globalIncidents.clear();
            await this.resolveAndLogIncidents(
                { symbol: null, resolvedAt: null },
                'RECOVERY',
                'Resolved all global incidents',
                now
            );
        }
    }

    async resolveIncidentByKey(key: string): Promise<void> {
        const now = Date.now();
        const active = this.state.symbols[key];
        if (active) {
            delete this.state.symbols[key];
            await this.resolveAndLogIncidents(
                { symbol: active.symbol, source: active.source, resolvedAt: null },
                'RECOVERY',
                `Resolved incident by key: ${key}`,
                now
            );
            console.log(`[IncidentManager] Resolved DB incident for key ${key}`);
        }
    }

    async resolveIncidentBySource(source: string, symbol: string | null = null): Promise<void> {
        const now = Date.now();
        if (symbol) {
            const key = this.buildIncidentKey(symbol, source);
            const active = this.state.symbols[key] || this.state.symbols[symbol]; // Fallback for legacy key
            if (active) {
                delete this.state.symbols[key];
                delete this.state.symbols[symbol];
                const actor = this.determineActor(symbol, source);
                await this.resolveAndLogIncidents(
                    { symbol, source, resolvedAt: null },
                    actor,
                    `Resolved incident for symbol ${symbol} from source ${source}`,
                    now
                );
                console.log(`[IncidentManager] Resolved incident for symbol ${symbol} from source ${source}`);
            }
        } else {
            const active = this.globalIncidents.get(source);
            if (active) {
                this.globalIncidents.delete(source);
                const actor = this.determineActor(null, source);
                await this.resolveAndLogIncidents(
                    { symbol: null, source, resolvedAt: null },
                    actor,
                    `Resolved global incident from source ${source}`,
                    now
                );
                console.log(`[IncidentManager] Resolved global incident from source ${source}`);
            }
        }
    }

    async resolveIncidentsBySourcePrefix(sourcePrefix: string, symbol: string): Promise<void> {
        const now = Date.now();
        const keysToDelete: string[] = [];
        const sourcesToDelete: string[] = [];

        for (const [key, incident] of Object.entries(this.state.symbols)) {
            if (incident.symbol === symbol && incident.source.startsWith(sourcePrefix)) {
                keysToDelete.push(key);
                sourcesToDelete.push(incident.source);
            }
        }

        for (const key of keysToDelete) {
            delete this.state.symbols[key];
        }

        if (sourcesToDelete.length > 0) {
            await this.resolveAndLogIncidents(
                { symbol, source: { in: sourcesToDelete }, resolvedAt: null },
                'RECOVERY',
                `Resolved incidents matching source prefix ${sourcePrefix} for symbol ${symbol}`,
                now
            );
            console.log(`[IncidentManager] Resolved DB incidents matching source prefix ${sourcePrefix} for symbol ${symbol}`);
        }
    }

    getActiveIncidentsCount(): number {
        return this.globalIncidents.size + Object.keys(this.state.symbols).length;
    }

    isHalted(): boolean {
        const lifecycleInc = this.globalIncidents.get('LIFECYCLE_INTEGRITY');
        return !!(lifecycleInc && lifecycleInc.level === 'CRITICAL');
    }

    /**
     * Clear all simulation incidents from both the database and the in-memory state.
     */
    async clearSimulationIncidents(): Promise<void> {
        for (const key of Object.keys(this.state.symbols)) {
            const inc = this.state.symbols[key];
            if (
                (inc.symbol && inc.symbol.startsWith('sim_')) ||
                inc.source.startsWith('ORDER_PIPELINE:sim_') ||
                inc.source.startsWith('OP:sim_') ||
                inc.source.includes('SIMULATOR') ||
                inc.reason.includes('sim_')
            ) {
                delete this.state.symbols[key];
            }
        }
        for (const [source, inc] of this.globalIncidents.entries()) {
            if (
                source.includes('SIMULATOR') ||
                source.startsWith('ORDER_PIPELINE:sim_') ||
                source.startsWith('OP:sim_') ||
                source === 'LIFECYCLE_INTEGRITY' ||
                inc.reason.includes('sim_')
            ) {
                this.globalIncidents.delete(source);
            }
        }
        const now = Date.now();
        const whereClause = {
            resolvedAt: null,
            OR: [
                { source: { startsWith: 'ORDER_PIPELINE:sim_' } },
                { source: { startsWith: 'OP:sim_' } },
                { source: { contains: 'SIMULATOR' } },
                { source: 'LIFECYCLE_INTEGRITY' },
                { symbol: { startsWith: 'sim_' } },
                { reason: { contains: 'sim_' } }
            ]
        };
        await this.resolveAndLogIncidents(whereClause, 'SIMULATOR', 'Resolved by simulator reset', now);
        console.log('[IncidentManager] Resolved all active simulation incidents in Neon DB.');
    }
}

