import { IncidentManager } from '../layer-B(Assessement)/IncidentManager';
import { OutboxPublisher } from '../layer-B(Assessement)/OutboxPublisher';
import { DefaultMachineInfoProvider } from '../shared/contracts/DefaultMachineInfoProvider';
import { prisma } from '../prisma';

async function main() {
    console.log('--- Outbox Lifecycle Verification Script ---');

    // 1. Clear out any old outbox items and incidents to start fresh
    await prisma.incidentOutbox.deleteMany({});
    await prisma.incidentTransition.deleteMany({});
    await prisma.incident.deleteMany({});
    await prisma.incidentGroup.deleteMany({});

    // 2. Instantiate dependencies
    const machineProvider = new DefaultMachineInfoProvider();
    const outboxPublisher = new OutboxPublisher(machineProvider);
    const incidentManager = new IncidentManager(undefined, outboxPublisher);

    // 3. Trigger CREATED transition
    console.log('\nStep 1: Reporting new global CRITICAL incident...');
    await incidentManager.reportIncident({
        level: 'CRITICAL',
        source: 'VERIFICATION_FEED',
        reason: 'Test verification incident'
    });

    // 4. Trigger STATE_CHANGED transition (severity update)
    console.log('\nStep 2: Escalating/changing severity to MEDIUM...');
    await incidentManager.reportIncident({
        level: 'MEDIUM',
        source: 'VERIFICATION_FEED',
        reason: 'Test verification incident updated'
    });

    // 5. Trigger RESOLVED transition
    console.log('\nStep 3: Resolving incident...');
    await incidentManager.resolveIncidentBySource('VERIFICATION_FEED', null);

    // Give the non-blocking background outbox inserts a moment to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 6. Query the outbox to verify the entries
    console.log('\nQuerying incident_outbox table...');
    const outboxRecords = await prisma.incidentOutbox.findMany({
        orderBy: { id: 'asc' }
    });

    console.log(`Found ${outboxRecords.length} records in outbox.`);

    for (const record of outboxRecords) {
        console.log(`\nRecord ID: ${record.id}`);
        console.log(`Status: ${record.status}`);
        console.log(`Attempts: ${record.attempts}`);
        console.log(`Payload:`, JSON.stringify(record.payload, null, 2));
    }

    // 7. Run validations
    if (outboxRecords.length !== 3) {
        throw new Error(`Expected exactly 3 outbox entries, found ${outboxRecords.length}`);
    }

    const events = outboxRecords.map(r => (r.payload as any).event);
    if (events[0] !== 'CREATED' || events[1] !== 'STATE_CHANGED' || events[2] !== 'RESOLVED') {
        throw new Error(`Unexpected event sequence: ${JSON.stringify(events)}`);
    }

    // Check payload fields on first record
    const firstPayload = outboxRecords[0].payload as any;
    if (firstPayload.schemaVersion !== 1) {
        throw new Error(`Expected schemaVersion 1, found ${firstPayload.schemaVersion}`);
    }
    if (!firstPayload.machine || !firstPayload.machine.machineId || !firstPayload.machine.licenseKey) {
        throw new Error('Machine payload fields missing');
    }
    if (!firstPayload.incident || !firstPayload.incident.incidentId || firstPayload.incident.source !== 'VERIFICATION_FEED') {
        throw new Error('Incident payload fields missing or mismatching');
    }

    console.log('\n✅ SUCCESS: Outbox lifecycle transition verification passed perfectly!');
}

main()
    .catch((err) => {
        console.error('❌ Verification failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
