import { AlertingService } from '../agent/notification/AlertingService';
import { prisma } from '../prisma';

async function main() {
    console.log("Starting Alerting verification...");
    
    // Stub Prisma database calls to avoid requiring a real DATABASE_URL connection
    let createdAlertLogs: any[] = [];
    (prisma.alertLog as any).create = async (args: any) => {
        createdAlertLogs.push(args.data);
        console.log(`[Database Mock] Saved alertLog:`, args.data);
        return args.data;
    };
    (prisma.circuitBreakerState as any).findUnique = async (args: any) => {
        console.log(`[Database Mock] findUnique circuitBreakerState:`, args);
        return null;
    };

    const alertingService = new AlertingService();
    
    // Mock process.env to trigger missing Telegram warning
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalChatId = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = '';
    process.env.TELEGRAM_CHAT_ID = '';

    // 1. INFO Alert
    console.log("\n--- Testing INFO Alert ---");
    await alertingService.sendAlert({
        level: 'INFO',
        title: 'Test Info Alert',
        message: 'This is a test info alert.'
    });
    
    // 2. WARNING Alert
    console.log("\n--- Testing WARNING Alert ---");
    await alertingService.sendAlert({
        level: 'WARNING',
        title: 'Test Warning Alert',
        message: 'This is a test warning alert.'
    });
    
    // 3. CRITICAL Alert
    console.log("\n--- Testing CRITICAL Alert ---");
    await alertingService.sendAlert({
        level: 'CRITICAL',
        title: 'Test Critical Alert',
        message: 'This is a test critical alert.'
    });
    
    // 4. Duplicate Suppression Check
    console.log("\n--- Testing Duplicate Suppression ---");
    console.log("Sending first duplicate warning...");
    await alertingService.sendAlert({
        level: 'WARNING',
        title: 'Duplicate Alert',
        message: 'This alert should suppress subsequent sends.',
        dedupKey: 'dedup_test_key'
    });
    console.log("Sending second duplicate warning...");
    await alertingService.sendAlert({
        level: 'WARNING',
        title: 'Duplicate Alert',
        message: 'This alert should suppress subsequent sends.',
        dedupKey: 'dedup_test_key'
    });

    console.log("\nCreated alert count:", createdAlertLogs.length);
    console.log("Verification complete!");

    // Restore environment variables
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
    process.env.TELEGRAM_CHAT_ID = originalChatId;
}

main().catch(console.error).finally(() => prisma.$disconnect());
