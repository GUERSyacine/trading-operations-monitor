import { flashCrashDetector } from '../agent/detectors/market/execution-intelligence/detectors/FlashCrashDetector';
import { spreadAnomalyDetector } from '../agent/detectors/market/execution-intelligence/detectors/SpreadDetector';
import { slippageIncident } from '../agent/detectors/market/execution-intelligence/detectors/SlippageDetector';
import { OperationsWatchdogService, RiskViolationType } from '../agent/detectors/operations/OperationsWatchdogService';
import { InfrastructureWatchdogService } from '../agent/detectors/infrastructure/InfrastructureWatchdogService';
import { HealthCheckResult } from '../shared/types/telemetry';
import { ExecutionIntelligenceService } from '../agent/detectors/market/execution-intelligence/ExecutionIntelligenceService';
import { IncidentManager } from '../agent/incident/manager/IncidentManager';
import { ReportingService } from '../agent/reporting/ReportingService';
import { AlertingService } from '../agent/notification/AlertingService';
import { HealthTreeService } from '../agent/incident/analysis/HealthTreeService';
import { prisma } from '../shared/prisma';
import { FreqtradeWebhookReceiver } from '../agent/detectors/infrastructure/FreqtradeWebhookReceiver';
import { WatchdogOrchestrator } from '../agent/WatchdogOrchestrator';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { MVP_CONFIG } from '../shared/mvpConfig';
import { EvidenceCollector } from '../agent/incident/analysis/EvidenceCollector';
import { TimelineReconstructor } from '../agent/incident/analysis/TimelineReconstructor';
import { CandidateGenerator, RootCauseCandidate } from '../agent/incident/rules/CandidateGenerator';
import { DockerRule, TelemetryRule, VMRule, NetworkRule, ExchangeRule, LifecycleRule } from '../agent/incident/rules/CandidateRules';
import { RootCauseScoringEngine } from '../agent/incident/analysis/RootCauseScoringEngine';
import {
    SupportingEvidenceRule,
    ContradictionRule,
    MissingEvidenceRule,
    ConcurrencyRule,
    CascadeSequenceRule,
    FirstOccurrenceRule,
    LifecycleDurationRule,
    EvaluationHintRule
} from '../agent/incident/rules/ScoringRules';

