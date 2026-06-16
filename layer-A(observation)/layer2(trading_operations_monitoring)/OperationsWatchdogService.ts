import { prisma } from '../../prisma';
import { AlertingService } from '../../layer-D(notification)/alerting/AlertingService';
import { HealthCheckResult } from '../types';
import { MVP_CONFIG } from '../../mvpConfig';
import { IncidentManager } from '../../layer-B(Assessement)/IncidentManager';
import { FreqtradeAdapter } from '../../adapters/freqtrade/FreqtradeAdapter';

export interface TradeMetrics {
    pnl: number;
    executedAt: Date;
    fillRate: number;
    latencyMs: number;
}

export enum RiskViolationType {
    LOW_CONFIDENCE = 'LOW_CONFIDENCE',
    BACKWARD_TRANSITION = 'BACKWARD_TRANSITION',
    TERMINAL_MUTATION = 'TERMINAL_MUTATION',
    INVALID_TRANSITION = 'INVALID_TRANSITION'
}

export interface ProtectionAction {
    execute(): Promise<void>;
}

export class AlertOnlyAction implements ProtectionAction {
    constructor(
        protected incidentManager: IncidentManager,
        protected reason: string,
        protected violationType: RiskViolationType
    ) {}

    async execute(): Promise<void> {
        await this.incidentManager.reportIncident({
            level: 'CRITICAL',
            source: 'LIFECYCLE_INTEGRITY',
            reason: `CRITICAL: Execution Risk Protection Triggered (Type: ${this.violationType}, Reason: ${this.reason})`
        });
    }
}

export class StopBuyAction extends AlertOnlyAction {
    constructor(
        incidentManager: IncidentManager,
        reason: string,
        violationType: RiskViolationType,
        private adapter?: FreqtradeAdapter
    ) {
        super(incidentManager, reason, violationType);
    }

    override async execute(): Promise<void> {
        await super.execute();
        if (this.adapter) {
            await this.adapter.executeActiveHalt('STOP_BUY');
        }
    }
}

export class StopAction extends AlertOnlyAction {
    constructor(
        incidentManager: IncidentManager,
        reason: string,
        violationType: RiskViolationType,
        private adapter?: FreqtradeAdapter
    ) {
        super(incidentManager, reason, violationType);
    }

    override async execute(): Promise<void> {
        await super.execute();
        if (this.adapter) {
            await this.adapter.executeActiveHalt('STOP');
        }
    }
}

export class OperationsWatchdogService {
    constructor(
        protected alertingService: AlertingService,
        protected incidentManager: IncidentManager,
        protected freqtradeAdapter?: FreqtradeAdapter,
        protected allowedInactivityMs: number = MVP_CONFIG.OPERATIONS.HEARTBEAT_TIMEOUT_MS
    ) {}

    protected heartbeatFailures = 0;
    protected brokerFailures = 0;
    protected tradeFrequencyFailures = new Map<string, number>();

