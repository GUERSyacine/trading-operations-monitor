import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { prisma } from '../shared/prisma';

async function runLiveLifecycleTest() {
    console.log('🧪 Starting Level 3 Live Lifecycle Verification...');

    const persistence = new EventPersistenceService();
    const config = {
        baseUrl: 'http://localhost:8080/api/v1',
        username: 'freqtrader',
        password: 'password123',
        pollIntervalMs: 5000
    };

    const adapter = new FreqtradeAdapter(config, persistence);
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');

    // ==========================================
    // Part 1: Verify ORDER_OPEN & Deduplication
    // ==========================================
    console.log('\n--- Part 1: Testing ORDER_OPEN and Deduplication ---');
    console.log('📡 Triggering forceenter for BTC/USDT (limit order at $10,000)...');
    const forceEnterOpenRes = await fetch(`${config.baseUrl}/forceenter`, {
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

    if (!forceEnterOpenRes.ok) {
        const errorText = await forceEnterOpenRes.text();
        throw new Error(`Failed to force enter limit trade: ${forceEnterOpenRes.status} - ${errorText}`);
    }

    const tradeOpenData = (await forceEnterOpenRes.json()) as any;
    const tradeOpenId = tradeOpenData.trade_id;
    if (typeof tradeOpenId !== 'number') {
        throw new Error(`Invalid trade_id returned from limit forceenter: ${JSON.stringify(tradeOpenData)}`);
    }
    console.log(`✅ Limit Trade created successfully. Trade ID: ${tradeOpenId}`);

    // Clean database audits of this trade ID
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: String(tradeOpenId)
            }
        }
    });

    try {
        console.log('🔄 Triggering pollOrders() (expecting ORDER_OPEN)...');
        await (adapter as any).pollOrders();

        const openEvents = await prisma.decisionAudit.findMany({
            where: {
                classification: 'ORDER_OPEN',
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: String(tradeOpenId)
                }
            }
        });

        if (openEvents.length !== 1) {
            throw new Error(`Expected exactly 1 ORDER_OPEN event, found ${openEvents.length}`);
        }
        console.log(`✅ ORDER_OPEN successfully persisted. Event ID: ${(openEvents[0].metadata as any)?.lifecycleEvent?.eventId}`);

        console.log('🔄 Triggering pollOrders() again (expecting no duplicate inserts)...');
        await (adapter as any).pollOrders();

        const openEventsDupCheck = await prisma.decisionAudit.findMany({
            where: {
                classification: 'ORDER_OPEN',
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: String(tradeOpenId)
                }
            }
        });

        if (openEventsDupCheck.length !== 1) {
            throw new Error(`Deduplication failed! Expected exactly 1 ORDER_OPEN event, found ${openEventsDupCheck.length}`);
        }
        console.log('✅ Deduplication check passed. No duplicate ORDER_OPEN events written.');

    } finally {
        console.log(`🧹 Cleaning up Part 1: Deleting Trade ID ${tradeOpenId}...`);
        await fetch(`${config.baseUrl}/trades/${tradeOpenId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
        });
        await prisma.decisionAudit.deleteMany({
            where: {
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: String(tradeOpenId)
                }
            }
        });
    }

    // ==========================================
    // Part 2: Verify ORDER_FILLED (Market order)
    // ==========================================
    console.log('\n--- Part 2: Testing ORDER_FILLED (Market order) ---');
    console.log('📡 Triggering forceenter for BTC/USDT (market order)...');
    const forceEnterFilledRes = await fetch(`${config.baseUrl}/forceenter`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            pair: 'BTC/USDT',
            side: 'long',
            ordertype: 'market',
            stakeamount: 100.0
        })
    });

    if (!forceEnterFilledRes.ok) {
        const errorText = await forceEnterFilledRes.text();
        throw new Error(`Failed to force enter market trade: ${forceEnterFilledRes.status} - ${errorText}`);
    }

    const tradeFilledData = (await forceEnterFilledRes.json()) as any;
    const tradeFilledId = tradeFilledData.trade_id;
    if (typeof tradeFilledId !== 'number') {
        throw new Error(`Invalid trade_id returned from market forceenter: ${JSON.stringify(tradeFilledData)}`);
    }
    console.log(`✅ Market Trade created successfully. Trade ID: ${tradeFilledId}`);

    // Clean database audits of this trade ID
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['lifecycleEvent', 'tradeId'],
                equals: String(tradeFilledId)
            }
        }
    });

    try {
        console.log('🔄 Triggering pollOrders() (expecting ORDER_FILLED)...');
        await (adapter as any).pollOrders();

        const filledEvents = await prisma.decisionAudit.findMany({
            where: {
                classification: 'ORDER_FILLED',
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: String(tradeFilledId)
                }
            }
        });

        if (filledEvents.length !== 1) {
            throw new Error(`Expected exactly 1 ORDER_FILLED event, found ${filledEvents.length}`);
        }
        console.log(`✅ ORDER_FILLED successfully persisted. Event ID: ${(filledEvents[0].metadata as any)?.lifecycleEvent?.eventId}`);

    } finally {
        console.log(`🧹 Cleaning up Part 2: Deleting Trade ID ${tradeFilledId}...`);
        await fetch(`${config.baseUrl}/trades/${tradeFilledId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
        });
        await prisma.decisionAudit.deleteMany({
            where: {
                metadata: {
                    path: ['lifecycleEvent', 'tradeId'],
                    equals: String(tradeFilledId)
                }
            }
        });
    }

    console.log('\n🎉 LEVEL 3 LIVE LIFECYCLE VERIFICATION PASSED SUCCESSFULLY!\n');
}

runLiveLifecycleTest().catch(err => {
    console.error('❌ Level 3 Live Lifecycle Verification Failed:', err);
    process.exit(1);
});
