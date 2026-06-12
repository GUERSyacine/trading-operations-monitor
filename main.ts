import { WatchdogOrchestrator } from './WatchdogOrchestrator';

console.log('====================================================');
console.log('🛡️  STARTING EXECUTION WATCHDOG DAEMON PROCESS');
console.log('====================================================\n');

const orchestrator = new WatchdogOrchestrator();

// Unhandled process crashes -> log and crash fast so systemd restarts it
process.on('uncaughtException', (error) => {
    console.error('FATAL: Uncaught Exception in Watchdog Process:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('FATAL: Unhandled Promise Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Graceful shutdown handler
async function handleShutdown(signal: string) {
    console.log(`\n[Process] Received signal: ${signal}`);
    try {
        await orchestrator.stop();
        console.log('[Process] Graceful shutdown completed. Exiting.');
        process.exit(0);
    } catch (err: any) {
        console.error('[Process] Error during shutdown routine:', err.message || err);
        process.exit(1);
    }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGUSR2', () => handleShutdown('SIGUSR2')); // Nodemon restart signal

async function main() {
    try {
        await orchestrator.start();
    } catch (err: any) {
        console.error('\n❌ FATAL: Watchdog startup failed validation checks:', err.message || err);
        process.exit(1);
    }
}

main();
