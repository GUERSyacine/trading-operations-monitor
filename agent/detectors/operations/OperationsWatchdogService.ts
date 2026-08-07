import { prisma } from '../../../shared/prisma';
import { AlertingService } from '../../notification/AlertingService';
import { HealthCheckResult, HealthNode, HealthStatus, SOURCE_CAPABILITIES, LifecycleSource, LifecycleEventType, buildTradeKey, normalizeSymbol } from '../../../shared/types/telemetry';
import { MVP_CONFIG } from '../../../shared/mvpConfig';
import { IncidentManager } from '../../incident/manager/IncidentManager';
import { TradingAdapter } from '../../adapters/base/TradingAdapter';
import { VisibilityEvaluator } from '../VisibilityEvaluator';
import { DecisionAudit } from '@prisma/client';
import { FailureInjectionService } from '../../../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../../../shared/services/FeatureFlagService';
import { FailureType, FeatureFlag, WatchdogEventType } from '../../../shared/types/developer';
import { EventBus } from '../../../shared/services/EventBus';

export interface OrderTimeline {
    orderId: string;
    tradeId: string;
    source: LifecycleSource;
    events: DecisionAudit[];
}

export interface ValidationResult {
    valid: boolean;
    skippedStages: boolean;
    violation?: RiskViolationType;
    terminalState: boolean;
    duplicates: number;
}

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
    INVALID_TRANSITION = 'INVALID_TRANSITION',
    DUPLICATE_FILL = 'DUPLICATE_FILL',
    UNEXPECTED_FILL = 'UNEXPECTED_FILL'
}

