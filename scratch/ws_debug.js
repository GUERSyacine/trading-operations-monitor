const WebSocket = require('ws');

const wsUrl = 'ws://localhost:8080/api/v1/message/ws?token=bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg';
const ws = new WebSocket(wsUrl);

ws.on('open', async () => {
    console.log('WS Open');
    const sub = {
        type: 'subscribe',
        data: ['entry', 'entry_fill', 'entry_cancel', 'exit', 'exit_fill', 'exit_cancel', 'status', 'warning', 'startup']
    };
    ws.send(JSON.stringify(sub));

    // Wait 2 seconds, then trigger forceenter
    setTimeout(async () => {
        const auth = Buffer.from('freqtrader:password123').toString('base64');
        const tradesRes = await fetch('http://localhost:8080/api/v1/trades', {
            headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
        });
        const tradesData = await tradesRes.json();
        const nextId = Math.max(...(tradesData.trades || []).map(t => t.trade_id), 0) + 1;
        console.log('Next trade ID will be:', nextId);

        console.log('Triggering forceenter...');
        const enterRes = await fetch('http://localhost:8080/api/v1/forceenter', {
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
        const enterData = await enterRes.json();
        const activeId = enterData.trade_id;
        console.log('Created trade ID:', activeId);

        // Wait 4 seconds, then cancel open-order
        setTimeout(async () => {
            console.log('Cancelling open order for trade ID:', activeId);
            const delRes = await fetch(`http://localhost:8080/api/v1/trades/${activeId}/open-order`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            });
            console.log('Cancel response status:', delRes.status);
            const delData = await delRes.json();
            console.log('Cancel response body:', delData);

            // Wait 4 seconds, then cleanup (DELETE the trade to clean up Freqtrade database)
            setTimeout(async () => {
                console.log('Cleaning up trade ID:', activeId);
                await fetch(`http://localhost:8080/api/v1/trades/${activeId}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Accept': 'application/json'
                    }
                });
                ws.close();
            }, 4000);
        }, 4000);
    }, 2000);
});

ws.on('message', (data) => {
    console.log('WS MESSAGE:', data.toString());
});

ws.on('close', () => {
    console.log('WS Close');
});
