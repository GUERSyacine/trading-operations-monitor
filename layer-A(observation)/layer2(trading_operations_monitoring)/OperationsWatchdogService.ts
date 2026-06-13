import { prisma } from '../../prisma';
import { AlertingService } from '../../layer-D(notification)/alerting/AlertingService';
import { HealthCheckResult } from '../types';
import { MVP_CONFIG } from '../../mvpConfig';
import { IncidentManager } from '../../layer-B(Assessement)/IncidentManager';

export interface TradeMetrics {
    pnl: number;
    executedAt: Date;
    fillRate: number;
    latencyMs: number;
}

export class OperationsWatchdogService {
    constructor(
        protected alertingService: AlertingService,
        protected incidentManager: IncidentManager,
        protected allowedInactivityMs: number = MVP_CONFIG.OPERATIONS.HEARTBEAT_TIMEOUT_MS
    ) {}

    protected heartbeatFailures = 0;
    protected brokerFailures = 0;
    protected tradeFrequencyFailures = new Map<string, number>();

    protected enrichMetadata(source: string, customMeta: Record<string, any> = {}): Record<string, any> {
        return {
            ...customMeta,
            watchdogVersion: '1.0.0',
            serviceName: 'OperationsWatchdogService',
            environment: process.env.NODE_ENV || 'production',
            checkId: `${source.toLowerCase()}_check`
        };
    }

    async checkHeartbeat(maxSilenceMs: number = this.allowedInactivityMs): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        let isSuccess = false;
        let latestAudit: any = null;
        let elapsedMs = 0;
        let errorMsg: string | null = null;

