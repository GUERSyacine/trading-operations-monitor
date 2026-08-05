import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config(); // fallback to current dir

import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { prisma } from '../shared/prisma';
import WebSocket from 'ws';

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

    // 2. Test WebSocket Ingestion via local mock WebSocket Server & FreqtradeWebSocketAdapter
    console.log('📡 Starting local Mock WebSocket server...');
    const wss = new WebSocket.Server({ port: 19999 });

    wss.on('connection', (ws) => {
        console.log('🔌 Client connected to Mock WebSocket server.');
        
        // Wait a brief moment to send messages after connection is open
        setTimeout(() => {
            console.log('📡 Injecting simulated WebSocket messages...');
            
            // Inject entry signal (maps to ORDER_CREATED)
            ws.send(JSON.stringify({
                type: 'entry',
                trade_id: 201,
                pair: 'SOL/USDT',
                direction: 'Long',
                order_rate: 150.5,
                amount: 10,
                open_date: new Date().toISOString()
            }));

            // Inject exit fill (maps to ORDER_FILLED)
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'exit_fill',
                    trade_id: 201,
                    order_id: 'ft_ord_999',
                    pair: 'SOL/USDT',
                    direction: 'Long',
                    close_rate: 155.2,
                    amount: 10,
                    close_date: new Date().toISOString()
                }));
            }, 100);
        }, 100);
    });

    const config = {
        baseUrl: 'http://127.0.0.1:19999',
        wsToken: 'test_token',
        username: 'freqtrader',
        password: 'password123'
    };

    const wsAdapter = new FreqtradeWebSocketAdapter(config, persistence);
    wsAdapter.connect();

    // Wait for connection to establish and messages to be received/processed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Cleanup websocket client and server
    wsAdapter.disconnect();
    await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
    console.log('🛑 Stopped mock WebSocket server and client.');

    // 3. Test Polling Ingestion via FreqtradeAdapter
    const pollingConfig = {
        name: 'freqtrade',
        baseUrl: 'http://127.0.0.1:8080/api/v1',
        username: 'admin',
        password: 'password',
        pollIntervalMs: 5000
    };

    const adapter = new FreqtradeAdapter(pollingConfig, persistence);

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
    
    // Check Event 1: ORDER_CREATED via WebSocket
    const evt1 = events[0];
    console.log('  - Asserting Event 1 (ORDER_CREATED via WebSocket)...');
    if (evt1.eventType !== 'ORDER_CREATED' || evt1.captureMethod !== 'WEBSOCKET' || evt1.schemaVersion !== 1) {
        throw new Error(`Event 1 mismatch. eventType=${evt1.eventType}, captureMethod=${evt1.captureMethod}`);
    }
    if (evt1.eventId !== `FREQTRADE:201:entry:${evt1.eventTimestamp}`) {
        throw new Error(`Deterministic ID failed for Event 1: ${evt1.eventId}`);
    }

    // Check Event 2: ORDER_FILLED via WebSocket
    const evt2 = events[1];
    console.log('  - Asserting Event 2 (ORDER_FILLED via WebSocket)...');
    if (evt2.eventType !== 'ORDER_FILLED' || evt2.captureMethod !== 'WEBSOCKET') {
        throw new Error('Event 2 mismatch.');
    }
    if (evt2.eventId !== `FREQTRADE:201:exit_fill:${evt2.eventTimestamp}`) {
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
