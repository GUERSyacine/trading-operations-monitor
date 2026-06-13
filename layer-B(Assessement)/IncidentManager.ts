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
                    this.state.symbols[record.symbol] = {
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
            const activeSymbolIncident = this.state.symbols[incident.symbol];
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
            this.state.symbols[incident.symbol] = incident as SymbolIncidentState;
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
        for (const symbol of Object.keys(this.state.symbols)) {
            const incident = this.state.symbols[symbol];
            if (now - incident.since > ttlMs) {
                console.log(`[IncidentManager] TTL Expired. Automatically recovering symbol incident for ${symbol}`);
                await this.resolveIncident(symbol);
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
            if (this.state.symbols[symbol]) {
                delete this.state.symbols[symbol];
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

    async resolveIncidentBySource(source: string, symbol: string | null = null): Promise<void> {
        const now = Date.now();
        if (symbol) {
            const active = this.state.symbols[symbol];
            if (active && active.source === source) {
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
}
