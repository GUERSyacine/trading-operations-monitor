import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { prisma } from '../prisma';
import assert from 'assert';

async function runLiveCancellationTest() {
    console.log('🧪 Starting Live Cancellation Verification (Limit Order)...');

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

    console.log(`🧹 Pre-cleaning database audits for trade IDs around ${nextTradeId}...`);
    for (let offset = -2; offset <= 5; offset++) {
        await cleanupDb(String(nextTradeId + offset));
    }

    // 3. Trigger limit order forceenter via REST (far below market so it sits on the book)
    console.log('📡 Triggering forceenter for ADA/USDT (Limit Order @ 0.1)...');
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
            ordertype: 'limit',
            price: 0.1,
            stakeamount: 10.0
        })
    });

    if (!forceEnterRes.ok) {
        const errorText = await forceEnterRes.text();
        wsAdapter.disconnect();
        throw new Error(`Failed to force enter limit order: ${forceEnterRes.status} - ${errorText}`);
    }

    const tradeResponseData = (await forceEnterRes.json()) as any;
    const activeTradeId = String(tradeResponseData.trade_id);
    console.log(`✅ Limit Order Trade created successfully with ID: ${activeTradeId}.`);

    console.log('Waiting for WebSocket to receive and persist ORDER_CREATED...');
    await new Promise(resolve => setTimeout(resolve, 4000));

    // 4. Cancel the open entry limit order
    console.log(`📡 Cancelling open order for Trade ID ${activeTradeId}...`);
    const cancelRes = await fetch(`${config.baseUrl}/trades/${activeTradeId}/open-order`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        }
    });
    console.log(`Cancel request response status: ${cancelRes.status}`);

    console.log('Waiting for WebSocket to receive and persist ORDER_CANCELLED...');
    await new Promise(resolve => setTimeout(resolve, 4000));

    // 5. Query the database to verify the persisted WebSocket events
    console.log('🔍 Querying database for events for this trade...');
    const allRecords = await prisma.decisionAudit.findMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: activeTradeId
            }
        },
        orderBy: {
            createdAt: 'asc'
        }
    });

    console.log('\n--- Database Record Audit for Canceled Trade ---');
    for (const record of allRecords) {
        console.log(`[DB RECORD] classification: ${record.classification}, captureMethod: ${(record.metadata as any)?.lifecycleEvent?.captureMethod}, eventId: ${(record.metadata as any)?.lifecycleEvent?.eventId}`);
    }
    console.log('------------------------------------------------\n');

    try {
        const createdEvent = allRecords.find(r => r.classification === 'ORDER_CREATED');
        const cancelledEvent = allRecords.find(r => r.classification === 'ORDER_CANCELLED');

        assert.ok(createdEvent, 'Should have persisted ORDER_CREATED event.');
        assert.ok(cancelledEvent, 'Should have persisted ORDER_CANCELLED event.');

        assert.strictEqual((createdEvent.metadata as any)?.lifecycleEvent?.captureMethod, 'WEBSOCKET', 'ORDER_CREATED captureMethod should be WEBSOCKET.');
        assert.strictEqual((cancelledEvent.metadata as any)?.lifecycleEvent?.captureMethod, 'WEBSOCKET', 'ORDER_CANCELLED captureMethod should be WEBSOCKET.');

        console.log('✅ End-to-End WebSocket Ingestion Verification for ORDER_CANCELLED Passed Successfully!');
    } catch (err: any) {
        console.error('❌ Integration assertions failed:', err.message);
        throw err;
    } finally {
        // Cleanup trade from Freqtrade database
        console.log(`🧹 Cleaning up: Deleting trade ID ${activeTradeId} from Freqtrade...`);
        await fetch(`${config.baseUrl}/trades/${activeTradeId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json'
            }
        });
        await cleanupDb(activeTradeId);
        wsAdapter.disconnect();
    }
}

runLiveCancellationTest().catch(err => {
    console.error('❌ Live cancellation test failed:', err);
    process.exit(1);
});
