import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { FreqtradeWebSocketAdapter } from '../layer-A(observation)/layer1(infrastructure_monitoring)/FreqtradeWebSocketAdapter';
import { EventPersistenceService } from '../adapters/base/EventPersistenceService';
import { prisma } from '../prisma';
import assert from 'assert';

async function runTest() {
    console.log('🧪 Starting Phase 2 Live WebSocket Persistence Verification...');

    const config = {
        baseUrl: 'http://localhost:8080/api/v1',
        wsToken: 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg',
        username: 'freqtrader',
        password: 'password123'
    };

    const persistence = new EventPersistenceService();
    const wsAdapter = new FreqtradeWebSocketAdapter(config, persistence);

    // 1. Connect WebSocket
    wsAdapter.connect();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Trigger forceenter via REST
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    console.log('📡 Triggering forceenter for BTC/USDT...');
    const forceEnterRes = await fetch(`${config.baseUrl}/forceenter`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            pair: 'BTC/USDT',
            side: 'long',
            price: 10000.0,
            ordertype: 'limit',
            stakeamount: 100.0
        })
    });

    if (!forceEnterRes.ok) {
        const errorText = await forceEnterRes.text();
        wsAdapter.disconnect();
        throw new Error(`Failed to force enter trade: ${forceEnterRes.status} - ${errorText}`);
    }

    const tradeData = (await forceEnterRes.json()) as any;
    const tradeId = String(tradeData.trade_id);
    console.log(`✅ Trade created with ID: ${tradeId}. Waiting for WebSocket event persistence...`);

    // 3. Wait to receive and persist the event
    await new Promise(resolve => setTimeout(resolve, 6000));

    // 4. Query the Database for verification
    console.log('🔍 Querying database for persisted ORDER_CREATED event...');
    const auditRecord = await prisma.decisionAudit.findFirst({
        where: {
            classification: 'ORDER_CREATED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: tradeId
            }
        }
    });

    try {
        assert(auditRecord !== null, `No audit record found for tradeId: ${tradeId}`);
        console.log('✅ Audit record found in database.');

        const metadata = auditRecord.metadata as any;
        assert(metadata !== null, 'Metadata must not be null');

        const lifecycleEvent = metadata.lifecycleEvent;
        assert(lifecycleEvent !== undefined, 'lifecycleEvent must be present in metadata');

        const rawPayload = metadata.rawPayload;
        assert(rawPayload !== undefined, 'rawPayload must be present in metadata');

        // Verify the specific Phase 2 requirements:
        assert.strictEqual(lifecycleEvent.captureMethod, 'WEBSOCKET');
        console.log('✅ Assertion passed: captureMethod === "WEBSOCKET"');

        assert.ok(lifecycleEvent.eventId, 'eventId must not be empty');
        console.log(`✅ Assertion passed: eventId is "${lifecycleEvent.eventId}"`);

        assert.ok(rawPayload, 'rawPayload must be present');
        assert.strictEqual(String(rawPayload.trade_id), tradeId);
        console.log('✅ Assertion passed: rawPayload matches the Freqtrade event payload structure');

        // Verify timestamp split:
        assert.ok(lifecycleEvent.observedAt, 'observedAt must be present');
        assert.ok(lifecycleEvent.occurredAt, 'occurredAt must be present');
        assert.ok(lifecycleEvent.observedAt >= lifecycleEvent.occurredAt, 'observedAt should be >= occurredAt');
        console.log(`✅ Assertion passed: split timestamps present. Occurred: ${lifecycleEvent.occurredAt}, Observed: ${lifecycleEvent.observedAt}`);

        // Verify normalized details:
        assert.strictEqual(lifecycleEvent.symbol, 'BTCUSDT');
        assert.strictEqual(lifecycleEvent.side, 'BUY');
        console.log('✅ Assertion passed: normalized details (symbol: BTCUSDT, side: BUY) match exactly');

    } catch (err: any) {
        console.error('❌ Verification assertions failed:', err.message);
        throw err;
    } finally {
        // 5. Cleanup
        console.log(`🧹 Cleaning up: Deleting Trade ID ${tradeId}...`);
        const deleteRes = await fetch(`${config.baseUrl}/trades/${tradeId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json'
            }
        });

        if (deleteRes.ok) {
            console.log(`✅ Trade ID ${tradeId} deleted.`);
        } else {
            console.error(`[Warning] Failed to delete trade ${tradeId}: ${deleteRes.status}`);
        }

        wsAdapter.disconnect();
    }

    console.log('🎉 Phase 2 Live WebSocket Persistence Verification PASSED SUCCESSFULLY!');
}

runTest().catch(err => {
    console.error('❌ Integration test failed:', err);
    process.exit(1);
});
