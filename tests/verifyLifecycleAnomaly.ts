import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { IncidentManager } from '../layer-B(Assessement)/IncidentManager';
import { LifecycleAnomalyDetector } from '../layer-B(Assessement)/LifecycleAnomalyDetector';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';
import { prisma } from '../prisma';
import assert from 'assert';

async function runTest() {
    console.log('🧪 Starting Phase 3 Lifecycle Anomaly Detection Verification...');

    const alertingService = new AlertingService();
    const incidentManager = new IncidentManager(alertingService);
    const anomalyDetector = new LifecycleAnomalyDetector(incidentManager);

    // Initialize incident manager state
    await incidentManager.init();

    const mockTradeId = '999';
    const mockSymbol = 'BTCUSDT';
    const sourceKey = `OP:${mockTradeId}`;
    const compositeKey = `${mockSymbol}:${sourceKey}`;

    // 1. Cleanup database mock data and pre-existing incidents to guarantee clean environment
    console.log('🧹 Cleaning database audits and incidents for Trade 999...');
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: mockTradeId
            }
        }
    });

    await prisma.incident.deleteMany({
        where: {
            source: sourceKey
        }
    });

    // Make sure in-memory state is also clean
    await incidentManager.resolveIncidentBySource(sourceKey, mockSymbol);

    // 2. Mock a stuck ORDER_CREATED event (observed 70 seconds ago)
    console.log('📝 Injecting mock ORDER_CREATED event...');
    const observedAtTime = Date.now() - 70000;
    const mockCreatedEvent = {
        schemaVersion: 1,
        eventId: `FREQTRADE:${mockTradeId}:entry:${observedAtTime}`,
        tradeId: mockTradeId,
        eventType: 'ORDER_CREATED',
        captureMethod: 'WEBSOCKET',
        eventTimestamp: observedAtTime,
        observedAt: observedAtTime,
        occurredAt: observedAtTime - 50,
        symbol: mockSymbol,
        side: 'BUY'
    };

    await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_CREATED',
            systemRiskState: 'NORMAL',
            rejectionReason: null,
            metadata: {
                telemetrySource: 'FREQTRADE',
                lifecycleEvent: mockCreatedEvent,
                rawPayload: { trade_id: Number(mockTradeId), type: 'entry', direction: 'Long' }
            } as any,
            createdAt: new Date(observedAtTime)
        }
    });

    // 3. Run anomaly checker
    console.log('🔍 Executing checkAnomalies (stuckThreshold = 60s)...');
    await anomalyDetector.checkAnomalies(60000, 3600000);

    // 4. Assert active incident exists in memory and database
    console.log('🧪 Verifying that incident was created...');
    const memorySymbols = incidentManager.getState().symbols;
    assert.ok(memorySymbols[compositeKey], 'Active incident must be registered in memory under the composite key.');
    assert.strictEqual(memorySymbols[compositeKey].level, 'HIGH');
    assert.strictEqual(memorySymbols[compositeKey].source, sourceKey);
    console.log('✅ Assertion passed: Incident registered in-memory under correct trade-specific composite key.');

    const dbIncidentsCount = await prisma.incident.count({
        where: {
            source: sourceKey,
            resolvedAt: null
        }
    });
    assert.strictEqual(dbIncidentsCount, 1, 'Exactly one unresolved incident must exist in the database.');
    console.log('✅ Assertion passed: Incident persisted to database.');

    // 5. Run anomaly check again to verify deduplication (should not insert another record)
    console.log('🔄 Executing checkAnomalies again to test duplicate suppression...');
    await anomalyDetector.checkAnomalies(60000, 3600000);

    const dbIncidentsCountPostDup = await prisma.incident.count({
        where: {
            source: sourceKey,
            resolvedAt: null
        }
    });
    assert.strictEqual(dbIncidentsCountPostDup, 1, 'Database unresolved incidents must remain exactly one (no duplicates created).');
    console.log('✅ Assertion passed: Duplicate incident creation correctly suppressed.');

    // 6. Mock matching ORDER_FILLED event
    console.log('📝 Injecting mock ORDER_FILLED event...');
    const mockFilledEvent = {
        schemaVersion: 1,
        eventId: `FREQTRADE:${mockTradeId}:entry_fill:${Date.now()}`,
        tradeId: mockTradeId,
        eventType: 'ORDER_FILLED',
        captureMethod: 'WEBSOCKET',
        eventTimestamp: Date.now(),
        observedAt: Date.now(),
        occurredAt: Date.now() - 10,
        symbol: mockSymbol,
        side: 'BUY'
    };

    await prisma.decisionAudit.create({
        data: {
            classification: 'ORDER_FILLED',
            systemRiskState: 'NORMAL',
            rejectionReason: null,
            metadata: {
                telemetrySource: 'FREQTRADE',
                lifecycleEvent: mockFilledEvent,
                rawPayload: { trade_id: Number(mockTradeId), type: 'entry_fill', direction: 'Long' }
            } as any,
            createdAt: new Date()
        }
    });

    // 7. Run anomaly checker to resolve the incident
    console.log('🔍 Executing checkAnomalies after resolving event injection...');
    await anomalyDetector.checkAnomalies(60000, 3600000);

    // 8. Assert incident was resolved in memory and database
    console.log('🧪 Verifying that incident was resolved...');
    const memorySymbolsPostResolve = incidentManager.getState().symbols;
    assert.ok(!memorySymbolsPostResolve[compositeKey], 'Active incident must be deleted from memory.');
    console.log('✅ Assertion passed: Incident removed from in-memory state.');

    const unresolvedDbIncidents = await prisma.incident.count({
        where: {
            source: sourceKey,
            resolvedAt: null
        }
    });
    assert.strictEqual(unresolvedDbIncidents, 0, 'No unresolved incidents for this trade should exist in the database.');

    const resolvedDbIncidents = await prisma.incident.count({
        where: {
            source: sourceKey,
            resolvedAt: {
                not: null
            }
        }
    });
    assert.strictEqual(resolvedDbIncidents, 1, 'Exactly one resolved incident must exist in the database.');
    console.log('✅ Assertion passed: Incident marked as resolved in the database.');

    // 9. Cleanup database mock rows
    console.log('🧹 Cleaning up mock audits and incidents...');
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: mockTradeId
            }
        }
    });

    await prisma.incident.deleteMany({
        where: {
            source: sourceKey
        }
    });

    console.log('🎉 Phase 3 Anomaly Detection Integration Test PASSED SUCCESSFULLY!');
}

runTest().catch(err => {
    console.error('❌ Integration test failed:', err);
    process.exit(1);
});
