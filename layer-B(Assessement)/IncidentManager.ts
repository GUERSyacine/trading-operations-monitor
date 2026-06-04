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
    private globalSince?: number;

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
                    this.state.globalLevel = record.level as IncidentSeverity | 'NORMAL';
                    this.state.globalReason = record.reason;
                    this.globalSince = detectedAtNum;
                }
            }
            console.log(`[IncidentManager] Restored ${activeIncidents.length} unresolved incident(s) from Neon DB.`);
        } catch (error: any) {
            console.error('[IncidentManager] Failed to restore active incidents from Neon DB on initialization:', error?.message || error);
        }
    }

    /**
     * Get read-only snapshot of current state
     */
    getState(): IncidentControllerState {
        return { ...this.state }; // Shallow copy sufficient for now
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
            if (this.state.globalLevel === incident.level && this.state.globalReason === incident.reason) {
                // Duplicate global level state, ignore duplicate insertion
                return;
            }
        }

        // 2. State & Database persistence execution
        if (isSymbolSpecific) {
            console.warn(`[IncidentManager] Symbol Incident: ${incident.symbol} -> ${incident.level} (${incident.reason})`);
            this.state.symbols[incident.symbol] = incident as SymbolIncidentState;
            await this.persistIncident(incident.symbol, incident.level, incident.source, incident.reason, (incident as any).since || Date.now());
        } else {
            console.warn(`[IncidentManager] GLOBAL Incident: ${incident.level} (${incident.reason})`);
            this.state.globalLevel = incident.level;
            this.state.globalReason = incident.reason;
            this.globalSince = Date.now();
            await this.persistIncident(null, incident.level, incident.source, incident.reason, this.globalSince);
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

        // Check global incident for expiration
        if (this.state.globalLevel !== 'NORMAL' && this.globalSince) {
            if (now - this.globalSince > ttlMs) {
                console.log('[IncidentManager] TTL Expired. Automatically recovering global system incident');
                await this.resolveIncident(null);
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
            this.state.globalLevel = 'NORMAL';
            delete this.state.globalReason;
            this.globalSince = undefined;
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
                console.error('[IncidentManager] Failed to resolve DB global incident:', error?.message || error);
            }
        }
    }
}
