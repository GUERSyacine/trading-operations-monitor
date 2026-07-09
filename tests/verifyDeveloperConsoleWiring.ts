import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();
import * as assert from 'assert';
import { EventBus } from '../cloud/EventBus';
import {
    EventCategory,
    WatchdogEventType,
    FailureType,
    FailureScope,
    FeatureFlag
} from '../cloud/types';
import { FailureInjectionService } from '../cloud/FailureInjectionService';
import { FeatureFlagService } from '../cloud/FeatureFlagService';
import { AlertingService } from '../agent/notification/AlertingService';
import { IncidentManager } from '../agent/incident/manager/IncidentManager';
import { InfrastructureWatchdogService } from '../agent/detectors/infrastructure/InfrastructureWatchdogService';
import { OperationsWatchdogService } from '../agent/detectors/operations/OperationsWatchdogService';
import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { HealthCheckResult } from '../agent/detectors/types';
import { prisma } from '../prisma';

async function testInterceptionWraps() {
    console.log(' - Testing Interception Wraps...');
    
    // Stub Prisma database operations to prevent requiring a live connection
    (prisma.decisionAudit as any).create = async () => ({});
    (prisma.decisionAudit as any).findFirst = async () => null;
    (prisma.decisionAudit as any).findMany = async () => [];
    (prisma.incident as any).create = async () => ({});
    (prisma.incident as any).findFirst = async () => null;
    (prisma.incident as any).update = async () => ({});
    (prisma.incident as any).updateMany = async () => ({});
    (prisma.incident as any).findMany = async () => [];
    (prisma.incident as any).findUnique = async () => ({ groupId: 1 });
    (prisma.incidentGroup as any).create = async (args: any) => ({ id: 1, ...args.data });
    (prisma.incidentGroup as any).findFirst = async () => null;
    (prisma.incidentGroup as any).update = async () => ({});
    (prisma.incidentGroup as any).updateMany = async () => ({});
    (prisma.incidentTransition as any).create = async () => ({});
    (prisma.alertLog as any).create = async () => ({});
    (prisma.incidentOutbox as any).create = async () => ({});
    (prisma as any).$transaction = async (callback: any) => callback(prisma);

    const bus = EventBus.getInstance();
    const failures = new FailureInjectionService(bus);
    const flags = new FeatureFlagService(bus);
    const alerts = new AlertingService({ flags });
    const incidentManager = new IncidentManager(alerts);

    const infra = new InfrastructureWatchdogService(alerts, failures, flags);
    const ops = new OperationsWatchdogService(alerts, incidentManager, undefined, 1000, failures, flags);

    failures.clearAll();

    // 1. DNS Failure simulation check
    assert.ok(!failures.isFailureActive(FailureType.DNS_FAILURE), 'DNS failure should not be active.');
    failures.injectFailure(FailureType.DNS_FAILURE, FailureScope.INFRASTRUCTURE);
    assert.ok(failures.isFailureActive(FailureType.DNS_FAILURE), 'DNS failure should be active.');

    const dnsResult = await infra.checkDnsResolution();
    assert.strictEqual(dnsResult.healthy, false, 'Simulated DNS check should return unhealthy.');
    assert.ok(dnsResult.metadata?.simulated, 'Simulated DNS check should carry simulated metadata.');
    assert.strictEqual(dnsResult.message, 'Simulated DNS resolution failure', 'Should return correct simulated message.');

    // 2. Network Timeout simulation check
    failures.clearAll();
    failures.injectFailure(FailureType.NETWORK_TIMEOUT, FailureScope.INFRASTRUCTURE);
    
    const netResult = await infra.checkHostNetwork();
    assert.strictEqual(netResult.healthy, false, 'Simulated network check should return unhealthy.');
    assert.ok(netResult.metadata?.simulated, 'Simulated network check should carry simulated metadata.');

    const freqResult = await infra.checkFreqtradeAPI();
    assert.strictEqual(freqResult.healthy, false, 'Simulated Freqtrade API check should return unhealthy.');
    assert.ok(freqResult.metadata?.simulated, 'Simulated Freqtrade API check should carry simulated metadata.');

    const exchangeResult = await infra.checkExchangeReachability();
    assert.strictEqual(exchangeResult.healthy, false, 'Simulated exchange check should return unhealthy.');
    assert.ok(exchangeResult.metadata?.simulated, 'Simulated exchange check should carry simulated metadata.');

    // 3. Operations Heartbeat Loss simulation check
    failures.clearAll();
    failures.injectFailure(FailureType.HEARTBEAT_LOSS, FailureScope.OPERATIONS);

    const hbResult = await ops.checkHeartbeat();
    assert.strictEqual(hbResult.healthy, false, 'Simulated heartbeat check should return unhealthy.');
    assert.ok(hbResult.metadata?.simulated, 'Simulated heartbeat check should carry simulated metadata.');

    // 4. Operations Broker Down simulation check
    failures.clearAll();
    failures.injectFailure(FailureType.BROKER_DOWN, FailureScope.OPERATIONS);

    const brokerResult = await ops.checkBrokerConnection();
    assert.strictEqual(brokerResult.healthy, false, 'Simulated broker connection check should return unhealthy.');
    assert.ok(brokerResult.metadata?.simulated, 'Simulated broker connection check should carry simulated metadata.');

    failures.clearAll();
    console.log('   ✅ Interception Wraps OK.');
}

