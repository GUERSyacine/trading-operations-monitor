import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import * as assert from 'assert';
import { prisma } from '../prisma';
import { DeveloperConsoleController } from '../layer-A(observation)/developer-console/DeveloperConsoleController';
import { EventBus } from '../layer-A(observation)/developer-console/EventBus';
import { FailureInjectionService } from '../layer-A(observation)/developer-console/FailureInjectionService';
import { FeatureFlagService } from '../layer-A(observation)/developer-console/FeatureFlagService';
import { InfrastructureController } from '../layer-A(observation)/developer-console/InfrastructureController';
import { OperationsSimulationService } from '../layer-A(observation)/developer-console/OperationsSimulationService';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';

class MockRunner {
    async run() { return { stdout: '', stderr: '' }; }
}

async function runTelemetryPurgeVerification() {
    console.log('🧪 Starting Simulation Telemetry Purge Verification...');

    const bus = EventBus.getInstance();
    const failures = new FailureInjectionService(bus);
    const flags = new FeatureFlagService(bus);
    const infra = new InfrastructureController(new MockRunner() as any, bus);
    const persistence = new EventPersistenceService();
    const operationsSim = new OperationsSimulationService(persistence);

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

    // 1. Clean up any existing test records first
    await prisma.decisionAudit.deleteMany({
        where: {
            OR: [
                { metadata: { path: ['telemetrySource'], equals: 'TEST_FREQTRADE' } },
                { metadata: { path: ['telemetrySource'], equals: 'SIMULATOR' } }
            ]
        }
    });

    // 2. Insert dummy production telemetry (FREQTRADE)
    const productionAudit = await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_FILLED',
            systemRiskState: 'NORMAL',
            metadata: {
                telemetrySource: 'TEST_FREQTRADE',
                lifecycleEvent: {
                    tradeId: 'real_trade_101',
                    source: 'TEST_FREQTRADE',
                    eventType: 'ORDER_FILLED'
                }
            } as any
        }
    });

    // 3. Insert dummy simulator telemetry (SIMULATOR)
    const simulatorAudit1 = await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_FILLED',
            systemRiskState: 'NORMAL',
            metadata: {
                telemetrySource: 'SIMULATOR',
                lifecycleEvent: {
                    tradeId: 'sim_trade_555',
                    source: 'SIMULATOR',
                    eventType: 'ORDER_FILLED'
                }
            } as any
        }
    });

    const simulatorAudit2 = await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_CREATED',
            systemRiskState: 'NORMAL',
            metadata: {
                lifecycleEvent: {
                    tradeId: 'sim_trade_555',
                    source: 'SIMULATOR', // Nested simulator source
                    eventType: 'ORDER_CREATED'
                }
            } as any
        }
    });

    console.log('📊 Verified initial insertions. Querying counts...');
    
    const initialProdCount = await prisma.decisionAudit.count({
        where: { metadata: { path: ['telemetrySource'], equals: 'TEST_FREQTRADE' } }
    });
    const initialSimCount = await prisma.decisionAudit.count({
        where: {
            OR: [
                { metadata: { path: ['telemetrySource'], equals: 'SIMULATOR' } },
                { metadata: { path: ['lifecycleEvent', 'source'], equals: 'SIMULATOR' } }
            ]
        }
    });

    assert.strictEqual(initialProdCount, 1, 'Should have exactly 1 production test record.');
    assert.strictEqual(initialSimCount, 2, 'Should have exactly 2 simulator test records.');
    console.log('   ✅ Initial counts verified (Production: 1, Simulator: 2)');

    // 4. Run the reset Simulation Lab logic
    console.log('🧹 Triggering resetSimulationLab via Controller...');
    await controller.resetSimulationLab('test_reset_purge_corr');

    // 5. Verify database counts after reset
    const finalProdCount = await prisma.decisionAudit.count({
        where: { metadata: { path: ['telemetrySource'], equals: 'TEST_FREQTRADE' } }
    });
    const finalSimCount = await prisma.decisionAudit.count({
        where: {
            OR: [
                { metadata: { path: ['telemetrySource'], equals: 'SIMULATOR' } },
                { metadata: { path: ['lifecycleEvent', 'source'], equals: 'SIMULATOR' } }
            ]
        }
    });

    assert.strictEqual(finalSimCount, 0, 'Simulator audits should be completely deleted (0 count).');
    assert.strictEqual(finalProdCount, 1, 'Production audits should NOT be deleted (1 count).');
    console.log('   ✅ Final counts verified (Production: 1, Simulator: 0)');

    // 6. Clean up the production test record
    await prisma.decisionAudit.delete({
        where: { id: productionAudit.id }
    });
    console.log('🧹 Cleaned up temporary test records.');

    console.log('🎉 TELEMETRY PURGE VERIFICATION PASSED SUCCESSFULLY!\n');
}

runTelemetryPurgeVerification()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Telemetry Purge Verification Failed:', err);
        process.exit(1);
    });
