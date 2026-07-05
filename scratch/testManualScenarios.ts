import { TimelineQuery, RootCauseCandidate } from '../layer-B(Assessement)/CandidateGenerator';
import { Timeline } from '../layer-B(Assessement)/TimelineReconstructor';
import {
    SupportingEvidenceRule,
    ContradictionRule,
    CascadeSequenceRule,
    FirstOccurrenceRule,
    EvaluationHintRule
} from '../layer-B(Assessement)/ScoringRules';
import { RootCauseScoringEngine } from '../layer-B(Assessement)/RootCauseScoringEngine';
import { MVP_CONFIG } from '../mvpConfig';
import { VMRule } from '../layer-B(Assessement)/CandidateRules';

async function run() {
    console.log('🧪 Running Manual Scenarios Verification...\n');

    const scoringRules = [
        new SupportingEvidenceRule(MVP_CONFIG.RCA.SCORING),
        new ContradictionRule(MVP_CONFIG.RCA.SCORING),
        new CascadeSequenceRule(MVP_CONFIG.RCA.SCORING),
        new FirstOccurrenceRule(MVP_CONFIG.RCA.SCORING),
        new EvaluationHintRule(MVP_CONFIG.RCA.SCORING)
    ];
    const scoringEngine = new RootCauseScoringEngine(scoringRules, MVP_CONFIG.RCA.SCORING);

    // =========================================================================
    // SCENARIO 1: Partial Docker Cascade (Docker -> API, with multiple audits)
    // =========================================================================
    console.log('--- SCENARIO 1: Partial Docker Cascade (Docker -> API, with multiple API audits) ---');
    
    // Timeline containing:
    // 1. Docker failure incident (INCIDENT)
    // 2. Freqtrade incident (INCIDENT)
    // 3. Freqtrade API failed audit #1 (AUDIT)
    // 4. Freqtrade API failed audit #2 (AUDIT)
    // 5. Freqtrade API failed audit #3 (AUDIT)
    const timeline1: any = {
        events: [
            { id: 'ev-doc', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
            { id: 'ev-api-inc', source: 'FREQTRADE', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000005000 },
            { id: 'ev-audit-1', source: 'FREQTRADE_API', event: 'OBSERVED', category: 'AUDIT', timestamp: 1710000010000 },
            { id: 'ev-audit-2', source: 'FREQTRADE_API', event: 'OBSERVED', category: 'AUDIT', timestamp: 1710000020000 },
            { id: 'ev-audit-3', source: 'FREQTRADE_API', event: 'OBSERVED', category: 'AUDIT', timestamp: 1710000030000 }
        ]
    };
    timeline1.eventsBySource = {
        'DOCKER': [timeline1.events[0]],
        'FREQTRADE': [timeline1.events[1]],
        'FREQTRADE_API': [timeline1.events[2], timeline1.events[3], timeline1.events[4]]
    };
    timeline1.eventsByCategory = {
        'INCIDENT': [timeline1.events[0], timeline1.events[1]],
        'AUDIT': [timeline1.events[2], timeline1.events[3], timeline1.events[4]]
    };
    timeline1.concurrencyClusters = [timeline1.events];
    timeline1.incidentLifecycles = {
        'lifecycle-doc': { incidentId: 'ev-doc', isResolved: false },
        'lifecycle-api': { incidentId: 'ev-api-inc', isResolved: false }
    };
    timeline1.firstIncident = timeline1.events[0];

    const candidate1: RootCauseCandidate = {
        id: 'DOCKER_CONTAINER_EXITED',
        title: 'Docker Container Exited',
        description: 'The Freqtrade docker container crashed, cascading to API timeouts.',
        triggerSignal: 'DOCKER',
        hypothesisType: 'INFRASTRUCTURE',
        affectedLayer: 'LAYER_A',
        evidenceIds: ['ev-doc', 'ev-api-inc', 'ev-audit-1', 'ev-audit-2', 'ev-audit-3'],
        supportingEvidence: ['ev-doc', 'ev-api-inc', 'ev-audit-1', 'ev-audit-2', 'ev-audit-3'],
        contradictingEvidence: [],
        missingEvidence: ['HEARTBEAT'],
        matchedSignals: ['DOCKER', 'FREQTRADE_API'],
        matchedRules: ['DockerRule'],
        matchedConditions: ['Docker failure incident detected', 'Docker to Freqtrade API cascade sequence matched'],
        evaluationHints: []
    };

    const scored1 = scoringEngine.scoreCandidates([candidate1], timeline1);
    console.log('Result for Candidate:');
    console.dir(scored1[0], { depth: null });
    console.log('\n');

    // =========================================================================
    // SCENARIO 2: Out-of-Order Cascade (Heartbeat fails first, then Docker fails)
    // =========================================================================
    console.log('--- SCENARIO 2: Out-of-Order Cascade (Heartbeat -> Docker) ---');

    // Timeline containing:
    // 1. Heartbeat incident fails (INCIDENT)
    // 2. Docker failure incident (INCIDENT)
    const timeline2: any = {
        events: [
            { id: 'ev-hb', source: 'HEARTBEAT', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000000000 },
            { id: 'ev-doc-2', source: 'DOCKER', event: 'DETECTED', category: 'INCIDENT', timestamp: 1710000010000 }
        ]
    };
    timeline2.eventsBySource = {
        'HEARTBEAT': [timeline2.events[0]],
        'DOCKER': [timeline2.events[1]]
    };
    timeline2.eventsByCategory = {
        'INCIDENT': [timeline2.events[0], timeline2.events[1]]
    };
    timeline2.concurrencyClusters = [timeline2.events];
    timeline2.incidentLifecycles = {
        'lifecycle-hb': { incidentId: 'ev-hb', isResolved: false },
        'lifecycle-doc-2': { incidentId: 'ev-doc-2', isResolved: false }
    };
    timeline2.firstIncident = timeline2.events[0];

    const candidate2: RootCauseCandidate = {
        id: 'DOCKER_CONTAINER_EXITED',
        title: 'Docker Container Exited',
        description: 'The Freqtrade docker container crashed, cascading to API timeouts.',
        triggerSignal: 'DOCKER',
        hypothesisType: 'INFRASTRUCTURE',
        affectedLayer: 'LAYER_A',
        evidenceIds: ['ev-hb', 'ev-doc-2'],
        supportingEvidence: ['ev-doc-2'],
        contradictingEvidence: [],
        missingEvidence: [],
        matchedSignals: ['DOCKER'],
        matchedRules: ['DockerRule'],
        matchedConditions: ['Docker failure incident detected'],
        evaluationHints: []
    };

    const scored2 = scoringEngine.scoreCandidates([candidate2], timeline2);
    console.log('Result for Candidate:');
    console.dir(scored2[0], { depth: null });

    // =========================================================================
    // SCENARIO 3: VM Resource Exhaustion (CPU & MEMORY high, DISK healthy)
    // =========================================================================
    console.log('\n--- SCENARIO 3: VM Resource Exhaustion (CPU & MEMORY high, DISK healthy) ---');
    const timeline3: any = {
        events: [
            { 
                id: 'ev-vm-1', 
                source: 'VM_HEALTH', 
                event: 'OBSERVED', 
                category: 'AUDIT', 
                message: 'CPU usage 98% > 80%, Memory usage 85% > 80%',
                timestamp: 1710000000000,
                metadata: {
                    cpuPct: 98,
                    memoryPct: 85,
                    diskPct: 20
                }
            },
            { 
                id: 'ev-vm-2', 
                source: 'VM_HEALTH', 
                event: 'OBSERVED', 
                category: 'AUDIT', 
                message: 'CPU usage 98% > 80%, Memory usage 85% > 80%',
                timestamp: 1710000000500,
                metadata: {
                    cpuPct: 98,
                    memoryPct: 85,
                    diskPct: 20
                }
            }
        ]
    };
    timeline3.eventsBySource = {
        'VM_HEALTH': [timeline3.events[0], timeline3.events[1]]
    };
    timeline3.eventsByCategory = {
        'AUDIT': [timeline3.events[0], timeline3.events[1]]
    };
    timeline3.concurrencyClusters = [timeline3.events];
    timeline3.incidentLifecycles = {};
    timeline3.firstIncident = timeline3.events[0];

    const vmRule = new VMRule({
        dockerCascadeWindowMs: 120_000,
        telemetryWindowMs: 120_000,
        vmExhaustionWindowMs: 120_000,
        networkOutageWindowMs: 60_000
    });

    const query3 = new TimelineQuery(timeline3);
    const matches3 = vmRule.evaluate(query3);

    const candidate3: RootCauseCandidate = {
        id: matches3[0].candidateId,
        title: matches3[0].title,
        description: matches3[0].description,
        triggerSignal: matches3[0].triggerSignal,
        hypothesisType: matches3[0].hypothesisType,
        affectedLayer: matches3[0].affectedLayer,
        evidenceIds: matches3[0].supportingEvidence,
        supportingEvidence: matches3[0].supportingEvidence,
        contradictingEvidence: matches3[0].contradictingEvidence,
        missingEvidence: matches3[0].missingEvidence,
        matchedSignals: matches3[0].matchedSignals,
        matchedRules: [matches3[0].ruleName],
        matchedConditions: matches3[0].matchedConditions,
        evaluationHints: matches3[0].evaluationHints
    };

    const scored3 = scoringEngine.scoreCandidates([candidate3], timeline3);
    console.log('Result for Candidate:');
    console.dir(scored3[0], { depth: null });
}

run().catch(console.error);
