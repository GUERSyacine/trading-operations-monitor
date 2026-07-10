import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { LifecycleEvent } from '../shared/types/telemetry';
import { prisma } from '../shared/prisma';
import assert from 'assert';

// Mock global fetch for API response stubbing
const originalFetch = global.fetch;

let mockStatusResponse: any = [];
let mockTradesResponse: any = { trades: [] };

global.fetch = async (url: any, options?: any): Promise<any> => {
    const urlStr = String(url);
    if (urlStr.endsWith('/status')) {
        return {
            ok: true,
            status: 200,
            json: async () => mockStatusResponse
        };
    }
    if (urlStr.endsWith('/trades')) {
        return {
            ok: true,
            status: 200,
            json: async () => mockTradesResponse
        };
    }
    return {
        ok: true,
        status: 200,
        json: async () => ({})
    };
};

async function runTest() {
    console.log('🧪 Starting Cross-Source Ingestion Reconciliation Test...');

    const persistence = new EventPersistenceService();
    const config = {
        baseUrl: 'http://mock-freqtrade:8080/api/v1',
        username: 'freqtrader',
        password: 'password123',
        pollIntervalMs: 15000
    };

    const adapter = new FreqtradeAdapter(config, persistence);

    const mockTradeId = '888';
    const mockOrderId = 'order_888';

    // Helper to clean up mock database entries
    const cleanup = async () => {
        await prisma.decisionAudit.deleteMany({
            where: {
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: mockTradeId
                }
            }
        });
    };

    // Make sure we start with a clean slate
    await cleanup();

    // ==========================================
    // SCENARIO A: Normal Path (WebSocket first)
    // ==========================================
    console.log('\n--- Scenario A: Normal Path (WebSocket first) ---');

    // 1. Mock a WebSocket fill event that already exists in the database
    console.log('Injecting mock WebSocket ORDER_FILLED event...');
    const wsEvent: LifecycleEvent = {
        schemaVersion: 1,
        eventId: `FREQTRADE:${mockTradeId}:entry_fill:${Date.now()}`,
        tradeId: mockTradeId,
        orderId: mockOrderId,
        eventType: 'ORDER_FILLED',
        source: 'FREQTRADE',
        captureMethod: 'WEBSOCKET',
        eventTimestamp: Date.now(),
        observedAt: Date.now(),
        occurredAt: Date.now(),
        symbol: 'BTCUSDT',
        side: 'BUY',
        price: 10000,
        amount: 1
    };
    await persistence.persistLifecycleEvent(wsEvent, { type: 'entry_fill', trade_id: 888, order_id: mockOrderId });

    // 2. Set up poller API response mock for a closed order
    mockStatusResponse = [];
    mockTradesResponse = {
        trades: [
            {
                trade_id: 888,
                pair: 'BTC/USDT',
                orders: [
                    {
                        order_id: mockOrderId,
                        status: 'closed',
                        ft_order_side: 'buy',
                        price: 10000,
                        amount: 1,
                        filled: 1
                    }
                ]
            }
        ]
    };

    // 3. Run the poller cycle
    console.log('Running poller cycle...');
    await (adapter as any).pollOrders();

    // 4. Assert that the poller skipped writing a duplicate ORDER_FILLED record
    const recordsScenarioA = await prisma.decisionAudit.findMany({
        where: {
            classification: 'ORDER_FILLED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: mockTradeId
            }
        }
    });

    assert.strictEqual(recordsScenarioA.length, 1, 'Only one ORDER_FILLED event should exist (the WebSocket one).');
    assert.strictEqual((recordsScenarioA[0].metadata as any)?.lifecycleEvent?.captureMethod, 'WEBSOCKET');
    console.log('✅ Scenario A PASS: Poller successfully skipped duplicate event insertion.');

    // ==========================================
    // SCENARIO B: Outage Recovery (Polling Safety Net)
    // ==========================================
    console.log('\n--- Scenario B: Outage Recovery (Polling Safety Net) ---');

    // 1. Clean DB to simulate that WebSocket missed the event (outage)
    console.log('Cleaning database (simulating missed WS event)...');
    await cleanup();

    // 2. Clear poller's internal cache for this order to trigger evaluation
    (adapter as any).lastKnownOrderStatus.clear();

    // 3. Run the poller cycle
    console.log('Running poller cycle...');
    await (adapter as any).pollOrders();

    // 4. Assert that the poller successfully reconciled and wrote the event
    const recordsScenarioB = await prisma.decisionAudit.findMany({
        where: {
            classification: 'ORDER_FILLED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: mockTradeId
            }
        }
    });

    assert.strictEqual(recordsScenarioB.length, 1, 'Polling safety net should have written the missing ORDER_FILLED event.');
    assert.strictEqual((recordsScenarioB[0].metadata as any)?.lifecycleEvent?.captureMethod, 'POLLING');
    console.log('✅ Scenario B PASS: Polling safely recovered/reconciled the missing fill event.');

    // ==========================================
    // SCENARIO C: Recovery Restart (Duplicate Protection)
    // ==========================================
    console.log('\n--- Scenario C: Recovery Restart (Duplicate Protection) ---');

    // 1. Instantiate a new adapter to simulate a fresh watchdog reboot/restart (clean in-memory cache)
    console.log('Rebooting watchdog (instantiating fresh FreqtradeAdapter)...');
    const freshAdapter = new FreqtradeAdapter(config, persistence);

    // 2. Run the fresh poller cycle
    console.log('Running poller cycle...');
    await (freshAdapter as any).pollOrders();

    // 3. Assert that the poller detected its own previous recovery write and did not duplicate
    const recordsScenarioC = await prisma.decisionAudit.findMany({
        where: {
            classification: 'ORDER_FILLED',
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: mockTradeId
            }
        }
    });

    assert.strictEqual(recordsScenarioC.length, 1, 'Fresh poller restart should not write duplicate event.');
    console.log('✅ Scenario C PASS: Fresh poller restart successfully deduplicated against database.');

    // Clean up
    console.log('\nCleaning up database...');
    await cleanup();

    // Restore fetch
    global.fetch = originalFetch;

    console.log('\n🎉 All Reconciliation Scenarios PASSED SUCCESSFULLY!');
}

runTest().catch(err => {
    console.error('❌ Integration test failed:', err);
    global.fetch = originalFetch;
    process.exit(1);
});
