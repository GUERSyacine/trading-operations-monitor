import * as dotenv from 'dotenv';
import { prisma } from '../shared/prisma';
import { DeveloperConsoleServer } from './developer/DeveloperConsoleServer';

// Load environment variables from .env
dotenv.config();

console.log('====================================================');
console.log('🌐 STARTING STANDALONE CLOUD GATEWAY SERVER');
console.log('====================================================\n');

async function main() {
    // 1. Fail-fast startup checks: check DATABASE_URL presence
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('❌ FATAL: DATABASE_URL environment variable is missing.');
        process.exit(1);
    }

    // 2. Fail-fast startup checks: verify database connection
    try {
        console.log('[CloudGateway] Verifying database connection...');
        await prisma.$connect();
        console.log('[CloudGateway] Database connection verified successfully.');
    } catch (err: any) {
        console.error(`❌ FATAL: Database connection failed: ${err?.message || err}`);
        process.exit(1);
    }

    const host = process.env.WATCHDOG_DEV_CONSOLE_HOST || '0.0.0.0';
    const port = Number(process.env.WATCHDOG_DEV_CONSOLE_PORT) || 3001;

    // 3. Instantiate server via composition root
    let server: DeveloperConsoleServer;
    try {
        server = DeveloperConsoleServer.bootstrap(port, host);
    } catch (err: any) {
        console.error(`❌ FATAL: Failed to compose Developer Console Server: ${err?.message || err}`);
        process.exit(1);
    }

    // 4. Register process signal termination handlers for clean shutdown
    const handleShutdown = async (signal: string) => {
        console.log(`\n[Process] Received ${signal}. Starting clean shutdown...`);
        try {
            await server.stop();
            await prisma.$disconnect();
            console.log('[Process] Standalone Cloud Gateway stopped gracefully.');
            process.exit(0);
        } catch (err: any) {
            console.error('[Process] Error during shutdown:', err?.message || err);
            process.exit(1);
        }
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    // 5. Start the server
    try {
        server.start();
        console.log('\n----------------------------------------------------');
        console.log('Execution Watchdog Cloud');
        console.log(`Host:              ${host}`);
        console.log(`Port:              ${port}`);
        console.log('Database:          Connected');
        console.log('Developer Console: Started');
        console.log('----------------------------------------------------');
        console.log('Ready to accept agents.\n');
    } catch (err: any) {
        console.error(`❌ FATAL: Server failed to start: ${err?.message || err}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('❌ FATAL: Unexpected error in main thread:', err);
    process.exit(1);
});
