import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { prisma } from '../shared/prisma';
import assert from 'assert';

async function runAudit() {
    console.log('🔍 Executing Database Audit for Prisma JSON Path Filtering...');

    const persistence = new EventPersistenceService();
    const testTradeId = '9999_test';
    const testOrderId = 'order_123456_test';

    // Cleanup before start
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: testTradeId
            }
        }
    });

    console.log('\n--- Audit 1: Verify JSON-path containment filtering ---');

    // 1. Inject a mock event
    console.log('Injecting mock event into Postgres...');
    await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_FILLED',
            systemRiskState: 'NORMAL',
            rejectionReason: null,
            metadata: {
                telemetrySource: 'FREQTRADE',
                lifecycleEvent: {
                    tradeId: testTradeId,
                    orderId: testOrderId,
                    eventType: 'ORDER_FILLED',
                    captureMethod: 'WEBSOCKET'
                }
            } as any
        }
    });

    // 2. Query using hasEquivalentLifecycleEvent
    console.log('Querying via hasEquivalentLifecycleEvent with matching orderId...');
    const matchFound = await persistence.hasEquivalentLifecycleEvent(testTradeId, 'ORDER_FILLED', testOrderId);
    console.log(`Result: ${matchFound}`);
    assert.strictEqual(matchFound, true, 'Prisma JSON path matching must return true.');
    console.log('✅ Audit 1 PASS: Prisma JSON-path containment works perfectly on the live database.');

    console.log('\n--- Audit 2: Verify classification boundary isolation ---');

    // 1. Query for ORDER_CANCELLED for the same orderId
    console.log('Querying for ORDER_CANCELLED on the same orderId...');
    const cancelledMatch = await persistence.hasEquivalentLifecycleEvent(testTradeId, 'ORDER_CANCELLED', testOrderId);
    console.log(`Result: ${cancelledMatch}`);
    assert.strictEqual(cancelledMatch, false, 'Classification filters must isolate different event types.');

    // 2. Query for ORDER_OPEN on the same orderId
    console.log('Querying for ORDER_OPEN on the same orderId...');
    const openMatch = await persistence.hasEquivalentLifecycleEvent(testTradeId, 'ORDER_OPEN', testOrderId);
    console.log(`Result: ${openMatch}`);
    assert.strictEqual(openMatch, false, 'Classification filters must isolate ORDER_OPEN.');
    console.log('✅ Audit 2 PASS: Classification isolation prevents blocking across event types.');

    // Cleanup
    console.log('\nCleaning up database...');
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: testTradeId
            }
        }
    });

    console.log('\n🎉 ALL DATABASE AUDITS COMPLETED SUCCESSFULLY!');
}

runAudit().catch(err => {
    console.error('❌ Database audit failed:', err);
    process.exit(1);
});
