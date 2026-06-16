import { flashCrashDetector } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/FlashCrashDetector';
import { spreadAnomalyDetector } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/SpreadDetector';
import { slippageIncident } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/SlippageDetector';
import { OperationsWatchdogService } from '../layer-A(observation)/layer2(trading_operations_monitoring)/OperationsWatchdogService';
import { InfrastructureWatchdogService } from '../layer-A(observation)/layer1(infrastructure_monitoring)/InfrastructureWatchdogService';
import { HealthCheckResult } from '../layer-A(observation)/types';
import { ExecutionIntelligenceService } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/ExecutionIntelligenceService';
import { IncidentManager } from '../layer-B(Assessement)/IncidentManager';
import { ReportingService } from '../layer-C(reporting)/ReportingService';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';
import { prisma } from '../prisma';
import { FreqtradeWebhookReceiver } from '../layer-A(observation)/layer1(infrastructure_monitoring)/FreqtradeWebhookReceiver';
import { EventPersistenceService } from '../adapters/base/EventPersistenceService';

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

        const mockIncidentManager: any = {
            incidentsReported: [] as any[],
            incidentsResolved: [] as any[],
            async reportIncident(incident: any) {
                this.incidentsReported.push(incident);
            },
            async resolveIncidentBySource(source: string, symbol: string | null = null) {
                this.incidentsResolved.push({ source, symbol });
            }
        };

        const watchdog = new OperationsWatchdogService(mockAlerting, mockIncidentManager as any, 5 * 60 * 1000);

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
        assert(persistedEvents[0].metadata.symbol === 'ETHUSDT', 'Symbol is normalized to ETHUSDT.');

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
        assert(persistedEvents[0].metadata.orderId === 'order_abc', 'orderId is stored correctly.');

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
        assert(exchangeHealthy.source === 'EXCHANGE', 'Exchange check returns source EXCHANGE.');
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
        let persisted: any[] = [];
        (prisma.incident as any).create = async (args: any) => {
            persisted.push(args.data);
            return args.data;
        };
        (prisma.incident as any).updateMany = async (args: any) => {
            return { count: 1 };
        };

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
    // SUMMARY
    // ----------------------------------------------------
    console.log('====================================================');
    console.log(`📊 TEST SUITE SUMMARY: Passed ${passedTests}/${totalTests} Assertions`);
    console.log('====================================================');
}

runTests();
