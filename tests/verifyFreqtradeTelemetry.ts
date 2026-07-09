import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config(); // fallback to current dir


import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';
import { FreqtradeWebhookReceiver } from '../agent/detectors/infrastructure/FreqtradeWebhookReceiver';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { prisma } from '../shared/prisma';


async function runVerification() {
    console.log('🧪 Starting Level 1 Freqtrade Telemetry Ingestion Verification...');

    const persistence = new EventPersistenceService();

    // 1. Clean up any previous test audits
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['telemetrySource'],
                equals: 'FREQTRADE'
            }
        }
    });
    console.log('🧹 Cleaned up existing Freqtrade telemetry from database.');

    // 2. Test Webhook Ingestion via FreqtradeWebhookReceiver
    const receiver = new FreqtradeWebhookReceiver(persistence, 19999, '127.0.0.1');
    receiver.start();

    console.log('📡 Injecting simulated webhooks...');
    
    // Inject entry signal
    const entryRes = await fetch('http://127.0.0.1:19999/webhooks/freqtrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'entry',
            trade_id: 201,
            symbol: 'SOL/USDT',
            strategy: 'SOL_RIDER',
            direction: 'long',
            price: 150.5,
            amount: 10
        })
    });
    if (entryRes.status !== 200) {
        throw new Error(`Failed to send entry webhook. Status: ${entryRes.status}`);
    }

    // Inject exit fill
    const fillRes = await fetch('http://127.0.0.1:19999/webhooks/freqtrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'exit_fill',
            trade_id: 201,
            order_id: 'ft_ord_999',
            symbol: 'SOL/USDT',
            price: 155.2,
            amount: 10
        })
    });
    if (fillRes.status !== 200) {
        throw new Error(`Failed to send exit_fill webhook. Status: ${fillRes.status}`);
    }

    await receiver.stop();
    console.log('🛑 Stopped webhook receiver.');

    // 3. Test Polling Ingestion via FreqtradeAdapter
    const config = {
        name: 'freqtrade',
        baseUrl: 'http://127.0.0.1:8080/api/v1',
        username: 'admin',
        password: 'password',
        pollIntervalMs: 5000
    };

    const adapter = new FreqtradeAdapter(config, persistence);

    // Mock the apiRequest call to return test trades and orders
    const mockTrades: any = {
        trades: [
            {
                trade_id: 202,
                strategy: 'SOL_RIDER',
                orders: [
                    {
                        order_id: 'ft_ord_1001',
                        pair: 'SOL/USDT',
                        status: 'open',
                        ft_order_side: 'buy',
                        price: 149.0,
                        amount: 5,
                        filled: 0,
                        order_timestamp: Date.now() - 5000
                    }
                ]
            }
        ]
    };

    (adapter as any).apiRequest = async (endpoint: string) => {
        if (endpoint === '/trades') {
            return mockTrades;
        }
        if (endpoint === '/status') {
            return [];
        }
        return { exchange: 'binance' };
    };

    console.log('🔄 Triggering FreqtradeAdapter pollOrders cycle (1)...');
    await (adapter as any).pollOrders();

    // Verify cache prevents duplicate logs
    console.log('🔄 Triggering FreqtradeAdapter pollOrders cycle (2 - Cache Optimization test)...');
    await (adapter as any).pollOrders();

    // Now modify the order status to closed (filled) to test transition
    mockTrades.trades[0].orders[0].status = 'closed';
    mockTrades.trades[0].orders[0].filled = 5;
    mockTrades.trades[0].orders[0].order_filled_timestamp = Date.now();

    console.log('🔄 Triggering FreqtradeAdapter pollOrders cycle (3 - Transition to FILLED)...');
    await (adapter as any).pollOrders();

    // 4. Database Assertions
    const audits = await prisma.decisionAudit.findMany({
        where: {
            metadata: {
                path: ['telemetrySource'],
                equals: 'FREQTRADE'
            }
        },
        orderBy: {
            createdAt: 'asc'
        }
    });

    console.log(`\n🔍 Found ${audits.length} Freqtrade audits in database.`);
    
    if (audits.length !== 4) {
        throw new Error(`Expected exactly 4 persisted Freqtrade audits, found ${audits.length}`);
    }

    const events = audits.map((a: any) => a.metadata.lifecycleEvent);

    // Assertions
    console.log('\n✏️ Running Assertions:');
    
    // Check Event 1: SIGNAL Webhook
    const evt1 = events[0];
    console.log('  - Asserting Event 1 (SIGNAL via Webhook)...');
    if (evt1.eventType !== 'SIGNAL' || evt1.captureMethod !== 'WEBHOOK' || evt1.schemaVersion !== 1) {
        throw new Error('Event 1 mismatch.');
    }
    if (evt1.eventId !== `FREQTRADE:201:SIGNAL:${evt1.eventTimestamp}`) {
        throw new Error(`Deterministic ID failed for Event 1: ${evt1.eventId}`);
    }

    // Check Event 2: ORDER_FILLED Webhook
    const evt2 = events[1];
    console.log('  - Asserting Event 2 (ORDER_FILLED via Webhook)...');
    if (evt2.eventType !== 'ORDER_FILLED' || evt2.captureMethod !== 'WEBHOOK') {
        throw new Error('Event 2 mismatch.');
    }
    if (evt2.eventId !== `FREQTRADE:ft_ord_999:ORDER_FILLED:${evt2.eventTimestamp}`) {
        throw new Error(`Deterministic ID failed for Event 2: ${evt2.eventId}`);
    }

    // Check Event 3: ORDER_OPEN Polled
    const evt3 = events[2];
    console.log('  - Asserting Event 3 (ORDER_OPEN via Polled)...');
    if (evt3.eventType !== 'ORDER_OPEN' || evt3.captureMethod !== 'POLLING') {
        throw new Error('Event 3 mismatch.');
    }
    if (evt3.eventId !== `FREQTRADE:ft_ord_1001:ORDER_OPEN:${evt3.eventTimestamp}`) {
        throw new Error(`Deterministic ID failed for Event 3: ${evt3.eventId}`);
    }

    // Check Event 4: ORDER_FILLED Polled
    const evt4 = events[3];
    console.log('  - Asserting Event 4 (ORDER_FILLED via Polled)...');
    if (evt4.eventType !== 'ORDER_FILLED' || evt4.captureMethod !== 'POLLING') {
        throw new Error('Event 4 mismatch.');
    }
    if (evt4.eventId !== `FREQTRADE:ft_ord_1001:ORDER_FILLED:${evt4.eventTimestamp}`) {
        throw new Error(`Deterministic ID failed for Event 4: ${evt4.eventId}`);
    }

    // Verify rawPayload preservation
    for (let i = 0; i < audits.length; i++) {
        const raw = (audits[i] as any).metadata.rawPayload;
        if (!raw) {
            throw new Error(`Audit index ${i} is missing rawPayload.`);
        }
        console.log(`  - Audit ${i + 1} (${events[i].eventType}) correctly preserved rawPayload.`);
    }

    console.log('\n🎉 LEVEL 1 SYNTHETIC TELEMETRY VERIFICATION PASSED SUCCESSFULLY!');
}

runVerification()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Ingestion Verification Failed:', err);
        process.exit(1);
    });
