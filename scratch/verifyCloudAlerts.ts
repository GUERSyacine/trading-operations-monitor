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
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { OutboxSyncWorker } from '../agent/incident/outbox/OutboxSyncWorker';
import { OutboxPublisher } from '../agent/incident/outbox/OutboxPublisher';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';
import { DefaultMachineInfoProvider } from '../shared/contracts/DefaultMachineInfoProvider';
import { prisma } from '../prisma';

async function main() {
    console.log('=== STARTING STEP 6 CLOUD ALERTS INTEGRATION VERIFICATION ===\n');

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

    // Instantiate OutboxPublisher and AlertingService
    const machineProvider = new DefaultMachineInfoProvider();
    const outboxPublisher = new OutboxPublisher(machineProvider);
    const alertingService = new AlertingService({ flags: featureFlagService, outboxPublisher });

    // Workers
    const onlineWorker = new OutboxSyncWorker(
        'http://127.0.0.1:3005/api/v1/cloud/incidents',
        5000, 5, 100, 50, 2000
    );
    const offlineWorker = new OutboxSyncWorker(
        'http://127.0.0.1:3005/api/v1/cloud/incidents?fail=true',
        5000, 5, 10, 50, 2000
    );

    try {
        // ==========================================================
        // SCENARIO A: Online Alert Dispatch
        // ==========================================================
        console.log('--- SCENARIO A: Online Alert Dispatch ---');
        await prisma.incidentOutbox.deleteMany({});

        await alertingService.sendAlert({
            level: 'CRITICAL',
            title: 'Scenario A: Test Online Alert',
            message: 'This warning should go straight through the outbox to mock cloud Telegram.',
            dedupKey: 'scen_a_critical'
        });

        // Verify it was enqueued as PENDING
        const recordA = await prisma.incidentOutbox.findFirst();
        if (!recordA) throw new Error('Scenario A: No outbox record created');
        console.log(`Record enqueued. ID: ${recordA.id}, Status: ${recordA.status}`);
        const payloadA = recordA.payload as any;
        if (payloadA.type !== 'ALERT') throw new Error(`Scenario A: Expected payload type ALERT, got ${payloadA.type}`);
        if (payloadA.alert.title !== 'Scenario A: Test Online Alert') throw new Error('Scenario A: Title mismatch');

        // Sync it online
        await onlineWorker.syncCycle();

        // Verify SENT
        const recordASent = await prisma.incidentOutbox.findUnique({ where: { id: recordA.id } });
        if (!recordASent || recordASent.status !== 'SENT') {
            throw new Error(`Scenario A failed: Expected status SENT, got ${recordASent?.status}`);
        }
        console.log('✅ SCENARIO A PASSED.\n');

        // ==========================================================
        // SCENARIO B: Offline Alert Recovery
        // ==========================================================
        console.log('--- SCENARIO B: Offline Alert Recovery ---');
        await prisma.incidentOutbox.deleteMany({});

        await alertingService.sendAlert({
            level: 'WARNING',
            title: 'Scenario B: Test Offline Alert',
            message: 'This warning should fail repeatedly and then be recovered manually.',
            dedupKey: 'scen_b_warning'
        });

        const recordB = await prisma.incidentOutbox.findFirst();
        if (!recordB) throw new Error('Scenario B: No outbox record created');

        // Sync with failure worker until status is FAILED (maxAttempts = 5)
        for (let i = 1; i <= 5; i++) {
            await offlineWorker.syncCycle();
            // Force nextRetryAt to past so the next loop will pick it up immediately
            await prisma.incidentOutbox.update({
                where: { id: recordB.id },
                data: { nextRetryAt: new Date(Date.now() - 1000) }
            });
            const tempRec = await prisma.incidentOutbox.findUnique({ where: { id: recordB.id } });
            console.log(`Sync attempt ${i}: Status = ${tempRec?.status}, Attempts = ${tempRec?.attempts}`);
        }

        const recordBFailed = await prisma.incidentOutbox.findUnique({ where: { id: recordB.id } });
        if (!recordBFailed || recordBFailed.status !== 'FAILED') {
            throw new Error(`Scenario B failed: Expected status FAILED, got ${recordBFailed?.status}`);
        }

        // Trigger manual requeue
        console.log('Triggering manual recovery requeue...');
        const retriedCount = await devConsoleController.retryFailedOutbox();
        console.log(`Manual recovery requeue returned count: ${retriedCount}`);
        if (retriedCount !== 1) throw new Error(`Scenario B: Expected 1 retried record, got ${retriedCount}`);

        const recordBRecovered = await prisma.incidentOutbox.findUnique({ where: { id: recordB.id } });
        if (!recordBRecovered || recordBRecovered.status !== 'PENDING' || recordBRecovered.attempts !== 0) {
            throw new Error(`Scenario B: Requeue failed. Status = ${recordBRecovered?.status}, Attempts = ${recordBRecovered?.attempts}`);
        }
        console.log('Record successfully requeued to PENDING.');

        // Sync online
        await onlineWorker.syncCycle();

        const recordBSent = await prisma.incidentOutbox.findUnique({ where: { id: recordB.id } });
        if (!recordBSent || recordBSent.status !== 'SENT') {
            throw new Error(`Scenario B failed: Expected final status SENT, got ${recordBSent?.status}`);
        }
        console.log('✅ SCENARIO B PASSED.\n');

        // ==========================================================
        // SCENARIO C: Payload Coexistence & Order Verification
        // ==========================================================
        console.log('--- SCENARIO C: Payload Coexistence & Order Verification ---');
        await prisma.incidentOutbox.deleteMany({});

        // 1. CREATED Incident
        await outboxPublisher.publishTransition('CREATED', {
            incidentId: '100',
            source: 'COEXISTENCE_TEST',
            level: 'HIGH',
            reason: 'Scenario C Incident Detected',
            detectedAt: Date.now()
        });

        // 2. ALERT
        await outboxPublisher.publishAlert({
            level: 'WARNING',
            title: 'Scenario C Warning Alert',
            message: 'First alert coexisting in the outbox'
        });

        // 3. RESOLVED Incident
        await outboxPublisher.publishTransition('RESOLVED', {
            incidentId: '100',
            source: 'COEXISTENCE_TEST',
            level: 'HIGH',
            reason: 'Scenario C Incident Resolved',
            detectedAt: Date.now()
        });

        // 4. ALERT
        await outboxPublisher.publishAlert({
            level: 'CRITICAL',
            title: 'Scenario C Critical Alert',
            message: 'Second alert coexisting in the outbox'
        });

        // Verify order in database
        const queuedItems = await prisma.incidentOutbox.findMany({ orderBy: { id: 'asc' } });
        if (queuedItems.length !== 4) throw new Error(`Scenario C: Expected 4 items, got ${queuedItems.length}`);

        console.log('FIFO Order verification:');
        queuedItems.forEach((item, idx) => {
            const p = item.payload as any;
            console.log(`Index ${idx}: ID = ${item.id}, Type = ${p.type}, Event = ${p.event || 'N/A'}`);
        });

        // Run online sync cycle
        await onlineWorker.syncCycle();

        const remainingPending = await prisma.incidentOutbox.count({ where: { status: 'PENDING' } });
        if (remainingPending !== 0) throw new Error(`Scenario C: Expected 0 pending items, got ${remainingPending}`);

        const sentItems = await prisma.incidentOutbox.findMany({ where: { status: 'SENT' }, orderBy: { id: 'asc' } });
        if (sentItems.length !== 4) throw new Error(`Scenario C: Expected 4 SENT items, got ${sentItems.length}`);
        console.log('✅ SCENARIO C PASSED.\n');

        console.log('🎉 ALL STEP 6 INTEGRATION SCENARIOS PASSED SUCCESSFULLY!');

    } finally {
        // Clean up server
        server.stop();
    }
}

main().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
