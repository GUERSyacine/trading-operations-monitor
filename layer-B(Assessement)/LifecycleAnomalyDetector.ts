import { IncidentManager } from './IncidentManager';
import { prisma } from '../prisma';

export class LifecycleAnomalyDetector {
    constructor(private incidentManager: IncidentManager) {}

    /**
     * Checks for stuck orders in the database by performing lookback-bounded bulk querying.
     * Implements O(2) DB query pattern to scale efficiently and avoid duplicate notifications.
     */
    async checkAnomalies(stuckTimeoutMs: number = 60000, lookbackMs: number = 3600000): Promise<void> {
        const now = Date.now();
        const lookbackStart = new Date(now - lookbackMs);

        try {
            // 1. Fetch all ORDER_CREATED audits in the lookback window
            const createdAudits = await prisma.decisionAudit.findMany({
                where: {
                    classification: 'ORDER_CREATED',
                    createdAt: {
                        gte: lookbackStart
                    }
                }
            });

            // 2. Fetch all matching resolved audits (filled or cancelled) in the lookback window
            const resolvedAudits = await prisma.decisionAudit.findMany({
                where: {
                    classification: {
                        in: ['ORDER_FILLED', 'ORDER_CANCELLED']
                    },
                    createdAt: {
                        gte: lookbackStart
                    }
                }
            });

            // 3. Build in-memory set of resolved trade IDs
            const resolvedTradeIds = new Set<string>();
            for (const audit of resolvedAudits) {
                const lifecycleEvent = (audit.metadata as any)?.lifecycleEvent;
                const tradeId = lifecycleEvent?.tradeId || (audit.metadata as any)?.rawPayload?.trade_id;
                if (tradeId !== undefined && tradeId !== null) {
                    resolvedTradeIds.add(String(tradeId));
                }
            }

            // 4. Process anomalies in memory
            for (const audit of createdAudits) {
                const lifecycleEvent = (audit.metadata as any)?.lifecycleEvent;
                if (!lifecycleEvent) {
                    continue;
                }

                const tradeId = String(lifecycleEvent.tradeId);
                const symbol = lifecycleEvent.symbol || 'unknown';
                const observedAt = Number(lifecycleEvent.observedAt || audit.createdAt.getTime());

                // Check if the order has been open/unfilled for longer than stuckTimeoutMs
                if (now - observedAt > stuckTimeoutMs) {
                    const sourceKey = `ORDER_PIPELINE:${tradeId}`;
                    if (!resolvedTradeIds.has(tradeId)) {
                        // Order is stuck and has no resolve event. Report Incident.
                        await this.incidentManager.reportIncident({
                            symbol: symbol,
                            level: 'HIGH',
                            source: sourceKey,
                            reason: `Limit order stuck: Trade ID ${tradeId} (${symbol}) has been open/unfilled for > ${stuckTimeoutMs / 1000}s.`,
                            since: observedAt
                        });
                    } else {
                        // Order is resolved. Check if there was an active incident in IncidentManager and resolve it.
                        const compositeKey = `${symbol}:${sourceKey}`;
                        const activeIncidents = this.incidentManager.getState().symbols;
                        if (activeIncidents[compositeKey]) {
                            await this.incidentManager.resolveIncidentBySource(sourceKey, symbol);
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error('[LifecycleAnomalyDetector] Failed to perform anomaly check:', error?.message || error);
        }
    }
}
