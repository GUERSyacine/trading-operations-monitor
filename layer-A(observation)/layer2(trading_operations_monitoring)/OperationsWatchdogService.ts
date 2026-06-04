import { prisma } from '../../prisma';
import { AlertingService } from '../../layer-D(notification)/alerting/AlertingService';

export interface TradeMetrics {
    pnl: number;
    executedAt: Date;
    fillRate: number;
    latencyMs: number;
}

export class OperationsWatchdogService {
    constructor(
        protected alertingService: AlertingService,
        protected allowedInactivityMs: number = 5 * 60 * 1000 // Default 5 minutes
    ) {}

    /**
     * 1. checkHeartbeat()
     * Question: Is the bot still alive?
     */
    async checkHeartbeat(maxSilenceMs: number = this.allowedInactivityMs): Promise<boolean> {
        try {
            const latestAudit = await prisma.decisionAudit.findFirst({
                orderBy: { createdAt: 'desc' }
            });

            if (!latestAudit) {
                console.warn('[OperationsWatchdog] WARNING: No decision audit entries found in database yet.');
                return false;
            }

            const now = Date.now();
            const elapsedMs = now - latestAudit.createdAt.getTime();

            if (elapsedMs > maxSilenceMs) {
                const elapsedMin = (elapsedMs / 60000).toFixed(1);
                console.error(`🚨 [OperationsWatchdog] HEARTBEAT LOST! No decision audits logged for ${elapsedMin} minutes.`);
                
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Trading Bot Heartbeat LOST',
                    message: `CRITICAL SAFETY BREACH: No decisions or updates logged by the trading engine in the last ${elapsedMin} minutes (Allowed limit: ${(maxSilenceMs / 60000).toFixed(1)}m). Bot may have crashed!`,
                    dedupKey: 'heartbeat_lost_critical'
                });
                return false;
            }

