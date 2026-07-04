import { EvidenceCollector } from '../layer-B(Assessement)/EvidenceCollector';
import { prisma } from '../prisma';

async function run() {
    try {
        console.log('🔍 Collecting evidence for incident group 77...');
        const collector = new EvidenceCollector();
        const evidence = await collector.collectEvidence(77);
        console.table(
            evidence.map(e => ({
                seq: e.sequence,
                source: e.source,
                event: e.event,
                timestamp: e.timestamp
            }))
        );
    } catch (e: any) {
        console.error('❌ Error during evidence collection:', e.message || e);
    } finally {
        await prisma.$disconnect();
    }
}

run();
