import * as assert from 'assert';
import { EventBus } from '../layer-A(observation)/developer-console/EventBus';
import {
    EventCategory,
    WatchdogEventType,
    SystemCommand,
    FailureType,
    FailureScope,
    FeatureFlag
} from '../layer-A(observation)/developer-console/types';
import { CommandRunner } from '../layer-A(observation)/developer-console/CommandRunner';
import { InfrastructureController } from '../layer-A(observation)/developer-console/InfrastructureController';
import { FailureInjectionService } from '../layer-A(observation)/developer-console/FailureInjectionService';
import { FeatureFlagService } from '../layer-A(observation)/developer-console/FeatureFlagService';
import { DeveloperConsoleGateway } from '../layer-A(observation)/developer-console/DeveloperConsoleGateway';

async function testEventBusAndRingBuffer() {
    console.log(' - Testing EventBus & RingBuffer...');
    const bus = EventBus.getInstance();
    bus.clearBuffer();

    // 1. Basic subscription
    let receivedCount = 0;
    const unsubscribe = bus.subscribe((evt) => {
        receivedCount++;
    });

    bus.emit(EventCategory.SYSTEM, WatchdogEventType.SYSTEM_STATUS_CHANGED, 'Test', { step: 1 });
    assert.strictEqual(receivedCount, 1, 'Event should be received by active subscription.');

    // 2. Unsubscribe leak check
    unsubscribe();
    bus.emit(EventCategory.SYSTEM, WatchdogEventType.SYSTEM_STATUS_CHANGED, 'Test', { step: 2 });
    assert.strictEqual(receivedCount, 1, 'No events should be received after unsubscribe.');

    // 3. RingBuffer limit check
    bus.clearBuffer();
    for (let i = 1; i <= 120; i++) {
        bus.emit(EventCategory.TELEMETRY, WatchdogEventType.TELEMETRY_RECEIVED, 'Test', { index: i });
    }

    const recent = bus.getRecentEvents();
    assert.strictEqual(recent.length, 100, 'RingBuffer should cap events at 100.');
    assert.strictEqual((recent[0].payload as any).index, 21, 'RingBuffer should discard oldest events first (index 1 to 20).');
    assert.strictEqual((recent[99].payload as any).index, 120, 'RingBuffer should contain latest events (up to index 120).');

    // 4. UUID Format Check
    const uuidRegex = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.ok(uuidRegex.test(recent[0].id), `Event ID should follow 'evt_UUID' format. Got: ${recent[0].id}`);
    console.log('   ✅ EventBus & RingBuffer OK.');
}