async function testFlagSuppressions() {
    console.log(' - Testing Outbound Alert Notification Suppressions...');
    const bus = EventBus.getInstance();
    const flags = new FeatureFlagService(bus);
    const alerts = new AlertingService({ flags });

    // Capture console.log to inspect suppression message
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
        logs.push(args.join(' '));
        originalLog.apply(console, args);
    };

    try {
        // Disable ALERTING
        flags.setFeatureFlag(FeatureFlag.ALERTING, false);
        await alerts.sendAlert({
            level: 'CRITICAL',
            title: 'Test Telegram Suppressed Alert',
            message: 'This is a test alert that should be suppressed.'
        });

        const suppressedLog = logs.find(log => log.includes('Telegram notification suppressed by ALERTING feature flag'));
        assert.ok(suppressedLog, 'Telegram suppression log should be printed.');

        // Enable ALERTING (will skip telegram dispatch if env credentials are missing, but won't print feature flag suppression message)
        logs.length = 0;
        flags.setFeatureFlag(FeatureFlag.ALERTING, true);
        await alerts.sendAlert({
            level: 'CRITICAL',
            title: 'Test Telegram Enabled Alert',
            message: 'This alert is enabled.'
        });
        const suppressedLogEnabled = logs.find(log => log.includes('Telegram notification suppressed by ALERTING feature flag'));
        assert.ok(!suppressedLogEnabled, 'Telegram suppression log should NOT be printed when flag is enabled.');
    } finally {
        console.log = originalLog;
    }

    console.log('   ✅ Outbound Suppressions OK.');
}

async function testWebSocketReactiveLifecycle() {
    console.log(' - Testing WebSocket Reactive Lifecycle...');
    const bus = EventBus.getInstance();
    const flags = new FeatureFlagService(bus);
    const persistence = new EventPersistenceService();

    let establishCalls = 0;
    let disconnectCalls = 0;

    const wsAdapter = new FreqtradeWebSocketAdapter(
        { baseUrl: 'http://localhost:8080', wsToken: 'test-token' },
        persistence,
        flags,
        bus
    );

    // Mock connection methods to prevent real socket creation
    (wsAdapter as any).establishConnection = () => {
        establishCalls++;
    };
    const originalDisconnect = wsAdapter.disconnect;
    wsAdapter.disconnect = function() {
        disconnectCalls++;
        originalDisconnect.apply(this);
    };

    // WEBSOCKET enabled by default
    assert.ok(flags.isFeatureEnabled(FeatureFlag.WEBSOCKET), 'WEBSOCKET flag should default to enabled.');
    
    // Connect initial
    wsAdapter.connect();
    assert.strictEqual(establishCalls, 1, 'establishConnection should be called.');

    // Toggle off WEBSOCKET feature flag
    flags.setFeatureFlag(FeatureFlag.WEBSOCKET, false);
    assert.strictEqual(disconnectCalls, 1, 'disconnect should be called reactively when flag is disabled.');

    // Toggle on WEBSOCKET feature flag
    flags.setFeatureFlag(FeatureFlag.WEBSOCKET, true);
    assert.strictEqual(establishCalls, 2, 'establishConnection should be called reactively when flag is enabled.');

    wsAdapter.disconnect();
    console.log('   ✅ WebSocket Reactive Lifecycle OK.');
}

async function testSkippedPollingEvents() {
    console.log(' - Testing Polling Suppression and System Event Broadcast...');
    const bus = EventBus.getInstance();
    const flags = new FeatureFlagService(bus);
    const persistence = new EventPersistenceService();

    const adapter = new FreqtradeAdapter(
        { baseUrl: 'http://localhost:8080', username: 'u', password: 'p', pollIntervalMs: 5000 },
        persistence,
        flags
    );

    // Disable POLLING feature flag
    flags.setFeatureFlag(FeatureFlag.POLLING, false);

    // Subscribe to EventBus to verify event broadcast
    let receivedEvent: any = null;
    const unsubscribe = bus.subscribe(evt => {
        if (evt.type === WatchdogEventType.SYSTEM_STATUS_CHANGED && evt.source === 'Adapter:FREQTRADE') {
            receivedEvent = evt;
        }
    });

    try {
        await (adapter as any).runPoll();
        assert.ok(receivedEvent, 'Event should be broadcast to EventBus when polling is skipped.');
        assert.strictEqual(receivedEvent.payload.message, 'Polling skipped: FeatureFlag.POLLING disabled', 'Should broadcast correct message.');
    } finally {
        unsubscribe();
    }

    console.log('   ✅ Polling Suppression OK.');
}

async function main() {
    console.log('🧪 Starting Cycle 3 Developer Console Wiring Verification Tests...');
    await testInterceptionWraps();
    await testFlagSuppressions();
    await testWebSocketReactiveLifecycle();
    await testSkippedPollingEvents();
    console.log('🎉 ALL CYCLE 3 WIRING VERIFICATION TESTS PASSED SUCCESSFULLY!\n');
}

main().catch(err => {
    console.error('❌ Cycle 3 Verification Tests Failed:', err);
    process.exit(1);
});