export enum TimelineConfidence {
    FULL = 'FULL',
    PARTIAL = 'PARTIAL'
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
        private adapter?: TradingAdapter
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
        private adapter?: TradingAdapter
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
        protected tradingAdapter?: TradingAdapter,
        protected allowedInactivityMs: number = MVP_CONFIG.OPERATIONS.HEARTBEAT_TIMEOUT_MS,
        protected failures?: FailureInjectionService,
        protected flags?: FeatureFlagService
    ) {
        // Register to listen to the LAB_RESET event to clear detector state
        EventBus.getInstance().subscribe((event) => {
            if (event.type === WatchdogEventType.LAB_RESET) {
                this.clearDetectorState();
            }
        });
    }

    protected heartbeatFailures = 0;
    protected brokerFailures = 0;
    protected startupGraceActive = false;

    public setStartupGraceActive(active: boolean): void {
        this.startupGraceActive = active;
    }

    public clearDetectorState(): void {
        this.heartbeatFailures = 0;
        this.brokerFailures = 0;
        this.consecutiveConfidenceBreaches = 0;
        this.consecutiveStructuralViolations = 0;
        this.consecutiveStructuralViolationsMap.clear();
        this.lastActiveViolationType = undefined;
        this.lastPipelineMetadata = null;
        this.tradeFrequencyFailures.clear();
    }

    protected tradeFrequencyFailures = new Map<string, number>();

    protected consecutiveConfidenceBreaches = 0;
    protected consecutiveStructuralViolations = 0;
    protected consecutiveStructuralViolationsMap = new Map<RiskViolationType, number>();
    protected lastActiveViolationType?: RiskViolationType;
    protected lastPipelineMetadata: any = null;

    private getEventStateValue(classification: string): number {
        const upper = classification.toUpperCase();
        if (upper === 'SIGNAL') return 0;
        if (upper === 'ORDER_CREATED') return 1;
        if (upper === 'ORDER_SUBMITTED' || upper === 'ORDER_SENT') return 2;
        if (upper === 'ORDER_ACKNOWLEDGED' || upper === 'ORDER_ACK') return 3;
        if (upper === 'ORDER_OPEN') return 4;
        if (upper === 'ORDER_PARTIALLY_FILLED') return 5;
        if (['ORDER_FILLED', 'ORDER_CANCELLED', 'EXCHANGE_REJECTED', 'ORDER_FAILED', 'ORDER'].includes(upper)) return 6;
        return -1;
    }

    private readonly canonicalOrder: string[] = [
        'SIGNAL',
        'ORDER_CREATED',
        'ORDER_SUBMITTED',
        'ORDER_ACKNOWLEDGED',
        'ORDER_OPEN',
        'ORDER_PARTIALLY_FILLED',
        'ORDER_FILLED'
    ];

    private validateOrderTimeline(
        timeline: OrderTimeline,
        isGuaranteedStep: (step: string) => boolean,
        hasSufficientEvidence: boolean = false,
        timelineConfidence: TimelineConfidence = TimelineConfidence.PARTIAL
    ): ValidationResult {
        const events = timeline.events;
        let isInvalid = false;
        let hasSkipped = false;
        let reachedTerminal = false;
        let duplicatesCount = 0;
        let lastStateValue = -1;
        let lastClassification: string | undefined = undefined;
        let violationType: RiskViolationType | undefined = undefined;
        const terminalStatesSeen = new Set<string>();

        for (let i = 0; i < events.length; i++) {
            const audit = events[i];
            const classification = audit.classification.toUpperCase();
            const stateVal = this.getEventStateValue(classification);

            if (stateVal === -1) {
                continue;
            }

            // Duplicate event detection
            if (lastClassification && classification === lastClassification) {
                duplicatesCount++;
                if (classification === 'ORDER_FILLED') {
                    isInvalid = true;
                    violationType = RiskViolationType.DUPLICATE_FILL;
                }
                continue;
            }

            if (lastStateValue !== -1) {
                // 1. Invalid Transition: terminal (6) -> active (< 6)
                if (lastStateValue === 6 && stateVal < 6) {
                    isInvalid = true;
                    violationType = RiskViolationType.INVALID_TRANSITION;
                }

                // 2. Backward Transition
                if (stateVal < lastStateValue) {
                    isInvalid = true;
                    violationType = RiskViolationType.BACKWARD_TRANSITION;
                }

                // 3. Skipped Stage
                if (stateVal > lastStateValue + 1) {
                    for (let stepIdx = lastStateValue + 1; stepIdx < stateVal; stepIdx++) {
                        const stepName = this.canonicalOrder[stepIdx];
                        if (isGuaranteedStep(stepName)) {
                            hasSkipped = true;
                            break;
                        }
                    }
                }
            } else {
                // First event in order timeline: check for skipped initial stages from ORDER_CREATED (1) onwards
                if (stateVal > 1) {
                    for (let stepIdx = 1; stepIdx < stateVal; stepIdx++) {
                        const stepName = this.canonicalOrder[stepIdx];
                        if (isGuaranteedStep(stepName)) {
                            hasSkipped = true;
                            if (classification === 'ORDER_FILLED' && !hasSufficientEvidence && timelineConfidence === TimelineConfidence.FULL) {
                                isInvalid = true;
                                violationType = RiskViolationType.UNEXPECTED_FILL;
                            }
                            break;
                        }
                    }
                }
            }

            // 4. Terminal Mutation Guard
            if (stateVal === 6) {
                reachedTerminal = true;
                terminalStatesSeen.add(classification);
                if (terminalStatesSeen.size > 1) {
                    isInvalid = true;
                    violationType = RiskViolationType.TERMINAL_MUTATION;
                }
            }

            lastStateValue = stateVal;
            lastClassification = classification;
        }

        return {
            valid: !isInvalid,
            skippedStages: hasSkipped,
            violation: violationType,
            terminalState: reachedTerminal,
            duplicates: duplicatesCount
        };
    }

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
        const runCheck = async (): Promise<HealthCheckResult> => {
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

            if (this.startupGraceActive && !isSuccess) {
                console.log(`[OperationsWatchdog] Heartbeat stale during startup grace period. Bypassing failure reporting.`);
                return {
                    source: 'HEARTBEAT',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    message: `Heartbeat check bypassed during startup grace period. Original issue: ${errorMsg}`
                };
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
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.HEARTBEAT_LOSS,
                component: 'OperationsWatchdogService',
                operation: 'checkHeartbeat',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errorMsg = 'Simulated heartbeat loss failure';
                    
                    // Trigger simulation alerts/incidents
                    await this.incidentManager.reportIncident({
                        level: 'CRITICAL',
                        source: 'HEARTBEAT',
                        reason: `No decisions or updates logged by the trading engine (SIMULATED): ${errorMsg}`
                    });

                    return {
                        source: 'HEARTBEAT',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errorMsg,
                        metadata: this.enrichMetadata('HEARTBEAT', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
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
                    classification: {
                        in: ['ORDER', 'ORDER_FILLED']
                    },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            // MVP assumption:
            // Freqtrade websocket/polling does not expose strategyId.
            // Since MVP supports only ONE running strategy, events without strategyId belong to this strategy.
            // Remove this fallback when multi-strategy support is introduced.
            const filteredTrades = trades.filter(t => {
                const meta = t.metadata as any;
                const stratId = meta?.strategyId || meta?.lifecycleEvent?.strategyId;
                return stratId === undefined || stratId === null || stratId === strategyId;
            });

            recentTradeCount = filteredTrades.length;
            isSuccess = filteredTrades.length > 0;
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
        const runCheck = async (): Promise<HealthCheckResult> => {
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

            if (this.startupGraceActive && !isSuccess) {
                console.log(`[OperationsWatchdog] Broker connection stale during startup grace period. Bypassing failure reporting.`);
                return {
                    source: 'BROKER_CONNECTION',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    message: `Broker connection check bypassed during startup grace period. Original issue: ${errorMsg}`
                };
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
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.BROKER_DOWN,
                component: 'OperationsWatchdogService',
                operation: 'checkBrokerConnection',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errorMsg = 'Simulated broker connection failure';
                    
                    await this.incidentManager.reportIncident({
                        level: 'CRITICAL',
                        source: 'BROKER_CONNECTION',
                        reason: `Broker connection is reported down or stale (SIMULATED): ${errorMsg}`
                    });

                    return {
                        source: 'BROKER_CONNECTION',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errorMsg,
                        metadata: this.enrichMetadata('BROKER_CONNECTION', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
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
                if (this.startupGraceActive) {
                    console.log(`[OperationsWatchdog] Market data telemetry stale (no ticks) during startup grace period. Bypassing failure reporting.`);
                    return {
                        source: 'MARKET_DATA',
                        healthy: true,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        message: `Market data check bypassed during startup grace period. Original issue: ${msg}`
                    };
                }
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
                if (this.startupGraceActive) {
                    console.log(`[OperationsWatchdog] Market data telemetry stale during startup grace period. Bypassing failure reporting.`);
                    return {
                        source: 'MARKET_DATA',
                        healthy: true,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        message: `Market data check bypassed during startup grace period. Original issue: ${msg}`
                    };
                }
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

            console.log('================ PIPELINE DEBUG ================');
            console.log('windowMs:', windowMs);
            console.log('windowHours:', windowMs / (1000 * 60 * 60));
            console.log('cutoff:', cutoff.toISOString());
            console.log('now:', new Date().toISOString());
            console.log('audits.length:', audits.length);

            const classifications = audits.reduce((acc: Record<string, number>, audit) => {
                acc[audit.classification] = (acc[audit.classification] || 0) + 1;
                return acc;
            }, {});

            console.log('classifications:', classifications);
            
            // Calculate and log Telemetry Reconciliation Statistics
            let wsTotalEvents = 0;
            let wsDeterministicCount = 0;
            let wsPendingHeuristicCount = 0;

            for (const audit of audits) {
                const meta = audit.metadata as Record<string, any> || {};
                const lifecycle = meta.lifecycleEvent || {};
                if (lifecycle.captureMethod === 'WEBSOCKET') {
                    wsTotalEvents++;
                    const oId = lifecycle.orderId;
                    if (oId && oId !== 'undefined' && oId !== 'null') {
                        wsDeterministicCount++;
                    } else {
                        wsPendingHeuristicCount++;
                    }
                }
            }

            console.log(`[TelemetryReconciliation] DB Status: Total WS events = ${wsTotalEvents}. Deterministic = ${wsDeterministicCount}, Pending association = ${wsPendingHeuristicCount}`);
            console.log('================================================');

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
                    const lifecycle = meta.lifecycleEvent || {};
                    const tradeId = meta.tradeId ?? lifecycle.tradeId;
                    if (tradeId !== undefined && tradeId !== null && tradeId !== '') {
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
                    const lifecycle = meta.lifecycleEvent || {};
                    const tradeId = meta.tradeId ?? lifecycle.tradeId;
                    const orderId = meta.orderId ?? lifecycle.orderId;
                    const hasTradeId = tradeId !== undefined && tradeId !== null && tradeId !== '';
                    const hasOrderId = orderId !== undefined && orderId !== null && orderId !== '';
                    if (hasTradeId || hasOrderId) {
                        hasCorrelatableIntermediate = true;
                        break;
                    }
                }
            }

            const observedClassifications = new Set<string>();
            for (const audit of audits) {
                observedClassifications.add(audit.classification.toUpperCase());
            }

            const caps = this.tradingAdapter?.capabilities || SOURCE_CAPABILITIES.FREQTRADE;
            const evalResult = VisibilityEvaluator.evaluate({
                capabilities: caps,
                observedClassifications
            });

            const pipelineVisibility = evalResult.pipelineVisibility;
            const visibilityReason = evalResult.visibilityReason;
            const telemetryCoverage = evalResult.telemetryCoverage;

            // Two-Stage Correlation Model & Reconstruction Engine
            const uniqueTradeKeys = new Set<string>();
            for (const audit of audits) {
                const meta = audit.metadata as Record<string, any> || {};
                const lifecycle = meta.lifecycleEvent || {};
                const tId = meta.tradeId ?? lifecycle.tradeId;
                const symbol = meta.symbol ?? lifecycle.symbol ?? 'unknown';
                if (tId !== undefined && tId !== null && tId !== '') {
                    uniqueTradeKeys.add(buildTradeKey(tId, symbol));
                }
            }

            const orderToTradeMap = new Map<string, string>(); // orderId -> tradeKey
            let correlationConflicts = 0;

            for (const audit of audits) {
                const meta = audit.metadata as Record<string, any> || {};
                const lifecycle = meta.lifecycleEvent || {};
                const tId = meta.tradeId ?? lifecycle.tradeId;
                const oId = meta.orderId ?? lifecycle.orderId;
                const symbol = meta.symbol ?? lifecycle.symbol ?? 'unknown';

                if (tId !== undefined && tId !== null && tId !== '' && oId !== undefined && oId !== null && oId !== '') {
                    const tradeKeyStr = buildTradeKey(tId, symbol);
                    const orderIdStr = String(oId);

                    if (orderToTradeMap.has(orderIdStr)) {
                        const existingTradeKey = orderToTradeMap.get(orderIdStr);
                        if (existingTradeKey !== tradeKeyStr) {
                            correlationConflicts++;
                            console.warn(`[OperationsWatchdog] Correlation conflict: orderId ${orderIdStr} maps to both tradeKey ${existingTradeKey} and ${tradeKeyStr}`);
                        }
                    } else {
                        orderToTradeMap.set(orderIdStr, tradeKeyStr);
                    }
                }
            }

            const tradeToOrdersMap = new Map<string, Set<string>>(); // tradeKey -> Set<orderId>
            for (const [orderId, tradeKey] of orderToTradeMap.entries()) {
                if (!tradeToOrdersMap.has(tradeKey)) {
                    tradeToOrdersMap.set(tradeKey, new Set<string>());
                }
                tradeToOrdersMap.get(tradeKey)!.add(orderId);
            }

            console.log('CORRELATION DEBUG');
            console.log('uniqueTradeKeys=', uniqueTradeKeys.size);
            console.log('orderToTradeMap=', orderToTradeMap.size);
            console.log('tradeToOrdersMap=', tradeToOrdersMap.size);

            let tradesWithLifecycleTelemetry = 0;
            const totalTradesAnalyzed = uniqueTradeKeys.size;

            let validTrades = 0;
            let invalidTrades = 0;
            let incompleteTrades = 0;
            let terminalTrades = 0;
            let tradesWithSkippedStages = 0;
            let duplicateEventsObserved = 0;

            // Track telemetry reconciliation method stats cycle-wide
            let wsHeuristicCount = 0;
            let wsUnresolvedCount = 0;

            // Map event classifications to state values for chronological sequence validation
            // (Note: getEventStateValue and canonicalOrder have been moved to class methods)

            const observedViolationsInCycle = new Set<RiskViolationType>();

            for (const tradeKey of uniqueTradeKeys) {
                const parts = tradeKey.split('::');
                const tradeId = parts[0];
                const tradeSymbol = parts[1];
                const associatedOrders = tradeToOrdersMap.get(tradeKey) || new Set<string>();
                
                const tradeTimeline = audits.filter(audit => {
                    const meta = audit.metadata as Record<string, any> || {};
                    const lifecycle = meta.lifecycleEvent || {};
                    const rawTradeId = meta.tradeId ?? lifecycle.tradeId;
                    const rawOrderId = meta.orderId ?? lifecycle.orderId;
                    const symbol = meta.symbol ?? lifecycle.symbol ?? 'unknown';
                    
                    const tId = rawTradeId !== undefined && rawTradeId !== null ? String(rawTradeId) : undefined;
                    const oId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : undefined;
                    
                    const matchesTradeKey = (tId === tradeId && normalizeSymbol(symbol) === tradeSymbol);
                    const matchesAssociatedOrder = (oId !== undefined && associatedOrders.has(oId));
                    
                    return matchesTradeKey || matchesAssociatedOrder;
                });

                tradeTimeline.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

                // Group events by orderId. Trade-level events (e.g. SIGNAL) have no orderId.
                // We perform a two-stage association to map events without an orderId
                // to their most likely orderId based on chronological proximity.
                const resolvedOrderIds = new Map<string, string>(); // event key -> resolved orderId
                
                const getAuditKey = (audit: typeof tradeTimeline[0], idx: number) => {
                    return audit.id || `idx_${idx}`;
                };

                // First, collect all events that have an explicit orderId
                const explicitOrderIds: { id: string; orderId: string; time: number; side?: string }[] = [];
                for (let i = 0; i < tradeTimeline.length; i++) {
                    const audit = tradeTimeline[i];
                    const classification = audit.classification.toUpperCase();
                    const stateVal = this.getEventStateValue(classification);
                    if (stateVal <= 0) continue;

                    const meta = audit.metadata as Record<string, any> || {};
                    const lifecycle = meta.lifecycleEvent || {};
                    const rawOrderId = meta.orderId ?? lifecycle.orderId;
                    if (rawOrderId !== undefined && rawOrderId !== null) {
                        const oId = String(rawOrderId);
                        const auditKey = getAuditKey(audit, i);
                        explicitOrderIds.push({
                            id: auditKey,
                            orderId: oId,
                            time: audit.createdAt.getTime(),
                            side: meta.side ?? lifecycle.side
                        });
                        resolvedOrderIds.set(auditKey, oId);
                    }
                }

                // Now, resolve orderId for events that don't have one
                for (let i = 0; i < tradeTimeline.length; i++) {
                    const audit = tradeTimeline[i];
                    const classification = audit.classification.toUpperCase();
                    const stateVal = this.getEventStateValue(classification);
                    if (stateVal <= 0) continue;
                    const auditKey = getAuditKey(audit, i);
                    if (resolvedOrderIds.has(auditKey)) continue;

                    const meta = audit.metadata as Record<string, any> || {};
                    const lifecycle = meta.lifecycleEvent || {};
                    const auditTime = audit.createdAt.getTime();
                    const auditSide = meta.side ?? lifecycle.side;

                    const isInitiation = [
                        'SIGNAL',
                        'ORDER_CREATED',
                        'ORDER_SUBMITTED',
                        'ORDER_SENT',
                        'ORDER_ACKNOWLEDGED',
                        'ORDER_ACK'
                    ].includes(classification);

                    const isTermination = [
                        'ORDER_CANCELLED',
                        'ORDER_FILLED',
                        'ORDER_PARTIALLY_FILLED',
                        'ORDER_FAILED',
                        'EXCHANGE_REJECTED',
                        'ORDER'
                    ].includes(classification);

                    // Find the chronologically closest explicit order ID (using directional heuristics)
                    let bestOrderId: string | undefined = undefined;
                    let bestDiff = Infinity;

                    for (const exp of explicitOrderIds) {
                        // Match side if both are specified
                        if (auditSide && exp.side && auditSide !== exp.side) {
                            continue;
                        }

                        // Apply directional filter:
                        // Initiation events must look forward in time (exp.time >= auditTime)
                        if (isInitiation && exp.time < auditTime) {
                            continue;
                        }
                        // Termination events must look backward in time (exp.time <= auditTime)
                        if (isTermination && exp.time > auditTime) {
                            continue;
                        }

                        const diff = Math.abs(exp.time - auditTime);
                        if (diff < bestDiff) {
                            bestDiff = diff;
                            bestOrderId = exp.orderId;
                        }
                    }

                    // Fallback to absolute closest if directional search yielded no candidate
                    if (bestOrderId === undefined) {
                        for (const exp of explicitOrderIds) {
                            if (auditSide && exp.side && auditSide !== exp.side) {
                                continue;
                            }
                            const diff = Math.abs(exp.time - auditTime);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestOrderId = exp.orderId;
                            }
                        }
                    }

                    const resolvedId = bestOrderId || 'default_order';
                    resolvedOrderIds.set(auditKey, resolvedId);
                    
                    if (lifecycle.captureMethod === 'WEBSOCKET') {
                        if (bestOrderId) {
                            wsHeuristicCount++;
                            // Log heuristic fallback usage for this specific event
                            console.log(`[TelemetryReconciliation] Fallback: Using chronological heuristic to associate ${classification} for trade ${tradeId} (symbol ${tradeSymbol}) to order ${resolvedId} [HEURISTIC]`);
                        } else {
                            wsUnresolvedCount++;
                            console.log(`[TelemetryReconciliation] Unresolved: Could not safely associate ${classification} for trade ${tradeId} (symbol ${tradeSymbol}) [UNRESOLVED]`);
                        }
                    }
                }


                const auditsWithOrderId: Map<string, typeof audits> = new Map();
                for (let i = 0; i < tradeTimeline.length; i++) {
                    const audit = tradeTimeline[i];
                    const classification = audit.classification.toUpperCase();
                    const stateVal = this.getEventStateValue(classification);
                    if (stateVal <= 0) continue;

                    const auditKey = getAuditKey(audit, i);
                    const resolvedId = resolvedOrderIds.get(auditKey) || 'default_order';
                    let list = auditsWithOrderId.get(resolvedId);
                    if (!list) {
                        list = [];
                        auditsWithOrderId.set(resolvedId, list);
                    }
                    list.push(audit);
                }

                // Determine tradeSource and calculate TimelineConfidence
                let tradeSource: LifecycleSource = 'FREQTRADE';
                let hasSufficientEvidence = false;
                for (const audit of tradeTimeline) {
                    const meta = audit.metadata as Record<string, any> || {};
                    const s = meta.lifecycleEvent?.source || meta.source;
                    if (s) {
                        tradeSource = String(s).toUpperCase() as LifecycleSource;
                    }
                    const classification = audit.classification.toUpperCase();
                    if (classification === 'SIGNAL' || classification === 'ORDER_CREATED') {
                        hasSufficientEvidence = true;
                    }
                }

                if (!hasSufficientEvidence) {
                    try {
                        const tradeIdNum = Number(tradeId);
                        const isNumber = !isNaN(tradeIdNum);
                        const orConditions: any[] = [
                            {
                                metadata: {
                                    path: ['tradeId'],
                                    equals: tradeId
                                }
                            },
                            {
                                metadata: {
                                    path: ['lifecycleEvent', 'tradeId'],
                                    equals: tradeId
                                }
                            }
                        ];
                        if (isNumber) {
                            orConditions.push(
                                {
                                    metadata: {
                                        path: ['tradeId'],
                                        equals: tradeIdNum
                                    }
                                },
                                {
                                    metadata: {
                                        path: ['lifecycleEvent', 'tradeId'],
                                        equals: tradeIdNum
                                    }
                                }
                            );
                        }

                        const dbMatch = await prisma.decisionAudit.findFirst({
                            where: {
                                classification: {
                                    in: ['SIGNAL', 'ORDER_CREATED']
                                },
                                OR: orConditions
                            }
                        });
                        if (dbMatch) {
                            hasSufficientEvidence = true;
                        }
                    } catch (error: any) {
                        console.error(`[OperationsWatchdog] Error querying database for trade ${tradeId} lifecycle source:`, error?.message || error);
                    }
                }

                // Determine TimelineConfidence recomputed on every cycle from the current timeline
                let timelineConfidence = TimelineConfidence.PARTIAL;
                // TODO: Refine timeline confidence checks as more adapters/exchanges are integrated.
                if (tradeSource === 'SIMULATOR' || tradeId.startsWith('sim_') || hasSufficientEvidence) {
                    timelineConfidence = TimelineConfidence.FULL;
                }

                const caps = SOURCE_CAPABILITIES[tradeSource] || SOURCE_CAPABILITIES.FREQTRADE;
                const isGuaranteedStep = (step: string): boolean => {
                    if (step === 'ORDER_FILLED') {
                        return caps.requiredEvents.some(e =>
                            ['ORDER_FILLED', 'ORDER_CANCELLED', 'EXCHANGE_REJECTED', 'ORDER_FAILED'].includes(e.toUpperCase())
                        );
                    }
                    return caps.requiredEvents.some(e => e.toUpperCase() === step);
                };

                // Create OrderTimeline structures
                const orderTimelines: OrderTimeline[] = [];
                for (const [oId, list] of auditsWithOrderId.entries()) {
                    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
                    orderTimelines.push({
                        orderId: oId,
                        tradeId: tradeId,
                        source: tradeSource,
                        events: list
                    });
                }

                // Sort order timelines chronologically
                orderTimelines.sort((a, b) => {
                    const timeA = a.events[0]?.createdAt.getTime() || 0;
                    const timeB = b.events[0]?.createdAt.getTime() || 0;
                    return timeA - timeB;
                });

                const getEventDirection = (audit: any): string => {
                    const meta = audit.metadata as any;
                    if (meta && meta.lifecycleEvent && meta.lifecycleEvent.direction) {
                        return meta.lifecycleEvent.direction;
                    }
                    const raw = meta?.rawPayload;
                    if (raw) {
                        const type = String(raw.type || raw.event || '').toLowerCase();
                        if (type.includes('entry') || type.includes('enter')) return 'ENTRY';
                        if (type.includes('exit')) return 'EXIT';
                        const side = String(raw.ft_order_side || '').toLowerCase();
                        if (side === 'buy') return 'ENTRY';
                        if (side === 'sell') return 'EXIT';
                    }
                    const side = String(meta?.side || meta?.lifecycleEvent?.side || '').toUpperCase();
                    if (side === 'BUY') return 'ENTRY';
                    if (side === 'SELL') return 'EXIT';

                    return 'UNKNOWN';
                };

                const entryEvents = tradeTimeline.filter(a => getEventDirection(a) === 'ENTRY');
                const exitEvents = tradeTimeline.filter(a => getEventDirection(a) === 'EXIT');
                const unknownEvents = tradeTimeline.filter(a => {
                    const dir = getEventDirection(a);
                    return dir !== 'ENTRY' && dir !== 'EXIT';
                });

                if (entryEvents.length > 0) {
                    console.log(
                        'TRADE DEBUG',
                        `${tradeId} (entry)`,
                        entryEvents.map(a => a.classification)
                    );
                }
                if (exitEvents.length > 0) {
                    console.log(
                        'TRADE DEBUG',
                        `${tradeId} (exit)`,
                        exitEvents.map(a => a.classification)
                    );
                }
                if (unknownEvents.length > 0) {
                    console.log(
                        'TRADE DEBUG',
                        `${tradeId} (unknown)`,
                        unknownEvents.map(a => a.classification)
                    );
                }

                const hasLifecycle = tradeTimeline.some(audit => {
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

                // Run state machine transition validator on each order timeline and aggregate results
                let tradeIsInvalid = false;
                let tradeHasSkipped = false;
                let tradeViolationType: RiskViolationType | undefined = undefined;
                let hasIncompleteOrder = false;
                let hasTerminalOrder = false;
                let hasValidatedOrder = false;

                for (const timeline of orderTimelines) {
                    const result = this.validateOrderTimeline(timeline, isGuaranteedStep, hasSufficientEvidence, timelineConfidence);

                    hasValidatedOrder = true;
                    if (!result.valid) {
                        tradeIsInvalid = true;
                        if (result.violation) {
                            tradeViolationType = result.violation;
                        }
                    }
                    if (!result.terminalState) {
                        hasIncompleteOrder = true;
                    }
                    if (result.terminalState) {
                        hasTerminalOrder = true;
                    }
                    if (result.skippedStages) {
                        tradeHasSkipped = true;
                    }
                    duplicateEventsObserved += result.duplicates;
                }

                // tradeSymbol is already extracted from tradeKey above

                if (hasValidatedOrder) {
                    if (tradeIsInvalid) {
                        invalidTrades++;
                        if (tradeViolationType) {
                            this.lastActiveViolationType = tradeViolationType;
                            observedViolationsInCycle.add(tradeViolationType);

                             // Report symbol-specific / trade-specific incident with source OP:${tradeId}:${violationType}
                             const sourceKey = `OP:${tradeId}:${tradeSymbol}:${tradeViolationType}`;
                             await this.incidentManager.reportIncident({
                                 symbol: tradeSymbol,
                                 level: 'HIGH',
                                 source: sourceKey,
                                 reason: `Execution Risk Violation (Type: ${tradeViolationType}, Trade ID: ${tradeId})`,
                                 since: Date.now()
                             });
                         }
                     } else if (hasIncompleteOrder) {
                         incompleteTrades++;
                     } else {
                         validTrades++;
                     }
 
                     // If trade is valid (or no longer has anomalies), resolve any active incidents matching the trade ID source prefix
                     if (!tradeIsInvalid) {
                         const sourcePrefix = `OP:${tradeId}:${tradeSymbol}:`;
                         if (typeof this.incidentManager.resolveIncidentsBySourcePrefix === 'function') {
                             await this.incidentManager.resolveIncidentsBySourcePrefix(sourcePrefix, tradeSymbol);
                         } else {
                             await this.incidentManager.resolveIncidentBySource(`OP:${tradeId}:${tradeSymbol}`, tradeSymbol);
                         }
                     }

                    const tradeIsTerminal = !hasIncompleteOrder && hasTerminalOrder;
                    if (tradeIsTerminal) {
                        terminalTrades++;
                    }

                    if (tradeHasSkipped) {
                        tradesWithSkippedStages++;
                    }
                }
            }

            const totalWsResolved = wsDeterministicCount + wsHeuristicCount + wsUnresolvedCount;
            console.log('================ RECONCILIATION SUMMARY ================');
            console.log(`[TelemetryReconciliation] DETERMINISTIC: ${wsDeterministicCount}`);
            console.log(`[TelemetryReconciliation] HEURISTIC:     ${wsHeuristicCount}`);
            console.log(`[TelemetryReconciliation] UNRESOLVED:    ${wsUnresolvedCount}`);
            console.log(`[TelemetryReconciliation] Total WS Events: ${totalWsResolved}`);
            console.log('========================================================');

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
                            OR: lookbackTradeIds.flatMap(id => [
                                {
                                    metadata: {
                                        path: ['tradeId'],
                                        equals: String(id)
                                    }
                                },
                                {
                                    metadata: {
                                        path: ['lifecycleEvent', 'tradeId'],
                                        equals: String(id)
                                    }
                                }
                            ])
                        }
                    });
                }

                for (const signal of lookbackSignals) {
                    const meta = signal.metadata as Record<string, any> || {};
                    const lifecycle = meta.lifecycleEvent || {};
                    const tradeId = meta.tradeId ?? lifecycle.tradeId;

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
                        const fLifecycle = fMeta.lifecycleEvent || {};
                        const fTradeId = fMeta.tradeId ?? fLifecycle.tradeId;
                        return String(fTradeId) === String(tradeId) && f.createdAt >= signal.createdAt;
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
                    telemetryCoverage,
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
                        lifecycleConfidenceScore,
                        telemetryReconciliation: {
                            deterministicCount: wsDeterministicCount,
                            heuristicCount: wsHeuristicCount,
                            unresolvedCount: wsUnresolvedCount
                        }
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
            this.lastPipelineMetadata = metadata;

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

            // 2. Evaluate Structural Violations per type
            const allViolationTypes = Object.values(RiskViolationType);
            for (const vType of allViolationTypes) {
                if (observedViolationsInCycle.has(vType)) {
                    const currentCount = this.consecutiveStructuralViolationsMap.get(vType) || 0;
                    this.consecutiveStructuralViolationsMap.set(vType, currentCount + 1);
                } else {
                    this.consecutiveStructuralViolationsMap.set(vType, 0);
                }
            }

            let maxStructuralConsecutive = 0;
            let dominantStructuralViolation: RiskViolationType | undefined = undefined;

            for (const vType of allViolationTypes) {
                const count = this.consecutiveStructuralViolationsMap.get(vType) || 0;
                if (count > maxStructuralConsecutive) {
                    maxStructuralConsecutive = count;
                    dominantStructuralViolation = vType;
                }
            }

            this.consecutiveStructuralViolations = maxStructuralConsecutive;

            // List all concurrent active structural violations
            const activeViolationsList: string[] = [];
            for (const vType of allViolationTypes) {
                const count = this.consecutiveStructuralViolationsMap.get(vType) || 0;
                if (count > 0) {
                    activeViolationsList.push(`${vType} (${count} cycles)`);
                }
            }
            const activeViolationsStr = activeViolationsList.join(', ');

            // Determine Risk Level & Active Violation details
            if (maxStructuralConsecutive >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_STRUCTURAL_CRITICAL && dominantStructuralViolation) {
                riskLevel = 'CRITICAL';
                activeViolation = dominantStructuralViolation;
                activeReason = `Sustained Structural Integrity Violations: ${activeViolationsStr}`;
            } else if (this.consecutiveConfidenceBreaches >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_CONFIDENCE_CRITICAL) {
                riskLevel = 'CRITICAL';
                activeViolation = RiskViolationType.LOW_CONFIDENCE;
                activeReason = `Sustained Confidence Score Degradation (${this.consecutiveConfidenceBreaches} consecutive cycles under threshold ${MVP_CONFIG.RISK_PROTECTION.CONFIDENCE_WARNING_THRESHOLD})`;
            } else if (maxStructuralConsecutive >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_STRUCTURAL_WARNING && dominantStructuralViolation) {
                riskLevel = 'WARNING';
                activeViolation = dominantStructuralViolation;
                activeReason = `Structural Integrity Violations observed: ${activeViolationsStr}`;
            } else if (this.consecutiveConfidenceBreaches >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_CONFIDENCE_WARNING) {
                riskLevel = 'WARNING';
                activeViolation = RiskViolationType.LOW_CONFIDENCE;
                activeReason = `Confidence Score Degradation observed (${this.consecutiveConfidenceBreaches} consecutive cycles)`;
            }

            // Execute Risk Escalation Actions
            if (riskLevel === 'CRITICAL' && activeViolation) {
                console.error(`🚨 [OperationsWatchdog] CRITICAL RISK BREACH: ${activeReason} (${activeViolation})`);
                
                let action: ProtectionAction;
                const protectionMode = MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE;
                if (protectionMode === 'STOP_BUY') {
                    action = new StopBuyAction(this.incidentManager, activeReason, activeViolation, this.tradingAdapter);
                } else if (protectionMode === 'STOP') {
                    action = new StopAction(this.incidentManager, activeReason, activeViolation, this.tradingAdapter);
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
                    classification: {
                        in: ['ORDER', 'ORDER_FILLED']
                    },
                    createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } // 3 days lookback
                },
                orderBy: { createdAt: 'desc' }
            });

            // MVP assumption:
            // Freqtrade websocket/polling does not expose strategyId.
            // Since MVP supports only ONE running strategy, events without strategyId belong to this strategy.
            // Remove this fallback when multi-strategy support is introduced.
            const filteredAudits = audits.filter(a => {
                const meta = a.metadata as any;
                const stratId = meta?.strategyId || meta?.lifecycleEvent?.strategyId;
                return stratId === undefined || stratId === null || stratId === strategyId;
            }).slice(0, rollingCount);

            const metadata = {
                strategyId,
                maxLatencyMs,
                rollingCount,
                auditsFound: filteredAudits.length,
                averageLatencyMs: 0
            };

            if (filteredAudits.length < rollingCount) {
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
            for (const audit of filteredAudits) {
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

    getOperationsSubtree(results: HealthCheckResult[]): HealthNode {
        const checkedAt = new Date();

        const findResult = (sources: string[]): HealthCheckResult | undefined => {
            return results.find(r => sources.includes(r.source));
        };

        const mapToNode = (id: string, name: string, sources: string[]): HealthNode => {
            const res = findResult(sources);
            if (!res) {
                return {
                    id,
                    name,
                    status: 'HEALTHY',
                    checkedAt,
                    message: 'No recent checks executed.'
                };
            }
            const status: HealthStatus = res.healthy 
                ? 'HEALTHY' 
                : (res.severity === 'WARNING' ? 'WARNING' : 'CRITICAL');
            return {
                id,
                name,
                status,
                message: res.message,
                checkedAt: res.checkedAt,
                metrics: res.metadata
            };
        };

        // 1. Bot Aliveness Sub-Parent
        const heartbeatNode = mapToNode('ops.aliveness.heartbeat', 'Heartbeat Freshness', ['HEARTBEAT']);
        const strategyNode = mapToNode('ops.aliveness.strategy_activity', 'Strategy Activity', ['TRADE_FREQUENCY', 'LATENCY']);
        const alivenessChildren = [heartbeatNode, strategyNode];
        let alivenessStatus: HealthStatus = 'HEALTHY';
        if (alivenessChildren.some(c => c.status === 'CRITICAL')) {
            alivenessStatus = 'CRITICAL';
        } else if (alivenessChildren.some(c => c.status === 'WARNING')) {
            alivenessStatus = 'WARNING';
        }
        const botAlivenessParent: HealthNode = {
            id: 'ops.bot_aliveness',
            name: 'Bot Aliveness',
            status: alivenessStatus,
            checkedAt,
            children: alivenessChildren
        };

        // 2. Broker Connection Sub-Parent
        const brokerConnNode = mapToNode('ops.broker.connection_status', 'Connection Status', ['BROKER_CONNECTION']);
        const orderFlowNode = mapToNode('ops.broker.order_flow', 'Order Flow & ACK', ['EXCHANGE_ACK']);
        const brokerChildren = [brokerConnNode, orderFlowNode];
        let brokerStatus: HealthStatus = 'HEALTHY';
        if (brokerChildren.some(c => c.status === 'CRITICAL')) {
            brokerStatus = 'CRITICAL';
        } else if (brokerChildren.some(c => c.status === 'WARNING')) {
            brokerStatus = 'WARNING';
        }
        const brokerConnectionParent: HealthNode = {
            id: 'ops.broker_connection',
            name: 'Broker Connection',
            status: brokerStatus,
            checkedAt,
            children: brokerChildren
        };

        // 3. Market Data Feed Sub-Parent
        const marketFeedNode = mapToNode('ops.market.feed_freshness', 'Feed Freshness', ['MARKET_DATA']);
        const marketChildren = [marketFeedNode];
        let marketStatus: HealthStatus = 'HEALTHY';
        if (marketChildren.some(c => c.status === 'CRITICAL')) {
            marketStatus = 'CRITICAL';
        } else if (marketChildren.some(c => c.status === 'WARNING')) {
            marketStatus = 'WARNING';
        }
        const marketDataFeedParent: HealthNode = {
            id: 'ops.market_data_feed',
            name: 'Market Data Feed',
            status: marketStatus,
            checkedAt,
            children: marketChildren
        };

        const children = [botAlivenessParent, brokerConnectionParent, marketDataFeedParent];

        let parentStatus: HealthStatus = 'HEALTHY';
        if (children.some(c => c.status === 'CRITICAL')) {
            parentStatus = 'CRITICAL';
        } else if (children.some(c => c.status === 'WARNING')) {
            parentStatus = 'WARNING';
        }

        return {
            id: 'operations',
            name: 'Operations',
            status: parentStatus,
            checkedAt,
            children
        };
    }

    getExecutionPipelineSubtree(): HealthNode {
        const checkedAt = new Date();
        const meta = this.lastPipelineMetadata;
        
        const visibilityLevel = meta?.observability?.pipelineVisibility || 'NONE';
        const lifecycleConfidence = meta?.observability?.lifecycle?.lifecycleConfidenceScore ?? 1.0;
        const invalidTrades = meta?.observability?.lifecycle?.invalidTrades ?? 0;

        // Pipeline Visibility Node
        let visibilityStatus: HealthStatus = 'HEALTHY';
        if (visibilityLevel === 'NONE') {
            visibilityStatus = 'CRITICAL';
        } else if (visibilityLevel === 'PARTIAL') {
            visibilityStatus = 'WARNING';
        }

        const visibilityNode: HealthNode = {
            id: 'execution.pipeline_visibility',
            name: 'Pipeline Visibility',
            status: visibilityStatus,
            message: `Visibility depth: ${visibilityLevel}`,
            checkedAt,
            metrics: meta?.observability || { level: visibilityLevel }
        };

        // Lifecycle Integrity Node
        let integrityStatus: HealthStatus = 'HEALTHY';
        if (invalidTrades > 0 || this.consecutiveStructuralViolations > 0) {
            integrityStatus = this.consecutiveStructuralViolations >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_STRUCTURAL_CRITICAL 
                ? 'CRITICAL' 
                : 'WARNING';
        } else if (lifecycleConfidence < MVP_CONFIG.RISK_PROTECTION.CONFIDENCE_WARNING_THRESHOLD) {
            integrityStatus = this.consecutiveConfidenceBreaches >= MVP_CONFIG.RISK_PROTECTION.CONSECUTIVE_CONFIDENCE_CRITICAL
                ? 'CRITICAL'
                : 'WARNING';
        }

        const integrityNode: HealthNode = {
            id: 'execution.lifecycle_integrity',
            name: 'Lifecycle Integrity',
            status: integrityStatus,
            message: `Confidence Score: ${(lifecycleConfidence * 100).toFixed(1)}% | Invalid trades: ${invalidTrades}`,
            checkedAt,
            metrics: meta?.observability?.lifecycle || { lifecycleConfidenceScore: lifecycleConfidence, invalidTrades }
        };

        const children = [visibilityNode, integrityNode];

        let parentStatus: HealthStatus = 'HEALTHY';
        if (children.some(c => c.status === 'CRITICAL')) {
            parentStatus = 'CRITICAL';
        } else if (children.some(c => c.status === 'WARNING')) {
            parentStatus = 'WARNING';
        }

        return {
            id: 'execution_pipeline',
            name: 'Execution Pipeline',
            status: parentStatus,
            checkedAt,
            children
        };
    }
}
