import * as assert from 'assert';
import { EventBus } from '../shared/services/EventBus';
import { CommandRunner } from '../cloud/developer/CommandRunner';
import { InfrastructureController } from '../cloud/developer/InfrastructureController';
import { FailureInjectionService } from '../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../shared/services/FeatureFlagService';
import { DeveloperConsoleGateway } from '../cloud/developer/DeveloperConsoleGateway';
import { DeveloperConsoleController } from '../cloud/developer/DeveloperConsoleController';
import { DeveloperConsoleServer } from '../cloud/developer/DeveloperConsoleServer';
import { SystemCommand } from '../shared/types/developer';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { OperationsSimulationService } from '../cloud/developer/OperationsSimulationService';
import { CloudAgentClient } from '../agent/identity/CloudAgentClient';
import { QaSimulationService } from '../cloud/developer/QaSimulationService';
import { prisma } from '../shared/prisma';

async function runClientUpdateTests() {
    console.log('🧪 Starting CloudAgentClient Update Protocol Integration Tests...');

    const bus = EventBus.getInstance();
    bus.clearBuffer();

    class StubRunner extends CommandRunner {
        public async run(command: SystemCommand): Promise<{ stdout: string; stderr: string }> {
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

    // Mock prisma agent record
    const mockAgent = {
        id: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
        hostname: 'vps-test',
        machineId: 'vps-machine',
        agentSecret: 'sec_testsecret123456',
        status: 'ONLINE'
    };

    if (!prisma.agent) (prisma as any).agent = {};
    (prisma.agent as any).findUnique = async (args: any) => {
        if (args.where.id === '1d422890-9370-45ed-9b2b-83fa904f7e7e') {
            return mockAgent;
        }
        return null;
    };

    const controller = new DeveloperConsoleController(
        failures,
        flags,
        infra,
        operationsSim
    );

    const testPort = 3998;
    const server = new DeveloperConsoleServer(controller, gateway, testPort, '127.0.0.1');

    console.log(' - Starting test server on port 3998...');
    server.start();

    const client = new CloudAgentClient(`http://127.0.0.1:${testPort}`);
    const qaSim = QaSimulationService.getInstance();

    try {
        // Test Case 1: Agent is on a deprecated version (e.g. 1.3.0)
        console.log('   - Testing client getUpdate() for deprecated agent version 1.3.0...');
        const resDeprecated = await client.getUpdate({
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'sec_testsecret123456',
            version: '1.3.0'
        });

        assert.strictEqual(resDeprecated.success, true);
        assert.strictEqual(resDeprecated.status, 'SUCCESS');
        assert.strictEqual(resDeprecated.updateAvailable, true);
        assert.strictEqual(resDeprecated.mandatory, false);
        assert.strictEqual(resDeprecated.warning, 'DEPRECATED_VERSION');
        assert.ok(resDeprecated.message?.includes('deprecated'));
        assert.strictEqual(resDeprecated.latestVersion, '1.6.0');
        assert.strictEqual(resDeprecated.minVersion, '1.2.0');
        assert.strictEqual(resDeprecated.downloadUrl, 'https://updates.watchdog.io/agents/latest.tar.gz');
        assert.strictEqual(resDeprecated.checksum, 'sha256:d3a1f87b8d4f4e24ef5476a26df855ad3eb9a9a3b8d4f4e24ef5476a26df855ad');
        assert.strictEqual(resDeprecated.releaseNotes, 'C7 Software Update Capability Release. Adds update protocol verification.');

        // Test Case 2: Agent is on an unsupported/rejected version (e.g. 1.1.0)
        console.log('   - Testing client getUpdate() for unsupported agent version 1.1.0 (Mandatory Upgrade)...');
        const resUnsupported = await client.getUpdate({
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'sec_testsecret123456',
            version: '1.1.0'
        });

        assert.strictEqual(resUnsupported.success, true);
        assert.strictEqual(resUnsupported.status, 'SUCCESS');
        assert.strictEqual(resUnsupported.updateAvailable, true);
        assert.strictEqual(resUnsupported.mandatory, true);
        assert.strictEqual(resUnsupported.warning, 'UNSUPPORTED_VERSION');
        assert.ok(resUnsupported.message?.includes('unsupported') || resUnsupported.message?.includes('Upgrade Required'));
        assert.strictEqual(resUnsupported.latestVersion, '1.6.0');
        assert.strictEqual(resUnsupported.minVersion, '1.2.0');

        // Test Case 3: Agent is on a fully compatible version (e.g. 1.5.0) but optional update exists (1.6.0)
        console.log('   - Testing client getUpdate() for compatible agent version 1.5.0 (Optional Upgrade)...');
        const resOptional = await client.getUpdate({
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'sec_testsecret123456',
            version: '1.5.0'
        });

        assert.strictEqual(resOptional.success, true);
        assert.strictEqual(resOptional.status, 'SUCCESS');
        assert.strictEqual(resOptional.updateAvailable, true);
        assert.strictEqual(resOptional.mandatory, false);
        assert.strictEqual(resOptional.warning, undefined);
        assert.strictEqual(resOptional.latestVersion, '1.6.0');

        // Test Case 4: Agent is already on the latest version (e.g. 1.6.0)
        console.log('   - Testing client getUpdate() for up-to-date agent version 1.6.0...');
        const resLatest = await client.getUpdate({
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'sec_testsecret123456',
            version: '1.6.0'
        });

        assert.strictEqual(resLatest.success, true);
        assert.strictEqual(resLatest.status, 'SUCCESS');
        assert.strictEqual(resLatest.updateAvailable, false);
        assert.strictEqual(resLatest.mandatory, false);
        assert.strictEqual(resLatest.warning, undefined);

        // Test Case 5: Unauthenticated update check
        console.log('   - Testing client getUpdate() with wrong credentials...');
        const resUnauth = await client.getUpdate({
            agentId: '1d422890-9370-45ed-9b2b-83fa904f7e7e',
            agentSecret: 'WRONG_SECRET',
            version: '1.5.0'
        });

        assert.strictEqual(resUnauth.success, false);
        assert.strictEqual(resUnauth.status, 'UNAUTHORIZED');
        assert.strictEqual(resUnauth.updateAvailable, false);

        console.log('🎉 ALL CLOUD AGENT CLIENT UPDATE TESTS PASSED SUCCESSFULLY!\n');
    } finally {
        console.log(' - Stopping test server...');
        await server.stop();
    }
}

runClientUpdateTests().catch(err => {
    console.error('❌ Integration Tests Failed:', err);
    process.exit(1);
});