    protected consecutiveConfidenceBreaches = 0;
    protected consecutiveStructuralViolations = 0;
    protected lastActiveViolationType?: RiskViolationType;

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
    private parseTimeframeToMs(timeframe: string): number | null {
        const match = timeframe.match(/^(\d+)([mhd])$/);
        if (!match) return null;
        const value = parseInt(match[1], 10);
        const unit = match[2];
        
        const allowed = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        if (!allowed.includes(timeframe)) {
            return null;
        }

        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: return null;
        }
    }

    private async handleMalformedMarketData(msg: string, checkStart: number): Promise<HealthCheckResult> {
        console.warn(`⚠️ [OperationsWatchdog] MALFORMED MARKET DATA: ${msg}`);
        await this.alertingService.sendAlert({
            level: 'WARNING',
            title: 'Market Data Telemetry Failure',
            message: `WARNING: ${msg}`,
            entityId: 'global',
            dedupKey: 'market_data_telemetry_fail:global'
        });
        return {
            source: 'MARKET_DATA',
            healthy: false,
            checkedAt: new Date(),
            checkDurationMs: Date.now() - checkStart,
            severity: 'WARNING',
            message: msg,
            metadata: this.enrichMetadata('MARKET_DATA')
        };
    }

    /**
     * 4. checkMarketDataFeed()
     * Question: Are market prices still arriving and advancing?
     */
    async checkMarketDataFeed(maxStalenessMs: number = MVP_CONFIG.OPERATIONS.MARKET_DATA_STALE_MS): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        try {
            // Find the newest MARKET_DATA event globally
            const newestWhere: any = { classification: 'MARKET_DATA' };

            const newestTicks = await prisma.decisionAudit.findMany({
                where: newestWhere,
                orderBy: { createdAt: 'desc' },
                take: 1
            });

            if (newestTicks.length === 0) {
                const msg = 'No market data updates globally.';
                console.warn(`⚠️ [OperationsWatchdog] MARKET DATA TELEMETRY STALE: ${msg}`);
                
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Market Data Telemetry Stale',
                    message: 'WARNING: Market data telemetry is stale globally! No events found.',
                    entityId: 'global',
                    dedupKey: 'market_data_telemetry_stale:global'
                });
                return {
                    source: 'MARKET_DATA',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: msg,
                    metadata: this.enrichMetadata('MARKET_DATA', {
                        maxStalenessMs,
                        tickCount: 0,
                        telemetryAgeMs: null,
                        latestTickAgeMs: null,
                        latestTickTimestamp: null
                    })
                };
            }

            const newestTick = newestTicks[0];
            
            // 1. Strict schema validation
            if (!newestTick.metadata || typeof newestTick.metadata !== 'object') {
                const msg = 'Malformed MARKET_DATA event: metadata object missing.';
                return this.handleMalformedMarketData(msg, checkStart);
            }

            const meta = newestTick.metadata as any;
            const lastMarketTimestamp = meta.lastMarketTimestamp;
            const timeframe = meta.timeframe;
            const sourceSystem = meta.sourceSystem;
            const heartbeatIntervalMs = meta.heartbeatIntervalMs;

            if (lastMarketTimestamp === undefined || lastMarketTimestamp === null || !timeframe) {
                const msg = 'Malformed MARKET_DATA event: missing lastMarketTimestamp or timeframe.';
                return this.handleMalformedMarketData(msg, checkStart);
            }

            const timeframeDurationMs = this.parseTimeframeToMs(timeframe);
            if (timeframeDurationMs === null) {
                const msg = `Invalid MARKET_DATA timeframe: ${timeframe}`;
                return this.handleMalformedMarketData(msg, checkStart);
            }

            const newestMarketTs = typeof lastMarketTimestamp === 'number'
                ? lastMarketTimestamp
                : new Date(lastMarketTimestamp).getTime();

            if (isNaN(newestMarketTs)) {
                const msg = 'Malformed MARKET_DATA event: lastMarketTimestamp could not be parsed.';
                return this.handleMalformedMarketData(msg, checkStart);
            }

            // Fetch the last 20 MARKET_DATA events matching the same sourceSystem (ordered by createdAt DESC)
            const historyWhere: any = {
                classification: 'MARKET_DATA',
                AND: [
                    {
                        metadata: {
                            path: ['sourceSystem'],
                            equals: sourceSystem
                        }
                    }
                ]
            };

            const history = await prisma.decisionAudit.findMany({
                where: historyWhere,
                orderBy: { createdAt: 'desc' },
                take: 20
            });

            const telemetryAgeMs = Date.now() - newestTick.createdAt.getTime();
            const latestTickAgeMs = Date.now() - newestMarketTs;

            // Dynamically derive stale threshold if heartbeatIntervalMs is present in metadata
            const resolvedStalenessThresholdMs = typeof heartbeatIntervalMs === 'number' && heartbeatIntervalMs > 0
                ? heartbeatIntervalMs * 3
                : maxStalenessMs;

            // 2. Telemetry Freshness check
            if (telemetryAgeMs > resolvedStalenessThresholdMs) {
                const msg = `Market data telemetry is stale. Age: ${(telemetryAgeMs / 1000).toFixed(0)} seconds (threshold: ${(resolvedStalenessThresholdMs / 1000).toFixed(0)}s).`;
                console.warn(`⚠️ [OperationsWatchdog] MARKET DATA TELEMETRY STALE: ${msg}`);

                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Market Data Telemetry Stale',
                    message: `WARNING: Market data telemetry is stale globally! Last event received was ${(telemetryAgeMs / 1000).toFixed(0)}s ago.`,
                    entityId: 'global',
                    dedupKey: 'market_data_telemetry_stale:global'
                });
                return {
                    source: 'MARKET_DATA',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: msg,
                    metadata: this.enrichMetadata('MARKET_DATA', {
                        maxStalenessMs,
                        resolvedStalenessThresholdMs,
                        tickCount: history.length,
                        telemetryAgeMs,
                        latestTickAgeMs,
                        latestTickTimestamp: new Date(newestMarketTs),
                        sourceSystem,
                        timeframe
                    })
                };
            }

            // 3. Market Progression check (only run if we have at least 2 events for this sourceSystem)
            if (history.length >= 2) {
                let oldestSameTsEvent = newestTick;
                for (let i = 1; i < history.length; i++) {
                    const currentEvent = history[i];
                    if (!currentEvent.metadata || typeof currentEvent.metadata !== 'object') {
                        break;
                    }
                    const curMeta = currentEvent.metadata as any;
                    const curTs = typeof curMeta.lastMarketTimestamp === 'number'
                        ? curMeta.lastMarketTimestamp
                        : new Date(curMeta.lastMarketTimestamp).getTime();

                    if (curTs === newestMarketTs) {
                        oldestSameTsEvent = currentEvent;
                    } else {
                        break;
                    }
                }

                const parsed = Number(process.env.OPS_MARKET_DATA_PROGRESSION_FACTOR);
                const progressionFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : 2.0;
                const progressionLimitMs = timeframeDurationMs * progressionFactor;
                const timeSinceFirstSeenMs = newestTick.createdAt.getTime() - oldestSameTsEvent.createdAt.getTime();

                if (timeSinceFirstSeenMs > progressionLimitMs) {
                    const msg = `Market data timestamp not advancing globally (stuck for ${(timeSinceFirstSeenMs / 1000).toFixed(0)}s, threshold: ${(progressionLimitMs / 1000).toFixed(0)}s).`;
                    console.warn(`⚠️ [OperationsWatchdog] MARKET DATA FEED STUCK: ${msg}`);

                    await this.alertingService.sendAlert({
                        level: 'WARNING',
                        title: 'Market Data Feed Stuck',
                        message: `WARNING: Market data timestamp is stuck and not advancing globally! Stuck for ${(timeSinceFirstSeenMs / 1000).toFixed(0)}s.`,
                        entityId: 'global',
                        dedupKey: 'market_data_stuck:global'
                    });
                    return {
                        source: 'MARKET_DATA',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'WARNING',
                        message: msg,
                        metadata: this.enrichMetadata('MARKET_DATA', {
                            maxStalenessMs,
                            resolvedStalenessThresholdMs,
                            tickCount: history.length,
                            telemetryAgeMs,
                            latestTickAgeMs,
                            latestTickTimestamp: new Date(newestMarketTs),
                            sourceSystem,
                            timeframe,
                            stuckDurationMs: timeSinceFirstSeenMs
                        })
                    };
                }
            }

            return {
                source: 'MARKET_DATA',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('MARKET_DATA', {
                    maxStalenessMs,
                    resolvedStalenessThresholdMs,
                    tickCount: history.length,
                    telemetryAgeMs,
                    latestTickAgeMs,
                    latestTickTimestamp: new Date(newestMarketTs),
                    sourceSystem,
                    timeframe
                })
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
            let submitted = 0;
            let ack = 0;
            let open = 0;
            let partiallyFilled = 0;
            let filled = 0;
            let cancelled = 0;
            let rejected = 0;
            let failed = 0;
            let completedOrders = 0;

            let signalsWithTradeId = 0;
            let signalsWithoutTradeId = 0;

            for (const audit of audits) {
                const classification = audit.classification.toUpperCase();
                if (classification === 'SIGNAL') {
                    signals++;
                    const meta = audit.metadata as Record<string, any> || {};
                    if (meta.tradeId !== undefined && meta.tradeId !== null && meta.tradeId !== '') {
                        signalsWithTradeId++;
                    } else {
                        signalsWithoutTradeId++;
                    }
                }
                else if (classification === 'ORDER_CREATED') created++;
                else if (classification === 'ORDER_SUBMITTED' || classification === 'ORDER_SENT') submitted++;
                else if (classification === 'ORDER_ACKNOWLEDGED' || classification === 'ORDER_ACK') ack++;
                else if (classification === 'ORDER_OPEN') open++;
                else if (classification === 'ORDER_PARTIALLY_FILLED') partiallyFilled++;
                else if (classification === 'ORDER_FILLED') filled++;
                else if (classification === 'ORDER_CANCELLED') cancelled++;
                else if (classification === 'EXCHANGE_REJECTED') rejected++;
                else if (classification === 'ORDER_FAILED') failed++;
                else if (classification === 'ORDER') completedOrders++;
            }

            const intermediateEventsObserved = created + submitted + ack + open + partiallyFilled + cancelled + rejected + failed;

            // Stage 5: Upgrade Pipeline Visibility Model
            let hasCorrelatableIntermediate = false;
            for (const audit of audits) {
                const classification = audit.classification.toUpperCase();
                const isIntermediate = [
                    'ORDER_CREATED',
                    'ORDER_SUBMITTED',
                    'ORDER_SENT',
                    'ORDER_ACKNOWLEDGED',
                    'ORDER_ACK',
                    'ORDER_OPEN',
                    'ORDER_PARTIALLY_FILLED',
                    'ORDER_CANCELLED',
                    'EXCHANGE_REJECTED',
                    'ORDER_FAILED'
                ].includes(classification);

                if (isIntermediate) {
                    const meta = audit.metadata as Record<string, any> || {};
                    const hasTradeId = meta.tradeId !== undefined && meta.tradeId !== null && meta.tradeId !== '';
                    const hasOrderId = meta.orderId !== undefined && meta.orderId !== null && meta.orderId !== '';
                    if (hasTradeId || hasOrderId) {
                        hasCorrelatableIntermediate = true;
                        break;
                    }
                }
            }

            let pipelineVisibility: 'LIMITED' | 'PARTIAL' | 'FULL' = 'LIMITED';
            let visibilityReason = 'Adapter only emits ORDER completion telemetry.';

            if (signals > 0 && hasCorrelatableIntermediate) {
                pipelineVisibility = 'FULL';
                visibilityReason = 'Ingesting SIGNAL and correlatable intermediate order lifecycle events.';
            } else if (signals > 0 || filled > 0 || created > 0 || failed > 0) {
                pipelineVisibility = 'PARTIAL';
                visibilityReason = 'Ingesting SIGNAL and ORDER_FILLED events via Freqtrade webhooks.';
            }

            // Two-Stage Correlation Model & Reconstruction Engine
            const uniqueTradeIds = new Set<string>();
            for (const audit of audits) {
                const meta = audit.metadata as Record<string, any> || {};
                const tId = meta.tradeId;
                if (tId !== undefined && tId !== null && tId !== '') {
                    uniqueTradeIds.add(String(tId));
                }
            }

            const orderToTradeMap = new Map<string, string>();
            let correlationConflicts = 0;

            for (const audit of audits) {
                const meta = audit.metadata as Record<string, any> || {};
                const tId = meta.tradeId;
                const oId = meta.orderId;

                if (tId !== undefined && tId !== null && tId !== '' && oId !== undefined && oId !== null && oId !== '') {
                    const tradeIdStr = String(tId);
                    const orderIdStr = String(oId);

                    if (orderToTradeMap.has(orderIdStr)) {
                        const existingTradeId = orderToTradeMap.get(orderIdStr);
                        if (existingTradeId !== tradeIdStr) {
                            correlationConflicts++;
                            console.warn(`[OperationsWatchdog] Correlation conflict: orderId ${orderIdStr} maps to both tradeId ${existingTradeId} and ${tradeIdStr}`);
                        }
                    } else {
                        orderToTradeMap.set(orderIdStr, tradeIdStr);
                    }
                }
            }

            const tradeToOrdersMap = new Map<string, Set<string>>();
            for (const [orderId, tradeId] of orderToTradeMap.entries()) {
                if (!tradeToOrdersMap.has(tradeId)) {
                    tradeToOrdersMap.set(tradeId, new Set<string>());
                }
                tradeToOrdersMap.get(tradeId)!.add(orderId);
            }

            let tradesWithLifecycleTelemetry = 0;
            const totalTradesAnalyzed = uniqueTradeIds.size;

            let validTrades = 0;
            let invalidTrades = 0;
            let incompleteTrades = 0;
            let terminalTrades = 0;
            let tradesWithSkippedStages = 0;
            let duplicateEventsObserved = 0;

            // Map event classifications to state values for chronological sequence validation
            const getEventStateValue = (classification: string): number => {
                const upper = classification.toUpperCase();
                if (upper === 'SIGNAL') return 0;
                if (upper === 'ORDER_CREATED') return 1;
                if (upper === 'ORDER_SUBMITTED' || upper === 'ORDER_SENT') return 2;
                if (upper === 'ORDER_ACKNOWLEDGED' || upper === 'ORDER_ACK') return 3;
                if (upper === 'ORDER_OPEN') return 4;
                if (upper === 'ORDER_PARTIALLY_FILLED') return 5;
                if (['ORDER_FILLED', 'ORDER_CANCELLED', 'EXCHANGE_REJECTED', 'ORDER_FAILED', 'ORDER'].includes(upper)) return 6;
                return -1;
            };

            for (const tradeId of uniqueTradeIds) {
                const associatedOrders = tradeToOrdersMap.get(tradeId) || new Set<string>();
                
                const tradeAudits = audits.filter(audit => {
                    const meta = audit.metadata as Record<string, any> || {};
                    const tId = meta.tradeId !== undefined && meta.tradeId !== null ? String(meta.tradeId) : undefined;
                    const oId = meta.orderId !== undefined && meta.orderId !== null ? String(meta.orderId) : undefined;
                    
                    return tId === tradeId || (oId !== undefined && associatedOrders.has(oId));
                });

                tradeAudits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

                const hasLifecycle = tradeAudits.some(audit => {
                    const classification = audit.classification.toUpperCase();
                    return [
                        'ORDER_CREATED',
                        'ORDER_SUBMITTED',
                        'ORDER_SENT',
                        'ORDER_ACKNOWLEDGED',
                        'ORDER_ACK',
                        'ORDER_OPEN',
                        'ORDER_PARTIALLY_FILLED',
                        'ORDER_CANCELLED',
                        'EXCHANGE_REJECTED',
                        'ORDER_FAILED'
                    ].includes(classification);
                });

                if (hasLifecycle) {
                    tradesWithLifecycleTelemetry++;
                }

                // Run state machine transition validator on trade timeline
                let isInvalid = false;
                let hasSkipped = false;
                let lastStateValue = -1;
                let lastClassification: string | undefined = undefined;
                let violationType: RiskViolationType | undefined = undefined;
                const terminalStatesSeen = new Set<string>();

                for (let i = 0; i < tradeAudits.length; i++) {
                    const audit = tradeAudits[i];
                    const classification = audit.classification.toUpperCase();
                    const stateVal = getEventStateValue(classification);

                    if (stateVal === -1) {
                        continue; // Skip unrecognized classifications
                    }

                    // Duplicate event detection (includes sequential PARTIALLY_FILLED events)
                    if (lastClassification && classification === lastClassification) {
                        duplicateEventsObserved++;
                        continue;
                    }

                    if (lastStateValue !== -1) {
                        // 1. Invalid Transition: from terminal (6) back to active (< 6)
                        if (lastStateValue === 6 && stateVal < 6) {
                            isInvalid = true;
                            violationType = RiskViolationType.INVALID_TRANSITION;
                        }

                        // 2. Backward Transition: from later state to earlier state
                        if (stateVal < lastStateValue) {
                            isInvalid = true;
                            violationType = RiskViolationType.BACKWARD_TRANSITION;
                        }

                        // 3. Skipped Stage: jump in progression steps
                        if (stateVal > lastStateValue + 1) {
                            hasSkipped = true;
                        }
                    } else {
                        // First event in timeline: if it starts after SIGNAL (0), it has skipped some initial stages (e.g. missing SIGNAL)
                        if (stateVal > 0) {
                            hasSkipped = true;
                        }
                    }

                    // 4. Terminal Mutation Guard
                    if (stateVal === 6) {
                        terminalStatesSeen.add(classification);
                        if (terminalStatesSeen.size > 1) {
                            isInvalid = true;
                            violationType = RiskViolationType.TERMINAL_MUTATION;
                        }
                    }

                    lastStateValue = stateVal;
                    lastClassification = classification;
                }

                if (lastStateValue !== -1) {
                    if (isInvalid) {
                        invalidTrades++;
                        if (violationType) {
                            this.lastActiveViolationType = violationType;
                        }
                    } else if (lastStateValue < 6) {
                        incompleteTrades++;
                    } else {
                        validTrades++;
                    }

                    if (lastStateValue === 6) {
                        terminalTrades++;
                    }

                    if (hasSkipped) {
                        tradesWithSkippedStages++;
                    }
                }
            }

            const validOrInvalidCount = validTrades + invalidTrades;
            const lifecycleConfidenceScore = validOrInvalidCount > 0 ? Number((validTrades / validOrInvalidCount).toFixed(4)) : 1.0;

            let eligibleSignalsCount = 0;
            let filledEligibleSignalsCount = 0;
            let unfilledSignalCount = 0;
            let uncorrelatableSignalCount = 0;
            let maxUnfilledAgeMs = 0;
            let totalUnfilledAgeMs = 0;
            
            const failureMsgs: string[] = [];
            const failedTradeIds: string[] = [];
            let pipelineHealthy = true;

            const totalSignalsSliding = signalsWithTradeId + signalsWithoutTradeId;
            const correlationQualityRatio = totalSignalsSliding > 0 ? Number((signalsWithTradeId / totalSignalsSliding).toFixed(4)) : 1.0;

            // Confidence is strictly derived from telemetry quality, not trading outcome
            let confidenceScore: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
            if (pipelineVisibility === 'PARTIAL' || pipelineVisibility === 'FULL') {
                if (correlationQualityRatio >= 0.95) {
                    confidenceScore = 'HIGH';
                } else if (correlationQualityRatio >= 0.70) {
                    confidenceScore = 'MEDIUM';
                } else {
                    confidenceScore = 'LOW';
                }
            } else {
                confidenceScore = 'LOW';
            }

            // Schema drift alert: warning when signals lack tradeId in webhook mode
            if (pipelineVisibility === 'PARTIAL' && signalsWithoutTradeId > 0) {
                console.error(`🚨 [OperationsWatchdog] OBSERVABILITY SCHEMA DRIFT DETECTED: ${signalsWithoutTradeId} signal(s) lack tradeId.`);
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Observability Schema Drift',
                    message: `WARNING: Ingested webhook signals lack tradeId (${signalsWithoutTradeId} signal(s) in the last ${windowMs / 60000} minutes). Webhook payload normalization or Freqtrade integration schema may be broken.`,
                    dedupKey: 'observability_schema_drift'
                });
            }

            // Stage 6: Pipeline Validation Logic for PARTIAL visibility
            if (pipelineVisibility === 'PARTIAL') {
                const timeoutThreshold = new Date(Date.now() - MVP_CONFIG.OPERATIONS.SIGNAL_FILL_TIMEOUT_MS);
                const maxLookback = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)); // 7 days safety cutoff

                const lookbackSignals = await prisma.decisionAudit.findMany({
                    where: {
                        classification: {
                            equals: 'SIGNAL',
                            mode: 'insensitive'
                        },
                        createdAt: {
                            gte: maxLookback
                        }
                    },
                    orderBy: {
                        createdAt: 'desc'
                    }
                });

                // Extract unique, valid trade IDs from lookback signals
                const lookbackTradeIds = Array.from(new Set(
                    lookbackSignals
                        .map(s => (s.metadata as Record<string, any> || {}).tradeId)
                        .filter((id): id is string | number => id !== undefined && id !== null && id !== '')
                ));

                let matchingFills: any[] = [];
                if (lookbackTradeIds.length > 0) {
                    // Query all matching fill events in a single batch
                    matchingFills = await prisma.decisionAudit.findMany({
                        where: {
                            classification: {
                                equals: 'ORDER_FILLED',
                                mode: 'insensitive'
                            },
                            OR: lookbackTradeIds.map(id => ({
                                metadata: {
                                    path: ['tradeId'],
                                    equals: String(id)
                                }
                            }))
                        }
                    });
                }

                for (const signal of lookbackSignals) {
                    const meta = signal.metadata as Record<string, any> || {};
                    const tradeId = meta.tradeId;

                    const isEligible = signal.createdAt <= timeoutThreshold;
                    if (isEligible) {
                        eligibleSignalsCount++;
                    }

                    if (tradeId === undefined || tradeId === null || tradeId === '') {
                        if (isEligible) {
                            uncorrelatableSignalCount++;
                        }
                        continue;
                    }

                    // Check in-memory list for a matching fill created at or after the signal
                    const hasMatchingFill = matchingFills.some(f => {
                        const fMeta = f.metadata as Record<string, any> || {};
                        return String(fMeta.tradeId) === String(tradeId) && f.createdAt >= signal.createdAt;
                    });

                    if (isEligible) {
                        if (hasMatchingFill) {
                            filledEligibleSignalsCount++;
                        } else {
                            unfilledSignalCount++;
                            const ageMs = Date.now() - signal.createdAt.getTime();
                            if (ageMs > maxUnfilledAgeMs) {
                                maxUnfilledAgeMs = ageMs;
                            }
                            totalUnfilledAgeMs += ageMs;

                            pipelineHealthy = false;
                            const msg = `Signal tradeId=${tradeId} symbol=${meta.symbol || 'unknown'} has been unfilled for more than ${MVP_CONFIG.OPERATIONS.SIGNAL_FILL_TIMEOUT_MS / 60000} minutes.`;
                            console.error(`🚨 [OperationsWatchdog] SIGNAL FILL TIMEOUT: ${msg}`);
                            failureMsgs.push(msg);
                            failedTradeIds.push(String(tradeId));
                            
                            await this.alertingService.sendAlert({
                                level: 'WARNING',
                                title: 'Signal Fill Timeout',
                                message: `WARNING: Signal generated at ${signal.createdAt.toISOString()} for symbol ${meta.symbol || 'unknown'} (Trade ID: ${tradeId}) has not been filled after ${(MVP_CONFIG.OPERATIONS.SIGNAL_FILL_TIMEOUT_MS / 60000).toFixed(0)} minutes.`,
                                dedupKey: `signal_fill_timeout_${tradeId}`
                            });
                        }
                    }
                }
            }

            const correlatableEligibleSignals = eligibleSignalsCount - uncorrelatableSignalCount;
            const coverageRatio = correlatableEligibleSignals > 0 ? Number((filledEligibleSignalsCount / correlatableEligibleSignals).toFixed(4)) : 1.0;
            const oldestUnfilledMinutes = maxUnfilledAgeMs > 0 ? Number((maxUnfilledAgeMs / 60000).toFixed(1)) : 0.0;
            const averageUnfilledMinutes = unfilledSignalCount > 0 ? Number(((totalUnfilledAgeMs / unfilledSignalCount) / 60000).toFixed(1)) : 0.0;

            // --- 24-HOUR TREND & HEALTHY-BASELINE ANALYTICS ---
            const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const historicalAudits = await prisma.decisionAudit.findMany({
                where: {
                    classification: {
                        equals: 'OBSERVABILITY_METRICS',
                        mode: 'insensitive'
                    },
                    createdAt: {
                        gte: cutoff24h
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            const pastCoverageRatios: number[] = [];
            const pastCorrelationRatios: number[] = [];
            let lowConfidenceCount = 0;
            let mediumConfidenceCount = 0;
            let highConfidenceCount = 0;

            for (const h of historicalAudits) {
                const meta = h.metadata as Record<string, any> || {};
                const obs = meta.observability || {};
                const cov = obs.coverage || {};
                const corr = obs.correlation || {};
                const conf = obs.confidence || {};

                if (typeof cov.coverageRatio === 'number') {
                    pastCoverageRatios.push(cov.coverageRatio);
                }
                if (typeof corr.correlationQualityRatio === 'number') {
                    pastCorrelationRatios.push(corr.correlationQualityRatio);
                }

                const score = (conf.score || '').toUpperCase();
                if (score === 'LOW') {
                    lowConfidenceCount++;
                } else if (score === 'MEDIUM') {
                    mediumConfidenceCount++;
                } else if (score === 'HIGH') {
                    highConfidenceCount++;
                }
            }

            // Include current confidence check in the 24h counters
            if (confidenceScore === 'LOW') {
                lowConfidenceCount++;
            } else if (confidenceScore === 'MEDIUM') {
                mediumConfidenceCount++;
            } else if (confidenceScore === 'HIGH') {
                highConfidenceCount++;
            }

            // Helpers for P95 and Average
            const getP95Value = (values: number[], defaultValue: number): number => {
                if (values.length === 0) return defaultValue;
                const sorted = [...values].sort((a, b) => a - b);
                const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
                return sorted[idx];
            };

            const getAverageValue = (values: number[], defaultValue: number): number => {
                if (values.length === 0) return defaultValue;
                const sum = values.reduce((a, b) => a + b, 0);
                return Number((sum / values.length).toFixed(4));
            };

            const historical24hAverageCoverage = getAverageValue(pastCoverageRatios, 1.0);
            const historical24hAverageCorrelation = getAverageValue(pastCorrelationRatios, 1.0);
            const historical24hP95Coverage = getP95Value(pastCoverageRatios, 1.0);
            const historical24hP95Correlation = getP95Value(pastCorrelationRatios, 1.0);

            // Compute change relative to P95 baseline
            const coverageRatioChange = Number((coverageRatio - historical24hP95Coverage).toFixed(4));
            const correlationQualityRatioChange = Number((correlationQualityRatio - historical24hP95Correlation).toFixed(4));

            // Sustained Degradation Check (requires drop for 3 consecutive checks)
            let coverageDegradedSustained = false;
            let correlationDegradedSustained = false;

            let hasMinHistory = false;
            if (historicalAudits.length >= 5) {
                const oldestAudit = historicalAudits[historicalAudits.length - 1];
                const timeDiffMs = Date.now() - oldestAudit.createdAt.getTime();
                if (timeDiffMs >= 60 * 60 * 1000) {
                    hasMinHistory = true;
                }
            }

            if (hasMinHistory && historicalAudits.length >= 2) {
                const check1 = historicalAudits[0];
                const check2 = historicalAudits[1];

                const meta1 = check1.metadata as Record<string, any> || {};
                const obs1 = meta1.observability || {};
                const c1 = obs1.coverage?.coverageRatio;
                const r1 = obs1.correlation?.correlationQualityRatio;

                const meta2 = check2.metadata as Record<string, any> || {};
                const obs2 = meta2.observability || {};
                const c2 = obs2.coverage?.coverageRatio;
                const r2 = obs2.correlation?.correlationQualityRatio;

                if (typeof c1 === 'number' && typeof c2 === 'number') {
                    const chgCurrent = coverageRatio - historical24hP95Coverage;
                    const chg1 = c1 - historical24hP95Coverage;
                    const chg2 = c2 - historical24hP95Coverage;

                    if (chgCurrent <= -0.15 && chg1 <= -0.15 && chg2 <= -0.15) {
                        coverageDegradedSustained = true;
                    }
                }

                if (typeof r1 === 'number' && typeof r2 === 'number') {
                    const chgCurrent = correlationQualityRatio - historical24hP95Correlation;
                    const chg1 = r1 - historical24hP95Correlation;
                    const chg2 = r2 - historical24hP95Correlation;

                    if (chgCurrent <= -0.10 && chg1 <= -0.10 && chg2 <= -0.10) {
                        correlationDegradedSustained = true;
                    }
                }
            }

            if (coverageDegradedSustained) {
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Observability Coverage Degradation Trend',
                    message: `WARNING: Observability coverage has suffered sustained degradation. Current: ${coverageRatio.toFixed(4)} vs 24h P95: ${historical24hP95Coverage.toFixed(4)} (Change: ${coverageRatioChange.toFixed(4)}) for 3 consecutive checks.`,
                    dedupKey: 'coverage_degradation_trend'
                });
            }

            if (correlationDegradedSustained) {
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'Observability Correlation Degradation Trend',
                    message: `WARNING: Observability correlation has suffered sustained degradation. Current: ${correlationQualityRatio.toFixed(4)} vs 24h P95: ${historical24hP95Correlation.toFixed(4)} (Change: ${correlationQualityRatioChange.toFixed(4)}) for 3 consecutive checks.`,
                    dedupKey: 'correlation_degradation_trend'
                });
            }

            const metadata = {
                observability: {
                    pipelineVisibility,
                    visibilityReason,
                    coverage: {
                        signalsObserved: signals,
                        eligibleSignals: eligibleSignalsCount,
                        filledEligibleSignals: filledEligibleSignalsCount,
                        coverageRatio
                    },
                    correlation: {
                        signalsWithTradeId,
                        signalsWithoutTradeId,
                        correlationQualityRatio
                    },
                    confidence: {
                        score: confidenceScore
                    },
                    lifecycle: {
                        totalTradesAnalyzed,
                        tradesWithLifecycleTelemetry,
                        intermediateEventsObserved,
                        correlationConflicts,
                        validTrades,
                        invalidTrades,
                        incompleteTrades,
                        terminalTrades, // Note: terminalTrades represents a separate completeness dimension and is not mutually exclusive with validTrades or invalidTrades.
                        tradesWithSkippedStages,
                        duplicateEventsObserved,
                        lifecycleConfidenceScore
                    },
                    analytics: {
                        unfilledSignalCount,
                        uncorrelatableSignalCount,
                        oldestUnfilledMinutes,
                        averageUnfilledMinutes
                    },
                    trends: {
                        historical24hAverageCoverage,
                        historical24hAverageCorrelation,
                        historical24hP95Coverage,
                        historical24hP95Correlation,
                        coverageRatioChange,
                        correlationQualityRatioChange,
                        lowConfidenceChecks24h: lowConfidenceCount,
                        mediumConfidenceChecks24h: mediumConfidenceCount,
                        highConfidenceChecks24h: highConfidenceCount
                    }
                }
            };

            const returnVal: HealthCheckResult = {
                source: 'ORDER_PIPELINE',
                healthy: pipelineHealthy,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: pipelineHealthy ? undefined : ('WARNING' as const),
                message: pipelineHealthy ? undefined : failureMsgs.join(' | '),
                metadata: this.enrichMetadata('ORDER_PIPELINE', pipelineHealthy ? metadata : {
                    ...metadata,
                    failedTradeIds
                })
            };

            // Stage 7: Persist current observability state (excluding itself from current calculations)
            try {
                await prisma.decisionAudit.create({
                    data: {
                        classification: 'OBSERVABILITY_METRICS',
                        systemRiskState: pipelineHealthy ? 'NORMAL' : 'DEGRADED',
                        metadata: metadata
                    }
                });
            } catch (persistErr: any) {
                console.error('[OperationsWatchdog] Failed to persist observability metrics snapshot:', persistErr?.message || persistErr);
            }

            // --- Phase 3C: Execution Risk Protection Engine ---
            let riskLevel: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';
            let activeViolation: RiskViolationType | undefined = undefined;
            let activeReason = '';

            // 1. Evaluate Confidence Degradation
            if (lifecycleConfidenceScore < MVP_CONFIG.RISK_PROTECTION.CONFIDENCE_WARNING_THRESHOLD) {
                this.consecutiveConfidenceBreaches++;
            } else {
                this.consecutiveConfidenceBreaches = 0;
            }

            // 2. Evaluate Structural Violations
            if (invalidTrades > 0) {
                this.consecutiveStructuralViolations++;
            } else {
                this.consecutiveStructuralViolations = 0;
            }

            // Determine Risk Level & Active Violation details
            if (this.consecutiveStructuralViolations >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_STRUCTURAL_CRITICAL) {
                riskLevel = 'CRITICAL';
                activeViolation = this.lastActiveViolationType || RiskViolationType.INVALID_TRANSITION;
                activeReason = `Sustained Structural Integrity Violations (${this.consecutiveStructuralViolations} consecutive cycles)`;
            } else if (this.consecutiveConfidenceBreaches >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_CONFIDENCE_CRITICAL) {
                riskLevel = 'CRITICAL';
                activeViolation = RiskViolationType.LOW_CONFIDENCE;
                activeReason = `Sustained Confidence Score Degradation (${this.consecutiveConfidenceBreaches} consecutive cycles under threshold ${MVP_CONFIG.RISK_PROTECTION.CONFIDENCE_WARNING_THRESHOLD})`;
            } else if (this.consecutiveStructuralViolations >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_STRUCTURAL_WARNING) {
                riskLevel = 'WARNING';
                activeViolation = this.lastActiveViolationType || RiskViolationType.INVALID_TRANSITION;
                activeReason = `Structural Integrity Violation observed (${this.consecutiveStructuralViolations} consecutive cycle)`;
            } else if (this.consecutiveConfidenceBreaches >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_CONFIDENCE_WARNING) {
                riskLevel = 'WARNING';
                activeViolation = RiskViolationType.LOW_CONFIDENCE;
                activeReason = `Confidence Score Degradation observed (${this.consecutiveConfidenceBreaches} consecutive cycles)`;
            }

            // Execute Risk Escalation Actions
            if (riskLevel === 'CRITICAL' && activeViolation) {
                console.error(`🚨 [OperationsWatchdog] CRITICAL RISK BREACH: ${activeReason} (${activeViolation})`);
                
                // Resolve ProtectionAction
                let action: ProtectionAction;
                const protectionMode = MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE;

                if (protectionMode === 'STOP_BUY') {
                    action = new StopBuyAction(this.incidentManager, activeReason, activeViolation, this.freqtradeAdapter);
                } else if (protectionMode === 'STOP') {
                    action = new StopAction(this.incidentManager, activeReason, activeViolation, this.freqtradeAdapter);
                } else {
                    action = new AlertOnlyAction(this.incidentManager, activeReason, activeViolation);
                }

                try {
                    await action.execute();
                } catch (actionErr: any) {
                    console.error('[OperationsWatchdog] Failed to execute ProtectionAction:', actionErr.message || actionErr);
                }
            } else if (riskLevel === 'WARNING' && activeViolation) {
                console.warn(`⚠️ [OperationsWatchdog] RISK WARNING: ${activeReason} (${activeViolation})`);
                await this.incidentManager.reportIncident({
                    level: 'HIGH',
                    source: 'LIFECYCLE_INTEGRITY',
                    reason: `WARNING: Execution Risk Warning (Type: ${activeViolation}, Reason: ${activeReason})`
                });
            } else {
                // Restore state: Resolve incident if active
                await this.incidentManager.resolveIncidentBySource('LIFECYCLE_INTEGRITY');
            }

            return returnVal;
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
            this.checkMarketDataFeed(),
            this.checkOrderPipeline(),
            this.checkExchangeAck(),
            this.checkLatency(strategyId)
        ]);
    }
}
