import * as assert from 'assert';
import * as http from 'http';
import { EventBus } from '../shared/services/EventBus';
import { CommandRunner } from '../cloud/developer/CommandRunner';
import { InfrastructureController } from '../cloud/developer/InfrastructureController';
import { FailureInjectionService } from '../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../shared/services/FeatureFlagService';
import { DeveloperConsoleGateway } from '../cloud/developer/DeveloperConsoleGateway';
import { DeveloperConsoleController } from '../cloud/developer/DeveloperConsoleController';
import { DeveloperConsoleServer } from '../cloud/developer/DeveloperConsoleServer';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario } from '../shared/types/developer';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { OperationsSimulationService } from '../cloud/developer/OperationsSimulationService';

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

import { prisma } from '../shared/prisma';

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

    const mockAgent = {
        id: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
        hostname: 'vps-test',
        machineId: 'vps-machine',
        agentSecret: 'sec_testsecret123456',
        status: 'ONLINE'
    };

    if (!prisma.agent) (prisma as any).agent = {};
    if (!prisma.agentHeartbeat) (prisma as any).agentHeartbeat = {};

    (prisma.agent as any).findUnique = async (args: any) => {
        if (args.where.id === '1d422890-9370-45ed-9b2b-83fa904f7e7e') {
            return mockAgent;
        }
        return null;
    };
    (prisma.agent as any).update = async (args: any) => {
        return {
            ...mockAgent,
            status: args.data.status,
            lastHeartbeatAt: args.data.lastHeartbeatAt,
            hostname: args.data.hostname,
            version: args.data.version
        };
    };
    (prisma.agentHeartbeat as any).create = async () => ({ id: 'hb-id' });

    const controller = new DeveloperConsoleController(
        failures,
        flags,
        infra,
        operationsSim
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

        // 2. Verify POST /api/v1/admin/failures/inject
        console.log('   - Testing POST /api/v1/admin/failures/inject...');
        const injectRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/admin/failures/inject',
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

        // 3. Verify GET /api/v1/dashboard/infra/status
        console.log('   - Testing GET /api/v1/dashboard/infra/status...');
        const statusRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dashboard/infra/status',
            method: 'GET'
        });
        assert.strictEqual(statusRes.statusCode, 200);
        const statusData = JSON.parse(statusRes.data);
        assert.strictEqual(statusData.success, true);
        assert.strictEqual(statusData.data.status, 'stopped');

        // 4. Verify SSE Event Stream (/api/v1/dashboard/events/stream)
        console.log('   - Testing SSE stream connection and data delivery...');
        const sseEvents: string[] = [];
        const sseReq = http.request({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dashboard/events/stream',
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
            path: '/api/v1/admin/failures/clear',
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

        // 4.5. Verify GET /api/v1/dashboard/flags and PUT /api/v1/dashboard/flags/:flag
        console.log('   - Testing GET /api/v1/dashboard/flags...');
        const getFlagsRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dashboard/flags',
            method: 'GET'
        });
        assert.strictEqual(getFlagsRes.statusCode, 200);
        const getFlagsData = JSON.parse(getFlagsRes.data);
        assert.strictEqual(getFlagsData.success, true);
        assert.ok(getFlagsData.data.WEBSOCKET);
        assert.strictEqual(getFlagsData.data.WEBSOCKET.enabled, true); // default true
        assert.strictEqual(getFlagsData.data.WEBSOCKET.name, 'WebSocket Ingestion');

        console.log('   - Testing PUT /api/v1/dashboard/flags/WEBSOCKET...');
        const putFlagRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dashboard/flags/WEBSOCKET',
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

        // 4.5 Verify POST /api/v1/admin/operations/run
        console.log('   - Testing POST /api/v1/admin/operations/run...');
        
        // Test Backward Transition (Failure Scenario)
        const runSimRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/admin/operations/run',
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
            path: '/api/v1/admin/operations/run',
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
            path: '/api/v1/admin/operations/run',
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
            path: '/api/v1/admin/operations/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            scenario: OperationScenario.POSITION_EXIT,
            tradeId: 'test_sim_exit_01'
        });
        assert.strictEqual(runExitRes.statusCode, 200);
        assert.strictEqual(JSON.parse(runExitRes.data).success, true);

        // 4.8. Verify POST /api/v1/admin/operations/reset
        console.log('   - Testing POST /api/v1/admin/operations/reset...');
        const resetRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/admin/operations/reset',
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
            path: '/api/v1/admin/failures/inject',
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
        assert.strictEqual(rejectData.error.code, 'FORBIDDEN');
        assert.ok(rejectData.error.message.includes('READ-ONLY'));

        // 6. Verify Agent Authentication Contract (Heartbeat, Incidents, Alerts)
        console.log('   - Testing Agent Authentication Contract (Missing Headers -> 401)...');
        const missHeaderRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/incidents',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        }, { some: 'payload' });
        assert.strictEqual(missHeaderRes.statusCode, 401);
        const missHeaderData = JSON.parse(missHeaderRes.data);
        assert.strictEqual(missHeaderData.success, false);
        assert.strictEqual(missHeaderData.status, 'UNAUTHORIZED');
        assert.strictEqual(missHeaderData.error.code, 'UNAUTHORIZED');
        assert.ok(missHeaderData.error.message.includes('Authentication headers'));

        console.log('   - Testing Agent Authentication Contract (Wrong Secret -> 401)...');
        const wrongSecretRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/incidents',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': '1d422890-9370-45ed-9b2b-83fa904f7e7e',
                'X-Agent-Secret': 'WRONG_SECRET',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        }, { some: 'payload' });
        assert.strictEqual(wrongSecretRes.statusCode, 401);
        const wrongSecretData = JSON.parse(wrongSecretRes.data);
        assert.strictEqual(wrongSecretData.success, false);
        assert.strictEqual(wrongSecretData.status, 'UNAUTHORIZED');
        assert.strictEqual(wrongSecretData.error.code, 'UNAUTHORIZED');
        assert.ok(wrongSecretData.error.message.includes('Authentication secret mismatch'));

        console.log('   - Testing Agent Authentication Contract (Unknown Agent ID -> 403 INVALID_TOKEN)...');
        const unknownAgentRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/incidents',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': '00000000-0000-0000-0000-000000000000',
                'X-Agent-Secret': 'sec_testsecret123456',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        }, { some: 'payload' });
        assert.strictEqual(unknownAgentRes.statusCode, 403);
        const unknownAgentData = JSON.parse(unknownAgentRes.data);
        assert.strictEqual(unknownAgentData.success, false);
        assert.strictEqual(unknownAgentData.status, 'INVALID_TOKEN');
        assert.strictEqual(unknownAgentData.error.code, 'INVALID_TOKEN');
        assert.ok(unknownAgentData.error.message.includes('Agent not found'));

        console.log('   - Testing Agent Authentication Contract (Success Path -> 201)...');
        const successAuthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/incidents',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': '1d422890-9370-45ed-9b2b-83fa904f7e7e',
                'X-Agent-Secret': 'sec_testsecret123456',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        }, {
            machine: {
                hostname: 'vps-test',
                machineId: 'vps-machine'
            },
            incident: {
                incidentId: 42,
                level: 'WARNING'
            },
            event: 'DETECTED'
        });
        assert.strictEqual(successAuthRes.statusCode, 201);
        const successAuthData = JSON.parse(successAuthRes.data);
        assert.strictEqual(successAuthData.received, true);

        console.log('   - Testing Agent Heartbeat (Success Path -> 200)...');
        const hbAuthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/heartbeat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': '1d422890-9370-45ed-9b2b-83fa904f7e7e',
                'X-Agent-Secret': 'sec_testsecret123456',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        }, {
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'sec_testsecret123456',
            hostname: 'vps-test',
            version: '1.5.0',
            status: 'ONLINE',
            uptime: 100,
            metrics: { cpuPct: 10, memoryPct: 20, diskPct: 30 },
            health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
        });
        assert.strictEqual(hbAuthRes.statusCode, 200);
        const hbAuthData = JSON.parse(hbAuthRes.data);
        assert.strictEqual(hbAuthData.success, true);

        // 7. Verify Standardized Error Response Codes (404 and 422)
        console.log('   - Testing GET /invalid-endpoint (404 Fallback)...');
        const notFoundRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/invalid-route-that-does-not-exist',
            method: 'GET'
        });
        assert.strictEqual(notFoundRes.statusCode, 404);
        const notFoundData = JSON.parse(notFoundRes.data);
        assert.strictEqual(notFoundData.success, false);
        assert.strictEqual(notFoundData.error.code, 'NOT_FOUND');
        assert.strictEqual(notFoundData.error.message, 'Not Found');

        console.log('   - Testing PUT /api/v1/dashboard/flags/WEBSOCKET (Missing enabled -> 422)...');
        // Clear read-only override so the PUT request is processed
        delete process.env.DEV_CONSOLE_READ_ONLY;
        const invalidPutRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/dashboard/flags/WEBSOCKET',
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        }, {
            reason: 'Test Suite Invalid enabled'
        });
        assert.strictEqual(invalidPutRes.statusCode, 422);
        const invalidPutData = JSON.parse(invalidPutRes.data);
        assert.strictEqual(invalidPutData.success, false);
        assert.strictEqual(invalidPutData.error.code, 'UNPROCESSABLE_ENTITY');
        assert.ok(invalidPutData.error.message.includes('enabled'));

        // 8. Verify Reserved Agent Config & Update Routes
        console.log('   - Testing GET /api/v1/agent/config (Unauthenticated -> 401)...');
        const configUnauthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/config',
            method: 'GET',
            headers: {
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        });
        assert.strictEqual(configUnauthRes.statusCode, 401);
        const configUnauthData = JSON.parse(configUnauthRes.data);
        assert.strictEqual(configUnauthData.success, false);
        assert.strictEqual(configUnauthData.error.code, 'UNAUTHORIZED');

        console.log('   - Testing GET /api/v1/agent/config (Authenticated -> 200)...');
        const configAuthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/config',
            method: 'GET',
            headers: {
                'X-Agent-Id': '1d422890-9370-45ed-9b2b-83fa904f7e7e',
                'X-Agent-Secret': 'sec_testsecret123456',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        });
        assert.strictEqual(configAuthRes.statusCode, 200);
        const configAuthData = JSON.parse(configAuthRes.data);
        assert.strictEqual(configAuthData.success, true);
        assert.deepStrictEqual(configAuthData.configuration, {});

        console.log('   - Testing GET /api/v1/agent/update (Unauthenticated -> 401)...');
        const updateUnauthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/update',
            method: 'GET',
            headers: {
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        });
        assert.strictEqual(updateUnauthRes.statusCode, 401);
        const updateUnauthData = JSON.parse(updateUnauthRes.data);
        assert.strictEqual(updateUnauthData.success, false);
        assert.strictEqual(updateUnauthData.error.code, 'UNAUTHORIZED');

        console.log('   - Testing GET /api/v1/agent/update (Authenticated -> 200)...');
        const updateAuthRes = await httpRequest({
            host: '127.0.0.1',
            port: testPort,
            path: '/api/v1/agent/update',
            method: 'GET',
            headers: {
                'X-Agent-Id': '1d422890-9370-45ed-9b2b-83fa904f7e7e',
                'X-Agent-Secret': 'sec_testsecret123456',
                'X-Agent-Version': '1.5.0',
                'X-Agent-Capabilities': 'TELEMETRY'
            }
        });
        assert.strictEqual(updateAuthRes.statusCode, 200);
        const updateAuthData = JSON.parse(updateAuthRes.data);
        assert.strictEqual(updateAuthData.success, true);
        assert.strictEqual(updateAuthData.updateAvailable, true); // 1.5.0 < 1.6.0 (latestVersion)
        assert.strictEqual(updateAuthData.latestVersion, '1.6.0');
        assert.strictEqual(updateAuthData.minVersion, '1.2.0');
        assert.strictEqual(updateAuthData.mandatory, false); // 1.5.0 >= 1.2.0 (minVersion)
        assert.strictEqual(updateAuthData.downloadUrl, 'https://updates.watchdog.io/agents/latest.tar.gz');
        assert.strictEqual(updateAuthData.checksum, 'sha256:d3a1f87b8d4f4e24ef5476a26df855ad3eb9a9a3b8d4f4e24ef5476a26df855ad');
        assert.strictEqual(updateAuthData.releaseNotes, 'C7 Software Update Capability Release. Adds update protocol verification.');

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
