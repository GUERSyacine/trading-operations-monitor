import 'dotenv/config';
import { DeveloperConsoleServer } from '../layer-A(observation)/developer-console/DeveloperConsoleServer';
import { DeveloperConsoleController } from '../layer-A(observation)/developer-console/DeveloperConsoleController';
import { DeveloperConsoleGateway } from '../layer-A(observation)/developer-console/DeveloperConsoleGateway';
import { EventBus } from '../layer-A(observation)/developer-console/EventBus';
import { CommandRunner } from '../layer-A(observation)/developer-console/CommandRunner';
import { InfrastructureController } from '../layer-A(observation)/developer-console/InfrastructureController';
import { FailureInjectionService } from '../layer-A(observation)/developer-console/FailureInjectionService';
import { FeatureFlagService } from '../layer-A(observation)/developer-console/FeatureFlagService';
import { OperationsSimulationService } from '../layer-A(observation)/developer-console/OperationsSimulationService';
import { EventPersistenceService } from '../adapters/base/EventPersistenceService';
import { OutboxSyncWorker } from '../layer-B(Assessement)/OutboxSyncWorker';
import { prisma } from '../prisma';

async function main() {
    console.log('=== STARTING SYNC WORKER INTEGRATION VERIFICATION ===\n');

    // 1. Start Mock Cloud Gateway on Port 3005
    const eventBus = EventBus.getInstance();
    const cmdRunner = new CommandRunner();
    const infraController = new InfrastructureController(cmdRunner, eventBus);
    const failureService = new FailureInjectionService(eventBus);
    const featureFlagService = new FeatureFlagService(eventBus);
    const devConsoleGateway = new DeveloperConsoleGateway(eventBus);
    const persistence = new EventPersistenceService();
    const operationsSimulationService = new OperationsSimulationService(persistence);

    const devConsoleController = new DeveloperConsoleController(
        failureService,
        featureFlagService,
        infraController,
        operationsSimulationService,
        undefined as any,
        undefined as any
    );
    const server = new DeveloperConsoleServer(devConsoleController, devConsoleGateway, 3005, '127.0.0.1');
    server.start();

    // Give server a moment to bind
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        // 2. Clear Database
        await prisma.incidentOutbox.deleteMany({});

        // ==========================================
        // TEST 1: Success Path
        // ==========================================
        console.log('--- TEST 1: Success Path ---');
        const rec1 = await prisma.incidentOutbox.create({
            data: {
                payload: { test: 'success-payload' },
                status: 'PENDING',
                attempts: 0,
                nextRetryAt: new Date(Date.now() - 1000) // ready to retry
            }
        });

        // Instantiate sync worker targeting port 3005
        const worker = new OutboxSyncWorker(
            'http://127.0.0.1:3005/api/v1/cloud/incidents',
            5000, // interval
            5,    // maxAttempts
            1000, // backoffBaseMs
            50,   // batchSize
            5000  // timeoutMs
        );

        await worker.syncCycle();

        const updatedRec1 = await prisma.incidentOutbox.findUnique({ where: { id: rec1.id } });
        if (!updatedRec1) throw new Error('Record 1 not found in DB');
        console.log(`Record 1 status: ${updatedRec1.status}, lastError: ${updatedRec1.lastError}`);
        if (updatedRec1.status !== 'SENT') throw new Error(`Test 1 Failed: Expected status SENT, got ${updatedRec1.status}`);
        console.log('✅ TEST 1 PASSED: Success Path Verified.\n');

        // ==========================================
        // TEST 2: Failure & Backoff Path
        // ==========================================
        console.log('--- TEST 2: Failure & Backoff Path ---');
        const rec2 = await prisma.incidentOutbox.create({
            data: {
                payload: { test: 'failure-payload' },
                status: 'PENDING',
                attempts: 0,
                nextRetryAt: new Date(Date.now() - 1000)
            }
        });

        // Target fail=true to force 500 error
        const failWorker = new OutboxSyncWorker(
            'http://127.0.0.1:3005/api/v1/cloud/incidents?fail=true',
            5000,
            5,
            1000,
            50,
            5000
        );

        await failWorker.syncCycle();

        const updatedRec2 = await prisma.incidentOutbox.findUnique({ where: { id: rec2.id } });
        if (!updatedRec2) throw new Error('Record 2 not found in DB');
        console.log(`Record 2 status: ${updatedRec2.status}, attempts: ${updatedRec2.attempts}, lastError: ${updatedRec2.lastError}`);
        if (updatedRec2.status !== 'PENDING') throw new Error(`Test 2 Failed: Expected status PENDING, got ${updatedRec2.status}`);
        if (updatedRec2.attempts !== 1) throw new Error(`Test 2 Failed: Expected attempts 1, got ${updatedRec2.attempts}`);
        if (!updatedRec2.lastError?.includes('500')) throw new Error(`Test 2 Failed: Expected 500 in error, got ${updatedRec2.lastError}`);
        console.log('✅ TEST 2 PASSED: Failure Path & Backoff Verified.\n');

        // ==========================================
        // TEST 3: Cloud Offline Path
        // ==========================================
        console.log('--- TEST 3: Cloud Offline Path ---');
        const rec3 = await prisma.incidentOutbox.create({
            data: {
                payload: { test: 'offline-payload' },
                status: 'PENDING',
                attempts: 0,
                nextRetryAt: new Date(Date.now() - 1000)
            }
        });

        // Target an invalid port to simulate network offline
        const offlineWorker = new OutboxSyncWorker(
            'http://127.0.0.1:9999/api/v1/cloud/incidents',
            5000,
            5,
            1000,
            50,
            2000 // short timeout
        );

        await offlineWorker.syncCycle();

        const updatedRec3 = await prisma.incidentOutbox.findUnique({ where: { id: rec3.id } });
        if (!updatedRec3) throw new Error('Record 3 not found in DB');
        console.log(`Record 3 status: ${updatedRec3.status}, attempts: ${updatedRec3.attempts}, lastError: ${updatedRec3.lastError}`);
        if (updatedRec3.status !== 'PENDING') throw new Error(`Test 3 Failed: Expected status PENDING, got ${updatedRec3.status}`);
        if (updatedRec3.attempts !== 1) throw new Error(`Test 3 Failed: Expected attempts 1, got ${updatedRec3.attempts}`);
        console.log('✅ TEST 3 PASSED: Cloud Offline / Connection Error Verified.\n');

        // ==========================================
        // TEST 4: Payload Verification
        // ==========================================
        console.log('--- TEST 4: Payload Verification ---');
        // Clear all
        await prisma.incidentOutbox.deleteMany({});
        
        const testPayload = {
            schemaVersion: 1,
            event: 'CREATED',
            machine: { machineId: 'vps-test-1', licenseKey: 'lic-abc' },
            incident: { incidentId: 999, source: 'TEST_SOURCE' }
        };
        const rec4 = await prisma.incidentOutbox.create({
            data: {
                payload: testPayload,
                status: 'PENDING',
                attempts: 0,
                nextRetryAt: new Date(Date.now() - 1000)
            }
        });

        await worker.syncCycle();
        const updatedRec4 = await prisma.incidentOutbox.findUnique({ where: { id: rec4.id } });
        if (!updatedRec4) throw new Error('Record 4 not found in DB');
        const retrievedPayload = updatedRec4.payload as any;
        console.log('Retrieved Payload:', JSON.stringify(retrievedPayload, null, 2));
        if (retrievedPayload.event !== 'CREATED' || retrievedPayload.machine.machineId !== 'vps-test-1') {
            throw new Error('Test 4 Failed: Payload mismatch or corruption.');
        }
        console.log('✅ TEST 4 PASSED: Payload Integrity Verified.\n');

        // ==========================================
        // TEST 5: Stress Test (50 batched incidents)
        // ==========================================
        console.log('--- TEST 5: Stress Test (50 queued incidents) ---');
        await prisma.incidentOutbox.deleteMany({});

        const stressCount = 50;
        const promises = [];
        for (let i = 0; i < stressCount; i++) {
            promises.push(
                prisma.incidentOutbox.create({
                    data: {
                        payload: { index: i, desc: `Stress incident ${i}` },
                        status: 'PENDING',
                        attempts: 0,
                        nextRetryAt: new Date(Date.now() - 1000)
                    }
                })
            );
        }
        await Promise.all(promises);

        const beforeCount = await prisma.incidentOutbox.count({ where: { status: 'PENDING' } });
        console.log(`Queued ${beforeCount} pending incidents.`);

        // Process them with BATCH_SIZE = 50
        await worker.syncCycle();

        const afterPendingCount = await prisma.incidentOutbox.count({ where: { status: 'PENDING' } });
        const afterSentCount = await prisma.incidentOutbox.count({ where: { status: 'SENT' } });

        console.log(`After Sync Cycle: Pending Count = ${afterPendingCount}, Sent Count = ${afterSentCount}`);
        if (afterPendingCount !== 0 || afterSentCount !== stressCount) {
            throw new Error(`Test 5 Failed: Expected 0 pending and ${stressCount} sent. Got ${afterPendingCount} and ${afterSentCount}`);
        }
        console.log('✅ TEST 5 PASSED: Stress Test and Batching Verified.\n');

        // ==========================================
        // TEST 6: Manual Retry of Failed Records
        // ==========================================
        console.log('--- TEST 6: Manual Retry of Failed Records ---');
        await prisma.incidentOutbox.deleteMany({});

        // 1. Create a permanently FAILED outbox record and another PENDING one
        const failedRec = await prisma.incidentOutbox.create({
            data: {
                payload: { test: 'failed-rec' },
                status: 'FAILED',
                attempts: 5,
                nextRetryAt: new Date(Date.now() - 1000),
                lastError: 'HTTP 500: Internal Server Error'
            }
        });
        const pendingRec = await prisma.incidentOutbox.create({
            data: {
                payload: { test: 'pending-rec' },
                status: 'PENDING',
                attempts: 2,
                nextRetryAt: new Date(Date.now() - 1000)
            }
        });

        // 2. Call the manual retry API endpoint for all failed records
        const retryRes = await fetch('http://127.0.0.1:3005/api/v1/dev/outbox/retry-failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!retryRes.ok) throw new Error(`Retry API failed: ${retryRes.status}`);
        const retryJson = await retryRes.json() as any;
        console.log('Retry API Response:', JSON.stringify(retryJson));
        if (retryJson.retried !== 1 || retryJson.status !== 'QUEUED') {
            throw new Error(`Test 6 Failed: Expected retried=1 and status=QUEUED, got ${JSON.stringify(retryJson)}`);
        }

        // 3. Verify database state
        const checkFailed = await prisma.incidentOutbox.findUnique({ where: { id: failedRec.id } });
        if (!checkFailed || checkFailed.status !== 'PENDING' || checkFailed.attempts !== 0 || checkFailed.lastError !== null) {
            throw new Error(`Test 6 Failed: Failed record not reset correctly: ${JSON.stringify(checkFailed)}`);
        }
        const checkPending = await prisma.incidentOutbox.findUnique({ where: { id: pendingRec.id } });
        if (!checkPending || checkPending.status !== 'PENDING' || checkPending.attempts !== 2) {
            throw new Error(`Test 6 Failed: Unrelated pending record was modified: ${JSON.stringify(checkPending)}`);
        }

        // 4. Test selective ID retry
        // Create two failed records
        const failed1 = await prisma.incidentOutbox.create({
            data: { payload: { test: 'f1' }, status: 'FAILED', attempts: 5 }
        });
        const failed2 = await prisma.incidentOutbox.create({
            data: { payload: { test: 'f2' }, status: 'FAILED', attempts: 5 }
        });

        // Call selective retry for failed1 only
        const selRes = await fetch('http://127.0.0.1:3005/api/v1/dev/outbox/retry-failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [failed1.id] })
        });
        if (!selRes.ok) throw new Error(`Selective Retry API failed: ${selRes.status}`);
        const selJson = await selRes.json() as any;
        if (selJson.retried !== 1) {
            throw new Error(`Test 6 Failed: Expected 1 retried, got ${selJson.retried}`);
        }

        const checkF1 = await prisma.incidentOutbox.findUnique({ where: { id: failed1.id } });
        if (!checkF1 || checkF1.status !== 'PENDING') {
            throw new Error('Test 6 Failed: failed1 did not reset to PENDING');
        }
        const checkF2 = await prisma.incidentOutbox.findUnique({ where: { id: failed2.id } });
        if (!checkF2 || checkF2.status !== 'FAILED') {
            throw new Error('Test 6 Failed: failed2 should remain FAILED');
        }

        console.log('✅ TEST 6 PASSED: Manual Outbox Retry & Selective Requeue Verified.\n');

        console.log('🎉 ALL STEP 5 INTEGRATION VERIFICATION TESTS PASSED SUCCESSFULLY!');

    } finally {
        // Shutdown Developer Console Server
        await server.stop();
    }
}

main()
    .catch((err) => {
        console.error('❌ Verification failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
