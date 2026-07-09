import { EvidenceCollector } from '../agent/incident/analysis/EvidenceCollector';
import { prisma } from '../shared/prisma';

async function run() {
    try {
        let groupId = parseInt(process.argv[2] || '');
        if (isNaN(groupId)) {
            const latestGroup = await prisma.incidentGroup.findFirst({
                orderBy: { openedAt: 'desc' }
            });
            if (!latestGroup) {
                console.error('❌ No incident groups found in database!');
                return;
            }
            groupId = latestGroup.id;
            console.log(`ℹ️ No group ID provided. Using latest group ID from database: ${groupId}`);
        } else {
            console.log(`🔍 Collecting evidence for incident group ${groupId}...`);
        }

        const collector = new EvidenceCollector();
        const evidence = await collector.collectEvidence(groupId);
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
