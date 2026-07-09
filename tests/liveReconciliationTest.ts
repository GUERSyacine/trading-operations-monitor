import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { prisma } from '../shared/prisma';
import assert from 'assert';

async function runLiveTest() {
    console.log('🧪 Starting Live Reconciliation Verification (Market Trade)...');

    const config = {
        baseUrl: 'http://localhost:8080/api/v1',
        wsToken: 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg',
        username: 'freqtrader',
        password: 'password123',
        pollIntervalMs: 15000
    };

    const persistence = new EventPersistenceService();
    const wsAdapter = new FreqtradeWebSocketAdapter(config, persistence);
    const pollerAdapter = new FreqtradeAdapter(config, persistence);

    // 1. Connect WebSocket
    wsAdapter.connect();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Query Freqtrade to find next trade ID and pre-clean database
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    console.log('🔍 Querying Freqtrade to find next trade ID...');
    const tradesRes = await fetch(`${config.baseUrl}/trades`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    let nextTradeId = 1;
    if (tradesRes.ok) {
        const tradesData = (await tradesRes.json()) as any;
        const existingTrades = tradesData.trades || [];
        nextTradeId = Math.max(...existingTrades.map((t: any) => t.trade_id), 0) + 1;
    }

    const cleanupDb = async (tid: string) => {
        await prisma.decisionAudit.deleteMany({
            where: {
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: tid
                }
            }
        });
    };

    // Clean for the next 5 trade IDs to ensure we capture whichever ID Freqtrade assigns, without race conditions!
    console.log(`🧹 Pre-cleaning database audits for trade IDs around ${nextTradeId}...`);
    for (let offset = -2; offset <= 5; offset++) {
        await cleanupDb(String(nextTradeId + offset));
    }

    // 3. Trigger market order forceenter via REST (so it fills immediately)
    console.log('📡 Triggering forceenter for ADA/USDT (Market Order)...');
    const forceEnterRes = await fetch(`${config.baseUrl}/forceenter`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            pair: 'ADA/USDT',
            side: 'long',
            ordertype: 'market',
            stakeamount: 10.0
        })
    });

    if (!forceEnterRes.ok) {
        const errorText = await forceEnterRes.text();
        wsAdapter.disconnect();
        throw new Error(`Failed to force enter trade: ${forceEnterRes.status} - ${errorText}`);
    }

    const tradeResponseData = (await forceEnterRes.json()) as any;
    const activeTradeId = String(tradeResponseData.trade_id);
    console.log(`✅ Trade created successfully with ID: ${activeTradeId}.`);

    console.log('Waiting for WebSocket to receive and persist events...');
    // Wait for websocket processing (entry and entry_fill)
    await new Promise(resolve => setTimeout(resolve, 6000));

    // 4. Assert that WebSocket has written the ORDER_FILLED event
    console.log('🔍 Querying database for WebSocket events...');
    const wsFilledRecords = await prisma.decisionAudit.findMany({
        where: {
            classification: 'ORDER_FILLED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: activeTradeId
            }
        }
    });

    console.log(`WebSocket ORDER_FILLED records found: ${wsFilledRecords.length}`);
    assert.ok(wsFilledRecords.length >= 1, 'WebSocket should have persisted at least one ORDER_FILLED event.');
    assert.strictEqual((wsFilledRecords[0].metadata as any)?.lifecycleEvent?.captureMethod, 'WEBSOCKET');

    // 5. Run the Poller to see if it generates and skips duplicate ORDER_FILLED write
    console.log('📡 Running polling cycle on closed/filled trade...');
    await (pollerAdapter as any).pollOrders();

    // 6. Query the DB again to verify no Polling ORDER_FILLED duplicates were written
    console.log('🔍 Re-querying database for all ORDER_FILLED events for this trade...');
    const allFilledRecords = await prisma.decisionAudit.findMany({
        where: {
            classification: 'ORDER_FILLED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: activeTradeId
            }
        }
    });

    // Output all database records to prove there is no duplicate
    console.log('\n--- Database Record Audit ---');
    for (const record of allFilledRecords) {
        console.log(`[DB RECORD] classification: ${record.classification}, captureMethod: ${(record.metadata as any)?.lifecycleEvent?.captureMethod}, eventId: ${(record.metadata as any)?.lifecycleEvent?.eventId}`);
    }
    console.log('-----------------------------\n');

    try {
        assert.strictEqual(allFilledRecords.length, 1, 'Only one ORDER_FILLED record must exist in total (the WebSocket one).');
        console.log('✅ Assertion passed: Exactly 1 WebSocket ORDER_FILLED record found.');

        const hasPollingDuplicate = allFilledRecords.some(r => (r.metadata as any)?.lifecycleEvent?.captureMethod === 'POLLING');
        assert.ok(!hasPollingDuplicate, 'No duplicate record from POLLING captureMethod should exist.');
        console.log('✅ Assertion passed: 0 Polling ORDER_FILLED duplicates found.');
    } catch (err: any) {
        console.error('❌ Verification assertions failed:', err.message);
        throw err;
    } finally {
        // 7. Cleanup Freqtrade and local DB
        console.log(`🧹 Cleaning up: Deleting Trade ID ${activeTradeId} from Freqtrade...`);
        const deleteRes = await fetch(`${config.baseUrl}/trades/${activeTradeId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json'
            }
        });
        if (deleteRes.ok) {
            console.log(`✅ Trade ID ${activeTradeId} deleted.`);
        }

        await cleanupDb(activeTradeId);
        wsAdapter.disconnect();
    }

    console.log('🎉 LIVE RECONCILIATION VERIFICATION PASSED SUCCESSFULLY!');
}

runLiveTest().catch(err => {
    console.error('❌ Live reconciliation test failed:', err);
    process.exit(1);
});
