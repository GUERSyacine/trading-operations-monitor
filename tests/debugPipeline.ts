import { prisma } from '../shared/prisma';
import { EvidenceCollector } from '../agent/incident/analysis/EvidenceCollector';
import { TimelineReconstructor } from '../cloud/analysis/TimelineReconstructor';
import { CandidateGenerator } from '../cloud/rules/CandidateGenerator';
import { DockerRule, TelemetryRule, VMRule, NetworkRule, ExchangeRule, LifecycleRule } from '../cloud/rules/CandidateRules';
import { RootCauseScoringEngine } from '../cloud/analysis/RootCauseScoringEngine';
import {
    SupportingEvidenceRule,
    ContradictionRule,
    MissingEvidenceRule,
    ConcurrencyRule,
    CascadeSequenceRule,
    FirstOccurrenceRule,
    LifecycleDurationRule,
    EvaluationHintRule
} from '../cloud/rules/ScoringRules';
import { MVP_CONFIG } from '../shared/mvpConfig';

async function run() {
    try {
        // Find group ID
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
            console.log(`ℹ️ No group ID provided. Using the latest group ID from database: ${groupId}`);
        } else {
            console.log(`ℹ️ Using provided group ID: ${groupId}`);
        }

        // Verify group exists
        const group = await prisma.incidentGroup.findUnique({
            where: { id: groupId }
        });
        if (!group) {
            console.error(`❌ Incident group ${groupId} does not exist in database!`);
            return;
        }

        console.log('\n--- 📂 Incident Group Metadata ---');
        console.log(`ID: ${group.id}`);
        console.log(`Type: ${group.groupType}`);
        console.log(`Correlation Key: ${group.correlationKey}`);
        console.log(`Highest Severity: ${group.highestSeverity}`);
        console.log(`Opened At: ${group.openedAt}`);

        // Step 6: Evidence Collection
        console.log('\n=== 📂 STEP 6: Evidence Collection ===');
        const collector = new EvidenceCollector();
        const evidence = await collector.collectEvidence(groupId);
        console.log(`Collected ${evidence.length} evidence items:`);
        console.table(
            evidence.map(e => ({
                seq: e.sequence,
                source: e.source,
                event: e.event,
                timestamp: e.timestamp
            }))
        );

        if (evidence.length === 0) {
            console.warn('⚠️ No evidence collected. Timeline reconstruction cannot proceed.');
            return;
        }

        // Step 7: Timeline Reconstruction
        console.log('\n=== ⏳ STEP 7: Timeline Reconstruction ===');
        const reconstructor = new TimelineReconstructor();
        const timeline = reconstructor.reconstruct(groupId, evidence);
        console.log(`Reconstructed timeline: startTime=${timeline.startTime}, endTime=${timeline.endTime}, duration=${timeline.durationMs}ms`);
        console.table(
            timeline.events.map(e => ({
                seq: e.sequence,
                source: e.source,
                delta: e.deltaFromPreviousMs,
                concurrent: e.isConcurrent
            }))
        );

        // Step 8: Candidate Generation
        console.log('\n=== 🧠 STEP 8: Candidate Generation ===');
        const rcaConfig = {
            dockerCascadeWindowMs: MVP_CONFIG.RCA.DOCKER_CASCADE_WINDOW_MS,
            telemetryWindowMs: MVP_CONFIG.RCA.TELEMETRY_WINDOW_MS,
            vmExhaustionWindowMs: MVP_CONFIG.RCA.VM_EXHAUSTION_WINDOW_MS,
            networkOutageWindowMs: MVP_CONFIG.RCA.NETWORK_OUTAGE_WINDOW_MS
        };
        const candidateRules = [
            new DockerRule(rcaConfig),
            new TelemetryRule(rcaConfig),
            new VMRule(rcaConfig),
            new NetworkRule(rcaConfig),
            new ExchangeRule(rcaConfig),
            new LifecycleRule(rcaConfig)
        ];
        const generator = new CandidateGenerator(candidateRules);
        const candidates = generator.generateCandidates(timeline);
        console.log(`Generated ${candidates.length} candidates:`);
        console.dir(candidates, { depth: null });

        // Step 9: Scoring
        console.log('\n=== 📊 STEP 9: Scoring ===');
        const scoringRules = [
            new SupportingEvidenceRule(MVP_CONFIG.RCA.SCORING),
            new ContradictionRule(MVP_CONFIG.RCA.SCORING),
            new MissingEvidenceRule(MVP_CONFIG.RCA.SCORING),
            new ConcurrencyRule(MVP_CONFIG.RCA.SCORING),
            new CascadeSequenceRule(MVP_CONFIG.RCA.SCORING),
            new FirstOccurrenceRule(MVP_CONFIG.RCA.SCORING),
            new LifecycleDurationRule(MVP_CONFIG.RCA.SCORING),
            new EvaluationHintRule(MVP_CONFIG.RCA.SCORING)
        ];
        const scorer = new RootCauseScoringEngine(scoringRules, MVP_CONFIG.RCA.SCORING);
        const scored = scorer.scoreCandidates(candidates, timeline);
        console.log(`Scored Candidates (sorted descending by rawScore):`);
        console.dir(scored, { depth: null });

    } catch (e: any) {
        console.error('❌ Error executing pipeline debug:', e.message || e);
    } finally {
        await prisma.$disconnect();
    }
}

run();
