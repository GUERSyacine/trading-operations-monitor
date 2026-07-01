import { IncidentControllerState, IncidentSeverity, SymbolIncidentState } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/types';
import { prisma } from '../prisma';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';

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

        // 1. Deduplication / Cooldown Guard (Noise Prevention)
        if (isSymbolSpecific) {
            const key = this.buildIncidentKey(incident.symbol, incident.source);
            const activeSymbolIncident = this.state.symbols[key];
            if (activeSymbolIncident && activeSymbolIncident.level === incident.level && activeSymbolIncident.reason === incident.reason) {
                // Duplicate incident, skip persistence & duplicate alert log rows
                return;
            }
        } else {
            const existing = this.globalIncidents.get(incident.source);
            if (existing && existing.level === incident.level && existing.reason === incident.reason) {
                // Duplicate global incident for this source, ignore duplicate insertion
                return;
            }
        }

        // 2. State & Database persistence execution
        if (isSymbolSpecific) {
            console.warn(`[IncidentManager] Symbol Incident: ${incident.symbol} -> ${incident.level} (${incident.reason})`);
            const key = this.buildIncidentKey(incident.symbol, incident.source);
            this.state.symbols[key] = incident as SymbolIncidentState;
            await this.persistIncident(incident.symbol, incident.level, incident.source, incident.reason, (incident as any).since || Date.now());
        } else {
            console.warn(`[IncidentManager] GLOBAL Incident: ${incident.level} (${incident.reason}) from source ${incident.source}`);
            const detectedAt = (incident as any).since || Date.now();
            this.globalIncidents.set(incident.source, {
                level: incident.level,
                reason: incident.reason,
                since: detectedAt
            });
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

    private async persistIncident(symbol: string | null, level: IncidentSeverity, source: string, reason: string, detectedAt: number) {
        try {
            await prisma.incident.create({
                data: {
                    symbol,
                    level,
                    source,
                    reason,
                    detectedAt: BigInt(detectedAt)
                }
            });
        } catch (error: any) {
            console.error('[IncidentManager] Failed to persist incident in Prisma/Neon:', error?.message || error);
        }
    }

    // Recovery Logic
    // We need methods to clear incidents, via manual intervention or TTL
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
                // Update DB resolution
                try {
                    await prisma.incident.updateMany({
                        where: {
                            symbol,
                            resolvedAt: null
                        },
                        data: {
                            resolvedAt: BigInt(now)
                        }
                    });
                } catch (error: any) {
                    console.error(`[IncidentManager] Failed to resolve DB incident for ${symbol}:`, error?.message || error);
                }
            }
        } else {
            this.globalIncidents.clear();
            try {
                await prisma.incident.updateMany({
                    where: {
                        symbol: null,
                        resolvedAt: null
                    },
                    data: {
                        resolvedAt: BigInt(now)
                    }
                });
            } catch (error: any) {
                console.error('[IncidentManager] Failed to resolve DB global incidents:', error?.message || error);
            }
        }
    }

    async resolveIncidentByKey(key: string): Promise<void> {
        const now = Date.now();
        const active = this.state.symbols[key];
        if (active) {
            delete this.state.symbols[key];
            try {
                await prisma.incident.updateMany({
                    where: {
                        symbol: active.symbol,
                        source: active.source,
                        resolvedAt: null
                    },
                    data: {
                        resolvedAt: BigInt(now)
                    }
                });
                console.log(`[IncidentManager] Resolved DB incident for key ${key}`);
            } catch (error: any) {
                console.error(`[IncidentManager] Failed to resolve DB incident for key ${key}:`, error?.message || error);
            }
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
                try {
                    await prisma.incident.updateMany({
                        where: {
                            symbol,
                            source,
                            resolvedAt: null
                        },
                        data: {
                            resolvedAt: BigInt(now)
                        }
                    });
                    console.log(`[IncidentManager] Resolved incident for symbol ${symbol} from source ${source}`);
                } catch (error: any) {
                    console.error(`[IncidentManager] Failed to resolve DB incident for ${symbol} / ${source}:`, error?.message || error);
                }
            }
        } else {
            const active = this.globalIncidents.get(source);
            if (active) {
                this.globalIncidents.delete(source);
                try {
                    await prisma.incident.updateMany({
                        where: {
                            symbol: null,
                            source,
                            resolvedAt: null
                        },
                        data: {
                            resolvedAt: BigInt(now)
                        }
                    });
                    console.log(`[IncidentManager] Resolved global incident from source ${source}`);
                } catch (error: any) {
                    console.error(`[IncidentManager] Failed to resolve DB global incident for source ${source}:`, error?.message || error);
                }
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
            try {
                await prisma.incident.updateMany({
                    where: {
                        symbol,
                        source: {
                            in: sourcesToDelete
                        },
                        resolvedAt: null
                    },
                    data: {
                        resolvedAt: BigInt(now)
                    }
                });
                console.log(`[IncidentManager] Resolved DB incidents matching source prefix ${sourcePrefix} for symbol ${symbol}`);
            } catch (error: any) {
                console.error(`[IncidentManager] Failed to resolve DB incidents by source prefix ${sourcePrefix} / ${symbol}:`, error?.message || error);
            }
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
        // 1. Clear in-memory symbol incidents starting with 'sim_' or source involving 'SIM'
        for (const key of Object.keys(this.state.symbols)) {
            const inc = this.state.symbols[key];
            if (
                (inc.symbol && inc.symbol.startsWith('sim_')) ||
                inc.source.startsWith('ORDER_PIPELINE:sim_') ||
                inc.source.includes('SIMULATOR') ||
                inc.reason.includes('sim_')
            ) {
                delete this.state.symbols[key];
            }
        }
        // 2. Clear in-memory global incidents starting with or involving simulation
        for (const [source, inc] of this.globalIncidents.entries()) {
            if (source.includes('SIMULATOR') || source.startsWith('ORDER_PIPELINE:sim_') || inc.reason.includes('sim_')) {
                this.globalIncidents.delete(source);
            }
        }
        // 3. Delete from DB where source/symbol matches simulation markers
        try {
            await prisma.incident.deleteMany({
                where: {
                    OR: [
                        { source: { startsWith: 'ORDER_PIPELINE:sim_' } },
                        { source: { contains: 'SIMULATOR' } },
                        { symbol: { startsWith: 'sim_' } },
                        { reason: { contains: 'sim_' } }
                    ]
                }
            });
            console.log('[IncidentManager] Cleared all simulation incidents from database and memory.');
        } catch (error: any) {
            console.error('[IncidentManager] Failed to delete simulation incidents from Prisma:', error?.message || error);
        }
    }
}