async function testCommandRunnerAndController() {
    console.log(' - Testing CommandRunner & InfrastructureController...');
    const runner = new CommandRunner();

    // 1. Whitelisted check
    // We expect run to fail on execution if docker isn't running or container doesn't exist,
    // but it should validate successfully or reject with shell execution error rather than whitelist error.
    try {
        await runner.run(SystemCommand.GET_FREQTRADE_STATUS);
    } catch (err: any) {
        assert.ok(!err.message.includes('not whitelisted'), 'Whitelisted command should pass validation check.');
    }

    // 2. Non-whitelisted check
    try {
        await runner.run('DIRTY_SH_INJECTION' as any);
        assert.fail('Non-whitelisted commands must throw.');
    } catch (err: any) {
        assert.ok(err.message.includes('is not whitelisted'), 'Invalid command should trigger whitelist rejection error.');
    }

    // 3. Command timeout check
    // Stub runner to execute a command that sleeps longer than timeout limit
    class MockSlowRunner extends CommandRunner {
        public async run(command: SystemCommand, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
            if (command === SystemCommand.GET_FREQTRADE_STATUS) {
                // Sleep for 2 seconds
                const sleepCmd = 'sleep 2';
                return new Promise((resolve, reject) => {
                    const child = require('child_process').exec(sleepCmd, (error: any, stdout: any, stderr: any) => {
                        if (error) reject(error);
                        else resolve({ stdout, stderr });
                    });
                    const t = setTimeout(() => {
                        child.kill();
                        reject(new Error(`Timeout of ${timeoutMs}ms exceeded.`));
                    }, timeoutMs);
                    child.on('exit', () => clearTimeout(t));
                });
            }
            return super.run(command, timeoutMs);
        }
    }

    const slowRunner = new MockSlowRunner();
    try {
        await slowRunner.run(SystemCommand.GET_FREQTRADE_STATUS, 50);
        assert.fail('Command execution exceeding timeout limit must reject.');
    } catch (err: any) {
        assert.ok(err.message.includes('Timeout'), 'Hanging process should be terminated and reject with timeout error.');
    }

    // 4. InfrastructureController Status mapping
    class StubRunner extends CommandRunner {
        public async run(command: SystemCommand): Promise<{ stdout: string; stderr: string }> {
            if (command === SystemCommand.GET_FREQTRADE_STATUS) {
                return { stdout: 'running\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }
    }
    const controller = new InfrastructureController(new StubRunner());
    const status = await controller.getFreqtradeStatus();
    assert.strictEqual(status, 'running', 'Status query should return clean stdout string.');
    console.log('   ✅ CommandRunner & Controller OK.');
}

async function testFailureAndFeatureFlagServices() {
    console.log(' - Testing FailureInjection & FeatureFlags...');
    const bus = EventBus.getInstance();
    const failures = new FailureInjectionService(bus);
    const flags = new FeatureFlagService(bus);

    // 1. Failure injection & manual check
    failures.clearAll();
    assert.ok(!failures.isFailureActive(FailureType.DNS_FAILURE), 'Failure should be inactive initially.');
    failures.injectFailure(FailureType.DNS_FAILURE, FailureScope.INFRASTRUCTURE);
    assert.ok(failures.isFailureActive(FailureType.DNS_FAILURE), 'Injected failure should be active.');

    // 2. TTL Lazy expiration
    failures.injectFailure(FailureType.NETWORK_TIMEOUT, FailureScope.INFRASTRUCTURE, 1); // 1 sec TTL
    assert.ok(failures.isFailureActive(FailureType.NETWORK_TIMEOUT), 'Failure should be active before TTL.');
    
    // Wait 1.1s for expiration
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(!failures.isFailureActive(FailureType.NETWORK_TIMEOUT), 'Failure should be inactive after TTL.');

    // 3. cleanupExpired manual trigger
    failures.injectFailure(FailureType.BROKER_DOWN, FailureScope.ALERTING, 1);
    await new Promise((r) => setTimeout(r, 1100));
    failures.cleanupExpired();
    assert.ok(!failures.isFailureActive(FailureType.BROKER_DOWN), 'Expired failure should be removed by cleanupExpired.');

    // 4. FeatureFlag defaults and set
    assert.ok(flags.isFeatureEnabled(FeatureFlag.POLLING), 'Feature flag should default to enabled (true).');
    flags.setFeatureFlag(FeatureFlag.POLLING, false);
    assert.ok(!flags.isFeatureEnabled(FeatureFlag.POLLING), 'Feature flag should toggle to disabled (false).');
    console.log('   ✅ FailureInjection & FeatureFlags OK.');
}

async function testGatewayMapping() {
    console.log(' - Testing DeveloperConsoleGateway...');
    const bus = EventBus.getInstance();
    bus.clearBuffer();
    const gateway = new DeveloperConsoleGateway(bus);

    bus.emit(EventCategory.ALERT, WatchdogEventType.ALERT_RAISED, 'AlertService', { reason: 'Test' });
    
    const initial = gateway.getInitialEvents();
    assert.strictEqual(initial.length, 1, 'Gateway should pull initial RingBuffer events.');
    const alertMsg = initial[0];
    assert.strictEqual(alertMsg.severity, 'critical', 'Mapped ALERT_RAISED event severity should be critical.');
    assert.strictEqual(alertMsg.color, '#ef4444', 'Mapped color should be red.');
    assert.strictEqual(alertMsg.icon, '🚨', 'Mapped icon should be 🚨.');

    let streamed: any = null;
    gateway.startStreaming((msg) => {
        streamed = msg;
    });

    bus.emit(EventCategory.FAILURE, WatchdogEventType.FAILURE_INJECTED, 'FailureInjectionService', { type: FailureType.DNS_FAILURE });
    assert.ok(streamed, 'Stream callback should execute on emitted events.');
    assert.strictEqual(streamed.severity, 'warning', 'Mapped FAILURE_INJECTED severity should be warning.');
    assert.strictEqual(streamed.color, '#f59e0b', 'Mapped color should be orange.');
    console.log('   ✅ DeveloperConsoleGateway OK.');
}

async function main() {
    console.log('🧪 Starting Cycle 1 Core Unit Tests...');
    await testEventBusAndRingBuffer();
    await testCommandRunnerAndController();
    await testFailureAndFeatureFlagServices();
    await testGatewayMapping();
    console.log('🎉 ALL CYCLE 1 UNIT TESTS PASSED SUCCESSFULLY!\n');
}

main().catch(err => {
    console.error('❌ Cycle 1 Unit Tests Failed:', err);
    process.exit(1);
});
