import { FreqtradeWebSocketAdapter } from '../agent/detectors/infrastructure/FreqtradeWebSocketAdapter';
import { EventPersistenceService } from '../agent/adapters/base/EventPersistenceService';

async function runTest() {
    console.log('🧪 Starting Level 1 Freqtrade WebSocket PoC Verification...');

    const config = {
        baseUrl: 'http://localhost:8080/api/v1',
        wsToken: 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg',
        username: 'freqtrader',
        password: 'password123'
    };

    const persistence = new EventPersistenceService();
    const wsAdapter = new FreqtradeWebSocketAdapter(config, persistence);
    wsAdapter.connect();

    // Wait for connection to establish
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Basic Auth for REST calls to trigger events
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');

    console.log('📡 Triggering forceenter to generate a live ENTRY websocket message...');
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
    const tradeId = tradeData.trade_id;
    console.log(`✅ Trade created with ID: ${tradeId}. Waiting to capture WebSocket events...`);

    // Wait to capture the websocket messages
    await new Promise(resolve => setTimeout(resolve, 6000));

    console.log(`🧹 Cleaning up: Deleting Trade ID ${tradeId} from Freqtrade bot...`);
    const deleteRes = await fetch(`${config.baseUrl}/trades/${tradeId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        }
    });

    if (!deleteRes.ok) {
        console.error(`[Warning] Failed to delete trade ${tradeId}: ${deleteRes.status}`);
    } else {
        console.log(`✅ Trade ID ${tradeId} deleted.`);
    }

    // Wait a brief moment to capture final messages if any
    await new Promise(resolve => setTimeout(resolve, 3000));

    wsAdapter.disconnect();
    console.log('🎉 WebSocket verification script run completed.');
}

runTest().catch(err => {
    console.error('❌ WebSocket verification failed:', err);
    process.exit(1);
});
