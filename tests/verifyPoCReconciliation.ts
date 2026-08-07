import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { prisma } from '../shared/prisma';

async function runPoCVerification() {
    console.log('🧪 Starting Proof of Concept (PoC) Telemetry & Timestamp Verification...');

    const config = {
        baseUrl: 'http://localhost:8080/api/v1',
        wsToken: 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg',
        username: 'freqtrader',
        password: 'password123'
    };

    const persistence = new EventPersistenceService();
    const wsEvents: any[] = [];

    // Capture WS events in-memory for precise analysis
    const wsAdapter = new FreqtradeWebSocketAdapter(config, {
        persistLifecycleEvent: async (event: any, rawPayload: any) => {
            console.log(`[WS Captured] Type: ${rawPayload.type}, Open Date: ${rawPayload.open_date}, Close Date: ${rawPayload.close_date}`);
            wsEvents.push({ event, rawPayload });
        },
        hasLifecycleEvent: async () => false,
        hasEquivalentLifecycleEvent: async () => false
    } as any);

    // 1. Connect WebSocket
    wsAdapter.connect();
    await new Promise(resolve => setTimeout(resolve, 1500));

    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    
    // 2. Query Freqtrade next trade ID
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
    await cleanupDb(String(nextTradeId));

    // 3. Create a limit order (to get entry and entry_cancel events)
    console.log('📡 Triggering forceenter for ADA/USDT...');
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
        wsAdapter.disconnect();
        throw new Error(`Failed to force enter: ${forceEnterRes.status}`);
    }

    const tradeResponseData = (await forceEnterRes.json()) as any;
    const activeTradeId = String(tradeResponseData.trade_id);
    console.log(`✅ Limit Order Trade created with ID: ${activeTradeId}.`);

    // Wait for entry WebSocket message
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. Cancel the entry order
    console.log(`📡 Cancelling open order for Trade ID ${activeTradeId}...`);
    const cancelRes = await fetch(`${config.baseUrl}/trades/${activeTradeId}/open-order`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        }
    });
    console.log(`Cancel request status: ${cancelRes.status}`);

    // Wait for entry_cancel WebSocket message
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Fetch completed historical trades from `/trades` to test after-delete persistence
    console.log('📡 Querying Freqtrade REST API /trades for reconciliation data...');
    const historicalRes = await fetch(`${config.baseUrl}/trades`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    if (!historicalRes.ok) {
        wsAdapter.disconnect();
        throw new Error('Failed to query historical trades');
    }
    const historicalData = (await historicalRes.json()) as any;
    const matchedTrade = (historicalData.trades || []).find((t: any) => String(t.trade_id) === activeTradeId);

    console.log('\n--- Freqtrade REST API Order Payload ---');
    console.log(JSON.stringify(matchedTrade?.orders, null, 2));
    console.log('----------------------------------------\n');

    // 6. Print detailed telemetry comparison and check timestamp drift
    console.log('📊 TELEMETRY TIMESTAMPS COMPARISON:');
    for (const wsEvt of wsEvents) {
        const payload = wsEvt.rawPayload;
        console.log(`\nWS Event Type: ${payload.type}`);
        console.log(`  - WS open_date:  ${payload.open_date}`);
        console.log(`  - WS close_date: ${payload.close_date || 'N/A'}`);

        // Parse WS occurredAt (matches Freqtrade internal clock)
        const rawDate = payload.open_date || payload.close_date;
        const occurredAt = rawDate ? new Date(rawDate).getTime() : undefined;
        console.log(`  - WS Parsed occurredAt (ms): ${occurredAt}`);

        if (matchedTrade && Array.isArray(matchedTrade.orders)) {
            for (const order of matchedTrade.orders) {
                console.log(`  REST Order: ${order.order_id} (${order.status})`);
                console.log(`    - REST order_timestamp (ms):        ${order.order_timestamp}`);
                console.log(`    - REST order_filled_timestamp (ms): ${order.order_filled_timestamp || 'N/A'}`);
                
                // Compare difference
                const refTime = payload.type.endsWith('_cancel') || payload.type.endsWith('_fill') 
                    ? (order.order_filled_timestamp || order.order_timestamp) 
                    : order.order_timestamp;
                
                if (occurredAt !== undefined && refTime !== undefined) {
                    const diff = Math.abs(occurredAt - refTime);
                    console.log(`    - Timestamp difference:             ${diff} ms`);
                }
            }
        }
    }

    // 7. Clean up
    console.log(`\n🧹 Cleaning up: Deleting trade ID ${activeTradeId} from Freqtrade...`);
    await fetch(`${config.baseUrl}/trades/${activeTradeId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        }
    });
    wsAdapter.disconnect();
    console.log('🏁 Verification complete.');
}

runPoCVerification().catch(err => {
    console.error('❌ PoC Verification failed:', err);
    process.exit(1);
});
