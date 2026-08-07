const config = {
    baseUrl: 'http://localhost:8080/api/v1',
    username: 'freqtrader',
    password: 'password123'
};

const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');

async function main() {
    console.log('1. Querying active trades...');
    const statusRes = await fetch(`${config.baseUrl}/status`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    const statusData = await statusRes.json();
    console.log('Active trades:', JSON.stringify(statusData, null, 2));

    console.log('2. Querying historical trades...');
    const tradesRes = await fetch(`${config.baseUrl}/trades`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    const tradesData = await tradesRes.json();
    console.log('Historical trades count:', tradesData.trades ? tradesData.trades.length : 0);

    console.log('3. Placing a limit order...');
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
    const forceEnterData = await forceEnterRes.json();
    console.log('Forceenter response:', forceEnterData);

    const activeTradeId = forceEnterData.trade_id;

    console.log('4. Querying active trade status specifically...');
    const tradeStatusRes = await fetch(`${config.baseUrl}/status`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    const tradeStatusData = await tradeStatusRes.json();
    const tradeObj = tradeStatusData.find(t => t.trade_id === activeTradeId);
    console.log('Trade object in /status:', JSON.stringify(tradeObj, null, 2));

    console.log('5. Cancelling the open order...');
    const cancelRes = await fetch(`${config.baseUrl}/trades/${activeTradeId}/open-order`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        }
    });
    console.log('Cancel response status:', cancelRes.status);
    if (!cancelRes.ok) {
        console.log('Cancel error response:', await cancelRes.text());
    } else {
        console.log('Cancel success response:', await cancelRes.json());
    }

    console.log('6. Checking if trade exists after cancellation...');
    const statusPostRes = await fetch(`${config.baseUrl}/status`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    const statusPostData = await statusPostRes.json();
    console.log('Trade in /status after cancel:', statusPostData.find(t => t.trade_id === activeTradeId));

    const tradesPostRes = await fetch(`${config.baseUrl}/trades`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    const tradesPostData = await tradesPostRes.json();
    const historicalTradeObj = tradesPostData.trades.find(t => t.trade_id === activeTradeId);
    console.log('Trade in /trades after cancel:', JSON.stringify(historicalTradeObj, null, 2));
}

main().catch(console.error);
