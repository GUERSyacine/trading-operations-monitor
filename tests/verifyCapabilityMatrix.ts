import { OperationsWatchdogService } from '../layer-A(observation)/layer2(trading_operations_monitoring)/OperationsWatchdogService';
import { prisma } from '../prisma';
import assert from 'assert';

async function runTests() {
    console.log('🧪 Starting Capability Matrix Unit Tests...');

    // 1. Mock IncidentManager & AlertingService
    const mockAlerting = {
        async sendAlert() {}
    };
    const mockIncident = {
        async reportIncident() {},
        async resolveIncidentBySource() {}
    };

    const watchdog = new OperationsWatchdogService(mockAlerting as any, mockIncident as any);

    // Save original findMany
    const originalFindMany = prisma.decisionAudit.findMany;
    let mockEvents: any[] = [];
    (prisma.decisionAudit as any).findMany = async (args: any) => {
        let filtered = [...mockEvents];
        if (args?.where?.classification) {
            const filter = args.where.classification;
            if (typeof filter === 'string') {
                filtered = filtered.filter((item: any) => item.classification === filter);
            } else if (filter && typeof filter === 'object') {
                if (filter.in) {
                    filtered = filtered.filter((item: any) => filter.in.includes(item.classification));
                } else if (filter.equals) {
                    filtered = filtered.filter((item: any) => item.classification === filter.equals);
                }
            }
        }
        return filtered;
    };

    try {
        // --- Case 1: Freqtrade Valid Timeline (SIGNAL -> ORDER_CREATED -> ORDER_OPEN -> ORDER_FILLED) ---
        console.log(' - Case 1: Freqtrade Valid (SIGNAL -> ORDER_CREATED -> ORDER_OPEN -> ORDER_FILLED)');
        mockEvents = [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't100', source: 'FREQTRADE' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't100', source: 'FREQTRADE' } },
            { classification: 'ORDER_OPEN', createdAt: new Date(Date.now() - 30 * 1000), metadata: { tradeId: 't100', source: 'FREQTRADE' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't100', source: 'FREQTRADE' } }
        ];

        const resultCase1 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        const lifecycle1 = resultCase1.metadata?.observability?.lifecycle;
        console.log(`   validTrades: ${lifecycle1?.validTrades}, tradesWithSkippedStages: ${lifecycle1?.tradesWithSkippedStages}`);
        assert.strictEqual(lifecycle1?.validTrades, 1, 'Case 1: Should have exactly 1 valid trade.');
        assert.strictEqual(lifecycle1?.tradesWithSkippedStages, 0, 'Case 1: Should have 0 skipped stages.');

        // --- Case 2: Freqtrade Invalid Timeline (SIGNAL -> ORDER_FILLED directly) ---
        console.log(' - Case 2: Freqtrade Invalid (SIGNAL -> ORDER_FILLED)');
        mockEvents = [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't101', source: 'FREQTRADE' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't101', source: 'FREQTRADE' } }
        ];

        const resultCase2 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        const lifecycle2 = resultCase2.metadata?.observability?.lifecycle;
        console.log(`   validTrades: ${lifecycle2?.validTrades}, tradesWithSkippedStages: ${lifecycle2?.tradesWithSkippedStages}`);
        assert.strictEqual(lifecycle2?.validTrades, 1, 'Case 2: Should have exactly 1 valid trade.');
        assert.strictEqual(lifecycle2?.tradesWithSkippedStages, 1, 'Case 2: Should have 1 skipped stage (ORDER_CREATED/ORDER_OPEN are supported but skipped).');

        // --- Case 3: Simulator Invalid Timeline (SIGNAL -> ORDER_CREATED -> ORDER_FILLED) ---
        console.log(' - Case 3: Simulator Invalid (SIGNAL -> ORDER_CREATED -> ORDER_FILLED)');
        mockEvents = [
            { classification: 'SIGNAL', createdAt: new Date(Date.now() - 50 * 1000), metadata: { tradeId: 't102', source: 'SIMULATOR' } },
            { classification: 'ORDER_CREATED', createdAt: new Date(Date.now() - 40 * 1000), metadata: { tradeId: 't102', source: 'SIMULATOR' } },
            { classification: 'ORDER_FILLED', createdAt: new Date(Date.now() - 10 * 1000), metadata: { tradeId: 't102', source: 'SIMULATOR' } }
        ];

        const resultCase3 = await watchdog.checkOrderPipeline(5 * 60 * 1000);
        const lifecycle3 = resultCase3.metadata?.observability?.lifecycle;
        console.log(`   validTrades: ${lifecycle3?.validTrades}, tradesWithSkippedStages: ${lifecycle3?.tradesWithSkippedStages}`);
        assert.strictEqual(lifecycle3?.validTrades, 1, 'Case 3: Should have exactly 1 valid trade.');
        assert.strictEqual(lifecycle3?.tradesWithSkippedStages, 1, 'Case 3: Should have 1 skipped stage (ORDER_SUBMITTED, ORDER_ACKNOWLEDGED, and ORDER_OPEN are supported but skipped).');

        console.log('✅ ALL CAPABILITY MATRIX UNIT TESTS PASSED SUCCESSFULLY!');
    } finally {
        // Restore original findMany
        (prisma.decisionAudit as any).findMany = originalFindMany;
    }
}

runTests().catch(err => {
    console.error('❌ Capability Matrix unit tests failed:', err);
    process.exit(1);
});