async function runTests() {
    console.log('====================================================');
    console.log('🧪 RUNNING SYSTEM INCIDENT ENGINE VERIFICATION SUITE');
    console.log('====================================================\n');

    let totalTests = 0;
    let passedTests = 0;

    function assert(condition: boolean, description: string) {
        totalTests++;
        if (condition) {
            passedTests++;
            console.log(`✅ [PASS] ${description}`);
        } else {
            console.error(`❌ [FAIL] ${description}`);
        }
    }

    // ----------------------------------------------------
    // TEST 1: Flash Crash Volatility shock detection
    // ----------------------------------------------------
    try {
        console.log('--- Checking Playbook 1: Flash Crash Detector ---');
        
        // Scenario A: Standard Normal Market Conditions (Should NOT trigger)
        const normalResult = flashCrashDetector('BTCUSDT', 0.005, 0.02, 120, 100);
        assert(normalResult === null, 'Should not trigger flash crash during normal market volatility.');

        // Scenario B: Volatility shock return but low volume (Should NOT trigger)
        const priceShockOnlyResult = flashCrashDetector('BTCUSDT', 0.09, 0.02, 100, 100);
        assert(priceShockOnlyResult === null, 'Should not trigger flash crash on return volatility alone without volume shock.');

        // Scenario C: Shock in both Volatility and Volume (Should trigger HIGH severity)
        const crashResult = flashCrashDetector('BTCUSDT', 0.12, 0.02, 450, 100);
        assert(crashResult !== null && crashResult.level === 'HIGH', 'Should halt trading on volatility shock AND volume shock.');
        if (crashResult) {
            console.log(`   > Trigger Reason: "${crashResult.reason}"`);
        }

        // Scenario D: Custom dynamic configuration check
        const customResult = flashCrashDetector('BTCUSDT', 0.05, 0.02, 150, 100, 2.0, 1.2);
        assert(customResult !== null && customResult.level === 'HIGH', 'Should halt with custom dynamic sensitivity multipliers.');
    } catch (e: any) {
        console.error('❌ Flash Crash detector test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 2: Spread Vacuum / Liquidity Shock detection
    // ----------------------------------------------------
    try {
        console.log('--- Checking Playbook 2: Spread Vacuum Detector ---');

        // Scenario A: Healthy Orderbook spreads (Should NOT trigger)
        const normalSpread = spreadAnomalyDetector('ETHUSDT', 0.02, 0.015);
        assert(normalSpread === null, 'Should not trigger spreads alerts during normal liquidity environments.');

        // Scenario B: Spread Vacuum (Should trigger HIGH severity)
        const spreadVacuum = spreadAnomalyDetector('ETHUSDT', 0.12, 0.015);
        assert(spreadVacuum !== null && spreadVacuum.level === 'HIGH', 'Should restrict executing trades (DEGRADED) on spread explosion.');
        if (spreadVacuum) {
            console.log(`   > Trigger Reason: "${spreadVacuum.reason}"`);
        }
    } catch (e: any) {
        console.error('❌ Spread Vacuum detector test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 3: Slippage / Execution Quality deviation
    // ----------------------------------------------------
    try {
        console.log('--- Checking Playbook 4: Slippage Deviation ---');

        // Scenario A: Zero/Negative price protection
        const badPrice = slippageIncident('SOLUSDT', 0, 15, 0.005);
        assert(badPrice === null, 'Should gracefully bypass and return null on invalid non-positive expected prices.');

        // Scenario B: Healthy fills (Should NOT trigger)
        const healthyFill = slippageIncident('SOLUSDT', 100.0, 100.2, 0.005);
        assert(healthyFill === null, 'Should not trigger anomalies during regular healthy fills.');

        // Scenario C: Execution anomaly (Should trigger HIGH severity)
        const slippageAnomaly = slippageIncident('SOLUSDT', 100.0, 101.5, 0.005);
        assert(slippageAnomaly !== null && slippageAnomaly.level === 'HIGH', 'Should halt trading on extreme slippage deviations.');
        if (slippageAnomaly) {
            console.log(`   > Trigger Reason: "${slippageAnomaly.reason}"`);
        }
    } catch (e: any) {
        console.error('❌ Slippage playbook test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 4: Operations Watchdog Service
    // ----------------------------------------------------
    try {
        console.log('--- Checking Service: Operations Watchdog Service ---');

        const mockAlerting: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        let mockHaltCalled: 'STOP_BUY' | 'STOP' | null = null;
        const mockAdapter: any = {
            async executeActiveHalt(type: 'STOP_BUY' | 'STOP') {
                mockHaltCalled = type;
            }
        };

        const mockIncidentManager: any = {
            incidentsReported: [] as any[],
            incidentsResolved: [] as any[],
            async reportIncident(incident: any) {
                this.incidentsReported.push(incident);
            },
            async resolveIncidentBySource(source: string, symbol: string | null = null) {
                this.incidentsResolved.push({ source, symbol });
            },
            getActiveIncidentsCount() {
                const active = new Set<string>();
                for (const inc of this.incidentsReported) {
                    active.add(inc.source);
                }
                for (const res of this.incidentsResolved) {
                    active.delete(res.source);
                }
                return active.size;
            },
            isHalted() {
                const active = new Set<string>();
                for (const inc of this.incidentsReported) {
                    if (inc.level === 'CRITICAL') {
                        active.add(inc.source);
                    }
                }
                for (const res of this.incidentsResolved) {
                    active.delete(res.source);
                }
                return active.has('LIFECYCLE_INTEGRITY');
            }
        };

        const watchdog = new OperationsWatchdogService(mockAlerting, mockIncidentManager as any, mockAdapter as any, 5 * 60 * 1000);

        // Dynamically override prisma.decisionAudit query handlers
        let mockFindFirst: any = async () => null;
        let mockFindMany: any = async () => [];
        const opsOriginalCreate = (prisma.decisionAudit as any).create;
        let mockCreate: any = async (args: any) => args.data as any;

        (prisma.decisionAudit as any).findFirst = async (args: any) => mockFindFirst(args);
        (prisma.decisionAudit as any).create = async (args: any) => mockCreate(args);
        (prisma.decisionAudit as any).findMany = async (args: any) => {
            let filtered = await mockFindMany(args);
            if (args?.where?.classification) {
                const filter = args.where.classification;
                if (typeof filter === 'string') {
                    filtered = filtered.filter((item: any) => item.classification === filter);
                } else if (filter && typeof filter === 'object') {
                    if (filter.in) {
                        filtered = filtered.filter((item: any) => filter.in.includes(item.classification));
                    } else if (filter.equals) {
                        filtered = filtered.filter((item: any) => item.classification === filter.equals);
                    }
                }
            }
            if (args?.where?.createdAt) {
                const filter = args.where.createdAt;
                if (filter.gte) {
                    filtered = filtered.filter((item: any) => {
                        const date = item.createdAt ? new Date(item.createdAt) : new Date();
                        return date >= filter.gte;
                    });
                }
                if (filter.lte) {
                    filtered = filtered.filter((item: any) => {
                        const date = item.createdAt ? new Date(item.createdAt) : new Date();
                        return date <= filter.lte;
                    });
                }
            }
            return filtered;
        };

        // 4.1 checkHeartbeat
        // Scenario A: Bot logged a heartbeat 10 seconds ago (Healthy)
        mockFindFirst = async () => ({
            createdAt: new Date(Date.now() - 10 * 1000)
        });
        mockAlerting.alertsSent = [];
        const hbAlive = await watchdog.checkHeartbeat();
        assert(hbAlive.healthy === true, 'Heartbeat check should pass when latest audit was 10 seconds ago.');
        assert(hbAlive.source === 'HEARTBEAT', 'Heartbeat source should be HEARTBEAT.');
        assert(typeof hbAlive.checkDurationMs === 'number', 'Heartbeat check includes checkDurationMs.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert should be sent when bot is alive.');
        assert(mockIncidentManager.incidentsResolved.some((r: any) => r.source === 'HEARTBEAT'), 'Heartbeat recovery should call resolveIncidentBySource.');
        assert(hbAlive.metadata?.watchdogVersion === '1.0.0', 'Metadata includes watchdogVersion.');
        assert(hbAlive.metadata?.serviceName === 'OperationsWatchdogService', 'Metadata includes serviceName.');
        assert(hbAlive.metadata?.environment !== undefined, 'Metadata includes environment.');
        assert(hbAlive.metadata?.checkId === 'heartbeat_check', 'Metadata includes checkId.');
        assert(hbAlive.metadata?.maxFailures === 3, 'Metadata includes maxFailures.');

        // Scenario B: Bot logged a heartbeat 10 minutes ago (Lost)
        mockFindFirst = async () => ({
            createdAt: new Date(Date.now() - 10 * 60 * 1000)
        });
        mockAlerting.alertsSent = [];
        mockIncidentManager.incidentsReported = [];
        (watchdog as any).heartbeatFailures = 0;

        const hbFail1 = await watchdog.checkHeartbeat();
        assert(hbFail1.healthy === false, 'Heartbeat should fail on first silence check.');
        assert(hbFail1.severity === 'WARNING', 'First heartbeat failure has WARNING severity.');
        assert(hbFail1.message === 'Heartbeat warning', 'First heartbeat failure has intermediate warning message.');

        const hbFail2 = await watchdog.checkHeartbeat();
        assert(hbFail2.healthy === false, 'Heartbeat should fail on second silence check.');
        assert(hbFail2.severity === 'WARNING', 'Second heartbeat failure has WARNING severity.');
        assert(hbFail2.message === 'Heartbeat warning', 'Second heartbeat failure has intermediate warning message.');

        const hbDead = await watchdog.checkHeartbeat();
        assert(hbDead.healthy === false, 'Heartbeat check should fail on third silence check.');
        assert(hbDead.severity === 'CRITICAL', 'Third consecutive failure has CRITICAL severity.');
        assert(hbDead.message?.includes('No decision audits logged') === true, 'Third consecutive failure contains the actual error detail.');
        assert(mockAlerting.alertsSent.length === 2, 'Two warning alerts sent from OperationsWatchdog directly.');
        assert(mockIncidentManager.incidentsReported.length === 1, 'One critical incident reported to IncidentManager.');
        assert(mockIncidentManager.incidentsReported[0].source === 'HEARTBEAT', 'Incident source should be HEARTBEAT.');
        assert(mockIncidentManager.incidentsReported[0].level === 'CRITICAL', 'Incident level should be CRITICAL.');

        // 4.2 checkTradeFrequency
        // Scenario A: Has trades (Healthy)
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const freqHealthy = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqHealthy.healthy === true, 'Trade frequency check should pass if at least 1 trade in window.');
        assert(freqHealthy.source === 'TRADE_FREQUENCY', 'Trade frequency source should be TRADE_FREQUENCY.');
        assert(freqHealthy.metadata?.maxFailures === 3, 'Trade frequency metadata includes maxFailures.');

        // Scenario B: Silence (Unhealthy)
        mockFindMany = async () => [];
        mockAlerting.alertsSent = [];
        (watchdog as any).tradeFrequencyFailures.clear();

        const freqFail1 = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqFail1.healthy === false, 'Trade frequency check should return healthy: false on first failure.');
        assert(freqFail1.severity === 'WARNING', 'First failure has WARNING severity.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert sent on first trade frequency failure.');

        const freqFail2 = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqFail2.healthy === false, 'Trade frequency check should return healthy: false on second failure.');
        assert(freqFail2.severity === 'WARNING', 'Second failure has WARNING severity.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert sent on second trade frequency failure.');

        const freqSilent = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqSilent.healthy === false, 'Trade frequency check should fail on third failure.');
        assert(freqSilent.severity === 'WARNING', 'Third failure has WARNING severity.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Strategy Silence Detected', 'Should send Strategy Silence warning.');

        // 4.3 checkBrokerConnection
        // Scenario A: Connected (Healthy)
        mockFindFirst = async () => ({
            classification: 'BROKER_PING',
            createdAt: new Date(),
            metadata: { connected: true }
        });
        mockAlerting.alertsSent = [];
        const brokerHealthy = await watchdog.checkBrokerConnection();
        assert(brokerHealthy.healthy === true, 'Broker connection check should pass when connected=true.');
        assert(brokerHealthy.source === 'BROKER_CONNECTION', 'Broker connection source should be BROKER_CONNECTION.');
        assert(mockIncidentManager.incidentsResolved.some((r: any) => r.source === 'BROKER_CONNECTION'), 'Broker connection recovery should call resolveIncidentBySource.');

        // Scenario B: Reporting Disconnected (Unhealthy)
        mockFindFirst = async () => ({
            classification: 'BROKER_PING',
            createdAt: new Date(),
            metadata: { connected: false, error: 'MT5 offline' }
        });
        mockAlerting.alertsSent = [];
        mockIncidentManager.incidentsReported = [];
        (watchdog as any).brokerFailures = 0;

        const brFail1 = await watchdog.checkBrokerConnection();
        assert(brFail1.healthy === false, 'Broker connection check should fail on first failure.');
        assert(brFail1.severity === 'WARNING', 'First broker failure has WARNING severity.');

        const brFail2 = await watchdog.checkBrokerConnection();
        assert(brFail2.healthy === false, 'Broker connection check should fail on second failure.');
        assert(brFail2.severity === 'WARNING', 'Second broker failure has WARNING severity.');

        const brokerFailed = await watchdog.checkBrokerConnection();
        assert(brokerFailed.healthy === false, 'Broker connection check should fail on third failure.');
        assert(brokerFailed.severity === 'CRITICAL', 'Third broker failure has CRITICAL severity.');
        assert(mockAlerting.alertsSent.length === 2, 'Two warning alerts sent from OperationsWatchdog directly.');
        assert(mockIncidentManager.incidentsReported.length === 1, 'One critical incident reported to IncidentManager.');
        assert(mockIncidentManager.incidentsReported[0].source === 'BROKER_CONNECTION', 'Incident source should be BROKER_CONNECTION.');
        assert(mockIncidentManager.incidentsReported[0].level === 'CRITICAL', 'Incident level should be CRITICAL.');

        // Scenario C: Stale connection check (Unhealthy)
        mockFindFirst = async () => null; // No connection events at all
        mockAlerting.alertsSent = [];
        // Reset broker failures from previous state by calling it healthy first, then 3 fails
        mockFindFirst = async () => ({
            classification: 'BROKER_PING',
            createdAt: new Date(),
            metadata: { connected: true }
        });
        await watchdog.checkBrokerConnection();
        // Now set to null to fail
        mockFindFirst = async () => null;
        
        const brStale1 = await watchdog.checkBrokerConnection();
        assert(brStale1.healthy === false, 'Broker connection check should fail on first stale event.');
        assert(brStale1.severity === 'WARNING', 'First stale event has WARNING severity.');

        const brStale2 = await watchdog.checkBrokerConnection();
        assert(brStale2.healthy === false, 'Broker connection check should fail on second stale event.');
        assert(brStale2.severity === 'WARNING', 'Second stale event has WARNING severity.');

        mockIncidentManager.incidentsReported = [];
        const brokerStale = await watchdog.checkBrokerConnection();
        assert(brokerStale.healthy === false, 'Broker check should fail when no ping logs are found in the timeframe.');
        assert(brokerStale.severity === 'CRITICAL', 'Third stale event has CRITICAL severity.');
        assert(mockIncidentManager.incidentsReported.length === 1, 'One critical incident reported on stale broker connection.');
        assert(mockIncidentManager.incidentsReported[0].source === 'BROKER_CONNECTION', 'Stale incident source is BROKER_CONNECTION.');

        // 4.4 checkMarketDataFeed
        // Scenario A: Tick received recently (Healthy)
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(), metadata: { lastMarketTimestamp: Date.now(), timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedHealthy = await watchdog.checkMarketDataFeed();
        assert(feedHealthy.healthy === true, 'Market data feed should pass when recent tick is received.');
        assert(feedHealthy.source === 'MARKET_DATA', 'Market data feed source should be MARKET_DATA.');
        assert(typeof feedHealthy.metadata?.latestTickAgeMs === 'number', 'Market feed metadata includes latestTickAgeMs as a number.');
        assert(feedHealthy.metadata?.latestTickAgeMs >= 0, 'Market feed metadata latestTickAgeMs is non-negative.');
        assert(feedHealthy.metadata?.latestTickTimestamp instanceof Date, 'Market feed metadata includes latestTickTimestamp as a Date.');

        // Scenario B: Stale / No tick (Unhealthy)
        mockFindMany = async () => [];
        mockAlerting.alertsSent = [];
        const feedStale = await watchdog.checkMarketDataFeed(30 * 1000);
        assert(feedStale.healthy === false, 'Market data feed should fail if no ticks received in window.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Market Data Telemetry Stale', 'Triggers market telemetry stale warning alert.');

        // Scenario C: Malformed metadata (Unhealthy)
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(), metadata: { sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedMalformed = await watchdog.checkMarketDataFeed();
        assert(feedMalformed.healthy === false, 'Market data feed should fail if metadata is malformed.');
        assert(feedMalformed.severity === 'WARNING', 'Malformed metadata check has WARNING severity.');
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Market Data Telemetry Failure'), 'Triggers malformed warning alert.');

        // Scenario D: Stale telemetry (Unhealthy)
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(Date.now() - 120 * 1000), metadata: { lastMarketTimestamp: Date.now(), timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedStaleTs = await watchdog.checkMarketDataFeed(60 * 1000);
        assert(feedStaleTs.healthy === false, 'Market data feed should fail if telemetry is too old.');
        assert(feedStaleTs.severity === 'WARNING', 'Stale telemetry check has WARNING severity.');
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Market Data Telemetry Stale'), 'Triggers stale telemetry warning alert.');

        // Scenario E: Stuck metadata (Unhealthy)
        const stuckTs = Date.now() - 10 * 1000;
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(), metadata: { lastMarketTimestamp: stuckTs, timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } },
            { classification: 'MARKET_DATA', createdAt: new Date(Date.now() - 5 * 60 * 1000), metadata: { lastMarketTimestamp: stuckTs, timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } },
            { classification: 'MARKET_DATA', createdAt: new Date(Date.now() - 11 * 60 * 1000), metadata: { lastMarketTimestamp: stuckTs, timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedStuck = await watchdog.checkMarketDataFeed();
        assert(feedStuck.healthy === false, 'Market data feed should fail if timestamp has not advanced for longer than progression factor.');
        assert(feedStuck.severity === 'WARNING', 'Stuck metadata check has WARNING severity.');
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Market Data Feed Stuck'), 'Triggers stuck warning alert.');

        // Scenario F: Dynamic staleness threshold derived from heartbeatIntervalMs (Healthy / Unhealthy)
        // Case F.1: telemetry age = 75 seconds, heartbeatIntervalMs = 60 seconds (threshold = 180s) -> Healthy
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(Date.now() - 75 * 1000), metadata: { lastMarketTimestamp: Date.now(), timeframe: '5m', sourceSystem: 'freqtrade', heartbeatIntervalMs: 60000, symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedHealthyDynamic = await watchdog.checkMarketDataFeed(60000);
        assert(feedHealthyDynamic.healthy === true, 'Market data feed should pass if age (75s) is below dynamic threshold (180s).');

        // Case F.2: telemetry age = 190 seconds, heartbeatIntervalMs = 60 seconds (threshold = 180s) -> Unhealthy
        mockFindMany = async () => [
            { classification: 'MARKET_DATA', createdAt: new Date(Date.now() - 190 * 1000), metadata: { lastMarketTimestamp: Date.now(), timeframe: '5m', sourceSystem: 'freqtrade', heartbeatIntervalMs: 60000, symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedStaleDynamic = await watchdog.checkMarketDataFeed(60000);
        assert(feedStaleDynamic.healthy === false, 'Market data feed should fail if age (190s) is above dynamic threshold (180s).');
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Market Data Telemetry Stale'), 'Triggers dynamic stale warning alert.');

        // 4.5 checkOrderPipeline
        const originalFindFirst = (prisma.decisionAudit as any).findFirst;
        // Scenario A: Only ORDER telemetry
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() },
            { classification: 'ORDER', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const pipelineA = await watchdog.checkOrderPipeline();
        assert(pipelineA.healthy === true, 'Pipeline check should pass when only ORDER telemetry is present (LIMITED visibility).');
        assert(pipelineA.metadata?.observability?.pipelineVisibility === 'LIMITED', 'Pipeline visibility should be LIMITED.');
        assert(pipelineA.metadata?.observability?.coverage?.coverageRatio === 1.0, 'coverageRatio should default to 1.0 under LIMITED visibility.');
        assert(pipelineA.metadata?.observability?.confidence?.score === 'LOW', 'Confidence score should be LOW under LIMITED visibility.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert should trigger under LIMITED visibility.');

        // Scenario B: SIGNAL + FILL telemetry (Normal flow)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(), metadata: { tradeId: 'trade_2', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(), metadata: { tradeId: 'trade_2', symbol: 'BTCUSDT' } },
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 6000 * 1000), metadata: { tradeId: 'trade_1', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 5000 * 1000), metadata: { tradeId: 'trade_1', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const pipelineB = await watchdog.checkOrderPipeline();
        assert(pipelineB.healthy === true, 'Pipeline check should pass when SIGNAL has matching ORDER_FILLED (PARTIAL visibility).');
        assert(pipelineB.metadata?.observability?.pipelineVisibility === 'PARTIAL', 'Pipeline visibility should be PARTIAL.');
        assert(pipelineB.metadata?.observability?.confidence?.score === 'HIGH', 'Confidence score should be HIGH.');
        assert(pipelineB.metadata?.observability?.coverage?.coverageRatio === 1.0, 'coverageRatio should be 1.0 (1 signal, 1 fill).');
        assert(mockAlerting.alertsSent.length === 0, 'No alert should trigger under normal flow.');

        // Scenario C: Recent SIGNAL (No fill yet, within timeout)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 'trade_2', symbol: 'BTCUSDT' } }
        ];
        (prisma.decisionAudit as any).findFirst = async () => null;
        mockAlerting.alertsSent = [];
        const pipelineC = await watchdog.checkOrderPipeline();
        assert(pipelineC.healthy === true, 'Pipeline check should pass for a recent signal within grace period.');
        assert(pipelineC.metadata?.observability?.pipelineVisibility === 'PARTIAL', 'Pipeline visibility should be PARTIAL.');
        assert(pipelineC.metadata?.observability?.coverage?.coverageRatio === 1.0, 'coverageRatio should be 1.0.');
        assert(pipelineC.metadata?.observability?.confidence?.score === 'HIGH', 'Confidence score should be HIGH.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert should trigger for recent unfilled signal.');

        // Scenario E: Webhook Ingestion Integration
        const receiver = new FreqtradeWebhookReceiver(new EventPersistenceService(), 9876, '127.0.0.1');
        receiver.start();

        let persistedEvents: any[] = [];
        const webhookOriginalCreate = (prisma.decisionAudit as any).create;
        (prisma.decisionAudit as any).create = async (args: any) => {
            persistedEvents.push(args.data);
            return args.data as any;
        };

        const response1 = await fetch('http://127.0.0.1:9876/webhooks/freqtrade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'entry',
                trade_id: 101,
                symbol: 'ETH/USDT',
                strategy: 'TREND_RIDER',
                direction: 'long',
                price: 3200,
                amount: 0.5
            })
        });
        const resJson1 = await response1.json() as any;
        assert(response1.status === 200, 'Webhook receiver should return status 200 for SIGNAL.');
        assert(resJson1.status === 'success', 'SIGNAL ingestion should be successful.');
        assert(persistedEvents.length === 1 && persistedEvents[0].classification === 'SIGNAL', 'Persists SIGNAL event.');
        assert((persistedEvents[0].metadata as any).lifecycleEvent.symbol === 'ETHUSDT', 'Symbol is normalized to ETHUSDT.');

        persistedEvents = [];
        const response2 = await fetch('http://127.0.0.1:9876/webhooks/freqtrade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'entry_fill',
                trade_id: 101,
                order_id: 'order_abc',
                symbol: 'ETH/USDT',
                price: 3205,
                amount: 0.5
            })
        });
        const resJson2 = await response2.json() as any;
        assert(response2.status === 200, 'Webhook receiver should return 200 for fill.');
        assert(persistedEvents.length === 1 && persistedEvents[0].classification === 'ORDER_FILLED', 'Persists ORDER_FILLED event.');
        assert((persistedEvents[0].metadata as any).lifecycleEvent.orderId === 'order_abc', 'orderId is stored correctly.');

        (prisma.decisionAudit as any).create = webhookOriginalCreate;
        await receiver.stop();

        // Scenario D: Old SIGNAL (No fill beyond timeout)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 4000 * 1000), metadata: { tradeId: 'trade_3', symbol: 'BTCUSDT' } },
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 'trade_4', symbol: 'BTCUSDT' } }
        ];
        (prisma.decisionAudit as any).findFirst = async () => null;
        mockAlerting.alertsSent = [];
        const pipelineD = await watchdog.checkOrderPipeline();
        assert(pipelineD.healthy === false, 'Pipeline check should fail when a signal exceeds the fill timeout without a corresponding fill.');
        assert(pipelineD.severity === 'WARNING', 'Pipeline failure has WARNING severity.');
        assert(pipelineD.metadata?.observability?.confidence?.score === 'HIGH', 'Confidence score should remain HIGH (good telemetry).');
        assert(pipelineD.metadata?.observability?.coverage?.coverageRatio === 0.0, 'coverageRatio should be 0.0 (1 eligible signal, 0 fills).');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Signal Fill Timeout', 'Triggers Signal Fill Timeout warning alert.');

        // Scenario F: Schema Drift (Signal without tradeId)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 10 * 1000), metadata: { symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const pipelineF = await watchdog.checkOrderPipeline();
        assert(pipelineF.healthy === true, 'Pipeline check remains healthy for recent signals.');
        assert(pipelineF.metadata?.observability?.pipelineVisibility === 'PARTIAL', 'Pipeline visibility is PARTIAL.');
        assert(pipelineF.metadata?.observability?.confidence?.score === 'LOW', 'Confidence score is LOW due to missing tradeId.');
        assert(pipelineF.metadata?.observability?.correlation?.signalsWithoutTradeId === 1, 'Signals without tradeId is 1.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Observability Schema Drift', 'Triggers Observability Schema Drift warning alert.');

        // Scenario G: Sustained Degradation & Trends (Phase 2C)
        const mockHealthyHistory = Array.from({ length: 10 }, (_, i) => ({
            classification: 'OBSERVABILITY_METRICS',
            createdAt: new Date(Date.now() - (i + 1) * 30 * 60 * 1000), // every 30 mins
            metadata: {
                observability: {
                    pipelineVisibility: 'PARTIAL',
                    coverage: { coverageRatio: 1.0 },
                    correlation: { correlationQualityRatio: 1.0 },
                    confidence: { score: 'HIGH' }
                }
            }
        }));

        let persistedObservabilitySnapshots: any[] = [];
        mockCreate = async (args: any) => {
            if (args.data.classification === 'OBSERVABILITY_METRICS') {
                persistedObservabilitySnapshots.push(args.data);
            }
            return args.data as any;
        };

        const runScenarioGCheck = async (degradedHistoryCount: number) => {
            const history = [...mockHealthyHistory];
            for (let i = 0; i < degradedHistoryCount; i++) {
                history[i] = {
                    classification: 'OBSERVABILITY_METRICS',
                    createdAt: new Date(Date.now() - (i + 1) * 60 * 1000), // 1 or 2 mins ago
                    metadata: {
                        observability: {
                            pipelineVisibility: 'PARTIAL',
                            coverage: { coverageRatio: 0.80 },
                            correlation: { correlationQualityRatio: 0.85 },
                            confidence: { score: 'MEDIUM' }
                        }
                    }
                };
            }

            const activeAudits = [
                { classification: 'SIGNAL', createdAt: new Date(Date.now() - 70 * 60 * 1000), metadata: { tradeId: 't1', symbol: 'BTCUSDT' } }, // eligible, filled
                { classification: 'SIGNAL', createdAt: new Date(Date.now() - 70 * 60 * 1000), metadata: { tradeId: 't2', symbol: 'BTCUSDT' } }, // eligible, unfilled
                { classification: 'SIGNAL', createdAt: new Date(Date.now() - 70 * 60 * 1000), metadata: { symbol: 'BTCUSDT' } }, // eligible, uncorrelatable
                { classification: 'SIGNAL', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't4', symbol: 'BTCUSDT' } }, // not eligible
                { classification: 'SIGNAL', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't5', symbol: 'BTCUSDT' } }, // not eligible
                { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 65 * 60 * 1000), metadata: { tradeId: 't1', symbol: 'BTCUSDT' } }
            ];

            mockFindMany = async () => [...activeAudits, ...history];
            mockAlerting.alertsSent = [];

            return await watchdog.checkOrderPipeline(2 * 60 * 60 * 1000);
        };

        persistedObservabilitySnapshots = [];
        const checkG1 = await runScenarioGCheck(0);
        assert(checkG1.healthy === false, 'Scenario G1: Pipeline check 1 should be unhealthy.');
        assert(checkG1.metadata?.observability?.coverage?.eligibleSignals === 3, 'Scenario G1: check 1 eligibleSignals = 3.');
        assert(checkG1.metadata?.observability?.analytics?.uncorrelatableSignalCount === 1, 'Scenario G1: check 1 uncorrelatableSignalCount = 1.');
        assert(checkG1.metadata?.observability?.coverage?.coverageRatio === 0.50, 'Scenario G1: check 1 coverageRatio = 0.50.');
        assert(checkG1.metadata?.observability?.correlation?.correlationQualityRatio === 0.80, 'Scenario G1: check 1 correlationQualityRatio = 0.80.');
        assert(checkG1.metadata?.observability?.trends?.historical24hP95Coverage === 1.0, 'Scenario G1: check 1 P95 coverage = 1.0.');
        assert(checkG1.metadata?.observability?.trends?.historical24hP95Correlation === 1.0, 'Scenario G1: check 1 P95 correlation = 1.0.');
        assert(checkG1.metadata?.observability?.trends?.coverageRatioChange === -0.50, 'Scenario G1: check 1 coverageRatioChange = -0.50.');
        assert(checkG1.metadata?.observability?.trends?.correlationQualityRatioChange === -0.20, 'Scenario G1: check 1 correlationQualityRatioChange = -0.20.');
        assert(checkG1.metadata?.observability?.trends?.highConfidenceChecks24h === 10, 'Scenario G1: check 1 highConfidenceChecks24h = 10.');
        assert(mockAlerting.alertsSent.filter((a: any) => a.title.includes('Degradation Trend')).length === 0, 'Scenario G1: No trend alert on single check drop.');
        assert(persistedObservabilitySnapshots.length === 1, 'Scenario G1: Snapshot was successfully persisted.');

        const checkG2 = await runScenarioGCheck(1);
        assert(mockAlerting.alertsSent.filter((a: any) => a.title.includes('Degradation Trend')).length === 0, 'Scenario G2: No trend alert on second consecutive drop.');

        const checkG3 = await runScenarioGCheck(2);
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Observability Coverage Degradation Trend'), 'Scenario G3: Fires coverage degradation trend alert on 3 consecutive drops.');
        assert(mockAlerting.alertsSent.some((a: any) => a.title === 'Observability Correlation Degradation Trend'), 'Scenario G3: Fires correlation degradation trend alert on 3 consecutive drops.');

        mockCreate = async (args: any) => args.data as any;
        (prisma.decisionAudit as any).findFirst = originalFindFirst;

        // Scenario H: Full Visibility Foundation (Phase 3A)
        console.log('   > Running Scenario H: Full Visibility Foundation...');
        // Scenario H1: Complete lifecycle (SIGNAL -> ORDER_CREATED -> ORDER_SUBMITTED -> ORDER_ACKNOWLEDGED -> ORDER_OPEN -> PARTIALLY_FILLED -> FILLED)
        // With Two-Stage Correlation: ORDER_OPEN, ORDER_ACKNOWLEDGED, and ORDER_PARTIALLY_FILLED are correlated by orderId (since they have orderId but no tradeId).
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_SUBMITTED', createdAt: new Date(Date.now() - 35 * 1000), metadata: { tradeId: 't100', orderId: 'ord100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_ACKNOWLEDGED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { orderId: 'ord100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 25 * 1000), metadata: { orderId: 'ord100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_PARTIALLY_FILLED', createdAt: new Date(Date.now() - 20 * 1000), metadata: { orderId: 'ord100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't100', orderId: 'ord100', symbol: 'BTCUSDT' } }
        ];

        mockAlerting.alertsSent = [];
        const checkH1 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkH1.healthy === true, 'Scenario H1 should be healthy.');
        assert(checkH1.metadata?.observability?.pipelineVisibility === 'FULL', 'Scenario H1 visibility should be FULL.');
        assert(checkH1.metadata?.observability?.lifecycle?.totalTradesAnalyzed === 1, 'Scenario H1 should analyze 1 trade.');
        assert(checkH1.metadata?.observability?.lifecycle?.tradesWithLifecycleTelemetry === 1, 'Scenario H1 should have lifecycle telemetry for 1 trade.');
        assert(checkH1.metadata?.observability?.lifecycle?.intermediateEventsObserved === 5, 'Scenario H1 should observe 5 intermediate events (created, submitted, ack, open, partiallyFilled).');
        assert(checkH1.metadata?.observability?.lifecycle?.correlationConflicts === 0, 'Scenario H1 should have 0 correlation conflicts.');

        // Scenario H2: Correlation Conflict Detection
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_SUBMITTED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', orderId: 'ord100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_SUBMITTED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't200', orderId: 'ord100', symbol: 'BTCUSDT' } } // Conflict! Same orderId, different tradeId
        ];
        const checkH2 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkH2.metadata?.observability?.lifecycle?.correlationConflicts === 1, 'Scenario H2 should register 1 correlation conflict.');

        // Scenario I: Lifecycle Integrity Validation (Phase 3B)
        console.log('   > Running Scenario I: Lifecycle Integrity Validation...');
        // Test I1 (Valid Timeline with Skipped Stages): SIGNAL -> ORDER_FILLED directly
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        const checkI1 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI1.metadata?.observability?.lifecycle?.validTrades === 1, 'Scenario I1: validTrades should be 1.');
        assert(checkI1.metadata?.observability?.lifecycle?.tradesWithSkippedStages === 1, 'Scenario I1: tradesWithSkippedStages should be 1.');
        assert(checkI1.metadata?.observability?.lifecycle?.invalidTrades === 0, 'Scenario I1: invalidTrades should be 0.');
        assert(checkI1.metadata?.observability?.lifecycle?.incompleteTrades === 0, 'Scenario I1: incompleteTrades should be 0.');
        assert(checkI1.metadata?.observability?.lifecycle?.terminalTrades === 1, 'Scenario I1: terminalTrades should be 1.');
        assert(checkI1.metadata?.observability?.lifecycle?.lifecycleConfidenceScore === 1.0, 'Scenario I1: confidence score should be 1.0.');

        // Test I2 (Invalid Timeline with Backward Transition): ORDER_FILLED -> ORDER_OPEN
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        const checkI2 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI2.metadata?.observability?.lifecycle?.invalidTrades === 1, 'Scenario I2: invalidTrades should be 1.');
        assert(checkI2.metadata?.observability?.lifecycle?.validTrades === 0, 'Scenario I2: validTrades should be 0.');
        assert(checkI2.metadata?.observability?.lifecycle?.incompleteTrades === 0, 'Scenario I2: incompleteTrades should be 0.');
        assert(checkI2.metadata?.observability?.lifecycle?.lifecycleConfidenceScore === 0.0, 'Scenario I2: confidence score should be 0.0.');

        // Test I3 (Incomplete Trade): SIGNAL -> ORDER_CREATED
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        const checkI3 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI3.metadata?.observability?.lifecycle?.incompleteTrades === 1, 'Scenario I3: incompleteTrades should be 1.');
        assert(checkI3.metadata?.observability?.lifecycle?.validTrades === 0, 'Scenario I3: validTrades should be 0.');
        assert(checkI3.metadata?.observability?.lifecycle?.invalidTrades === 0, 'Scenario I3: invalidTrades should be 0.');
        assert(checkI3.metadata?.observability?.lifecycle?.terminalTrades === 0, 'Scenario I3: terminalTrades should be 0.');
        assert(checkI3.metadata?.observability?.lifecycle?.lifecycleConfidenceScore === 1.0, 'Scenario I3: confidence score should be 1.0 (incomplete ignored).');

        // Test I4 (Duplicate Events): SIGNAL -> ORDER_SUBMITTED -> ORDER_SUBMITTED -> ORDER_FILLED
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_SUBMITTED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_SUBMITTED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 20 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        const checkI4 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI4.metadata?.observability?.lifecycle?.validTrades === 1, 'Scenario I4: validTrades should be 1.');
        assert(checkI4.metadata?.observability?.lifecycle?.duplicateEventsObserved === 1, 'Scenario I4: duplicateEventsObserved should be 1.');

        // Test I5 (Terminal Mutation): SIGNAL -> ORDER_OPEN -> ORDER_CANCELLED -> ORDER_FILLED
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_CANCELLED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 20 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        const checkI5 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI5.metadata?.observability?.lifecycle?.invalidTrades === 1, 'Scenario I5: invalidTrades should be 1.');
        assert(checkI5.metadata?.observability?.lifecycle?.validTrades === 0, 'Scenario I5: validTrades should be 0.');

        // Test I6 (Multiple Orders - Entry/Exit): ORDER_FILLED (entry) followed by ORDER_CREATED -> ORDER_FILLED (exit)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 60 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', orderId: 'entry_buy', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', orderId: 'entry_buy', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', orderId: 'exit_sell', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 20 * 1000), metadata: { tradeId: 't100', orderId: 'exit_sell', symbol: 'BTCUSDT' } }
        ];
        const checkI6 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI6.metadata?.observability?.lifecycle?.validTrades === 1, 'Scenario I6: validTrades should be 1.');
        assert(checkI6.metadata?.observability?.lifecycle?.invalidTrades === 0, 'Scenario I6: invalidTrades should be 0.');
        assert(checkI6.metadata?.observability?.lifecycle?.incompleteTrades === 0, 'Scenario I6: incompleteTrades should be 0.');
        assert(checkI6.metadata?.observability?.lifecycle?.terminalTrades === 1, 'Scenario I6: terminalTrades should be 1.');
        assert(checkI6.metadata?.observability?.lifecycle?.lifecycleConfidenceScore === 1.0, 'Scenario I6: confidence score should be 1.0.');

        // Test I7 (Multiple Orders - DCA): Order A (Buy 1), Order B (Buy 2), Order C (Exit)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 80 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            // Order A (Entry buy)
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 70 * 1000), metadata: { tradeId: 't100', orderId: 'order_a', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 65 * 1000), metadata: { tradeId: 't100', orderId: 'order_a', symbol: 'BTCUSDT' } },
            // Order B (DCA buy)
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 60 * 1000), metadata: { tradeId: 't100', orderId: 'order_b', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 55 * 1000), metadata: { tradeId: 't100', orderId: 'order_b', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', orderId: 'order_b', symbol: 'BTCUSDT' } },
            // Order C (Exit sell)
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', orderId: 'order_c', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', orderId: 'order_c', symbol: 'BTCUSDT' } }
        ];
        const checkI7 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkI7.metadata?.observability?.lifecycle?.validTrades === 1, 'Scenario I7: validTrades should be 1.');
        assert(checkI7.metadata?.observability?.lifecycle?.invalidTrades === 0, 'Scenario I7: invalidTrades should be 0.');
        assert(checkI7.metadata?.observability?.lifecycle?.incompleteTrades === 0, 'Scenario I7: incompleteTrades should be 0.');
        assert(checkI7.metadata?.observability?.lifecycle?.terminalTrades === 1, 'Scenario I7: terminalTrades should be 1.');
        assert(checkI7.metadata?.observability?.lifecycle?.lifecycleConfidenceScore === 1.0, 'Scenario I7: confidence score should be 1.0.');

        // Scenario J: Execution Risk Protection (Phase 3C)
        console.log('   > Running Scenario J: Execution Risk Protection...');

        // Test J1: Mode = ALERT_ONLY, Structural Violation Warning (1 cycle) & Critical (3 cycles)
        MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE = 'ALERT_ONLY';
        (watchdog as any).consecutiveConfidenceBreaches = 0;
        (watchdog as any).consecutiveStructuralViolations = 0;
        (watchdog as any).consecutiveStructuralViolationsMap.clear();
        mockHaltCalled = null;
        mockIncidentManager.incidentsReported = [];
        mockIncidentManager.incidentsResolved = [];

        // Run 1: Structural violation (invalidTrades > 0) -> Warning
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } } // backward transition
        ];

        const checkJ1_1 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveStructuralViolations === 1, 'Run 1: consecutiveStructuralViolations should be 1.');
        assert(mockIncidentManager.incidentsReported.length === 2, 'Run 1: Should report 2 warning incidents (1 trade-specific, 1 global).');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.source === 'LIFECYCLE_INTEGRITY' && i.level === 'HIGH'), 'Run 1: Global incident level should be HIGH.');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.source.startsWith('OP:t100:') && i.level === 'HIGH' && i.reason.includes('BACKWARD_TRANSITION')), 'Run 1: Trade-specific incident level should be HIGH and reason should include BACKWARD_TRANSITION.');
        assert(mockHaltCalled === null, 'Run 1: No halt called in ALERT_ONLY mode.');

        // Run 2: Structural violation
        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveStructuralViolations === 2, 'Run 2: consecutiveStructuralViolations should be 2.');

        // Run 3: Structural violation -> Critical
        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveStructuralViolations === 3, 'Run 3: consecutiveStructuralViolations should be 3.');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.level === 'CRITICAL' && i.reason.includes('Sustained Structural Integrity Violations')), 'Run 3: Critical incident reported.');
        assert(mockHaltCalled === null, 'Run 3: No halt called since PROTECTION_MODE is ALERT_ONLY.');

        // Test J2: Mode = STOP_BUY, Structural Violation triggers StopBuyAction
        MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE = 'STOP_BUY';
        (watchdog as any).consecutiveConfidenceBreaches = 0;
        (watchdog as any).consecutiveStructuralViolations = 2; // pre-set to 2 to trigger on next run
        (watchdog as any).consecutiveStructuralViolationsMap.set(RiskViolationType.BACKWARD_TRANSITION, 2);
        mockHaltCalled = null;
        mockIncidentManager.incidentsReported = [];

        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveStructuralViolations === 3, 'J2 Run: consecutiveStructuralViolations should reach 3.');
        assert(mockHaltCalled === 'STOP_BUY', 'J2 Run: mockHaltCalled should be STOP_BUY.');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.level === 'CRITICAL'), 'J2 Run: Critical incident reported.');

        // Test J3: Mode = STOP, Structural Violation triggers StopAction
        MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE = 'STOP';
        (watchdog as any).consecutiveConfidenceBreaches = 0;
        (watchdog as any).consecutiveStructuralViolations = 2; // pre-set to 2
        (watchdog as any).consecutiveStructuralViolationsMap.set(RiskViolationType.BACKWARD_TRANSITION, 2);
        mockHaltCalled = null;
        mockIncidentManager.incidentsReported = [];

        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveStructuralViolations === 3, 'J3 Run: consecutiveStructuralViolations should reach 3.');
        assert(mockHaltCalled === 'STOP', 'J3 Run: mockHaltCalled should be STOP.');

        // Test J4: Confidence Breach Escalation (5 cycles)
        MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE = 'STOP_BUY';
        (watchdog as any).consecutiveConfidenceBreaches = 4; // pre-set to 4 to trigger on next run
        (watchdog as any).consecutiveStructuralViolations = 0; // avoid structural trigger
        (watchdog as any).consecutiveStructuralViolationsMap.clear();
        mockHaltCalled = null;
        mockIncidentManager.incidentsReported = [];

        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveConfidenceBreaches === 5, 'J4 Run: consecutiveConfidenceBreaches should reach 5.');
        assert(mockHaltCalled === 'STOP_BUY', 'J4 Run: mockHaltCalled should be STOP_BUY due to confidence breach.');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.level === 'CRITICAL' && i.reason.includes('LOW_CONFIDENCE')), 'J4 Run: Critical incident reported with LOW_CONFIDENCE reason.');

        // Test J5: Recovery
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't100', symbol: 'BTCUSDT' } }
        ];
        mockIncidentManager.incidentsResolved = [];
        await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert((watchdog as any).consecutiveConfidenceBreaches === 0, 'Recovery: confidence breaches reset to 0.');
        assert((watchdog as any).consecutiveStructuralViolations === 0, 'Recovery: structural violations reset to 0.');
        assert((watchdog as any).consecutiveStructuralViolationsMap.get(RiskViolationType.BACKWARD_TRANSITION) === 0, 'Recovery: map for BACKWARD_TRANSITION resets to 0.');
        assert(mockIncidentManager.incidentsResolved.some((r: any) => r.source === 'LIFECYCLE_INTEGRITY'), 'Recovery: resolves LIFECYCLE_INTEGRITY incident.');

        // Test J6: TimelineConfidence & UNEXPECTED_FILL regression checks
        console.log('   > Running Test J6: TimelineConfidence & UNEXPECTED_FILL regression checks...');
        
        // 1. Real Trade with partial timeline (only ORDER_FILLED) -> PARTIAL confidence -> NO UNEXPECTED_FILL
        mockFindMany = async () => [
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 'real_trade_123', symbol: 'BTCUSDT', source: 'FREQTRADE' } }
        ];
        (watchdog as any).consecutiveStructuralViolations = 0;
        (watchdog as any).consecutiveStructuralViolationsMap.clear();
        mockIncidentManager.incidentsReported = [];
        
        const checkJ6_1 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkJ6_1.metadata?.observability?.lifecycle?.invalidTrades === 0, 'Real trade with partial timeline should have 0 invalid trades.');
        assert(checkJ6_1.metadata?.observability?.lifecycle?.validTrades === 1, 'Real trade with partial timeline should have 1 valid trade.');
        assert((watchdog as any).consecutiveStructuralViolations === 0, 'Real trade with partial timeline should not increment structural violations.');

        // 2. Simulator Trade with partial timeline (only ORDER_FILLED) -> FULL confidence -> UNEXPECTED_FILL triggered
        mockFindMany = async () => [
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 'sim_trade_123', symbol: 'BTCUSDT', source: 'SIMULATOR' } }
        ];
        (watchdog as any).consecutiveStructuralViolations = 0;
        (watchdog as any).consecutiveStructuralViolationsMap.clear();
        mockIncidentManager.incidentsReported = [];
        
        const checkJ6_2 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        assert(checkJ6_2.metadata?.observability?.lifecycle?.invalidTrades === 1, 'Simulator trade with partial timeline should have 1 invalid trade.');
        assert((watchdog as any).consecutiveStructuralViolations === 1, 'Simulator trade with partial timeline should increment structural violations.');
        assert(mockIncidentManager.incidentsReported.some((i: any) => i.reason.includes('UNEXPECTED_FILL')), 'Simulator trade with partial timeline should report UNEXPECTED_FILL incident.');

        // Reset mocks
        mockCreate = async (args: any) => args.data as any;
        (prisma.decisionAudit as any).findFirst = originalFindFirst;

        // 4.6 checkExchangeAck
        // Scenario A: Responding normally (Healthy)
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const exchangeAckHealthy = await watchdog.checkExchangeAck();
        assert(exchangeAckHealthy.healthy === true, 'Exchange ACK check should pass under normal order execution flow.');
        assert(exchangeAckHealthy.source === 'EXCHANGE_ACK', 'Exchange ACK source should be EXCHANGE_ACK.');
        assert(exchangeAckHealthy.metadata?.totalEventsAnalyzed === 1, 'Exchange ACK metadata includes correct totalEventsAnalyzed.');

        // Scenario B: Consecutive Timeouts (Unhealthy)
        mockFindMany = async () => [
            { classification: 'ORDER_ACK_TIMEOUT', createdAt: new Date() },
            { classification: 'ORDER_ACK_TIMEOUT', createdAt: new Date() },
            { classification: 'EXCHANGE_TIMEOUT', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const exchangeAckStale = await watchdog.checkExchangeAck(15 * 60 * 1000, 3);
        assert(exchangeAckStale.healthy === false, 'Exchange ACK check should fail if consecutive timeouts exceed the threshold.');
        assert(exchangeAckStale.metadata?.totalEventsAnalyzed === 3, 'Exchange ACK metadata includes correct totalEventsAnalyzed.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].level === 'CRITICAL', 'Triggers exchange ack failure critical alert.');

        // 4.7 checkLatency
        // Scenario A: Low Latency (Healthy)
        mockFindMany = async () => [
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 120 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 180 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 150 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 110 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 140 } } }
        ];
        mockAlerting.alertsSent = [];
        const latencyHealthy = await watchdog.checkLatency('TREND_RIDER', 500, 5);
        assert(latencyHealthy.healthy === true, 'Latency check passes when average is below threshold.');
        assert(latencyHealthy.source === 'LATENCY', 'Latency source should be LATENCY.');

        // Scenario B: Latency Spiked (Unhealthy)
        mockFindMany = async () => [
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 1200 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 1500 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 1100 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 950 } } },
            { classification: 'ORDER', metadata: { outcome: { latencyMs: 1300 } } }
        ]; // Average ~ 1210ms
        mockAlerting.alertsSent = [];
        const latencySpike = await watchdog.checkLatency('TREND_RIDER', 1000, 5);
        assert(latencySpike.healthy === false, 'Latency check should fail when average latency spikes past threshold.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Order Latency Spike', 'Triggers order latency spike warning alert.');

        // 4.7.1 runAllOperationsChecks orchestrator
        mockFindFirst = async () => ({
            createdAt: new Date(Date.now() - 10 * 1000)
        });
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date(), metadata: { symbol: 'BTCUSDT', outcome: { latencyMs: 120 } } },
            { classification: 'SIGNAL', createdAt: new Date() },
            { classification: 'ORDER_CREATED', createdAt: new Date() },
            { classification: 'ORDER_SENT', createdAt: new Date() },
            { classification: 'MARKET_DATA', createdAt: new Date(), metadata: { lastMarketTimestamp: Date.now(), timeframe: '5m', sourceSystem: 'freqtrade', symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const opsResults = await watchdog.runAllOperationsChecks({ strategyId: 'TREND_RIDER', symbol: 'BTCUSDT' });
        assert(opsResults.length === 7, 'runAllOperationsChecks should return exactly 7 results.');
        assert(opsResults.every(r => r.healthy === true), 'All 7 returned operations checks should be healthy.');

        // 4.7.2 Strategy Isolation verification
        (watchdog as any).tradeFrequencyFailures.clear();
        mockFindMany = async () => [];
        mockAlerting.alertsSent = [];
        
        // Fail STRATEGY_A 3 times to trigger alarm
        await watchdog.checkTradeFrequency('STRATEGY_A');
        await watchdog.checkTradeFrequency('STRATEGY_A');
        const freqSilentA = await watchdog.checkTradeFrequency('STRATEGY_A');
        assert(freqSilentA.healthy === false, 'STRATEGY_A should fail.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Strategy Silence Detected' && mockAlerting.alertsSent[0].entityId === 'STRATEGY_A', 'Alarm alert triggers for STRATEGY_A.');

        // Now run STRATEGY_B once - should fail but NOT trigger alarm alert or inherit STRATEGY_A failures
        mockAlerting.alertsSent = [];
        const freqSilentB = await watchdog.checkTradeFrequency('STRATEGY_B');
        assert(freqSilentB.healthy === false, 'STRATEGY_B should fail on first check.');
        assert(freqSilentB.metadata?.consecutiveFailures === 1, 'STRATEGY_B consecutiveFailures should be 1.');
        assert(mockAlerting.alertsSent.length === 0, 'No alarm alert triggers for STRATEGY_B.');

        assert((watchdog as any).tradeFrequencyFailures.get('STRATEGY_A') === 3, 'STRATEGY_A failures count is preserved at 3.');
        assert((watchdog as any).tradeFrequencyFailures.get('STRATEGY_B') === 1, 'STRATEGY_B failures count is isolated at 1.');

        // Success on STRATEGY_B resets its counter to 0, leaving STRATEGY_A untouched
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() }
        ];
        const freqHealthyB = await watchdog.checkTradeFrequency('STRATEGY_B');
        assert(freqHealthyB.healthy === true, 'STRATEGY_B should succeed.');
        assert((watchdog as any).tradeFrequencyFailures.get('STRATEGY_A') === 3, 'STRATEGY_A failures count is still 3.');
        assert((watchdog as any).tradeFrequencyFailures.get('STRATEGY_B') === 0, 'STRATEGY_B failures count is reset to 0.');

        (prisma.decisionAudit as any).create = opsOriginalCreate;

        // ----------------------------------------------------
        // LAYER 1: Infrastructure Health Checks Tests
        // ----------------------------------------------------
        console.log('   > Running Infrastructure Health Check Tests...');
        
        const infraWatchdog = new InfrastructureWatchdogService(mockAlerting);

        let createdAudits: any[] = [];
        (prisma.decisionAudit as any).create = async (args: any) => {
            createdAudits.push(args.data);
            return args.data;
        };

        // Stub out system helper calls
        let mockCpuUsage = async () => 45.0;
        let mockDiskUsage = async () => ({ usedPct: 40, freeBytes: 10000000000 });
        let mockDockerInspect = async (name: string): Promise<any> => ({
            State: { Status: 'running', StartedAt: new Date(Date.now() - 5000 * 1000).toISOString(), Health: { Status: 'healthy' }, ExitCode: 0 },
            RestartCount: 0
        });
        let mockHttpResponse = async (url: string) => ({ statusCode: 200, responseTimeMs: 25 });
        let mockPing = async (target: string) => ({ loss: 0, latency: 15 });
        let mockDnsResolve = async (host: string) => ['127.0.0.1'];

        (infraWatchdog as any).getCpuUsage = () => mockCpuUsage();
        (infraWatchdog as any).getDiskUsage = () => mockDiskUsage();
        (infraWatchdog as any).getDockerInspect = (name: string) => mockDockerInspect(name);
        (infraWatchdog as any).getHttpResponse = (url: string) => mockHttpResponse(url);
        (infraWatchdog as any).executePing = (target: string) => mockPing(target);
        (infraWatchdog as any).resolveDnsPromise = (host: string) => mockDnsResolve(host);

        // 4.8 checkVMHealth
        // Scenario A: Healthy VM (CPU 45%, Mem 50%, Disk 40%)
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const vmHealthy = await infraWatchdog.checkVMHealth();
        assert(vmHealthy.healthy === true, 'VM health check should pass under normal resources.');
        assert(vmHealthy.source === 'VM', 'VM check returns source VM.');
        assert(vmHealthy.checkedAt instanceof Date, 'VM check includes checkedAt Date timestamp.');
        assert(typeof vmHealthy.checkDurationMs === 'number', 'VM check includes checkDurationMs number.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'VM_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should create a NORMAL VM_HEALTH audit entry.');
        assert(createdAudits[0].metadata.cpuPct === 45 && createdAudits[0].metadata.diskFreeBytes === 10000000000 && typeof createdAudits[0].metadata.hostname === 'string', 'Metadata should store cpuPct, diskFreeBytes, and hostname.');

        // Scenario B: Unhealthy VM (CPU 99%)
        mockCpuUsage = async () => 99.0;
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const vmUnhealthy = await infraWatchdog.checkVMHealth();
        assert(vmUnhealthy.healthy === false, 'VM health check should fail under high CPU load.');
        assert(vmUnhealthy.severity === 'CRITICAL', 'Unhealthy VM result is CRITICAL.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'VM_HEALTH' && createdAudits[0].systemRiskState === 'PROTECTION', 'Should create a PROTECTION VM_HEALTH audit entry.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].level === 'CRITICAL', 'Should send a critical alert on high resource consumption.');
        mockCpuUsage = async () => 45.0; // reset

        // Scenario C: VM reboot detected (uptime decreased)
        (infraWatchdog as any).lastUptimeSeconds = 5000000;
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const vmReboot = await infraWatchdog.checkVMHealth();
        assert(vmReboot.healthy === false, 'VM health check should fail when a reboot is detected.');
        assert(mockAlerting.alertsSent.some((a: any) => a.message.includes('reboot')), 'Alert should report unexpected reboot.');

        // Scenario D: Warning VM (CPU 85%)
        mockCpuUsage = async () => 85.0;
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const vmWarning = await infraWatchdog.checkVMHealth();
        assert(vmWarning.healthy === true, 'VM health check should return healthy: true under warning resources.');
        assert(vmWarning.severity === 'WARNING', 'Warning VM result has severity WARNING.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'VM_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should create a NORMAL VM_HEALTH audit entry.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].level === 'WARNING', 'Should send a warning alert on elevated resource consumption.');
        mockCpuUsage = async () => 45.0; // reset

        // 4.9 checkDockerContainerHealth
        // Scenario A: Running and healthy
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const dockerHealthy = await infraWatchdog.checkDockerContainerHealth();
        assert(dockerHealthy.healthy === true, 'Docker check should pass when container is running and healthy.');
        assert(dockerHealthy.source === 'DOCKER', 'Docker check returns source DOCKER.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'DOCKER_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should audit DOCKER_HEALTH as NORMAL.');

        // Scenario B: Container missing
        mockDockerInspect = async (name: string) => null;
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const dockerMissing = await infraWatchdog.checkDockerContainerHealth();
        assert(dockerMissing.healthy === false, 'Docker check should fail when container inspect returns null.');
        assert(dockerMissing.severity === 'CRITICAL', 'Missing container returns CRITICAL severity.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Docker Container Missing', 'Should send alert for missing container.');
        
        // Scenario C: Restart loop or low uptime
        mockDockerInspect = async (name: string) => ({
            State: { Status: 'running', StartedAt: new Date(Date.now() - 10 * 1000).toISOString(), Health: { Status: 'healthy' }, ExitCode: 0 },
            RestartCount: 1
        }); // Uptime = 10s < 60s, restartCount has increased from 0 to 1
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const dockerLowUptime = await infraWatchdog.checkDockerContainerHealth();
        assert(dockerLowUptime.healthy === false, 'Docker check should fail when container has suspiciously low uptime.');
        assert(mockAlerting.alertsSent.some((a: any) => a.message.includes('low uptime') || a.message.includes('restart count')), 'Should report low uptime crash loop alert.');
        
        // Reset Docker mock
        mockDockerInspect = async (name: string) => ({
            State: { Status: 'running', StartedAt: new Date(Date.now() - 5000 * 1000).toISOString(), Health: { Status: 'healthy' }, ExitCode: 0 },
            RestartCount: 0
        });

        // 4.10 checkFreqtradeAPI
        // Scenario A: Healthy ping
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const ftHealthy = await infraWatchdog.checkFreqtradeAPI();
        assert(ftHealthy.healthy === true, 'Freqtrade API check should pass under 200 OK.');
        assert(ftHealthy.source === 'FREQTRADE', 'Freqtrade API check returns source FREQTRADE.');
        assert(ftHealthy.metadata?.maxFailures === 3, 'Freqtrade API metadata includes maxFailures.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'FREQTRADE_API' && createdAudits[0].metadata.responseTimeMs === 25, 'Should log responseTimeMs.');

        // Scenario B: Failure sequence (must fail 3 times consecutively to alert)
        mockHttpResponse = async (url: string) => ({ statusCode: 502, responseTimeMs: 10 });
        createdAudits = [];
        mockAlerting.alertsSent = [];
        
        const ftFail1 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftFail1.healthy === false, 'Should fail with healthy: false on first consecutive Freqtrade API error.');
        assert(ftFail1.severity === 'WARNING', 'First error has WARNING severity.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert on first error.');

        // Simulate downtime elapsed time
        (infraWatchdog as any).lastSuccessfulApiCheck = Date.now() - 50 * 1000;

        const ftFail2 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftFail2.healthy === false, 'Should fail with healthy: false on second consecutive Freqtrade API error.');
        assert(ftFail2.severity === 'WARNING', 'Second error has WARNING severity.');
        
        const ftFail3 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftFail3.healthy === false, 'Should fail and trigger alert on third consecutive Freqtrade API error.');
        assert(ftFail3.severity === 'CRITICAL', 'Failed Freqtrade API returns CRITICAL.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Freqtrade API Unreachable', 'Critical alert should trigger on 3rd failure.');
        assert(mockAlerting.alertsSent[0].message.includes('50s'), 'Should report down-time duration in the alert.');
        
        // Scenario C: Freqtrade API check throws/rejects (transient exception counting)
        mockHttpResponse = async (url: string) => {
            throw new Error('Socket hang up');
        };
        createdAudits = [];
        mockAlerting.alertsSent = [];
        (infraWatchdog as any).freqtradeFailures = 0;
        (infraWatchdog as any).lastSuccessfulApiCheck = Date.now();

        const ftThrow1 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftThrow1.healthy === false, 'Should fail with healthy: false on first Freqtrade throw failure.');
        assert(ftThrow1.severity === 'WARNING', 'First throw has WARNING severity.');

        // Simulate downtime
        (infraWatchdog as any).lastSuccessfulApiCheck = Date.now() - 30 * 1000;

        const ftThrow2 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftThrow2.healthy === false, 'Should fail with healthy: false on second Freqtrade throw failure.');
        assert(ftThrow2.severity === 'WARNING', 'Second throw has WARNING severity.');

        const ftThrow3 = await infraWatchdog.checkFreqtradeAPI();
        assert(ftThrow3.healthy === false, 'Should fail on third consecutive throw/reject failure.');
        assert(ftThrow3.severity === 'CRITICAL', 'Throwing Freqtrade check returns CRITICAL on third attempt.');
        assert(ftThrow3.metadata?.error === 'Socket hang up', 'Metadata should capture the thrown error message.');

        // Reset Freqtrade mock
        mockHttpResponse = async (url: string) => ({ statusCode: 200, responseTimeMs: 25 });

        // 4.11 checkHostNetwork
        // Scenario A: Internet works (0% loss)
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const netHealthy = await infraWatchdog.checkHostNetwork();
        assert(netHealthy.healthy === true, 'Host network check should pass if targets respond.');
        assert(netHealthy.source === 'NETWORK', 'Host network check returns source NETWORK.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'NETWORK_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should log NETWORK_HEALTH as NORMAL.');

        // Scenario B: Packet loss > 50%
        mockPing = async (target: string) => ({ loss: 100, latency: 9999 });
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const netDown = await infraWatchdog.checkHostNetwork();
        assert(netDown.healthy === false, 'Host network check should fail if all targets drop packets.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'VPS Network Offline', 'Should send VPS Network Offline alert.');

        // Scenario C: Network degradation (one target offline)
        mockPing = async (target: string) => {
            if (target === '1.1.1.1') return { loss: 100, latency: 9999 };
            return { loss: 0, latency: 15 };
        };
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const netDegraded = await infraWatchdog.checkHostNetwork();
        assert(netDegraded.healthy === true, 'Degraded network check should return healthy: true.');
        assert(netDegraded.severity === 'WARNING', 'Degraded network has severity WARNING.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'NETWORK_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should log NETWORK_HEALTH as NORMAL.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'VPS Network Degraded', 'Should send VPS Network Degraded warning alert.');
        assert(netDegraded.metadata?.failedTargets.includes('1.1.1.1'), 'Metadata should include failed target.');
        assert(netDegraded.metadata?.successfulTargets.includes('8.8.8.8'), 'Metadata should include successful target.');
        assert(netDegraded.metadata?.packetLossPct === 50, 'Metadata should compute average packet loss percent.');
        mockPing = async (target: string) => ({ loss: 0, latency: 15 }); // Reset

        // 4.12 checkExchangeReachability
        // Scenario A: Exchange api online
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const exchangeHealthy = await infraWatchdog.checkExchangeReachability();
        assert(exchangeHealthy.healthy === true, 'Exchange reachability check should pass when API is online.');
        assert(exchangeHealthy.source === 'EXCHANGE_REACHABILITY', 'Exchange check returns source EXCHANGE_REACHABILITY.');
        assert(exchangeHealthy.metadata?.maxFailures === 3, 'Exchange reachability metadata includes maxFailures.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'EXCHANGE_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should log EXCHANGE_HEALTH as NORMAL.');

        // Scenario B: Exchange api offline (consecutive failures tracking)
        mockHttpResponse = async (url: string) => ({ statusCode: 504, responseTimeMs: 5000 });
        createdAudits = [];
        mockAlerting.alertsSent = [];
        
        const exFail1 = await infraWatchdog.checkExchangeReachability();
        assert(exFail1.healthy === false, 'Exchange check should return unhealthy on first failure.');
        assert(exFail1.severity === 'WARNING', 'First failure has WARNING severity.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert on first exchange failure.');

        // Simulate downtime duration
        (infraWatchdog as any).lastSuccessfulExchangeCheck = Date.now() - 40 * 1000;

        const exFail2 = await infraWatchdog.checkExchangeReachability();
        assert(exFail2.healthy === false, 'Exchange check should return unhealthy on second failure.');
        assert(exFail2.severity === 'WARNING', 'Second failure has WARNING severity.');

        const exFail3 = await infraWatchdog.checkExchangeReachability();
        assert(exFail3.healthy === false, 'Exchange check should fail and alert on third consecutive failure.');
        assert(exFail3.severity === 'CRITICAL', 'Failed exchange check returns CRITICAL severity.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Exchange API Unreachable', 'Should alert when Exchange API is down.');
        assert(mockAlerting.alertsSent[0].message.includes('40s'), 'Should report exchange downtime duration in alert message.');
        // Scenario C: Exchange api check throws/rejects (transient exception counting)
        mockHttpResponse = async (url: string) => {
            throw new Error('Connection refused');
        };
        createdAudits = [];
        mockAlerting.alertsSent = [];
        (infraWatchdog as any).exchangeFailures = 0;
        (infraWatchdog as any).lastSuccessfulExchangeCheck = Date.now();

        const exThrow1 = await infraWatchdog.checkExchangeReachability();
        assert(exThrow1.healthy === false, 'Exchange check should return unhealthy on first throw/reject failure.');
        assert(exThrow1.severity === 'WARNING', 'First throw has WARNING severity.');

        // Simulate downtime duration
        (infraWatchdog as any).lastSuccessfulExchangeCheck = Date.now() - 30 * 1000;

        const exThrow2 = await infraWatchdog.checkExchangeReachability();
        assert(exThrow2.healthy === false, 'Exchange check should return unhealthy on second throw/reject failure.');
        assert(exThrow2.severity === 'WARNING', 'Second throw has WARNING severity.');

        const exThrow3 = await infraWatchdog.checkExchangeReachability();
        assert(exThrow3.healthy === false, 'Exchange check should fail on third consecutive throw/reject failure.');
        assert(exThrow3.severity === 'CRITICAL', 'Failed exchange check returns CRITICAL severity.');
        assert(exThrow3.metadata?.error === 'Connection refused', 'Metadata should capture the thrown error message.');
        mockHttpResponse = async (url: string) => ({ statusCode: 200, responseTimeMs: 25 }); // Reset

        // 4.13 checkDnsResolution
        // Scenario A: DNS works
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const dnsHealthy = await infraWatchdog.checkDnsResolution();
        assert(dnsHealthy.healthy === true, 'DNS check should pass when host resolves.');
        assert(dnsHealthy.source === 'DNS', 'DNS check returns source DNS.');
        assert(createdAudits.length === 1 && createdAudits[0].classification === 'DNS_HEALTH' && createdAudits[0].systemRiskState === 'NORMAL', 'Should log DNS_HEALTH as NORMAL.');

        // Scenario B: DNS fails
        mockDnsResolve = async (host: string) => [];
        createdAudits = [];
        mockAlerting.alertsSent = [];
        const dnsDown = await infraWatchdog.checkDnsResolution();
        assert(dnsDown.healthy === false, 'DNS check should fail when DNS query returns empty array.');
        assert(dnsDown.severity === 'CRITICAL', 'Failed DNS check returns CRITICAL.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'DNS Resolution Failed', 'Should alert when DNS resolution fails.');
        mockDnsResolve = async (host: string) => ['127.0.0.1']; // Reset

        // 4.14 runAllInfrastructureChecks orchestrator
        const allResults = await infraWatchdog.runAllInfrastructureChecks();
        assert(allResults.length === 6, 'runAllInfrastructureChecks should return exactly 6 results.');
        assert(allResults.every(r => r.healthy === true), 'All 6 returned health results should be healthy.');
        assert(allResults.every(r => r.metadata?.watchdogVersion === '1.0.0'), 'All infra check results include watchdogVersion.');
        assert(allResults.every(r => r.metadata?.serviceName === 'InfrastructureWatchdogService'), 'All infra check results include serviceName.');
        assert(allResults.every(r => r.metadata?.environment !== undefined), 'All infra check results include environment.');
        assert(allResults.every(r => r.metadata?.checkId !== undefined), 'All infra check results include checkId.');

        // Scenario K: Hierarchical System Health Tree (Phase 3D)
        console.log('   > Running Scenario K: Hierarchical System Health Tree...');
        
        const healthTreeService = new HealthTreeService(
            mockIncidentManager as any,
            infraWatchdog,
            watchdog
        );

        // Run K1: Healthy system state
        mockIncidentManager.incidentsReported = [];
        mockIncidentManager.incidentsResolved = [];
        (watchdog as any).lastPipelineMetadata = {
            observability: {
                pipelineVisibility: 'FULL',
                lifecycle: { lifecycleConfidenceScore: 1.0, invalidTrades: 0 }
            }
        };

        const treeHealthy = await healthTreeService.getSystemHealthTree(allResults, opsResults);
        assert(treeHealthy.id === 'global', 'K1: Root node ID should be global.');
        assert(treeHealthy.status === 'HEALTHY', 'K1: Root status should be HEALTHY when all subtrees are healthy.');
        assert(treeHealthy.children?.length === 4, 'K1: Root should have exactly 4 children.');

        const infraNode = treeHealthy.children?.find(c => c.id === 'infrastructure');
        assert(infraNode !== undefined, 'K1: Should find infrastructure parent node.');
        assert(infraNode?.status === 'HEALTHY', 'K1: Infrastructure parent should be HEALTHY.');
        assert(infraNode?.children?.length === 6, 'K1: Infrastructure subtree should have 6 children.');

        const opsNode = treeHealthy.children?.find(c => c.id === 'operations');
        assert(opsNode !== undefined, 'K1: Should find operations parent node.');
        assert(opsNode?.status === 'HEALTHY', 'K1: Operations parent should be HEALTHY.');
        assert(opsNode?.children?.length === 3, 'K1: Operations subtree should have 3 sub-parents.');

        const pipelineNode = treeHealthy.children?.find(c => c.id === 'execution_pipeline');
        assert(pipelineNode !== undefined, 'K1: Should find execution pipeline parent node.');
        assert(pipelineNode?.status === 'HEALTHY', 'K1: Execution pipeline parent should be HEALTHY.');

        const protectionNode = treeHealthy.children?.find(c => c.id === 'protection');
        assert(protectionNode !== undefined, 'K1: Should find protection parent node.');
        assert(protectionNode?.status === 'HEALTHY', 'K1: Protection parent should be HEALTHY.');
        assert(!!protectionNode?.children?.some(c => c.id === 'protection.mode'), 'K1: Includes Protection Mode node.');

        // Run K2: Critical in Infrastructure DNS propagates up
        const degradedInfraResults = allResults.map(r => r.source === 'DNS' ? { ...r, healthy: false, severity: 'CRITICAL' as const, message: 'DNS Fail' } : r);
        const treeDegradedInfra = await healthTreeService.getSystemHealthTree(degradedInfraResults, opsResults);
        
        const infraNodeDegraded = treeDegradedInfra.children?.find(c => c.id === 'infrastructure');
        assert(infraNodeDegraded?.status === 'CRITICAL', 'K2: Infrastructure parent status should propagate to CRITICAL.');
        const dnsNodeDegraded = infraNodeDegraded?.children?.find(c => c.id === 'infra.dns_resolution');
        assert(dnsNodeDegraded?.status === 'CRITICAL', 'K2: DNS child node status should be CRITICAL.');
        assert(dnsNodeDegraded?.message === 'DNS Fail', 'K2: DNS child node message is captured.');
        assert(treeDegradedInfra.status === 'CRITICAL', 'K2: Global root status should propagate to CRITICAL.');

        // Run K3: Warning in VM Health propagates to Warning parent
        const warningInfraResults = allResults.map(r => r.source === 'VM' ? { ...r, healthy: false, severity: 'WARNING' as const, message: 'High memory usage' } : r);
        const treeWarningInfra = await healthTreeService.getSystemHealthTree(warningInfraResults, opsResults);
        const infraNodeWarning = treeWarningInfra.children?.find(c => c.id === 'infrastructure');
        assert(infraNodeWarning?.status === 'WARNING', 'K3: Infrastructure parent status should propagate to WARNING.');
        assert(treeWarningInfra.status === 'WARNING', 'K3: Global root status should propagate to WARNING.');

        // Run K4: Active Incident & Halt State in Protection Subtree
        mockIncidentManager.incidentsReported = [
            { level: 'CRITICAL', source: 'LIFECYCLE_INTEGRITY', reason: 'Structural integrity failure' }
        ];
        const treeHalted = await healthTreeService.getSystemHealthTree(allResults, opsResults);
        const protectionNodeHalted = treeHalted.children?.find(c => c.id === 'protection');
        assert(protectionNodeHalted?.status === 'CRITICAL', 'K4: Protection subtree propagates to CRITICAL on active halt.');
        assert(treeHalted.status === 'CRITICAL', 'K4: Global root status propagates to CRITICAL on active halt.');
        
        const haltStateNode = protectionNodeHalted?.children?.find(c => c.id === 'protection.active_halt_state');
        assert(haltStateNode?.status === 'CRITICAL', 'K4: halt state child status is CRITICAL.');
        assert(haltStateNode?.message === 'Halt: ACTIVE', 'K4: halt state child message shows ACTIVE.');
    } catch (e: any) {
        console.error('❌ Operations Watchdog Service test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 5: Execution Intelligence Service
    // ----------------------------------------------------
    try {
        console.log('--- Checking Service: Execution Intelligence Service ---');

        const mockAlerting: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        const incidentManager = new IncidentManager(mockAlerting);

        let createdIncidents: any[] = [];
        let mockIncidentCreate = async (args: any) => {
            createdIncidents.push(args.data);
            return args.data;
        };
        (prisma.incident as any).create = async (args: any) => mockIncidentCreate(args);
        (prisma.incident as any).findFirst = async () => null;
        (prisma.incident as any).findUnique = async () => ({ groupId: 1 });
        (prisma.incident as any).findMany = async () => [];
        (prisma.incident as any).update = async () => ({});
        (prisma.incidentGroup as any).create = async (args: any) => ({ id: 1, ...args.data });
        (prisma.incidentGroup as any).findFirst = async () => null;
        (prisma.incidentGroup as any).update = async () => ({});
        (prisma.incidentGroup as any).updateMany = async () => ({});
        (prisma.incidentTransition as any).create = async () => ({});
        (prisma as any).$transaction = async (callback: any) => callback(prisma);

        const execIntel = new ExecutionIntelligenceService(incidentManager);

        // Scenario A: Normal parameters, no incidents
        createdIncidents = [];
        const resNormal = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            return1m: 0.005,
            atr1m: 0.02,
            volumeCurrent: 100,
            volumeMedian: 100,
            expectedPrice: 100.0,
            filledPrice: 100.2,
            allowedSlippagePct: 0.005,
            currentSpread: 0.02,
            medianSpread: 0.015
        });
        assert(resNormal.length === 0, 'Should return 0 incidents under normal market and execution conditions.');
        assert(createdIncidents.length === 0, 'Should not report any incidents to IncidentManager under normal conditions.');

        // Scenario B: Volatility shock return and volume shock (Flash Crash)
        createdIncidents = [];
        const resFlash = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            return1m: 0.12,
            atr1m: 0.02,
            volumeCurrent: 450,
            volumeMedian: 100
        });
        assert(resFlash.length === 1 && resFlash[0].level === 'HIGH', 'Should detect Flash Crash and return the incident.');
        assert(createdIncidents.length === 1 && createdIncidents[0].level === 'HIGH', 'Should report Halted incident to IncidentManager.');

        // Scenario B1: atr1m=0 guard — no price history, must return null (not false-positive)
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resZeroAtr = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            return1m: 0.12,
            atr1m: 0,          // Zero ATR — new symbol or broken feed
            volumeCurrent: 450,
            volumeMedian: 100
        });
        assert(resZeroAtr.length === 0, 'Flash crash detector should return null when atr1m is 0 (no price baseline).');

        // Scenario B2: volumeMedian=0 guard — no volume history, must return null (not false-positive)
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resZeroVol = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            return1m: 0.12,
            atr1m: 0.02,
            volumeCurrent: 450,
            volumeMedian: 0    // Zero volume median — new symbol or broken feed
        });
        assert(resZeroVol.length === 0, 'Flash crash detector should return null when volumeMedian is 0 (no volume baseline).');

        // Scenario C: Multiple concurrent incidents (Spread vacuum and Slippage deviation)
        createdIncidents = [];
        (incidentManager as any).state = {
            globalLevel: 'NORMAL',
            symbols: {}
        };
        const resMultiple = await execIntel.runDetectors({
            symbol: 'ETHUSDT',
            currentSpread: 0.12,
            medianSpread: 0.015,
            expectedPrice: 100.0,
            filledPrice: 101.5,
            allowedSlippagePct: 0.005
        });
        assert(resMultiple.length === 2, 'Should detect both Liquidity and Slippage anomalies concurrently.');
        assert(resMultiple.some(i => i.level === 'HIGH' && i.reason.includes('Spread')), 'Should return DEGRADED spread incident.');
        assert(resMultiple.some(i => i.level === 'HIGH' && i.reason.includes('Slippage')), 'Should return HALTED slippage incident.');
        assert(createdIncidents.length === 2, 'Should report both incidents to IncidentManager.');

        // Verify enriched slippage reason includes threshold and price values
        const slippageIncident = resMultiple.find(i => i.source === 'SLIPPAGE');
        assert(slippageIncident !== undefined, 'Slippage incident should be present in Scenario C.');
        assert(slippageIncident!.reason.includes('expected='), 'Slippage reason should include expected price.');
        assert(slippageIncident!.reason.includes('filled='), 'Slippage reason should include filled price.');
        assert(slippageIncident!.reason.includes('%'), 'Slippage reason should include threshold percentage.');

        // Scenario C1: allowedSlippagePct=0 guard — zero tolerance is a config error, not an anomaly
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resZeroSlippage = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            expectedPrice: 100.0,
            filledPrice: 101.5,
            allowedSlippagePct: 0   // Zero tolerance — config error, should not fire
        });
        assert(resZeroSlippage.filter(i => i.source === 'SLIPPAGE').length === 0, 'Slippage detector should return null when allowedSlippagePct is 0.');

        // Scenario C2: NaN inputs guard — broken exchange data should not trigger incidents
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resNaN = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            expectedPrice: NaN,
            filledPrice: 101.5,
            allowedSlippagePct: 0.005
        });
        assert(resNaN.filter(i => i.source === 'SLIPPAGE').length === 0, 'Slippage detector should return null when inputs contain NaN.');

        // Verify enriched spread reason includes threshold and median details
        const spreadIncident = resMultiple.find(i => i.source === 'SPREAD');
        assert(spreadIncident !== undefined, 'Spread incident should be present in Scenario C.');
        assert(spreadIncident!.reason.includes('Spread Explosion:'), 'Spread reason should contain prefix.');
        assert(spreadIncident!.reason.includes('multiplier:'), 'Spread reason should include multiplier info.');

        // Scenario C3: medianSpread=0 guard — no history, must return null (not false-positive)
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resZeroMedianSpread = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            currentSpread: 0.05,
            medianSpread: 0
        });
        assert(resZeroMedianSpread.filter(i => i.source === 'SPREAD').length === 0, 'Spread detector should return null when medianSpread is 0.');

        // Scenario C4: NaN inputs guard for spread — broken data should not trigger incidents
        createdIncidents = [];
        (incidentManager as any).state = { globalLevel: 'NORMAL', symbols: {} };
        const resSpreadNaN = await execIntel.runDetectors({
            symbol: 'BTCUSDT',
            currentSpread: NaN,
            medianSpread: 0.015
        });
        assert(resSpreadNaN.filter(i => i.source === 'SPREAD').length === 0, 'Spread detector should return null when inputs contain NaN.');
    } catch (e: any) {
        console.error('❌ Execution Intelligence Service test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 5.1: IncidentManager State Machine & Deduplication
    // ----------------------------------------------------
    try {
        console.log('--- Checking IncidentManager: Source-keyed Global Incident State ---');
        const mockAlertingForManager: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        const mgr = new IncidentManager(mockAlertingForManager);
        let databaseIncidents: any[] = [];
        let transitions: any[] = [];
        let persisted: any[] = [];
        let nextIncidentId = 1;

        (prisma.incident as any).create = async (args: any) => {
            const newIncident = {
                id: nextIncidentId++,
                symbol: args.data.symbol,
                level: args.data.level,
                source: args.data.source,
                reason: args.data.reason,
                detectedAt: args.data.detectedAt,
                resolvedAt: null
            };
            databaseIncidents.push(newIncident);
            persisted.push(args.data);
            return newIncident;
        };

        (prisma.incident as any).findFirst = async (args: any) => {
            const symbol = args.where.symbol;
            const source = args.where.source;
            const resolvedAt = args.where.resolvedAt;
            return databaseIncidents.find(i => i.symbol === symbol && i.source === source && i.resolvedAt === resolvedAt) || null;
        };

        (prisma.incident as any).findMany = async (args: any) => {
            let res = databaseIncidents;
            if (args && args.where) {
                if ('symbol' in args.where) {
                    res = res.filter(i => i.symbol === args.where.symbol);
                }
                if ('source' in args.where) {
                    res = res.filter(i => i.source === args.where.source);
                }
                if ('resolvedAt' in args.where) {
                    res = res.filter(i => i.resolvedAt === args.where.resolvedAt);
                }
            }
            return res;
        };

        (prisma.incident as any).update = async (args: any) => {
            const inc = databaseIncidents.find(i => i.id === args.where.id);
            if (inc) {
                inc.level = args.data.level ?? inc.level;
                inc.reason = args.data.reason ?? inc.reason;
                inc.detectedAt = args.data.detectedAt ?? inc.detectedAt;
            }
            persisted.push(args.data);
            return inc;
        };

        (prisma.incident as any).updateMany = async (args: any) => {
            const ids = args.where.id?.in || [];
            const matches = databaseIncidents.filter(i => ids.includes(i.id) || (args.where.symbol === i.symbol && args.where.source === i.source));
            for (const m of matches) {
                m.resolvedAt = args.data.resolvedAt;
            }
            return { count: matches.length };
        };

        (prisma.incident as any).findUnique = async (args: any) => {
            return databaseIncidents.find(i => i.id === args.where.id) || null;
        };

        let databaseIncidentGroups: any[] = [];
        let nextGroupId = 1;
        (prisma.incidentGroup as any).create = async (args: any) => {
            const g = {
                id: nextGroupId++,
                ...args.data
            };
            databaseIncidentGroups.push(g);
            return g;
        };
        (prisma.incidentGroup as any).findFirst = async (args: any) => {
            return databaseIncidentGroups.find(g => g.correlationKey === args.where.correlationKey && g.resolvedAt === null) || null;
        };
        (prisma.incidentGroup as any).update = async (args: any) => {
            const g = databaseIncidentGroups.find(x => x.id === args.where.id);
            if (g) {
                Object.assign(g, args.data);
            }
            return g || {};
        };
        (prisma.incidentGroup as any).updateMany = async () => ({ count: 0 });

        (prisma.incidentTransition as any).create = async (args: any) => {
            transitions.push(args.data);
            return args.data;
        };
        (prisma as any).$transaction = async (callback: any) => callback(prisma);

        // 1. Report HEARTBEAT critical failure
        persisted = [];
        mockAlertingForManager.alertsSent = [];
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'HEARTBEAT',
            reason: 'Heartbeat down'
        });
        assert(persisted.length === 1, 'Should persist heartbeat incident on initial failure.');
        assert(mockAlertingForManager.alertsSent.length === 1, 'Should send Telegram alert for initial heartbeat failure.');

        // 2. Report HEARTBEAT critical failure again (Deduplication)
        persisted = [];
        mockAlertingForManager.alertsSent = [];
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'HEARTBEAT',
            reason: 'Heartbeat down'
        });
        assert(persisted.length === 0, 'Should skip duplicate heartbeat insertion (deduplication).');
        assert(mockAlertingForManager.alertsSent.length === 0, 'Should not send duplicate alert for heartbeat.');

        // 3. Report BROKER_CONNECTION critical failure concurrently
        persisted = [];
        mockAlertingForManager.alertsSent = [];
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'BROKER_CONNECTION',
            reason: 'Broker offline'
        });
        assert(persisted.length === 1, 'Should persist broker incident concurrently with heartbeat.');
        assert(mockAlertingForManager.alertsSent.length === 1, 'Should send Telegram alert for broker connection.');

        // 4. Report HEARTBEAT again (Should not ping-pong / should still deduplicate correctly!)
        persisted = [];
        mockAlertingForManager.alertsSent = [];
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'HEARTBEAT',
            reason: 'Heartbeat down'
        });
        assert(persisted.length === 0, 'Should continue to deduplicate heartbeat despite concurrent broker incident.');
        assert(mockAlertingForManager.alertsSent.length === 0, 'Should not send duplicate alert for heartbeat.');

        // 5. Verify getState() reports the highest severity and reason
        const state = mgr.getState();
        assert(state.globalLevel === 'CRITICAL', 'globalLevel should reflect CRITICAL.');
        assert(state.globalReason === 'Heartbeat down' || state.globalReason === 'Broker offline', 'globalReason should expose an active critical reason.');

        // 6. Resolve HEARTBEAT only
        persisted = [];
        await mgr.resolveIncidentBySource('HEARTBEAT');
        const stateAfterHbResolve = mgr.getState();
        assert(stateAfterHbResolve.globalLevel === 'CRITICAL', 'globalLevel should still be CRITICAL because Broker is still down.');
        assert(stateAfterHbResolve.globalReason === 'Broker offline', 'globalReason should update to the remaining active incident.');

        // 7. Resolve BROKER_CONNECTION
        await mgr.resolveIncidentBySource('BROKER_CONNECTION');
        const stateAfterAllResolve = mgr.getState();
        assert(stateAfterAllResolve.globalLevel === 'NORMAL', 'globalLevel should return to NORMAL after all active incidents are resolved.');
        assert(stateAfterAllResolve.globalReason === undefined, 'globalReason should be undefined.');

        console.log('✅ [PASS] IncidentManager source-keyed global state and deduplication works perfectly.');
    } catch (e: any) {
        console.error('❌ IncidentManager test crashed:', e.message || e);
    }
    console.log('');

    // ---------------------------------------------------------------------------------
    // TEST 5.2: Incident Timeline Transition & Chronological Ordering Regression Test
    // ---------------------------------------------------------------------------------
    try {
        console.log('--- Checking IncidentManager: Transition Timeline & Ordering ---');
        const mockAlertingForTimeline: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        const mgr = new IncidentManager(mockAlertingForTimeline);
        let databaseIncidents: any[] = [];
        let transitions: any[] = [];
        let nextIncidentId = 1;

        (prisma.incident as any).create = async (args: any) => {
            const newIncident = {
                id: nextIncidentId++,
                symbol: args.data.symbol,
                level: args.data.level,
                source: args.data.source,
                reason: args.data.reason,
                detectedAt: args.data.detectedAt,
                resolvedAt: null
            };
            databaseIncidents.push(newIncident);
            return newIncident;
        };

        (prisma.incident as any).findFirst = async (args: any) => {
            const symbol = args.where.symbol;
            const source = args.where.source;
            const resolvedAt = args.where.resolvedAt;
            return databaseIncidents.find(i => i.symbol === symbol && i.source === source && i.resolvedAt === resolvedAt) || null;
        };

        (prisma.incident as any).findMany = async (args: any) => {
            let res = databaseIncidents;
            if (args && args.where) {
                if ('symbol' in args.where) {
                    res = res.filter(i => i.symbol === args.where.symbol);
                }
                if ('source' in args.where) {
                    res = res.filter(i => i.source === args.where.source);
                }
                if ('resolvedAt' in args.where) {
                    res = res.filter(i => i.resolvedAt === args.where.resolvedAt);
                }
            }
            return res;
        };

        (prisma.incident as any).update = async (args: any) => {
            const inc = databaseIncidents.find(i => i.id === args.where.id);
            if (inc) {
                inc.level = args.data.level ?? inc.level;
                inc.reason = args.data.reason ?? inc.reason;
                inc.detectedAt = args.data.detectedAt ?? inc.detectedAt;
            }
            return inc;
        };

        (prisma.incident as any).updateMany = async (args: any) => {
            const ids = args.where.id?.in || [];
            const matches = databaseIncidents.filter(i => ids.includes(i.id) || (args.where.symbol === i.symbol && args.where.source === i.source));
            for (const m of matches) {
                m.resolvedAt = args.data.resolvedAt;
            }
            return { count: matches.length };
        };

        (prisma.incident as any).findUnique = async (args: any) => {
            return databaseIncidents.find(i => i.id === args.where.id) || null;
        };

        let databaseIncidentGroups: any[] = [];
        let nextGroupId = 1;
        (prisma.incidentGroup as any).create = async (args: any) => {
            const g = {
                id: nextGroupId++,
                ...args.data
            };
            databaseIncidentGroups.push(g);
            return g;
        };
        (prisma.incidentGroup as any).findFirst = async (args: any) => {
            return databaseIncidentGroups.find(g => g.correlationKey === args.where.correlationKey && g.resolvedAt === null) || null;
        };
        (prisma.incidentGroup as any).update = async (args: any) => {
            const g = databaseIncidentGroups.find(x => x.id === args.where.id);
            if (g) {
                Object.assign(g, args.data);
            }
            return g || {};
        };
        (prisma.incidentGroup as any).updateMany = async () => ({ count: 0 });

        (prisma.incidentTransition as any).create = async (args: any) => {
            transitions.push(args.data);
            return args.data;
        };
        (prisma as any).$transaction = async (callback: any) => callback(prisma);

        // 1. WARNING incident reported
        await mgr.reportIncident({
            level: 'WARNING',
            source: 'TEST_SOURCE',
            reason: 'First Warning'
        });
        assert(transitions.length === 1, 'Should log exactly 1 transition on initial warning detection.');
        assert(transitions[0].transitionType === 'DETECTED', 'Initial transition type should be DETECTED.');
        assert(transitions[0].level === 'WARNING', 'Initial transition level should be WARNING.');

        // Let's add a tiny delay to ensure timestamps are strictly increasing
        await new Promise(resolve => setTimeout(resolve, 5));

        // 2. CRITICAL incident reported (Escalation)
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'TEST_SOURCE',
            reason: 'Escalated to Critical'
        });
        assert(transitions.length === 2, 'Should log exactly 2 transitions after escalation.');
        assert(transitions[1].transitionType === 'LEVEL_CHANGED', 'Escalation transition type should be LEVEL_CHANGED.');
        assert(transitions[1].level === 'CRITICAL', 'Escalation transition level should be CRITICAL.');

        await new Promise(resolve => setTimeout(resolve, 5));

        // 3. CRITICAL incident reported again (Duplicate / Level unchanged)
        await mgr.reportIncident({
            level: 'CRITICAL',
            source: 'TEST_SOURCE',
            reason: 'Still Critical'
        });
        assert(transitions.length === 2, 'Should NOT log any transition for duplicate level report.');

        await new Promise(resolve => setTimeout(resolve, 5));

        // 4. Incident resolved
        await mgr.resolveIncidentBySource('TEST_SOURCE');
        assert(transitions.length === 3, 'Should log exactly 3 transitions after resolution.');
        assert(transitions[2].transitionType === 'RESOLVED', 'Resolution transition type should be RESOLVED.');
        assert(transitions[2].level === null, 'Resolution transition level should be null.');

        // 5. Verify occurredAt chronological ordering
        const t1 = Number(transitions[0].occurredAt);
        const t2 = Number(transitions[1].occurredAt);
        const t3 = Number(transitions[2].occurredAt);
        assert(t1 < t2, 'occurredAt 1 should be less than occurredAt 2.');
        assert(t2 < t3, 'occurredAt 2 should be less than occurredAt 3.');

        console.log('✅ [PASS] Incident Timeline Transition and Chronological Ordering verified.');
    } catch (e: any) {
        console.error('❌ Incident Timeline regression test failed:', e.message || e);
    }
    console.log('');

    // ---------------------------------------------------------------------------------
    // TEST 5.3: Incident Correlation & Lifecycles Regression Test
    // ---------------------------------------------------------------------------------
    try {
        console.log('--- Checking IncidentManager: Incident Grouping / Correlation & Lifecycles ---');
        const mockAlertingForGrouping: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        const mgr = new IncidentManager(mockAlertingForGrouping);
        let databaseIncidents: any[] = [];
        let databaseIncidentGroups: any[] = [];
        let transitions: any[] = [];
        let nextIncidentId = 1;
        let nextGroupId = 1;

        (prisma.incident as any).create = async (args: any) => {
            const newIncident = {
                id: nextIncidentId++,
                symbol: args.data.symbol,
                level: args.data.level,
                source: args.data.source,
                reason: args.data.reason,
                detectedAt: args.data.detectedAt,
                resolvedAt: null,
                groupId: args.data.groupId
            };
            databaseIncidents.push(newIncident);
            return newIncident;
        };

        (prisma.incident as any).findFirst = async (args: any) => {
            const symbol = args.where.symbol;
            const source = args.where.source;
            const resolvedAt = args.where.resolvedAt;
            return databaseIncidents.find(i => i.symbol === symbol && i.source === source && i.resolvedAt === resolvedAt) || null;
        };

        (prisma.incident as any).findUnique = async (args: any) => {
            return databaseIncidents.find(i => i.id === args.where.id) || null;
        };

        (prisma.incident as any).findMany = async (args: any) => {
            let res = databaseIncidents;
            if (args && args.where) {
                if (args.where.groupId) {
                    res = res.filter(i => i.groupId === args.where.groupId);
                }
                if (args.where.symbol) {
                    res = res.filter(i => i.symbol === args.where.symbol);
                }
                if (args.where.source) {
                    res = res.filter(i => i.source === args.where.source);
                }
                if ('resolvedAt' in args.where) {
                    res = res.filter(i => i.resolvedAt === args.where.resolvedAt);
                }
            }
            return res;
        };

        (prisma.incident as any).update = async (args: any) => {
            const inc = databaseIncidents.find(i => i.id === args.where.id);
            if (inc) {
                inc.level = args.data.level ?? inc.level;
                inc.reason = args.data.reason ?? inc.reason;
                inc.detectedAt = args.data.detectedAt ?? inc.detectedAt;
            }
            return inc;
        };

        (prisma.incident as any).updateMany = async (args: any) => {
            const ids = args.where.id?.in || [];
            const matches = databaseIncidents.filter(i => ids.includes(i.id));
            for (const m of matches) {
                m.resolvedAt = args.data.resolvedAt;
            }
            return { count: matches.length };
        };

        (prisma.incidentGroup as any).create = async (args: any) => {
            const g = {
                id: nextGroupId++,
                correlationKey: args.data.correlationKey,
                symbol: args.data.symbol,
                groupType: args.data.groupType,
                openedAt: args.data.openedAt,
                resolvedAt: null,
                highestSeverity: args.data.highestSeverity
            };
            databaseIncidentGroups.push(g);
            return g;
        };

        (prisma.incidentGroup as any).findFirst = async (args: any) => {
            const correlationKey = args.where.correlationKey;
            const resolvedAt = args.where.resolvedAt;
            const openedAtGte = args.where.openedAt?.gte;
            return databaseIncidentGroups.find(g => 
                g.correlationKey === correlationKey && 
                g.resolvedAt === resolvedAt && 
                (!openedAtGte || g.openedAt >= openedAtGte)
            ) || null;
        };

        (prisma.incidentGroup as any).update = async (args: any) => {
            const g = databaseIncidentGroups.find(x => x.id === args.where.id);
            if (g) {
                if (args.data.highestSeverity !== undefined) {
                    g.highestSeverity = args.data.highestSeverity;
                }
                if (args.data.resolvedAt !== undefined) {
                    g.resolvedAt = args.data.resolvedAt;
                }
            }
            return g || {};
        };

        (prisma.incidentGroup as any).updateMany = async () => ({ count: 0 });

        (prisma.incidentTransition as any).create = async (args: any) => {
            transitions.push(args.data);
            return args.data;
        };
        (prisma as any).$transaction = async (callback: any) => callback(prisma);

        // 1. Report Incident A (Symbol: BTCUSDT, Source: ORDER_PIPELINE, Severity: WARNING)
        await mgr.reportIncident({
            symbol: 'BTCUSDT',
            level: 'WARNING',
            source: 'ORDER_PIPELINE',
            reason: 'Order stale'
        });
        assert(databaseIncidentGroups.length === 1, 'Group 1 should be created.');
        assert(databaseIncidentGroups[0].correlationKey === 'OPS:BTCUSDT', 'Group 1 correlation key should be OPS:BTCUSDT.');
        assert(databaseIncidentGroups[0].highestSeverity === 'WARNING', 'Group 1 severity should be WARNING.');
        assert(databaseIncidents.length === 1, 'Incident A should be created.');
        assert(databaseIncidents[0].groupId === databaseIncidentGroups[0].id, 'Incident A should link to Group 1.');

        // 2. Report Incident B (Symbol: BTCUSDT, Source: SIGNAL_INTEGRITY, Severity: CRITICAL) within 10s
        await mgr.reportIncident({
            symbol: 'BTCUSDT',
            level: 'CRITICAL',
            source: 'SIGNAL_INTEGRITY',
            reason: 'Signal missing'
        });
        assert(databaseIncidentGroups.length === 1, 'Incident B should bind to the existing Group 1.');
        assert(databaseIncidents.length === 2, 'Incident B should be created.');
        assert(databaseIncidents[1].groupId === databaseIncidentGroups[0].id, 'Incident B should link to Group 1.');
        assert(databaseIncidentGroups[0].highestSeverity === 'CRITICAL', 'Group 1 severity should escalate to CRITICAL.');

        // 3. Report Incident C (Symbol: ETHUSDT, Source: ORDER_PIPELINE, Severity: LOW)
        await mgr.reportIncident({
            symbol: 'ETHUSDT',
            level: 'LOW',
            source: 'ORDER_PIPELINE',
            reason: 'ETH order stale'
        });
        assert(databaseIncidentGroups.length === 2, 'Group 2 should be created due to symbol difference.');
        assert(databaseIncidentGroups[1].correlationKey === 'OPS:ETHUSDT', 'Group 2 correlation key should be OPS:ETHUSDT.');

        // 4. Report Infrastructure Incident (Source: CPU, Severity: WARNING)
        await mgr.reportIncident({
            level: 'WARNING',
            source: 'CPU_HIGH',
            reason: 'CPU overload'
        });
        assert(databaseIncidentGroups.length === 3, 'Group 3 should be created for infrastructure.');
        assert(databaseIncidentGroups[2].groupType === 'INFRASTRUCTURE', 'Group 3 type should be INFRASTRUCTURE.');
        assert(databaseIncidentGroups[2].correlationKey === 'INFRA:GLOBAL', 'Group 3 correlation key should be INFRA:GLOBAL.');

        // 5. Mixed Severity Timeline & Recalculation (Test 5.3.5)
        databaseIncidents = [];
        databaseIncidentGroups = [];
        nextIncidentId = 1;
        nextGroupId = 1;

        // A (HIGH)
        await mgr.reportIncident({
            symbol: 'BTCUSDT',
            level: 'HIGH',
            source: 'ORDER_PIPELINE_STALE',
            reason: 'HIGH severity incident'
        });
        // B (CRITICAL)
        await mgr.reportIncident({
            symbol: 'BTCUSDT',
            level: 'CRITICAL',
            source: 'SIGNAL_INTEGRITY_BREACH',
            reason: 'CRITICAL severity incident'
        });
        // C (WARNING)
        await mgr.reportIncident({
            symbol: 'BTCUSDT',
            level: 'WARNING',
            source: 'LATENCY_SPIKE',
            reason: 'WARNING severity incident'
        });

        assert(databaseIncidentGroups.length === 1, 'All BTCUSDT incidents should be correlated to Group 1.');
        assert(databaseIncidentGroups[0].highestSeverity === 'CRITICAL', 'Initial group severity should be CRITICAL.');

        // Resolve B (CRITICAL)
        await mgr.resolveIncidentBySource('SIGNAL_INTEGRITY_BREACH', 'BTCUSDT');
        assert(databaseIncidentGroups[0].resolvedAt === null, 'Group 1 should remain open.');
        assert(databaseIncidentGroups[0].highestSeverity === 'HIGH', 'Group severity should recalculate down to HIGH.');

        // Resolve A (HIGH)
        await mgr.resolveIncidentBySource('ORDER_PIPELINE_STALE', 'BTCUSDT');
        assert(databaseIncidentGroups[0].resolvedAt === null, 'Group 1 should remain open.');
        assert(databaseIncidentGroups[0].highestSeverity === 'WARNING', 'Group severity should recalculate down to WARNING.');

        // Resolve C (WARNING)
        await mgr.resolveIncidentBySource('LATENCY_SPIKE', 'BTCUSDT');
        assert(databaseIncidentGroups[0].resolvedAt !== null, 'Group 1 should now be resolved.');
        assert(databaseIncidentGroups[0].highestSeverity === 'CRITICAL', 'Resolved group severity should freeze at historical peak CRITICAL.');

        console.log('✅ [PASS] Incident Correlation and Dynamic Group Severity Lifecycles verified.');
    } catch (e: any) {
        console.error('❌ Incident Grouping / Correlation regression test failed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 6: Reporting Service
    // ----------------------------------------------------
    try {
        console.log('--- Checking Service: Reporting Service ---');

        const reporting = new ReportingService();

        let mockIncidents: any[] = [];
        (prisma.incident as any).findMany = async (args: any) => {
            let res = mockIncidents;
            if (args?.where) {
                if (args.where.resolvedAt === null) {
                    res = res.filter(i => i.resolvedAt === null);
                }
                if (args.where.detectedAt && args.where.detectedAt.gte) {
                    const cutoff = Number(args.where.detectedAt.gte);
                    res = res.filter(i => Number(i.detectedAt) >= cutoff);
                }
            }
            return res;
        };

        // Scenario A: No incidents logged today
        mockIncidents = [];
        const reportEmpty = await reporting.generateDailyReport(new Date());
        assert(reportEmpty.includes('Operations Incidents:\n- None'), 'Daily report shows "- None" when no operations incidents are logged.');
        assert(reportEmpty.includes('Execution Incidents:\n- None'), 'Daily report shows "- None" when no execution incidents are logged.');
        assert(reportEmpty.includes('Current Health:\nNORMAL'), 'System Health is NORMAL when there are no active incidents.');

        // Scenario B: Operations and Execution incidents are logged
        mockIncidents = [
            {
                id: 1,
                symbol: null,
                level: 'CRITICAL',
                source: 'BROKER_DISCONNECT',
                reason: 'Broker connection is reported down! Detail: Connection offline',
                detectedAt: BigInt(Date.now() - 5000),
                resolvedAt: null
            },
            {
                id: 2,
                symbol: 'BTCUSDT',
                level: 'MEDIUM',
                source: 'MARKET_DATA_FEED_STALE',
                reason: 'Market data updates are stale globally!',
                detectedAt: BigInt(Date.now() - 10000),
                resolvedAt: BigInt(Date.now() - 2000)
            },
            {
                id: 3,
                symbol: 'ETHUSDT',
                level: 'MEDIUM',
                source: 'SPREAD',
                reason: 'Spread Explosion: 0.12 > 5x Median',
                detectedAt: BigInt(Date.now() - 20000),
                resolvedAt: null
            }
        ];

        const reportWithData = await reporting.generateDailyReport(new Date());
        assert(reportWithData.includes('- Broker Disconnect: 1'), 'Daily report groups and counts Broker Disconnect.');
        assert(reportWithData.includes('- Market Data Feed Stale: 1'), 'Daily report groups and counts Market Data Feed Stale.');
        assert(reportWithData.includes('- Spread Anomaly: 1'), 'Daily report groups and counts Spread Anomaly.');
        assert(reportWithData.includes('Current Health:\nHALTED'), 'System Health is HALTED because there is an active HALTED incident.');

        // Scenario C: Health score calculation
        // Active: id=1 (HALTED -> -50), id=3 (DEGRADED -> -20). id=2 is resolved.
        // Total score: 100 - 50 - 20 = 30. Level: HALTED.
        const health = await reporting.getSystemHealthScore();
        assert(health.score === 30, `Health score should be 30 (Calculated: ${health.score}).`);
        assert(health.level === 'HALTED', `Health level should be HALTED (Calculated: ${health.level}).`);
        assert(health.activeIncidentsCount === 2, 'Should count 2 active incidents.');

        // Scenario D: Health score calculation (Normal state)
        mockIncidents = [];
        const healthEmpty = await reporting.getSystemHealthScore();
        assert(healthEmpty.score === 100, 'Health score is 100 when there are no active incidents.');
        assert(healthEmpty.level === 'EXCELLENT', 'Health level is EXCELLENT when there are no active incidents.');
    } catch (e: any) {
        console.error('❌ Reporting Service test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 7: Alerting Service Deduplication
    // ----------------------------------------------------
    try {
        console.log('--- Checking Service: Alerting Service ---');

        const alertingService = new AlertingService();
        
        // Mock process.env to avoid network calls to Telegram API
        const prevToken = process.env.TELEGRAM_BOT_TOKEN;
        const prevChatId = process.env.TELEGRAM_CHAT_ID;
        process.env.TELEGRAM_BOT_TOKEN = '';
        process.env.TELEGRAM_CHAT_ID = '';

        // Mock database insertion since we want to focus on de-duplication cache
        let originalCreate = prisma.alertLog.create;
        let createdAlertLogs: any[] = [];
        (prisma.alertLog as any).create = async (args: any) => {
            createdAlertLogs.push(args.data);
            return args.data;
        };

        // First alert dispatch (non-duplicate)
        await alertingService.sendAlert({
            level: 'CRITICAL',
            title: 'Test Alert',
            message: 'First delivery attempt',
            dedupKey: 'test_alert_dedup'
        });
        assert(createdAlertLogs.length === 1, 'Should persist first alert delivery.');

        // Second alert dispatch (duplicate within cooldown)
        await alertingService.sendAlert({
            level: 'CRITICAL',
            title: 'Test Alert',
            message: 'Second duplicate delivery attempt',
            dedupKey: 'test_alert_dedup'
        });
        assert(createdAlertLogs.length === 1, 'Should suppress duplicate alert within cooldown period.');

        // Verify deduplication map works on a custom key too
        await alertingService.sendAlert({
            level: 'WARNING',
            title: 'Another Alert',
            message: 'Custom key delivery',
            dedupKey: 'another_alert_dedup'
        });
        assert(createdAlertLogs.length === 2, 'Should deliver alert with different dedup key.');

        // Cleanup
        prisma.alertLog.create = originalCreate;
        process.env.TELEGRAM_BOT_TOKEN = prevToken;
        process.env.TELEGRAM_CHAT_ID = prevChatId;
    } catch (e: any) {
        console.error('❌ Alerting Service test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 8: Infrastructure Integration via Orchestrator
    // ----------------------------------------------------
    try {
        console.log('--- Checking Orchestrator: Infrastructure Integration & Idempotency ---');
        
        const mockAlertingForOrch: any = {
            alertsSent: [] as any[],
            async sendAlert(alert: any) {
                this.alertsSent.push(alert);
            }
        };

        const orchestrator = new WatchdogOrchestrator();
        // Inject our mock alerting service and a real incident manager with the mock alerting
        const mgr = new IncidentManager(mockAlertingForOrch);
        (orchestrator as any).incidentManager = mgr;
        (orchestrator as any).alertingService = mockAlertingForOrch;

        // Mock database
        let databaseIncidents: any[] = [];
        let databaseIncidentGroups: any[] = [];
        let transitions: any[] = [];
        let nextIncidentId = 1;
        let nextGroupId = 1;

        const originalIncidentCreate = prisma.incident.create;
        const originalIncidentFindFirst = prisma.incident.findFirst;
        const originalIncidentFindMany = prisma.incident.findMany;
        const originalIncidentUpdate = prisma.incident.update;
        const originalIncidentUpdateMany = prisma.incident.updateMany;
        const originalIncidentGroupCreate = prisma.incidentGroup.create;
        const originalIncidentGroupFindFirst = prisma.incidentGroup.findFirst;
        const originalIncidentGroupUpdate = prisma.incidentGroup.update;
        const originalTransitionCreate = prisma.incidentTransition.create;

        (prisma.incident as any).create = async (args: any) => {
            const newIncident = {
                id: nextIncidentId++,
                symbol: args.data.symbol,
                level: args.data.level,
                source: args.data.source,
                reason: args.data.reason,
                detectedAt: args.data.detectedAt,
                resolvedAt: null,
                groupId: args.data.groupId
            };
            databaseIncidents.push(newIncident);
            return newIncident;
        };

        (prisma.incident as any).findFirst = async (args: any) => {
            const symbol = args.where?.symbol;
            const source = args.where?.source;
            const resolvedAt = args.where?.resolvedAt;
            return databaseIncidents.find(i => i.symbol === symbol && i.source === source && i.resolvedAt === resolvedAt) || null;
        };

        (prisma.incident as any).findMany = async (args: any) => {
            let res = databaseIncidents;
            if (args && args.where) {
                if (args.where.groupId) {
                    res = res.filter(i => i.groupId === args.where.groupId);
                }
                if (args.where.symbol !== undefined) {
                    res = res.filter(i => i.symbol === args.where.symbol);
                }
                if (args.where.source) {
                    res = res.filter(i => i.source === args.where.source);
                }
                if ('resolvedAt' in args.where) {
                    res = res.filter(i => i.resolvedAt === args.where.resolvedAt);
                }
            }
            return res;
        };

        (prisma.incident as any).update = async (args: any) => {
            const inc = databaseIncidents.find(i => i.id === args.where.id);
            if (inc) {
                inc.level = args.data.level ?? inc.level;
                inc.reason = args.data.reason ?? inc.reason;
                inc.detectedAt = args.data.detectedAt ?? inc.detectedAt;
            }
            return inc;
        };

        (prisma.incident as any).updateMany = async (args: any) => {
            const ids = args.where.id?.in || [];
            const matches = databaseIncidents.filter(i => ids.includes(i.id));
            for (const m of matches) {
                m.resolvedAt = args.data.resolvedAt;
            }
            return { count: matches.length };
        };

        (prisma.incidentGroup as any).create = async (args: any) => {
            const g = {
                id: nextGroupId++,
                correlationKey: args.data.correlationKey,
                symbol: args.data.symbol,
                groupType: args.data.groupType,
                openedAt: args.data.openedAt,
                resolvedAt: null,
                highestSeverity: args.data.highestSeverity
            };
            databaseIncidentGroups.push(g);
            return g;
        };

        (prisma.incidentGroup as any).findFirst = async (args: any) => {
            const correlationKey = args.where?.correlationKey;
            const resolvedAt = args.where?.resolvedAt;
            const groupType = args.where?.groupType;
            const openedAtGte = args.where?.openedAt?.gte;
            return databaseIncidentGroups.find(g => 
                (!correlationKey || g.correlationKey === correlationKey) && 
                (!groupType || g.groupType === groupType) &&
                g.resolvedAt === resolvedAt && 
                (!openedAtGte || g.openedAt >= openedAtGte)
            ) || null;
        };

        (prisma.incidentGroup as any).update = async (args: any) => {
            const g = databaseIncidentGroups.find(x => x.id === args.where.id);
            if (g) {
                if (args.data.highestSeverity !== undefined) {
                    g.highestSeverity = args.data.highestSeverity;
                }
                if (args.data.resolvedAt !== undefined) {
                    g.resolvedAt = args.data.resolvedAt;
                }
            }
            return g;
        };

        (prisma.incidentTransition as any).create = async (args: any) => {
            const t = {
                id: transitions.length + 1,
                incidentId: args.data.incidentId,
                transitionType: args.data.transitionType,
                level: args.data.level,
                reason: args.data.reason,
                occurredAt: args.data.occurredAt
            };
            transitions.push(t);
            return t;
        };

        // Now mock the InfrastructureWatchdogService methods
        let mockDockerHealthy = true;
        let mockFreqtradeHealthy = true;
        let mockVmHealthy = true;

        (orchestrator as any).infraService.checkDockerContainerHealth = async () => {
            if (mockDockerHealthy) {
                return { source: 'DOCKER', healthy: true, checkedAt: new Date(), checkDurationMs: 5 };
            } else {
                return { source: 'DOCKER', healthy: false, checkedAt: new Date(), checkDurationMs: 5, severity: 'CRITICAL', message: 'Docker crash' };
            }
        };

        (orchestrator as any).infraService.checkFreqtradeAPI = async () => {
            if (mockFreqtradeHealthy) {
                return { source: 'FREQTRADE', healthy: true, checkedAt: new Date(), checkDurationMs: 5 };
            } else {
                return { source: 'FREQTRADE', healthy: false, checkedAt: new Date(), checkDurationMs: 5, severity: 'WARNING', message: 'API slow' };
            }
        };

        (orchestrator as any).infraService.checkVMHealth = async () => {
            if (mockVmHealthy) {
                return { source: 'VM', healthy: true, checkedAt: new Date(), checkDurationMs: 5 };
            } else {
                return { source: 'VM', healthy: false, checkedAt: new Date(), checkDurationMs: 5, severity: 'CRITICAL', message: 'CPU high' };
            }
        };

        // Mock others to return healthy
        (orchestrator as any).infraService.checkHostNetwork = async () => ({ source: 'NETWORK', healthy: true, checkedAt: new Date(), checkDurationMs: 5 });
        (orchestrator as any).infraService.checkExchangeReachability = async () => ({ source: 'EXCHANGE_REACHABILITY', healthy: true, checkedAt: new Date(), checkDurationMs: 5 });
        (orchestrator as any).infraService.checkDnsResolution = async () => ({ source: 'DNS', healthy: true, checkedAt: new Date(), checkDurationMs: 5 });

        // --- Cycle 1: Everything is healthy ---
        await (orchestrator as any).runInfraLoop();
        assert(databaseIncidents.length === 0, 'Healthy cycle should not create any incidents.');
        assert(databaseIncidentGroups.length === 0, 'Healthy cycle should not create any incident groups.');

        // --- Cycle 2: Docker goes unhealthy ---
        mockDockerHealthy = false;
        await (orchestrator as any).runInfraLoop();
        assert(databaseIncidents.length === 1, 'Docker failure should create an incident.');
        assert(databaseIncidents[0].source === 'DOCKER' && databaseIncidents[0].level === 'CRITICAL', 'Docker incident details should match.');
        assert(databaseIncidentGroups.length === 1, 'Incident group should be created.');
        assert(databaseIncidentGroups[0].groupType === 'INFRASTRUCTURE', 'Group type should be INFRASTRUCTURE.');
        assert(databaseIncidentGroups[0].highestSeverity === 'CRITICAL', 'Group severity should be CRITICAL.');

        // --- Cycle 3: Docker is STILL unhealthy (repeated unhealthy cycle) ---
        await (orchestrator as any).runInfraLoop();
        assert(databaseIncidents.length === 1, 'Repeated unhealthy cycle should not duplicate incident.');
        assert(databaseIncidentGroups.length === 1, 'Repeated unhealthy cycle should not duplicate group.');

        // --- Cycle 4: Freqtrade API and VM ALSO go unhealthy ---
        mockFreqtradeHealthy = false;
        mockVmHealthy = false;
        await (orchestrator as any).runInfraLoop();
        assert(databaseIncidents.length === 3, 'VM and Freqtrade failures should create additional incidents.');
        // Verify they group into the same INFRASTRUCTURE group
        assert(databaseIncidents.every(i => i.groupId === databaseIncidentGroups[0].id), 'All infra incidents should bind to the same INFRASTRUCTURE group.');
        assert(databaseIncidentGroups.length === 1, 'Should keep only 1 INFRASTRUCTURE group.');

        // --- Cycle 5: VM recovers (healthy), Docker and Freqtrade still unhealthy ---
        mockVmHealthy = true;
        await (orchestrator as any).runInfraLoop();
        const vmIncident = databaseIncidents.find(i => i.source === 'VM');
        assert(vmIncident.resolvedAt !== null, 'VM incident should be resolved.');
        assert(databaseIncidentGroups[0].resolvedAt === null, 'INFRASTRUCTURE group should remain open since Docker/Freqtrade are still active.');

        // --- Cycle 6: VM is STILL healthy (repeated healthy cycle) ---
        const prevResolvedAt = vmIncident.resolvedAt;
        await (orchestrator as any).runInfraLoop();
        assert(vmIncident.resolvedAt === prevResolvedAt, 'Repeated healthy cycle should not mutate resolvedAt.');

        // --- Cycle 7: Docker and Freqtrade recover (everything healthy now) ---
        mockDockerHealthy = true;
        mockFreqtradeHealthy = true;
        await (orchestrator as any).runInfraLoop();
        assert(databaseIncidents.every(i => i.resolvedAt !== null), 'All incidents should be resolved.');
        assert(databaseIncidentGroups[0].resolvedAt !== null, 'INFRASTRUCTURE group should now be resolved.');

        // Cleanup
        prisma.incident.create = originalIncidentCreate;
        prisma.incident.findFirst = originalIncidentFindFirst;
        prisma.incident.findMany = originalIncidentFindMany;
        prisma.incident.update = originalIncidentUpdate;
        prisma.incident.updateMany = originalIncidentUpdateMany;
        prisma.incidentGroup.create = originalIncidentGroupCreate;
        prisma.incidentGroup.findFirst = originalIncidentGroupFindFirst;
        prisma.incidentGroup.update = originalIncidentGroupUpdate;
        prisma.incidentTransition.create = originalTransitionCreate;

        console.log('✅ [PASS] Orchestrator integration, idempotency, and multi-source grouping verified successfully.');
    } catch (e: any) {
        console.error('❌ Orchestrator Infrastructure Integration test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 9: Evidence Collection (RCA Phase 3.1)
    // ----------------------------------------------------
    try {
        console.log('--- Checking RCA Phase 3.1: Evidence Collection ---');

        const originalFindUniqueGroup = prisma.incidentGroup.findUnique;
        const originalFindManyAudits = prisma.decisionAudit.findMany;

        const mockGroup = {
            id: 101,
            correlationKey: 'INFRA:GLOBAL',
            symbol: null,
            groupType: 'INFRASTRUCTURE',
            openedAt: BigInt(1710000000000),
            resolvedAt: BigInt(1710000060000),
            highestSeverity: 'CRITICAL',
            incidents: [
                {
                    id: 501,
                    symbol: null,
                    level: 'CRITICAL',
                    source: 'DOCKER',
                    reason: 'Docker container down',
                    detectedAt: BigInt(1710000005000),
                    resolvedAt: BigInt(1710000045000),
                    groupId: 101
                },
                {
                    id: 502,
                    symbol: null,
                    level: 'WARNING',
                    source: 'VM',
                    reason: 'High CPU utilization',
                    detectedAt: BigInt(1710000010000),
                    resolvedAt: null,
                    groupId: 101
                }
            ]
        } as any;

        const mockAudits = [
            {
                id: 'audit-1',
                classification: 'VM_HEALTH',
                rejectionReason: 'CPU is at 98%',
                systemRiskState: 'NORMAL',
                htf: null,
                metadata: { cpu: 98 },
                createdAt: new Date(1710000008000)
            },
            {
                id: 'audit-2', // Out of bounds audit
                classification: 'EXCHANGE_HEALTH',
                rejectionReason: 'Binance slow response',
                systemRiskState: 'NORMAL',
                htf: null,
                metadata: null,
                createdAt: new Date(1710000090000)
            }
        ] as any;

        (prisma.incidentGroup as any).findUnique = async (args: any) => {
            if (args.where.id === 101) return mockGroup;
            return null;
        };

        (prisma.decisionAudit as any).findMany = async (args: any) => {
            const gte = args.where.createdAt.gte.getTime();
            const lte = args.where.createdAt.lte.getTime();
            return mockAudits.filter((a: any) => a.createdAt.getTime() >= gte && a.createdAt.getTime() <= lte);
        };

        const collector = new EvidenceCollector();
        const evidence = await collector.collectEvidence(101);

        // Assertions
        assert(evidence.length === 6, 'Should collect exactly 6 evidence items.');
        
        // Check sorting and sequence mapping
        assert(evidence[0].category === 'GROUP' && evidence[0].event === 'CREATED' && evidence[0].timestamp === 1710000000000, 'Sequence 1 should be group creation.');
        assert(evidence[0].sequence === 1, 'Sequence 1 should have sequence index 1.');
        assert(evidence[0].groupId === 101, 'Group created evidence should hold correct groupId.');
        assert(evidence[0].correlationKey === 'INFRA:GLOBAL', 'Group created evidence should hold correlation key.');
        assert(evidence[0].severity === 'CRITICAL', 'Group created evidence should hold highestSeverity.');

        assert(evidence[1].category === 'INCIDENT' && evidence[1].event === 'DETECTED' && evidence[1].source === 'DOCKER' && evidence[1].timestamp === 1710000005000, 'Sequence 2 should be DOCKER incident detection.');
        assert(evidence[1].sequence === 2, 'Sequence 2 should have sequence index 2.');
        assert(evidence[1].groupId === 101, 'DOCKER incident should have correct groupId.');
        assert(evidence[1].severity === 'CRITICAL', 'DOCKER incident should have CRITICAL level.');

        assert(evidence[2].category === 'AUDIT' && evidence[2].event === 'OBSERVED' && evidence[2].source === 'VM_HEALTH' && evidence[2].timestamp === 1710000008000, 'Sequence 3 should be VM_HEALTH audit.');
        assert(evidence[2].sequence === 3, 'Sequence 3 should have sequence index 3.');
        assert(evidence[2].groupId === 101, 'Audit evidence should have correct groupId.');
        assert(evidence[2].origin === 'OBSERVATION', 'Audit evidence should have origin OBSERVATION.');
        assert((evidence[2].metadata as any)?.cpu === 98, 'Audit evidence should preserve metadata.');

        assert(evidence[3].category === 'INCIDENT' && evidence[3].event === 'DETECTED' && evidence[3].source === 'VM' && evidence[3].timestamp === 1710000010000, 'Sequence 4 should be VM incident detection.');
        assert(evidence[3].sequence === 4, 'Sequence 4 should have sequence index 4.');
        assert(evidence[3].severity === 'WARNING', 'VM incident should have WARNING level.');

        assert(evidence[4].category === 'INCIDENT' && evidence[4].event === 'RESOLVED' && evidence[4].source === 'DOCKER' && evidence[4].timestamp === 1710000045000, 'Sequence 5 should be DOCKER incident resolution.');
        assert(evidence[4].sequence === 5, 'Sequence 5 should have sequence index 5.');

        assert(evidence[5].category === 'GROUP' && evidence[5].event === 'RESOLVED' && evidence[5].timestamp === 1710000060000, 'Sequence 6 should be group resolution.');
        assert(evidence[5].sequence === 6, 'Sequence 6 should have sequence index 6.');
        assert(evidence[5].origin === 'ASSESSMENT', 'Group resolution should have origin ASSESSMENT.');

        // Verify out of bounds audit was excluded
        const hasExchangeAudit = evidence.some(e => e.source === 'EXCHANGE_HEALTH');
        assert(!hasExchangeAudit, 'Should exclude audits outside group active timeframe.');

        // Restore mocks
        prisma.incidentGroup.findUnique = originalFindUniqueGroup;
        prisma.decisionAudit.findMany = originalFindManyAudits;

        console.log('✅ [PASS] Evidence Collection sequence, types, sorting, and boundary exclusions verified.');
    } catch (e: any) {
        console.error('❌ Evidence Collection test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 10: Timeline Reconstruction & Temporal Clustering (RCA Phase 3.2)
    // ----------------------------------------------------
    try {
        console.log('--- Checking RCA Phase 3.2: Timeline Reconstruction & Temporal Clustering ---');

        const mockEvidenceList = [
            {
                id: 'ev-1',
                groupId: 101,
                sequence: 1,
                category: 'GROUP',
                source: 'INFRASTRUCTURE',
                event: 'CREATED',
                timestamp: 1710000000000,
                origin: 'ASSESSMENT',
                message: 'Incident group created'
            },
            {
                id: 'ev-2',
                groupId: 101,
                sequence: 2,
                category: 'INCIDENT',
                source: 'VM',
                event: 'DETECTED',
                timestamp: 1710000000500, // 500ms since start
                origin: 'ASSESSMENT',
                entityId: 'inc-1',
                severity: 'WARNING',
                message: 'VM High CPU'
            },
            {
                id: 'ev-3',
                groupId: 101,
                sequence: 3,
                category: 'INCIDENT',
                source: 'DOCKER',
                event: 'DETECTED',
                timestamp: 1710000000800, // 300ms since previous, 800ms since start
                origin: 'ASSESSMENT',
                entityId: 'inc-2',
                severity: 'CRITICAL',
                message: 'Docker down'
            },
            {
                id: 'ev-4',
                groupId: 101,
                sequence: 4,
                category: 'INCIDENT',
                source: 'HEARTBEAT',
                event: 'DETECTED',
                timestamp: 1710000003000, // 2200ms since previous, 3000ms since start
                origin: 'ASSESSMENT',
                entityId: 'inc-3',
                severity: 'MEDIUM',
                message: 'Heartbeat silent'
            },
            {
                id: 'ev-5',
                groupId: 101,
                sequence: 5,
                category: 'INCIDENT',
                source: 'VM',
                event: 'RESOLVED',
                timestamp: 1710000005000, // 2000ms since previous, 5000ms since start
                origin: 'ASSESSMENT',
                entityId: 'inc-1',
                severity: 'WARNING',
                message: 'VM CPU resolved'
            },
            {
                id: 'ev-6',
                groupId: 101,
                sequence: 6,
                category: 'GROUP',
                source: 'INFRASTRUCTURE',
                event: 'RESOLVED',
                timestamp: 1710000006000, // 1000ms since previous, 6000ms since start
                origin: 'ASSESSMENT',
                message: 'Group resolved'
            }
        ] as any[];

        const reconstructor = new TimelineReconstructor(1000); // 1000ms threshold
        const timeline = reconstructor.reconstruct(101, mockEvidenceList);

        // Core assertions
        assert(timeline.groupId === 101, 'Timeline groupId should match.');
        assert(timeline.startTime === 1710000000000, 'Timeline startTime should match first event.');
        assert(timeline.endTime === 1710000006000, 'Timeline endTime should match last event.');
        assert(timeline.durationMs === 6000, 'Timeline durationMs should be 6000ms.');
        assert(timeline.events.length === 6, 'Timeline should contain 6 events.');

        // Verify deltas
        const ev2 = timeline.events[1];
        assert(ev2.deltaFromStartMs === 500, 'ev-2 deltaFromStartMs should be 500ms.');
        assert(ev2.deltaFromPreviousMs === 500, 'ev-2 deltaFromPreviousMs should be 500ms.');

        const ev3 = timeline.events[2];
        assert(ev3.deltaFromStartMs === 800, 'ev-3 deltaFromStartMs should be 800ms.');
        assert(ev3.deltaFromPreviousMs === 300, 'ev-3 deltaFromPreviousMs should be 300ms.');

        // Verify adjacency pointers
        assert(ev3.previousEventId === 'ev-2', 'ev-3 previousEventId should point to ev-2.');
        assert(ev3.nextEventId === 'ev-4', 'ev-3 nextEventId should point to ev-4.');
        assert(ev3.previousSequence === 2, 'ev-3 previousSequence should be 2.');
        assert(ev3.nextSequence === 4, 'ev-3 nextSequence should be 4.');

        // Verify duration calculations in incidentLifecycles
        const vmIncLifecycle = timeline.incidentLifecycles['inc-1'];
        assert(vmIncLifecycle !== undefined, 'VM incident lifecycle should be recorded.');
        assert(vmIncLifecycle.isResolved === true, 'VM incident lifecycle should be resolved.');
        assert(vmIncLifecycle.durationMs === 4500, 'VM incident lifecycle duration should be 4500ms (5000 - 500).');
        assert(vmIncLifecycle.initialSeverity === 'WARNING', 'VM incident initialSeverity should be WARNING.');
        assert(vmIncLifecycle.peakSeverity === 'WARNING', 'VM incident peakSeverity should be WARNING.');

        const dockerIncLifecycle = timeline.incidentLifecycles['inc-2'];
        assert(dockerIncLifecycle !== undefined, 'Docker lifecycle should exist.');
        assert(dockerIncLifecycle.isResolved === false, 'Docker lifecycle should remain active/unresolved.');

        // Verify statistics
        assert(timeline.statistics.incidentCount === 4, 'statistics: incidentCount should be 4.');
        assert(timeline.statistics.infraCount === 3, 'statistics: infraCount (VM, DOCKER) should be 3.');
        assert(timeline.statistics.opsCount === 1, 'statistics: opsCount (HEARTBEAT) should be 1.');
        assert(timeline.statistics.resolvedCount === 1, 'statistics: resolvedCount should be 1.');
        assert(timeline.statistics.activeCount === 2, 'statistics: activeCount should be 2.');
        assert(timeline.statistics.firstIncidentAt === 1710000000500, 'statistics: firstIncidentAt matches first detected incident.');
        assert(timeline.statistics.lastIncidentAt === 1710000003000, 'statistics: lastIncidentAt matches last detected incident.');
        assert(timeline.statistics.peakSeverity === 'CRITICAL', 'statistics: peakSeverity should be CRITICAL.');

        // Verify Concurrency Clustering (Compare to cluster start to prevent chaining)
        // Cluster 1: GroupCreated (0), VM (500), DOCKER (800) are within 1000ms of clusterStart (0).
        // HEARTBEAT (3000) is > 1000ms from clusterStart (0), so it splits.
        // Cluster 2: VM Resolved (5000) and Group Resolved (6000) are within 1000ms of clusterStart (5000).
        assert(timeline.concurrencyClusters.length === 2, 'Should find exactly 2 concurrent clusters.');
        const cluster1 = timeline.concurrencyClusters[0];
        assert(cluster1.length === 3, 'First cluster should contain 3 events.');
        assert(cluster1[0].id === 'ev-1' && cluster1[1].id === 'ev-2' && cluster1[2].id === 'ev-3', 'First cluster elements should match.');
        const cluster2 = timeline.concurrencyClusters[1];
        assert(cluster2.length === 2, 'Second cluster should contain 2 events.');
        assert(cluster2[0].id === 'ev-5' && cluster2[1].id === 'ev-6', 'Second cluster elements should match.');

        assert(ev2.isConcurrent === true && ev3.isConcurrent === true, 'Clustered events should flag isConcurrent = true.');
        assert(timeline.events[3].isConcurrent === false, 'Out-of-cluster event should flag isConcurrent = false.');

        // Verify Record-based index maps (JSON-serializable)
        assert(timeline.eventsBySource['VM'].length === 2, 'eventsBySource VM index should yield 2 events.');
        assert(timeline.eventsByCategory['INCIDENT'].length === 4, 'eventsByCategory INCIDENT index should yield 4 events.');

        console.log('✅ [PASS] Timeline reconstruction, temporal deltas, serialization records, statistical metrics, and non-chaining concurrency verified.');
    } catch (e: any) {
        console.error('❌ Timeline Reconstruction test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 11: Candidate Hypothesis Generation (RCA Phase 3.3)
    // ----------------------------------------------------
    try {
        console.log('--- Checking Playbook 11: Candidate Hypothesis Generation ---');

        // Setup test config with windows matching MVP_CONFIG
        const config = {
            dockerCascadeWindowMs: MVP_CONFIG.RCA.DOCKER_CASCADE_WINDOW_MS,
            telemetryWindowMs: MVP_CONFIG.RCA.TELEMETRY_WINDOW_MS,
            vmExhaustionWindowMs: MVP_CONFIG.RCA.VM_EXHAUSTION_WINDOW_MS,
            networkOutageWindowMs: MVP_CONFIG.RCA.NETWORK_OUTAGE_WINDOW_MS
        };

        const rules = [
            new DockerRule(config),
            new TelemetryRule(config),
            new VMRule(config),
            new NetworkRule(config),
            new ExchangeRule(config),
            new LifecycleRule(config)
        ];

        const generator = new CandidateGenerator(rules);

        // 1. Build mock Timeline for Scenario A (VM Exhaustion) + Scenario B (Isolated Telemetry Blip) + Scenario C (Isolated Exchange API Outage)
        const mockTimelineA: any = {
            events: [
                { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 },
                { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000005000 },
                { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }
            ],
            eventsBySource: {
                'CPU': [{ id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }],
                'MEMORY': [{ id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }],
                'HEARTBEAT': [{ id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000005000 }],
                'EXCHANGE_REACHABILITY': [{ id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 },
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000005000 },
                    { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }
                ]
            ],
            incidentLifecycles: {
                'ev-cpu-lifecycle': { incidentId: 'ev-cpu', isResolved: false },
                'ev-mem-lifecycle': { incidentId: 'ev-mem', isResolved: false },
                'ev-hb-lifecycle': { incidentId: 'ev-hb', isResolved: false },
                'ev-ex-lifecycle': { incidentId: 'ev-ex', isResolved: false }
            },
            firstIncident: { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        let candidates = generator.generateCandidates(mockTimelineA);

        // Assertions for mockTimelineA:
        // - VM_RESOURCE_EXHAUSTION should exist
        const vmCand = candidates.find(c => c.id === 'VM_RESOURCE_EXHAUSTION');
        assert(vmCand !== undefined, 'VM Exhaustion hypothesis should be generated.');
        if (vmCand) {
            assert(vmCand.supportingEvidence.includes('ev-cpu') && vmCand.supportingEvidence.includes('ev-mem'), 'VM Exhaustion should list CPU and MEMORY as supporting evidence.');
            assert(vmCand.missingEvidence.length === 0, 'VM Exhaustion should not list healthy alternative channels in missingEvidence.');
            assert(vmCand.evaluationHints.some(h => h.id === 'VM_RESOURCE_OVERLOAD' && h.description === 'Concurrent resource threshold breach' && h.evidenceIds.includes('ev-cpu')), 'VM Exhaustion should include positive concurrency hint.');
        }

        // - TELEMETRY_BLACKOUT should exist (since HEARTBEAT is down)
        const telCand = candidates.find(c => c.id === 'TELEMETRY_BLACKOUT');
        assert(telCand !== undefined, 'Telemetry blackout hypothesis should be generated.');
        if (telCand) {
            assert(telCand.missingEvidence.includes('BROKER_CONNECTION') && telCand.missingEvidence.includes('MARKET_DATA_STALE'), 'Telemetry blackout should flag BROKER_CONNECTION and MARKET_DATA_STALE as missing.');
        }

        // - EXCHANGE_OUTAGE should exist and be healthy (no network/DNS outage contradicting it)
        const exCand = candidates.find(c => c.id === 'EXCHANGE_OUTAGE');
        assert(exCand !== undefined, 'Exchange outage hypothesis should be generated.');
        if (exCand) {
            assert(exCand.contradictingEvidence.length === 0, 'Exchange outage should have zero contradicting evidence when network is healthy.');
            assert(exCand.evaluationHints.some(h => h.id === 'LOCAL_NETWORK_DNS_HEALTHY' && h.description === 'Local network and DNS are operational'), 'Exchange outage should note local network health as a positive hint.');
        }

        // Docker, Network, and Lifecycle rule should output empty (or not be merged as active candidates)
        assert(!candidates.some(c => c.id === 'DOCKER_CONTAINER_EXITED'), 'Should not generate Docker candidate when Docker events are absent.');
        assert(!candidates.some(c => c.id === 'NETWORK_OUTAGE'), 'Should not generate Network candidate when Network and DNS events are absent.');
        assert(!candidates.some(c => c.id === 'LIFECYCLE_MUTATION'), 'Should not generate Lifecycle candidate when Lifecycle events are absent.');


        // 2. Build mock Timeline for Scenario D (Exchange Outage with concurrent Network Outage)
        const mockTimelineB: any = {
            events: [
                { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
            ],
            eventsBySource: {
                'EXCHANGE_REACHABILITY': [{ id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }],
                'NETWORK': [{ id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 }],
                'DNS': [{ id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                    { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                    { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
                ]
            ],
            incidentLifecycles: {
                'ev-ex-lifecycle': { incidentId: 'ev-ex', isResolved: false },
                'ev-net-lifecycle': { incidentId: 'ev-net', isResolved: false },
                'ev-dns-lifecycle': { incidentId: 'ev-dns', isResolved: false }
            },
            firstIncident: { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }
        };

        candidates = generator.generateCandidates(mockTimelineB);

        // Assertions for mockTimelineB:
        // - NETWORK_OUTAGE should exist
        const netCand = candidates.find(c => c.id === 'NETWORK_OUTAGE');
        assert(netCand !== undefined, 'Network outage candidate should be generated.');
        if (netCand) {
            assert(netCand.supportingEvidence.includes('ev-net') && netCand.supportingEvidence.includes('ev-dns'), 'Network outage should list NETWORK and DNS as supporting evidence.');
            assert(netCand.evaluationHints.some(h => h.id === 'NET_DNS_OUTAGE' && h.description === 'Concurrent Network and DNS outage' && h.evidenceIds.includes('ev-net')), 'Network outage should include concurrency hint.');
        }

        // - EXCHANGE_OUTAGE should exist, but local network events must be in contradictingEvidence
        const exCandB = candidates.find(c => c.id === 'EXCHANGE_OUTAGE');
        assert(exCandB !== undefined, 'Exchange outage candidate should still be generated.');
        if (exCandB) {
            assert(exCandB.contradictingEvidence.includes('ev-net') && exCandB.contradictingEvidence.includes('ev-dns'), 'Exchange outage contradictingEvidence should contain local Network/DNS event IDs.');
            assert(exCandB.evaluationHints.some(h => h.id === 'LOCAL_NETWORK_DOWN_CONCURRENCY' && h.description === 'Local network down concurrently' && h.evidenceIds.includes('ev-net')), 'Exchange outage should include negative hint reflecting local outage.');
            assert(exCandB.matchedSignals.includes('NETWORK:DETECTED') && exCandB.matchedSignals.includes('DNS:DETECTED'), 'Exchange outage matchedSignals should contain local Network and DNS indicators.');
        }


        // 3. Build mock Timeline for Scenario F (Docker Cascade Sequence: DOCKER -> FREQTRADE_API -> HEARTBEAT)
        const mockTimelineC: any = {
            events: [
                { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
            ],
            eventsBySource: {
                'DOCKER': [{ id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }],
                'FREQTRADE_API': [{ id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }],
                'HEARTBEAT': [{ id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            ],
            incidentLifecycles: {
                'ev-doc-lifecycle': { incidentId: 'ev-doc', isResolved: false },
                'ev-api-lifecycle': { incidentId: 'ev-api', isResolved: false },
                'ev-hb-lifecycle': { incidentId: 'ev-hb', isResolved: false }
            },
            firstIncident: { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        candidates = generator.generateCandidates(mockTimelineC);

        const docCand = candidates.find(c => c.id === 'DOCKER_CONTAINER_EXITED');
        assert(docCand !== undefined, 'Docker container exited hypothesis should be generated.');
        if (docCand) {
            assert(docCand.supportingEvidence.includes('ev-doc') && docCand.supportingEvidence.includes('ev-api') && docCand.supportingEvidence.includes('ev-hb'), 'Docker candidate should link full Docker -> API -> Heartbeat evidence.');
            assert(docCand.matchedSignals.includes('DOCKER:DETECTED') && docCand.matchedSignals.includes('FREQTRADE_API:DETECTED') && docCand.matchedSignals.includes('HEARTBEAT:DETECTED'), 'Docker candidate matchedSignals should list Docker, API, and Heartbeat tags.');
            assert(docCand.matchedConditions.includes('Docker to Freqtrade API cascade sequence matched'), 'Docker candidate should note API cascade match.');
            assert(docCand.matchedConditions.includes('Heartbeat silence cascaded after Freqtrade API timeout'), 'Docker candidate should note full Heartbeat cascade match.');
            assert(docCand.missingEvidence.length === 0, 'Docker candidate missingEvidence should be empty when full cascade occurs.');
        }

        console.log('✅ [PASS] Candidate hypothesis generation, cascade sequences, missing evidence tracking, and local network contradiction checks verified.');
    } catch (e: any) {
        console.error('❌ Candidate hypothesis generation test crashed:', e.message || e);
    }
    // ----------------------------------------------------
    // TEST 12: Root Cause Candidate Scoring (RCA Phase 3.4)
    // ----------------------------------------------------
    try {
        console.log('--- Checking Playbook 12: Root Cause Candidate Scoring ---');

        const scoreConfig = MVP_CONFIG.RCA.SCORING;
        const scoreRules = [
            new SupportingEvidenceRule(scoreConfig),
            new ContradictionRule(scoreConfig),
            new MissingEvidenceRule(scoreConfig),
            new ConcurrencyRule(scoreConfig),
            new CascadeSequenceRule(scoreConfig),
            new FirstOccurrenceRule(scoreConfig),
            new LifecycleDurationRule(scoreConfig),
            new EvaluationHintRule(scoreConfig)
        ];
        const scoringEngine = new RootCauseScoringEngine(scoreRules, scoreConfig);

        // Scenario A: Full Docker Cascade (Scenario C from Candidate Generator)
        const mockTimelineDockerCascade: any = {
            events: [
                { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
            ],
            eventsBySource: {
                'DOCKER': [{ id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }],
                'FREQTRADE_API': [{ id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }],
                'HEARTBEAT': [{ id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            ],
            incidentLifecycles: {
                'ev-doc-lifecycle': { incidentId: 'ev-doc', isResolved: false },
                'ev-api-lifecycle': { incidentId: 'ev-api', isResolved: false },
                'ev-hb-lifecycle': { incidentId: 'ev-hb', isResolved: false }
            },
            firstIncident: { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        const config = {
            dockerCascadeWindowMs: MVP_CONFIG.RCA.DOCKER_CASCADE_WINDOW_MS,
            telemetryWindowMs: MVP_CONFIG.RCA.TELEMETRY_WINDOW_MS,
            vmExhaustionWindowMs: MVP_CONFIG.RCA.VM_EXHAUSTION_WINDOW_MS,
            networkOutageWindowMs: MVP_CONFIG.RCA.NETWORK_OUTAGE_WINDOW_MS
        };

        const rules = [
            new DockerRule(config),
            new TelemetryRule(config),
            new VMRule(config),
            new NetworkRule(config),
            new ExchangeRule(config),
            new LifecycleRule(config)
        ];

        const generator = new CandidateGenerator(rules);
        const dockerCandidates = generator.generateCandidates(mockTimelineDockerCascade);

        const scoredDocker = scoringEngine.scoreCandidates(dockerCandidates, mockTimelineDockerCascade);

        // Case 1: Full Docker Cascade
        const scoredDockerCand = scoredDocker.find(s => s.candidate.id === 'DOCKER_CONTAINER_EXITED');
        assert(scoredDockerCand !== undefined, 'Docker candidate should be scored.');
        if (scoredDockerCand) {
            assert(scoredDockerCand.normalizedScore === 100, 'Full Docker cascade should hit normalizedScore = 100.');
            assert(scoredDockerCand.confidence === 1.0, 'Full Docker cascade confidence should be 1.0.');
            assert(scoredDockerCand.contributions.some(c => c.ruleId === 'SCR_CASCADE_SEQUENCE' && c.polarity === 'POSITIVE'), 'Should have a positive cascade sequence contribution.');
            assert(scoredDockerCand.contributions.some(c => c.ruleId === 'SCR_FIRST_OCCURRENCE' && c.polarity === 'POSITIVE'), 'Should have a positive first occurrence contribution.');
            assert(scoredDockerCand.metadata.candidateId === 'DOCKER_CONTAINER_EXITED', 'ScoreMetadata should contain the correct candidateId.');
            assert(scoredDockerCand.metadata.executionTimeMs >= 0, 'ScoreMetadata should contain a valid non-negative executionTimeMs.');
        }

        // Case 2: Broken/Out-of-order Docker Cascade (Heartbeat happens FIRST, then Docker)
        const mockTimelineBrokenDocker: any = {
            events: [
                { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
            ],
            eventsBySource: {
                'HEARTBEAT': [{ id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }],
                'DOCKER': [{ id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }],
                'FREQTRADE_API': [{ id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-api', source: 'FREQTRADE_API', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000020000 }
                ]
            ],
            incidentLifecycles: {
                'ev-hb-lifecycle': { incidentId: 'ev-hb', isResolved: false },
                'ev-doc-lifecycle': { incidentId: 'ev-doc', isResolved: false },
                'ev-api-lifecycle': { incidentId: 'ev-api', isResolved: false }
            },
            firstIncident: { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        const brokenCandidates = generator.generateCandidates(mockTimelineBrokenDocker);
        const scoredBroken = scoringEngine.scoreCandidates(brokenCandidates, mockTimelineBrokenDocker);
        const scoredBrokenDocker = scoredBroken.find(s => s.candidate.id === 'DOCKER_CONTAINER_EXITED');
        assert(scoredBrokenDocker !== undefined, 'Broken Docker candidate should be scored.');
        if (scoredBrokenDocker) {
            assert(scoredBrokenDocker.rawScore < (scoredDockerCand?.rawScore || 100), 'Broken Docker cascade should score lower than full Docker cascade.');
            assert(scoredBrokenDocker.contributions.some(c => c.ruleId === 'SCR_CASCADE_SEQUENCE' && c.polarity === 'NEGATIVE'), 'Broken Docker cascade should receive negative sequence contribution.');
            assert(scoredBrokenDocker.contributions.some(c => c.ruleId === 'SCR_FIRST_OCCURRENCE' && c.polarity === 'NEGATIVE'), 'Broken Docker cascade should receive negative first occurrence contribution.');
        }

        // Scenario B: Exchange Reachability with Local Network Contradiction (Scenario D from Candidate Generator)
        const mockTimelineExchangeContradiction: any = {
            events: [
                { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
            ],
            eventsBySource: {
                'EXCHANGE_REACHABILITY': [{ id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }],
                'NETWORK': [{ id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 }],
                'DNS': [{ id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                    { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 },
                    { id: 'ev-net', source: 'NETWORK', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010100 },
                    { id: 'ev-dns', source: 'DNS', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010150 }
                ]
            ],
            incidentLifecycles: {
                'ev-ex-lifecycle': { incidentId: 'ev-ex', isResolved: false },
                'ev-net-lifecycle': { incidentId: 'ev-net', isResolved: false },
                'ev-dns-lifecycle': { incidentId: 'ev-dns', isResolved: false }
            },
            firstIncident: { id: 'ev-ex', source: 'EXCHANGE_REACHABILITY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }
        };

        const exCandidates = generator.generateCandidates(mockTimelineExchangeContradiction);
        const scoredEx = scoringEngine.scoreCandidates(exCandidates, mockTimelineExchangeContradiction);

        // Case 3: Exchange reachability with network contradiction
        const scoredExCand = scoredEx.find(s => s.candidate.id === 'EXCHANGE_OUTAGE');
        assert(scoredExCand !== undefined, 'Exchange outage candidate should be scored.');
        if (scoredExCand) {
            assert(scoredExCand.contributions.some(c => c.ruleId === 'SCR_CONTRADICTION' && c.polarity === 'NEGATIVE'), 'Exchange outage should have network contradictions.');
            assert(scoredExCand.contributions.some(c => c.ruleId === 'SCR_EVALUATION_HINT' && c.polarity === 'NEGATIVE' && c.reason.includes('Local network down concurrently')), 'Exchange outage should receive negative hint contribution.');
        }

        // Scenario C: VM Resource Exhaustion (Scenario A from Candidate Generator)
        const mockTimelineVM: any = {
            events: [
                { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }
            ],
            eventsBySource: {
                'CPU': [{ id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }],
                'MEMORY': [{ id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }]
            },
            eventsByCategory: {
                'INCIDENT': [
                    { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }
                ]
            },
            concurrencyClusters: [
                [
                    { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
                    { id: 'ev-mem', source: 'MEMORY', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000500 }
                ]
            ],
            incidentLifecycles: {
                'ev-cpu-lifecycle': { incidentId: 'ev-cpu', isResolved: false },
                'ev-mem-lifecycle': { incidentId: 'ev-mem', isResolved: false }
            },
            firstIncident: { id: 'ev-cpu', source: 'CPU', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        const vmCandidates = generator.generateCandidates(mockTimelineVM);
        const scoredVM = scoringEngine.scoreCandidates(vmCandidates, mockTimelineVM);

        // Case 4: VM resource exhaustion concurrency and hints
        const scoredVMCand = scoredVM.find(s => s.candidate.id === 'VM_RESOURCE_EXHAUSTION');
        assert(scoredVMCand !== undefined, 'VM candidate should be scored.');
        if (scoredVMCand) {
            assert(scoredVMCand.contributions.some(c => c.ruleId === 'SCR_CONCURRENCY' && c.polarity === 'POSITIVE'), 'VM Exhaustion should receive concurrency bonus.');
            assert(scoredVMCand.contributions.some(c => c.ruleId === 'SCR_EVALUATION_HINT' && c.polarity === 'POSITIVE' && c.reason.includes('Concurrent resource threshold breach')), 'VM Exhaustion should receive positive evaluation hint bonus.');
        }

        // Case 5: No evidence baseline scenario
        const mockEmptyTimeline: any = {
            events: [],
            eventsBySource: {},
            eventsByCategory: { 'INCIDENT': [] },
            concurrencyClusters: [],
            incidentLifecycles: {},
            firstIncident: undefined
        };

        const noEvidenceCandidate: RootCauseCandidate = {
            id: 'VM_RESOURCE_EXHAUSTION',
            title: 'VM Resource Exhaustion',
            description: 'System CPU, memory, or disk constraints reached critical limits.',
            triggerSignal: 'VM',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            evidenceIds: [],
            supportingEvidence: [],
            contradictingEvidence: [],
            missingEvidence: ['CPU', 'MEMORY', 'DISK'],
            matchedSignals: [],
            matchedRules: ['VMRule'],
            matchedConditions: [],
            evaluationHints: []
        };

        const scoredNoEvidence = scoringEngine.scoreCandidates([noEvidenceCandidate], mockEmptyTimeline);
        assert(scoredNoEvidence.length === 1, 'Should score the empty evidence candidate.');
        const emptyResult = scoredNoEvidence[0];
        assert(emptyResult.rawScore < 40, 'Empty candidate raw score should be below the base score (40) due to missing evidence penalties.');
        assert(emptyResult.normalizedScore >= 0 && emptyResult.normalizedScore < 20, 'Normalized score should be near zero.');
        assert(emptyResult.confidence < 0.2, 'Confidence should be near zero.');

        // Case 6: Tie-breaker validation (100 vs 100 normalized score but different raw scores)
        const candidateHighRaw: RootCauseCandidate = {
            id: 'CANDIDATE_HIGH',
            title: 'High Raw Candidate',
            description: 'A candidate with very high raw score',
            triggerSignal: 'CPU',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            evidenceIds: Array.from({ length: 15 }, (_, i) => `ev-${i + 1}`),
            supportingEvidence: Array.from({ length: 15 }, (_, i) => `ev-${i + 1}`),
            contradictingEvidence: [],
            missingEvidence: [],
            matchedSignals: [],
            matchedRules: [],
            matchedConditions: [],
            evaluationHints: []
        };

        const candidateLowRaw: RootCauseCandidate = {
            id: 'CANDIDATE_LOW',
            title: 'Low Raw Candidate',
            description: 'A candidate with lower raw score but still reaching max',
            triggerSignal: 'CPU',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            evidenceIds: Array.from({ length: 13 }, (_, i) => `ev-${i + 1}`),
            supportingEvidence: Array.from({ length: 13 }, (_, i) => `ev-${i + 1}`),
            contradictingEvidence: [],
            missingEvidence: [],
            matchedSignals: [],
            matchedRules: [],
            matchedConditions: [],
            evaluationHints: []
        };

        // Standard timeline containing all events
        const mockTieEvents = Array.from({ length: 15 }, (_, i) => ({
            id: `ev-${i + 1}`,
            source: `CPU_${i}`,
            event: 'DETECTED',
            category: 'INCIDENT',
            timestamp: 1710000000000 + i * 1000
        }));

        const mockTieTimeline: any = {
            events: mockTieEvents,
            eventsBySource: mockTieEvents.reduce((acc: any, ev) => {
                acc[ev.source] = [ev];
                return acc;
            }, {}),
            eventsByCategory: {
                'INCIDENT': mockTieEvents
            },
            concurrencyClusters: [mockTieEvents],
            incidentLifecycles: {
                'ev-1-lifecycle': { incidentId: 'ev-1', isResolved: false }
            },
            firstIncident: { id: 'ev-1', source: 'CPU_0', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 }
        };

        const sortedResult = scoringEngine.scoreCandidates([candidateLowRaw, candidateHighRaw], mockTieTimeline);

        assert(sortedResult[0].candidate.id === 'CANDIDATE_HIGH', 'Tie-breaker: CANDIDATE_HIGH (higher raw score) should be sorted first.');
        assert(sortedResult[0].normalizedScore === 100 && sortedResult[1].normalizedScore === 100, 'Both candidates in tie-breaker should have normalizedScore = 100.');
        assert(sortedResult[0].rawScore > sortedResult[1].rawScore, 'CANDIDATE_HIGH should have a strictly higher raw score than CANDIDATE_LOW.');

        console.log('✅ [PASS] Evidence scoring rules, centralized weighting, normalization, duration checks, empty baselines, and raw score tie-breaking verified.');
    } catch (e: any) {
        console.error('❌ Evidence scoring test crashed:', e.message || e);
    }
    console.log('');

    // ----------------------------------------------------
    // SUMMARY
    // ----------------------------------------------------
    console.log('====================================================');
    console.log(`📊 TEST SUITE SUMMARY: Passed ${passedTests}/${totalTests} Assertions`);
    console.log('====================================================');
}

runTests();
