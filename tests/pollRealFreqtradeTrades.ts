import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
dotenv.config();

import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { FreqtradeAdapter } from '../agent/adapters/freqtrade/FreqtradeAdapter';
import { prisma } from '../shared/prisma';

async function main() {
    console.log('📡 Starting real Freqtrade polling test...');
    const persistence = new EventPersistenceService();

    // 1. Clean up the database first to ensure a clean slate for the real bot timeline
    await prisma.decisionAudit.deleteMany({
        where: {
            metadata: {
                path: ['telemetrySource'],
                equals: 'FREQTRADE'
            }
        }
    });
    console.log('🧹 Cleaned up existing Freqtrade telemetry from database.');
    
    // Config pointing to the real Freqtrade REST API
    const config = {
        name: 'freqtrade',
        baseUrl: 'http://127.0.0.1:8080/api/v1',
        username: 'freqtrader',
        password: 'password123',
        pollIntervalMs: 5000
    };

    const adapter = new FreqtradeAdapter(config, persistence);

    // Call the protected pollOrders method directly
    console.log('🔄 Polling real Freqtrade orders...');
    await (adapter as any).pollOrders();

    console.log('📊 Querying database to show the ingested telemetry timeline...');
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

    console.log(`\n=== REAL FREQTRADE TELEMETRY TIMELINE (${audits.length} events) ===`);
    for (const audit of audits) {
        const event = (audit.metadata as any).lifecycleEvent;
        console.log(`[${new Date(event.observedAt).toISOString()}] [${event.captureMethod}] ${event.eventType} | ID: ${event.eventId} | Symbol: ${event.symbol} | Price: ${event.price} | Amount: ${event.amount}`);
    }
    console.log('====================================================\n');
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Error running real Freqtrade poll:', err);
        process.exit(1);
    });