        try {
            latestAudit = await prisma.decisionAudit.findFirst({
                where: {
                    classification: {
                        in: ['HEARTBEAT', 'ORDER', 'SIGNAL', 'MARKET_DATA']
                    }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (!latestAudit) {
                isSuccess = false;
                errorMsg = 'No decision audit entries found in database yet.';
            } else {
                const now = Date.now();
                elapsedMs = now - latestAudit.createdAt.getTime();
                if (elapsedMs > maxSilenceMs) {
                    isSuccess = false;
                    const elapsedMin = (elapsedMs / 60000).toFixed(1);
                    errorMsg = `No decision audits logged for ${elapsedMin} minutes.`;
                } else {
                    isSuccess = true;
                }
            }
        } catch (error: any) {
            isSuccess = false;
            errorMsg = error?.message || String(error);
        }

        try {
            if (!isSuccess) {
                this.heartbeatFailures++;
            } else {
                this.heartbeatFailures = 0;
            }

            const maxFailures = 3;
            const isAlarm = this.heartbeatFailures >= maxFailures;
            const severity = isAlarm ? 'CRITICAL' : (this.heartbeatFailures > 0 ? 'WARNING' : undefined);

            const baseMetadata = {
                latestAuditId: latestAudit?.id,
                latestAuditClass: latestAudit?.classification,
                latestAuditCreatedAt: latestAudit?.createdAt,
                elapsedMs,
                consecutiveFailures: this.heartbeatFailures,
                maxFailures
            };
            const metadata = this.enrichMetadata('HEARTBEAT', baseMetadata);

            if (!isSuccess) {
                if (isAlarm) {
                    console.error(`🚨 [OperationsWatchdog] HEARTBEAT LOST CRITICAL: ${errorMsg}`);
                    await this.incidentManager.reportIncident({
                        level: 'CRITICAL',
                        source: 'HEARTBEAT',
                        reason: `No decisions or updates logged by the trading engine in the last ${(elapsedMs / 60000).toFixed(1)} minutes`
                    });
                } else {
                    console.warn(`⚠️ [OperationsWatchdog] HEARTBEAT SILENCE WARNING: ${errorMsg}`);
                    await this.alertingService.sendAlert({
                        level: 'WARNING',
                        title: 'Trading Bot Heartbeat Silence Warning',
                        message: `WARNING: No decisions or updates logged by the trading engine in the last ${(elapsedMs / 60000).toFixed(1)} minutes (consecutive checks failed: ${this.heartbeatFailures}).`,
                        dedupKey: 'heartbeat_lost_warning'
                    });
                }
                return {
                    source: 'HEARTBEAT',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity,
                    message: isAlarm ? (errorMsg || 'Heartbeat lost') : 'Heartbeat warning',
                    metadata
                };
            }

            // Stateful recovery: resolve the incident if it was active
            await this.incidentManager.resolveIncidentBySource('HEARTBEAT');

            console.log(`[OperationsWatchdog] Bot is ALIVE. Last update was ${(elapsedMs / 1000).toFixed(0)}s ago.`);
            return {
                source: 'HEARTBEAT',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata
            };
        } catch (innerError: any) {
            console.error('[OperationsWatchdog] Failed checkHeartbeat audit logging:', innerError?.message || innerError);
            return {
                source: 'HEARTBEAT',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: innerError?.message || String(innerError)
            };
        }
    }

    /**
     * 2. checkTradeFrequency()
     * Question: Is the bot alive but doing nothing?
     */
    async checkTradeFrequency(strategyId: string, maxSilenceMs: number = MVP_CONFIG.OPERATIONS.TRADE_SILENCE_MS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        let isSuccess = false;
        let recentTradeCount = 0;
        let errorMsg: string | null = null;

        try {
            const cutoff = new Date(Date.now() - maxSilenceMs);
            const trades = await prisma.decisionAudit.findMany({
                where: {
                    classification: 'ORDER',
                    createdAt: { gte: cutoff },
                    metadata: {
                        path: ['strategyId'],
                        equals: strategyId
                    }
                },
                orderBy: { createdAt: 'desc' }
            });
            recentTradeCount = trades.length;
            isSuccess = trades.length > 0;
            if (!isSuccess) {
                const hours = (maxSilenceMs / (60 * 60 * 1000)).toFixed(0);
                errorMsg = `Strategy ${strategyId} has 0 trades in the last ${hours} hours.`;
            }
        } catch (error: any) {
            isSuccess = false;
            errorMsg = error?.message || String(error);
        }

        try {
            let failures = this.tradeFrequencyFailures.get(strategyId) || 0;
            if (!isSuccess) {
                failures++;
                this.tradeFrequencyFailures.set(strategyId, failures);
            } else {
                this.tradeFrequencyFailures.set(strategyId, 0);
                failures = 0;
            }

            const maxFailures = 3;
            const isAlarm = failures >= maxFailures;
            const severity = failures > 0 ? 'WARNING' : undefined;

            const baseMetadata = {
                strategyId,
                maxSilenceMs,
                recentTradeCount,
                consecutiveFailures: failures,
                maxFailures
            };
            const metadata = this.enrichMetadata('TRADE_FREQUENCY', baseMetadata);

            if (!isSuccess) {
                if (isAlarm) {
                    const hours = (maxSilenceMs / (60 * 60 * 1000)).toFixed(0);
                    console.warn(`⚠️ [OperationsWatchdog] TRADE FREQUENCY COLLAPSE: ${errorMsg}`);
                    await this.alertingService.sendAlert({
                        level: 'WARNING',
                        title: 'Strategy Silence Detected',
                        message: `WARNING: Strategy ${strategyId} trade count collapsed to 0 over the last ${hours} hours (consecutive checks failed: ${failures}). Bot is active but idle!`,
                        entityId: strategyId,
                        dedupKey: `${strategyId}:silence_warning`
                    });
                }
                return {
                    source: 'TRADE_FREQUENCY',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: errorMsg || 'No trades',
                    metadata
                };
            }

            return {
                source: 'TRADE_FREQUENCY',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata
            };
        } catch (innerError: any) {
            console.error('[OperationsWatchdog] Failed checkTradeFrequency audit logging:', innerError?.message || innerError);
            return {
                source: 'TRADE_FREQUENCY',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'WARNING',
                message: innerError?.message || String(innerError)
            };
        }
    }

    async checkBrokerConnection(maxSilenceMs: number = MVP_CONFIG.OPERATIONS.BROKER_TIMEOUT_MS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        let isSuccess = false;
        let latestPing: any = null;
        let errorMsg: string | null = null;
        let customMeta: Record<string, any> = {};

        try {
            const cutoff = new Date(Date.now() - maxSilenceMs);
            latestPing = await prisma.decisionAudit.findFirst({
                where: {
                    classification: { in: ['BROKER_PING', 'BROKER_CONNECTION', 'HEARTBEAT'] },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            if (!latestPing) {
                isSuccess = false;
                errorMsg = `No broker ping or connection heartbeat in the last ${(maxSilenceMs / 60000).toFixed(1)} minutes.`;
            } else {
                const metadata = latestPing.metadata as any;
                if (metadata) {
                    customMeta = metadata;
                    if (metadata.connected === false || metadata.status === 'disconnected' || metadata.error) {
                        isSuccess = false;
                        errorMsg = metadata.error || 'Connection offline';
                    } else {
                        isSuccess = true;
                    }
                } else {
                    isSuccess = true;
                }
            }
        } catch (error: any) {
            isSuccess = false;
            errorMsg = error?.message || String(error);
        }

        try {
            if (!isSuccess) {
                this.brokerFailures++;
            } else {
                this.brokerFailures = 0;
            }

            const maxFailures = 3;
            const isAlarm = this.brokerFailures >= maxFailures;
            const severity = isAlarm ? 'CRITICAL' : (this.brokerFailures > 0 ? 'WARNING' : undefined);

            const baseMetadata = {
                latestPingId: latestPing?.id,
                latestPingClass: latestPing?.classification,
                latestPingCreatedAt: latestPing?.createdAt,
                consecutiveFailures: this.brokerFailures,
                maxFailures,
                ...customMeta
            };
            const metadata = this.enrichMetadata('BROKER_CONNECTION', baseMetadata);

            if (!isSuccess) {
                if (isAlarm) {
                    console.error(`🚨 [OperationsWatchdog] BROKER CONNECTION STALE/DOWN CRITICAL: ${errorMsg}`);
                    await this.incidentManager.reportIncident({
                        level: 'CRITICAL',
                        source: 'BROKER_CONNECTION',
                        reason: `Broker connection is reported down or stale. Detail: ${errorMsg || 'Connection offline'}`
                    });
                } else {
                    console.warn(`⚠️ [OperationsWatchdog] BROKER CONNECTION WARNING: ${errorMsg}`);
                    await this.alertingService.sendAlert({
                        level: 'WARNING',
                        title: 'Broker Connection Warning',
                        message: `WARNING: Broker connection is degraded or silent (consecutive checks failed: ${this.brokerFailures}). Detail: ${errorMsg || 'Connection offline'}`,
                        dedupKey: 'broker_connection_stale_warning'
                    });
                }
                return {
                    source: 'BROKER_CONNECTION',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity,
                    message: errorMsg || 'Connection issue',
                    metadata
                };
            }

            // Stateful recovery: resolve the incident if it was active
            await this.incidentManager.resolveIncidentBySource('BROKER_CONNECTION');

            console.log('[OperationsWatchdog] Broker connection is healthy.');
            return {
                source: 'BROKER_CONNECTION',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata
            };
        } catch (innerError: any) {
            console.error('[OperationsWatchdog] Failed checkBrokerConnection audit logging:', innerError?.message || innerError);
            return {
                source: 'BROKER_CONNECTION',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: innerError?.message || String(innerError)
            };
        }
    }

    /**
     * 4. checkMarketDataFeed()
     * Question: Are market prices still arriving?
     */
    async checkMarketDataFeed(symbol?: string, maxStalenessMs: number = MVP_CONFIG.OPERATIONS.MARKET_DATA_STALE_MS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        try {
            const cutoff = new Date(Date.now() - maxStalenessMs);
            const whereClause: any = {
                classification: { in: ['MARKET_DATA', 'TICK'] },
                createdAt: { gte: cutoff }
            };

            if (symbol) {
                whereClause.metadata = {
                    path: ['symbol'],
                    equals: symbol
                };
            }

            const ticks = await prisma.decisionAudit.findMany({
                where: whereClause,
                orderBy: { createdAt: 'desc' },
                take: 100
            });

            const newestTick = ticks[0];
            const latestTickAgeMs = newestTick ? Date.now() - newestTick.createdAt.getTime() : null;

            const metadata = {
                symbol,
                maxStalenessMs,
                tickCount: ticks.length,
                latestTickAgeMs,
                latestTickTimestamp: newestTick ? newestTick.createdAt : null
            };

            if (ticks.length === 0) {
                const target = symbol ? `for symbol ${symbol}` : 'globally';
                const msg = `No updates ${target} in the last ${(maxStalenessMs / 1000).toFixed(0)} seconds.`;
                console.warn(`⚠️ [OperationsWatchdog] MARKET DATA FEED STALE: ${msg}`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Market Data Feed Stale',
                    message: `WARNING: Market data updates are stale ${target}! Last update was more than ${(maxStalenessMs / 1000).toFixed(0)}s ago.`,
                    entityId: symbol || 'global',
                    dedupKey: `market_data_stale:${symbol || 'global'}`
                });
                return {
                    source: 'MARKET_DATA',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: msg,
                    metadata: this.enrichMetadata('MARKET_DATA', metadata)
                };
            }

            return {
                source: 'MARKET_DATA',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('MARKET_DATA', metadata)
            };
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check market data feed:', error?.message || error);
            return {
                source: 'MARKET_DATA',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'WARNING',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('MARKET_DATA')
            };
        }
    }

    /**
     * 5. checkOrderPipeline()
     * Question: Signal generated -> Order created -> Order sent -> Order acknowledged -> Order filled?
     */
    async checkOrderPipeline(windowMs: number = MVP_CONFIG.OPERATIONS.ORDER_PIPELINE_WINDOW_MS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
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

            const metadata = {
                windowMs,
                signals,
                created,
                sent,
                filled,
                failed
            };

            if ((signals > 0 || created > 0) && sent === 0 && failed === 0) {
                const msg = `Signals=${signals}, Created=${created}, Sent=${sent}. Orders are created but not being dispatched!`;
                console.error(`🚨 [OperationsWatchdog] ORDER PIPELINE BLOCKED: ${msg}`);
                
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Order Pipeline Blocked',
                    message: `CRITICAL PIPELINE FAILURE: Signals generated (${signals}) or orders created (${created}) but 0 orders were sent to the broker in the last ${(windowMs / 60000).toFixed(0)} minutes. Check connection or execution logs!`,
                    dedupKey: 'order_pipeline_blocked_critical'
                });
                return {
                    source: 'ORDER_PIPELINE',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: msg,
                    metadata: this.enrichMetadata('ORDER_PIPELINE', metadata)
                };
            }

            return {
                source: 'ORDER_PIPELINE',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('ORDER_PIPELINE', metadata)
            };
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check order pipeline:', error?.message || error);
            return {
                source: 'ORDER_PIPELINE',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('ORDER_PIPELINE')
            };
        }
    }

    /**
     * 6. checkExchangeAck()
     * Question: Exchange responding?
     */
    async checkExchangeAck(windowMs: number = MVP_CONFIG.OPERATIONS.EXCHANGE_ACK_WINDOW_MS, maxConsecutiveTimeouts: number = MVP_CONFIG.OPERATIONS.EXCHANGE_ACK_MAX_TIMEOUTS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
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

            const metadata = {
                windowMs,
                maxConsecutiveTimeouts,
                consecutiveTimeouts,
                totalEventsAnalyzed: audits.length
            };

            if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
                const msg = `Detected ${consecutiveTimeouts} consecutive order timeout/acknowledgement failures.`;
                console.error(`🚨 [OperationsWatchdog] EXCHANGE ACK CRITICAL: ${msg}`);
                
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Exchange Ack Failure',
                    message: `CRITICAL: Exchange is not responding! Detected ${consecutiveTimeouts} consecutive order acknowledgment timeouts. System execution is compromised!`,
                    dedupKey: 'exchange_ack_failure_critical'
                });
                return {
                    source: 'EXCHANGE_ACK',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: msg,
                    metadata: this.enrichMetadata('EXCHANGE_ACK', metadata)
                };
            }

            return {
                source: 'EXCHANGE_ACK',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('EXCHANGE_ACK', metadata)
            };
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check exchange ack:', error?.message || error);
            return {
                source: 'EXCHANGE_ACK',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('EXCHANGE_ACK')
            };
        }
    }

    /**
     * 7. checkLatency()
     * Question: Is execution infrastructure slow?
     */
    async checkLatency(strategyId: string, maxLatencyMs: number = MVP_CONFIG.OPERATIONS.LATENCY_THRESHOLD_MS, rollingCount: number = MVP_CONFIG.OPERATIONS.LATENCY_ROLLING_COUNT): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        try {
            const audits = await prisma.decisionAudit.findMany({
                where: {
                    classification: 'ORDER',
                    createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }, // 3 days lookback
                    metadata: {
                        path: ['strategyId'],
                        equals: strategyId
                    }
                },
                orderBy: { createdAt: 'desc' },
                take: rollingCount
            });

            const metadata = {
                strategyId,
                maxLatencyMs,
                rollingCount,
                auditsFound: audits.length,
                averageLatencyMs: 0
            };

            if (audits.length < rollingCount) {
                // Not enough trades to compute representative latency average
                return {
                    source: 'LATENCY',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('LATENCY', metadata)
                };
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

            if (validCount === 0) {
                return {
                    source: 'LATENCY',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('LATENCY', metadata)
                };
            }

            const averageLatency = totalLatency / validCount;
            metadata.averageLatencyMs = averageLatency;

            if (averageLatency > maxLatencyMs) {
                const msg = `Strategy ${strategyId} average order latency is ${averageLatency.toFixed(0)}ms`;
                console.warn(`⚠️ [OperationsWatchdog] LATENCY SPIKE: ${msg}`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Order Latency Spike',
                    message: `WARNING: Strategy ${strategyId} average order latency spiked to ${averageLatency.toFixed(0)}ms (threshold: ${maxLatencyMs}ms). Execution paths are slow!`,
                    entityId: strategyId,
                    dedupKey: `${strategyId}:latency_spike_warning`
                });
                return {
                    source: 'LATENCY',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: msg,
                    metadata: this.enrichMetadata('LATENCY', metadata)
                };
            }

            return {
                source: 'LATENCY',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('LATENCY', metadata)
            };
        } catch (error: any) {
            console.error('[OperationsWatchdog] Failed to check latency:', error?.message || error);
            return {
                source: 'LATENCY',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'WARNING',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('LATENCY')
            };
        }
    }

    /**
     * runAllOperationsChecks()
     * Orchestrator to run all operations monitoring checks concurrently.
     */
    async runAllOperationsChecks(params: { strategyId?: string; symbol?: string } = {}): Promise<HealthCheckResult[]> {
        const strategyId = params.strategyId || 'DEFAULT_STRATEGY';
        return await Promise.all([
            this.checkHeartbeat(),
            this.checkTradeFrequency(strategyId),
            this.checkBrokerConnection(),
            this.checkMarketDataFeed(params.symbol),
            this.checkOrderPipeline(),
            this.checkExchangeAck(),
            this.checkLatency(strategyId)
        ]);
    }
}