            console.log(`[OperationsWatchdog] Bot is ALIVE. Last update was ${(elapsedMs / 1000).toFixed(0)}s ago.`);
            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check liveness:', error?.message || error);
            return false;
        }
    }

    /**
     * 2. checkTradeFrequency()
     * Question: Is the bot alive but doing nothing?
     */
    async checkTradeFrequency(strategyId: string, maxSilenceMs: number = 24 * 60 * 60 * 1000): Promise<boolean> {
        try {
            const cutoff = new Date(Date.now() - maxSilenceMs);
            const trades = await prisma.decisionAudit.findMany({
                where: {
                    classification: 'ORDER',
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (trades.length === 0) {
                const hours = (maxSilenceMs / (60 * 60 * 1000)).toFixed(0);
                console.warn(`⚠️ [OperationsWatchdog] TRADE FREQUENCY COLLAPSE: Strategy ${strategyId} has 0 trades in the last ${hours} hours.`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Strategy Silence Detected',
                    message: `WARNING: Strategy ${strategyId} trade count collapsed to 0 over the last ${hours} hours. Bot is active but idle!`,
                    entityId: strategyId,
                    dedupKey: `${strategyId}:silence_warning`
                });
                return false;
            }
            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check trade frequency:', error?.message || error);
            return false;
        }
    }

    /**
     * 3. checkBrokerConnection()
     * Question: Can the strategy still talk to the broker?
     */
    async checkBrokerConnection(maxSilenceMs: number = 5 * 60 * 1000): Promise<boolean> {
        try {
            const cutoff = new Date(Date.now() - maxSilenceMs);
            const latestPing = await prisma.decisionAudit.findFirst({
                where: {
                    classification: { in: ['BROKER_PING', 'BROKER_CONNECTION', 'HEARTBEAT'] },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (!latestPing) {
                console.error(`🚨 [OperationsWatchdog] BROKER CONNECTION STALE: No broker ping or connection heartbeat in the last ${(maxSilenceMs / 60000).toFixed(1)} minutes.`);
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Broker Connection Stale',
                    message: `CRITICAL: No successful broker connection confirmation or ping in the last ${(maxSilenceMs / 60000).toFixed(1)} minutes. Broker might be unreachable!`,
                    dedupKey: 'broker_connection_stale_critical'
                });
                return false;
            }

            const metadata = latestPing.metadata as any;
            if (metadata && (metadata.connected === false || metadata.status === 'disconnected' || metadata.error)) {
                const errorDetail = metadata.error || 'Connection offline';
                console.error(`🚨 [OperationsWatchdog] BROKER DISCONNECTED: ${errorDetail}`);
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Broker Connection Disconnected',
                    message: `CRITICAL: Broker connection is reported down! Detail: ${errorDetail}`,
                    dedupKey: 'broker_disconnected_critical'
                });
                return false;
            }

            console.log('[OperationsWatchdog] Broker connection is healthy.');
            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check broker connection:', error?.message || error);
            return false;
        }
    }

    /**
     * 4. checkMarketDataFeed()
     * Question: Are market prices still arriving?
     */
    async checkMarketDataFeed(symbol?: string, maxStalenessMs: number = 60 * 1000): Promise<boolean> {
        try {
            const cutoff = new Date(Date.now() - maxStalenessMs);
            
            // Query recent ticks from DB and filter in-memory for robustness
            const ticks = await prisma.decisionAudit.findMany({
                where: {
                    classification: { in: ['MARKET_DATA', 'TICK'] },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' },
                take: 100
            });

            const filtered = symbol
                ? ticks.filter((t: any) => (t.metadata as any)?.symbol === symbol)
                : ticks;

            if (filtered.length === 0) {
                const target = symbol ? `for symbol ${symbol}` : 'globally';
                console.warn(`⚠️ [OperationsWatchdog] MARKET DATA FEED STALE: No updates ${target} in the last ${(maxStalenessMs / 1000).toFixed(0)} seconds.`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Market Data Feed Stale',
                    message: `WARNING: Market data updates are stale ${target}! Last update was more than ${(maxStalenessMs / 1000).toFixed(0)}s ago.`,
                    entityId: symbol || 'global',
                    dedupKey: `market_data_stale:${symbol || 'global'}`
                });
                return false;
            }

            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check market data feed:', error?.message || error);
            return false;
        }
    }

    /**
     * 5. checkOrderPipeline()
     * Question: Signal generated -> Order created -> Order sent -> Order acknowledged -> Order filled?
     */
    async checkOrderPipeline(windowMs: number = 60 * 60 * 1000): Promise<boolean> {
        try {
            const cutoff = new Date(Date.now() - windowMs);
            const audits = await prisma.decisionAudit.findMany({
                where: {
                    createdAt: { gte: cutoff }
                }
            });

            let signals = 0;
            let created = 0;
            let sent = 0;
            let filled = 0;
            let failed = 0;

            for (const audit of audits) {
                const classification = audit.classification.toUpperCase();
                if (classification === 'SIGNAL') signals++;
                else if (classification === 'ORDER_CREATED') created++;
                else if (classification === 'ORDER_SENT') sent++;
                else if (classification === 'ORDER_FILLED' || classification === 'ORDER') {
                    filled++;
                    sent++; // Implicitly sent if filled or logged under default ORDER
                } else if (classification === 'ORDER_FAILED') failed++;
            }

            if ((signals > 0 || created > 0) && sent === 0 && failed === 0) {
                console.error(`🚨 [OperationsWatchdog] ORDER PIPELINE BLOCKED: Signals=${signals}, Created=${created}, Sent=${sent}. Orders are created but not being dispatched!`);
                
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Order Pipeline Blocked',
                    message: `CRITICAL PIPELINE FAILURE: Signals generated (${signals}) or orders created (${created}) but 0 orders were sent to the broker in the last ${(windowMs / 60000).toFixed(0)} minutes. Check connection or execution logs!`,
                    dedupKey: 'order_pipeline_blocked_critical'
                });
                return false;
            }

            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check order pipeline:', error?.message || error);
            return false;
        }
    }

    /**
     * 6. checkExchangeAck()
     * Question: Exchange responding?
     */
    async checkExchangeAck(windowMs: number = 15 * 60 * 1000, maxConsecutiveTimeouts: number = 3): Promise<boolean> {
        try {
            const cutoff = new Date(Date.now() - windowMs);
            const audits = await prisma.decisionAudit.findMany({
                where: {
                    classification: { in: ['ORDER_ACK_TIMEOUT', 'EXCHANGE_TIMEOUT', 'ORDER_SENT', 'ORDER_FILLED', 'ORDER'] },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            let consecutiveTimeouts = 0;
            for (const audit of audits) {
                if (audit.classification === 'ORDER_ACK_TIMEOUT' || audit.classification === 'EXCHANGE_TIMEOUT') {
                    consecutiveTimeouts++;
                } else {
                    // Resets on successful transmission/acknowledgement
                    break;
                }
            }

            if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
                console.error(`🚨 [OperationsWatchdog] EXCHANGE ACK CRITICAL: Detected ${consecutiveTimeouts} consecutive order timeout/acknowledgement failures.`);
                
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Exchange Ack Failure',
                    message: `CRITICAL: Exchange is not responding! Detected ${consecutiveTimeouts} consecutive order acknowledgment timeouts. System execution is compromised!`,
                    dedupKey: 'exchange_ack_failure_critical'
                });
                return false;
            }

            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check exchange ack:', error?.message || error);
            return false;
        }
    }

    /**
     * 7. checkLatency()
     * Question: Is execution infrastructure slow?
     */
    async checkLatency(strategyId: string, maxLatencyMs: number = 1000, rollingCount: number = 5): Promise<boolean> {
        try {
            const audits = await prisma.decisionAudit.findMany({
                where: {
                    classification: 'ORDER',
                    createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } // 3 days lookback
                },
                orderBy: { createdAt: 'desc' },
                take: rollingCount
            });

            if (audits.length < rollingCount) {
                // Not enough trades to compute representative latency average
                return true;
            }

            let totalLatency = 0;
            let validCount = 0;
            for (const audit of audits) {
                const meta = audit.metadata as any;
                const latency = meta?.outcome?.latencyMs ?? meta?.latencyMs;
                if (typeof latency === 'number') {
                    totalLatency += latency;
                    validCount++;
                }
            }

            if (validCount === 0) return true;

            const averageLatency = totalLatency / validCount;
            if (averageLatency > maxLatencyMs) {
                console.warn(`⚠️ [OperationsWatchdog] LATENCY SPIKE: Strategy ${strategyId} average order latency is ${averageLatency.toFixed(0)}ms`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Order Latency Spike',
                    message: `WARNING: Strategy ${strategyId} average order latency spiked to ${averageLatency.toFixed(0)}ms (threshold: ${maxLatencyMs}ms). Execution paths are slow!`,
                    entityId: strategyId,
                    dedupKey: `${strategyId}:latency_spike_warning`
                });
                return false;
            }

            return true;
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check latency:', error?.message || error);
            return false;
        }
    }
}
