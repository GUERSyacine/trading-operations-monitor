import { flashCrashDetector } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/FlashCrashDetector';
import { spreadAnomalyDetector } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/SpreadDetector';
import { slippageIncident } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/detectors/SlippageDetector';
import { OperationsWatchdogService } from '../layer-A(observation)/layer2(trading_operations_monitoring)/OperationsWatchdogService';
import { ExecutionIntelligenceService } from '../layer-A(observation)/layer3(market-monitoring)/execution-intelligence/ExecutionIntelligenceService';
import { IncidentManager } from '../layer-B(Assessement)/IncidentManager';
import { ReportingService } from '../layer-C(reporting)/ReportingService';
import { prisma } from '../prisma';

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

        const watchdog = new OperationsWatchdogService(mockAlerting, 5 * 60 * 1000);

        // Dynamically override prisma.decisionAudit query handlers
        let mockFindFirst: any = async () => null;
        let mockFindMany: any = async () => [];

        (prisma.decisionAudit as any).findFirst = async (args: any) => mockFindFirst(args);
        (prisma.decisionAudit as any).findMany = async (args: any) => mockFindMany(args);

        // 4.1 checkHeartbeat
        // Scenario A: Bot logged a heartbeat 10 seconds ago (Healthy)
        mockFindFirst = async () => ({
            createdAt: new Date(Date.now() - 10 * 1000)
        });
        mockAlerting.alertsSent = [];
        const hbAlive = await watchdog.checkHeartbeat();
        assert(hbAlive === true, 'Heartbeat check should pass when latest audit was 10 seconds ago.');
        assert(mockAlerting.alertsSent.length === 0, 'No alert should be sent when bot is alive.');

        // Scenario B: Bot logged a heartbeat 10 minutes ago (Lost)
        mockFindFirst = async () => ({
            createdAt: new Date(Date.now() - 10 * 60 * 1000)
        });
        mockAlerting.alertsSent = [];
        const hbDead = await watchdog.checkHeartbeat();
        assert(hbDead === false, 'Heartbeat check should fail when latest audit was 10 minutes ago.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].level === 'CRITICAL', 'Telegram alert should trigger on heartbeat loss.');

        // 4.2 checkTradeFrequency
        // Scenario A: Has trades (Healthy)
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const freqHealthy = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqHealthy === true, 'Trade frequency check should pass if at least 1 trade in window.');

        // Scenario B: Silence (Unhealthy)
        mockFindMany = async () => [];
        mockAlerting.alertsSent = [];
        const freqSilent = await watchdog.checkTradeFrequency('TREND_RIDER');
        assert(freqSilent === false, 'Trade frequency check should fail and alert if 0 trades in window.');
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
        assert(brokerHealthy === true, 'Broker connection check should pass when connected=true.');

        // Scenario B: Reporting Disconnected (Unhealthy)
        mockFindFirst = async () => ({
            classification: 'BROKER_PING',
            createdAt: new Date(),
            metadata: { connected: false, error: 'MT5 offline' }
        });
        mockAlerting.alertsSent = [];
        const brokerFailed = await watchdog.checkBrokerConnection();
        assert(brokerFailed === false, 'Broker connection check should fail when status is disconnected.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].level === 'CRITICAL', 'Dispatches critical alert on broker failure.');

        // Scenario C: Stale connection check (Unhealthy)
        mockFindFirst = async () => null; // No connection events at all
        mockAlerting.alertsSent = [];
        const brokerStale = await watchdog.checkBrokerConnection();
        assert(brokerStale === false, 'Broker check should fail when no ping logs are found in the timeframe.');

        // 4.4 checkMarketDataFeed
        // Scenario A: Tick received recently (Healthy)
        mockFindMany = async () => [
            { classification: 'TICK', createdAt: new Date(), metadata: { symbol: 'BTCUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedHealthy = await watchdog.checkMarketDataFeed('BTCUSDT');
        assert(feedHealthy === true, 'Market data feed should pass when recent tick matches symbol.');

        // Scenario B: Stale / No tick for symbol (Unhealthy)
        mockFindMany = async () => [
            { classification: 'TICK', createdAt: new Date(Date.now() - 5 * 60 * 1000), metadata: { symbol: 'ETHUSDT' } }
        ];
        mockAlerting.alertsSent = [];
        const feedStale = await watchdog.checkMarketDataFeed('BTCUSDT', 30 * 1000);
        assert(feedStale === false, 'Market data feed should fail if no ticks received for requested symbol in window.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Market Data Feed Stale', 'Triggers market feed stale warning alert.');

        // 4.5 checkOrderPipeline
        // Scenario A: Normal pipeline (Healthy)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date() },
            { classification: 'ORDER_CREATED', createdAt: new Date() },
            { classification: 'ORDER_SENT', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const pipelineHealthy = await watchdog.checkOrderPipeline();
        assert(pipelineHealthy === true, 'Pipeline check should pass when signals and created orders have matching sent logs.');

        // Scenario B: Blocked pipeline (Unhealthy)
        mockFindMany = async () => [
            { classification: 'SIGNAL', createdAt: new Date() },
            { classification: 'ORDER_CREATED', createdAt: new Date() }
            // Missing ORDER_SENT!
        ];
        mockAlerting.alertsSent = [];
        const pipelineBlocked = await watchdog.checkOrderPipeline();
        assert(pipelineBlocked === false, 'Pipeline check should fail if orders are created but 0 are sent.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Order Pipeline Blocked', 'Triggers order pipeline blocked critical alert.');

        // 4.6 checkExchangeAck
        // Scenario A: Responding normally (Healthy)
        mockFindMany = async () => [
            { classification: 'ORDER', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const exchangeAckHealthy = await watchdog.checkExchangeAck();
        assert(exchangeAckHealthy === true, 'Exchange ACK check should pass under normal order execution flow.');

        // Scenario B: Consecutive Timeouts (Unhealthy)
        mockFindMany = async () => [
            { classification: 'ORDER_ACK_TIMEOUT', createdAt: new Date() },
            { classification: 'ORDER_ACK_TIMEOUT', createdAt: new Date() },
            { classification: 'EXCHANGE_TIMEOUT', createdAt: new Date() }
        ];
        mockAlerting.alertsSent = [];
        const exchangeAckStale = await watchdog.checkExchangeAck(15 * 60 * 1000, 3);
        assert(exchangeAckStale === false, 'Exchange ACK check should fail if consecutive timeouts exceed the threshold.');
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
        assert(latencyHealthy === true, 'Latency check passes when average is below threshold.');

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
        assert(latencySpike === false, 'Latency check should fail when average latency spikes past threshold.');
        assert(mockAlerting.alertsSent.length === 1 && mockAlerting.alertsSent[0].title === 'Order Latency Spike', 'Triggers order latency spike warning alert.');
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
    } catch (e: any) {
        console.error('❌ Execution Intelligence Service test crashed:', e.message || e);
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
    // SUMMARY
    // ----------------------------------------------------
    console.log('====================================================');
    console.log(`📊 TEST SUITE SUMMARY: Passed ${passedTests}/${totalTests} Assertions`);
    console.log('====================================================');
}

runTests();
