import * as assert from 'assert';
import * as http from 'http';
import { EventBus } from '../layer-A(observation)/developer-console/EventBus';
import { CommandRunner } from '../layer-A(observation)/developer-console/CommandRunner';
import { InfrastructureController } from '../layer-A(observation)/developer-console/InfrastructureController';
import { FailureInjectionService } from '../layer-A(observation)/developer-console/FailureInjectionService';
import { FeatureFlagService } from '../layer-A(observation)/developer-console/FeatureFlagService';
import { DeveloperConsoleGateway } from '../layer-A(observation)/developer-console/DeveloperConsoleGateway';
import { DeveloperConsoleController } from '../layer-A(observation)/developer-console/DeveloperConsoleController';
import { DeveloperConsoleServer } from '../layer-A(observation)/developer-console/DeveloperConsoleServer';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario } from '../layer-A(observation)/developer-console/types';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { OperationsSimulationService } from '../layer-A(observation)/developer-console/OperationsSimulationService';

// Helper to make local HTTP requests
function httpRequest(options: http.RequestOptions, body?: any): Promise<{ statusCode: number; data: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
        });
        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

import { prisma } from '../prisma';

async function runTests() {
    console.log('🧪 Starting DeveloperConsoleServer Integration Tests...');

    // Clear environment overrides to test clean defaults
    delete process.env.DEV_CONSOLE_READ_ONLY;

    const bus = EventBus.getInstance();
    bus.clearBuffer();

    class StubRunner extends CommandRunner {
        public async run(command: SystemCommand): Promise<{ stdout: string; stderr: string }> {
            if (command === SystemCommand.GET_FREQTRADE_STATUS) {
                return { stdout: 'stopped\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }
    }

    const runner = new StubRunner();
    const infra = new InfrastructureController(runner, bus);
    const failures = new FailureInjectionService(bus);
    const flags = new FeatureFlagService(bus);
    const gateway = new DeveloperConsoleGateway(bus);
    const persistence = new EventPersistenceService();
    persistence.persistLifecycleEvent = async () => { return {} as any; };
    const operationsSim = new OperationsSimulationService(persistence);

    // Stub prisma to avoid actual DB connection in test
    (prisma.decisionAudit as any).deleteMany = async () => ({ count: 0 });
    (prisma.alertLog as any).deleteMany = async () => ({ count: 0 });

    const mockIncidentManager = {
        clearSimulationIncidents: async () => {}
    } as any;
    const mockOpsService = {
        clearDetectorState: () => {}
    } as any;
    const controller = new DeveloperConsoleController(
        failures,
        flags,
        infra,
        operationsSim,
        mockIncidentManager,
        mockOpsService
    );

    const testPort = 3999;
    const server = new DeveloperConsoleServer(controller, gateway, testPort, '127.0.0.1');

    console.log(' - Starting test server on port 3999...');
    server.start();

    try {
        // 1. Verify GET /health
        console.log('   - Testing GET /health...');
        const healthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/health',
            method: 'GET'
        });
        assert.strictEqual(healthRes.statusCode, 200);
        const healthData = JSON.parse(healthRes.data);
        assert.strictEqual(healthData.success, true);
        assert.strictEqual(healthData.data.status, 'UP');
        assert.strictEqual(healthData.data.version, '1.0.0');
        assert.strictEqual(healthData.data.readOnly, false);
        assert.ok(healthData.data.uptime >= 0);

        // 2. Verify POST /api/v1/failures/inject
        console.log('   - Testing POST /api/v1/failures/inject...');
        const injectRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/failures/inject',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            type: FailureType.DNS_FAILURE,
            scope: FailureScope.INFRASTRUCTURE,
            ttlSeconds: 60,
            correlationId: 'test_corr_123'
        });
        assert.strictEqual(injectRes.statusCode, 200);
        const injectData = JSON.parse(injectRes.data);
        assert.strictEqual(injectData.success, true);
        assert.ok(failures.isFailureActive(FailureType.DNS_FAILURE));

        // 3. Verify GET /api/v1/infra/status
        console.log('   - Testing GET /api/v1/infra/status...');
        const statusRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/infra/status',
            method: 'GET'
        });
        assert.strictEqual(statusRes.statusCode, 200);
        const statusData = JSON.parse(statusRes.data);
        assert.strictEqual(statusData.success, true);
        assert.strictEqual(statusData.data.status, 'stopped');

        // 4. Verify SSE Event Stream (/api/v1/events/stream)
        console.log('   - Testing SSE stream connection and data delivery...');
        const sseEvents: string[] = [];
        const sseReq = http.request({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/events/stream',
            method: 'GET'
        }, (res) => {
            res.on('data', chunk => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        sseEvents.push(line.replace('data: ', '').trim());
                    }
                }
            });
        });
        sseReq.end();

        // Wait for SSE connection to receive initial history
        await new Promise((r) => setTimeout(r, 200));

        // Trigger a new event
        await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/failures/clear',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            type: FailureType.DNS_FAILURE,
            correlationId: 'test_corr_456'
        });

        // Wait for event to propagate
        await new Promise((r) => setTimeout(r, 200));
        sseReq.destroy();

        assert.ok(sseEvents.length >= 2, 'Should receive initial history and subsequent clear event.');
        
        // Assert correlation ID propagation
        const clearEvent = JSON.parse(sseEvents[sseEvents.length - 1]);
        assert.strictEqual(clearEvent.correlationId, 'test_corr_456');

        // 4.5. Verify GET /api/v1/flags and PUT /api/v1/flags/:flag
        console.log('   - Testing GET /api/v1/flags...');
        const getFlagsRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/flags',
            method: 'GET'
        });
        assert.strictEqual(getFlagsRes.statusCode, 200);
        const getFlagsData = JSON.parse(getFlagsRes.data);
        assert.strictEqual(getFlagsData.success, true);
        assert.ok(getFlagsData.data.WEBSOCKET);
        assert.strictEqual(getFlagsData.data.WEBSOCKET.enabled, true); // default true
        assert.strictEqual(getFlagsData.data.WEBSOCKET.name, 'WebSocket Ingestion');

        console.log('   - Testing PUT /api/v1/flags/WEBSOCKET...');
        const putFlagRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/flags/WEBSOCKET',
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        }, {
            enabled: false,
            reason: 'Test Suite Update',
            correlationId: 'test_flag_corr'
        });
        assert.strictEqual(putFlagRes.statusCode, 200);
        const putFlagData = JSON.parse(putFlagRes.data);
        assert.strictEqual(putFlagData.success, true);
        assert.strictEqual(flags.isFeatureEnabled(FeatureFlag.WEBSOCKET), false);

        // 4.5 Verify POST /api/v1/operations/run
        console.log('   - Testing POST /api/v1/operations/run...');
        
        // Test Backward Transition (Failure Scenario)
        const runSimRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/operations/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            scenario: OperationScenario.BACKWARD_TRANSITION,
            tradeId: 'test_sim_trade_01',
            symbol: 'BTCUSDT',
            timestampOffset: 0,
            correlationId: 'test_sim_corr'
        });
        assert.strictEqual(runSimRes.statusCode, 200);
        const runSimData = JSON.parse(runSimRes.data);
        assert.strictEqual(runSimData.success, true);

        // Test Happy Path (Normal Scenario with auto-generated Trade ID)
        const runHappyRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/operations/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            scenario: OperationScenario.ENTRY_EXECUTION,
            symbol: 'BTCUSDT'
        });
        assert.strictEqual(runHappyRes.statusCode, 200);
        assert.strictEqual(JSON.parse(runHappyRes.data).success, true);

        // Test Order Cancel (Normal Scenario)
        const runCancelRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/operations/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            scenario: OperationScenario.ORDER_CANCEL,
            tradeId: 'test_sim_cancel_01'
        });
        assert.strictEqual(runCancelRes.statusCode, 200);
        assert.strictEqual(JSON.parse(runCancelRes.data).success, true);

        // Test Normal Exit (Normal Scenario)
        const runExitRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/operations/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            scenario: OperationScenario.POSITION_EXIT,
            tradeId: 'test_sim_exit_01'
        });
        assert.strictEqual(runExitRes.statusCode, 200);
        assert.strictEqual(JSON.parse(runExitRes.data).success, true);

        // 4.8. Verify POST /api/v1/dev/lab/reset
        console.log('   - Testing POST /api/v1/dev/lab/reset...');
        const resetRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dev/lab/reset',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            correlationId: 'test_reset_corr'
        });
        assert.strictEqual(resetRes.statusCode, 200);
        const resetData = JSON.parse(resetRes.data);
        assert.strictEqual(resetData.success, true);

        // 5. Verify Read-Only Mode enforcement
        console.log('   - Testing Read-Only Mode access restriction...');
        process.env.DEV_CONSOLE_READ_ONLY = 'true';
        
        // Re-inject failure in read-only mode should fail with 403
        const rejectRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/failures/inject',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            type: FailureType.HEARTBEAT_LOSS,
            scope: FailureScope.OPERATIONS,
            correlationId: 'test_corr_789'
        });
        assert.strictEqual(rejectRes.statusCode, 403);
        const rejectData = JSON.parse(rejectRes.data);
        assert.strictEqual(rejectData.success, false);
        assert.ok(rejectData.message.includes('READ-ONLY'));

        console.log('🎉 ALL SERVER INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
    } finally {
        console.log(' - Stopping test server...');
        await server.stop();
    }
}

runTests().catch(err => {
    console.error('❌ Integration Tests Failed:', err);
    process.exit(1);
});
