import { Evidence } from '../agent/incident/analysis/EvidenceCollector';
import { TimelineReconstructor } from '../agent/incident/analysis/TimelineReconstructor';
import { CandidateGenerator } from '../agent/incident/rules/CandidateGenerator';
import { DockerRule } from '../agent/incident/rules/CandidateRules';
import { RootCauseScoringEngine } from '../agent/incident/analysis/RootCauseScoringEngine';
import {
    SupportingEvidenceRule,
    ContradictionRule,
    MissingEvidenceRule,
    ConcurrencyRule,
    CascadeSequenceRule,
    FirstOccurrenceRule,
    LifecycleDurationRule,
    EvaluationHintRule
} from '../agent/incident/rules/ScoringRules';
import { MVP_CONFIG } from '../mvpConfig';

function runPipelineForEvidence(title: string, mockEvidence: Evidence[]) {
    console.log(`\n\n--- 🧪 SIMULATION: ${title} ---`);

    const reconstructor = new TimelineReconstructor();
    const timeline = reconstructor.reconstruct(90, mockEvidence);

    const rcaConfig = {
        dockerCascadeWindowMs: MVP_CONFIG.RCA.DOCKER_CASCADE_WINDOW_MS,
        telemetryWindowMs: MVP_CONFIG.RCA.TELEMETRY_WINDOW_MS,
        vmExhaustionWindowMs: MVP_CONFIG.RCA.VM_EXHAUSTION_WINDOW_MS,
        networkOutageWindowMs: MVP_CONFIG.RCA.NETWORK_OUTAGE_WINDOW_MS
    };

    const generator = new CandidateGenerator([new DockerRule(rcaConfig)]);
    const candidates = generator.generateCandidates(timeline);

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

    console.log('Result Candidate:');
    console.dir(scored[0], { depth: null });
}

async function main() {
    // 1. Partial Cascade (Heartbeat healthy)
    const partialEvidence: Evidence[] = [
        {
            id: 'EVD:INCIDENT_DETECTED:1:1783175317300',
            groupId: 90,
            sequence: 1,
            category: 'INCIDENT',
            source: 'DOCKER',
            event: 'DETECTED',
            timestamp: 1783175317300,
            origin: 'ASSESSMENT',
            entityId: 'INCIDENT:1',
            severity: 'CRITICAL',
            message: 'Container unreachable'
        },
        {
            id: 'EVD:AUDIT:2:1783175317315',
            groupId: 90,
            sequence: 2,
            category: 'AUDIT',
            source: 'FREQTRADE_API',
            event: 'OBSERVED',
            timestamp: 1783175317315,
            origin: 'OBSERVATION',
            entityId: 'AUDIT:2',
            message: 'Freqtrade API unreachable',
            metadata: {
                statusCode: 502,
                consecutiveFailures: 3,
                error: 'Bad Gateway'
            }
        },
        {
            id: 'EVD:AUDIT:3:1783175317320',
            groupId: 90,
            sequence: 3,
            category: 'AUDIT',
            source: 'HEARTBEAT',
            event: 'OBSERVED',
            timestamp: 1783175317320,
            origin: 'OBSERVATION',
            entityId: 'AUDIT:3',
            message: 'Audit: HEARTBEAT',
            metadata: {
                consecutiveFailures: 0
            }
        }
    ];

    runPipelineForEvidence('Docker -> API partial cascade (Heartbeat healthy)', partialEvidence);

    // 2. Full Cascade (Heartbeat failed audit)
    const fullEvidence: Evidence[] = [
        {
            id: 'EVD:INCIDENT_DETECTED:1:1783175317300',
            groupId: 90,
            sequence: 1,
            category: 'INCIDENT',
            source: 'DOCKER',
            event: 'DETECTED',
            timestamp: 1783175317300,
            origin: 'ASSESSMENT',
            entityId: 'INCIDENT:1',
            severity: 'CRITICAL',
            message: 'Container unreachable'
        },
        {
            id: 'EVD:AUDIT:2:1783175317315',
            groupId: 90,
            sequence: 2,
            category: 'AUDIT',
            source: 'FREQTRADE_API',
            event: 'OBSERVED',
            timestamp: 1783175317315,
            origin: 'OBSERVATION',
            entityId: 'AUDIT:2',
            message: 'Freqtrade API unreachable',
            metadata: {
                statusCode: 502,
                consecutiveFailures: 3,
                error: 'Bad Gateway'
            }
        },
        {
            id: 'EVD:AUDIT:3:1783175317330',
            groupId: 90,
            sequence: 3,
            category: 'AUDIT',
            source: 'HEARTBEAT',
            event: 'OBSERVED',
            timestamp: 1783175317330,
            origin: 'OBSERVATION',
            entityId: 'AUDIT:3',
            message: 'Heartbeat down (3 consecutive failures)',
            metadata: {
                consecutiveFailures: 3
            }
        }
    ];

    runPipelineForEvidence('Docker -> API -> Heartbeat full cascade (Heartbeat failed audit)', fullEvidence);
}

main().catch(console.error);
