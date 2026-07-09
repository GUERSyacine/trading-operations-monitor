import { Timeline, TimelineEvent } from '../analysis/TimelineReconstructor';
import { IncidentClassifier } from '../analysis/IncidentClassifier';

export type EvaluationHintId =
    | 'DOCKER_FAILED_FIRST'
    | 'FULL_DOCKER_CASCADE'
    | 'API_TIMEOUT_CASCADE'
    | 'HEARTBEAT_CASCADE'
    | 'HEARTBEAT_HEALTHY'
    | 'TELEMETRY_WARNING'
    | 'TELEMETRY_HEALTHY'
    | 'VM_RESOURCE_OVERLOAD'
    | 'VM_RESOURCE_HEALTHY'
    | 'NET_DNS_OUTAGE'
    | 'NETWORK_FAILED'
    | 'NETWORK_HEALTHY'
    | 'DNS_FAILED'
    | 'DNS_HEALTHY'
    | 'EXCHANGE_UNREACHABLE'
    | 'LOCAL_NETWORK_DOWN_CONCURRENCY'
    | 'LOCAL_NETWORK_DNS_HEALTHY'
    | 'STATE_MACHINE_MUTATION';

export interface EvaluationHint {
    id: EvaluationHintId;
    polarity: 'POSITIVE' | 'NEGATIVE';
    description: string;
    evidenceIds: string[];
}

export interface RootCauseCandidate {
    id: string;                     // Unique hypothesis identifier (e.g. 'DOCKER_CONTAINER_EXITED')
    title: string;                  // Human-readable title
    description: string;            // Simple explanation
    triggerSignal: string;          // Triggering component/signal
    hypothesisType: 'INFRASTRUCTURE' | 'OPERATIONS' | 'EXTERNAL' | 'SYSTEM';
    affectedLayer: 'LAYER_A' | 'LAYER_B' | 'LAYER_C' | 'EXTERNAL';
    evidenceIds: string[];          // Union of supporting + contradicting evidence IDs
    supportingEvidence: string[];   // Supporting event IDs
    contradictingEvidence: string[]; // Weakening/contradicting event IDs
    missingEvidence: string[];      // Expected components not observed
    matchedSignals: string[];       // Component state identifiers (e.g. ['DOCKER:DETECTED'])
    matchedRules: string[];         // Rules that generated this candidate
    matchedConditions: string[];    // Combined evaluation conditions
    evaluationHints: EvaluationHint[]; // Combined structured hints
}

export interface CandidateMatch {
    candidateId: string;
    ruleName: string;               // Name of the rule generating the match (e.g. 'DockerRule')
    title: string;
    description: string;
    triggerSignal: string;
    hypothesisType: 'INFRASTRUCTURE' | 'OPERATIONS' | 'EXTERNAL' | 'SYSTEM';
    affectedLayer: 'LAYER_A' | 'LAYER_B' | 'LAYER_C' | 'EXTERNAL';
    supportingEvidence: string[];   // Incident/Audit event IDs
    contradictingEvidence: string[]; // Incident/Audit event IDs
    missingEvidence: string[];      // Expected source components not observed (e.g. ['HEARTBEAT'])
    matchedConditions: string[];    // Plain-English evaluation notes
    evaluationHints: EvaluationHint[]; // Evaluation signals
    matchedSignals: string[];       // Unique signal tags (e.g. ['DOCKER:DETECTED'])
}

export interface CandidateRule {
    name: string;
    evaluate(query: TimelineQuery): CandidateMatch[];
}

export class TimelineQuery {
    constructor(private readonly timeline: Timeline) {}

    public findBySource(source: string): TimelineEvent[] {
        return this.timeline.eventsBySource[source] || [];
    }

    public findByCategory(category: 'INCIDENT' | 'AUDIT' | 'GROUP'): TimelineEvent[] {
        return this.timeline.eventsByCategory[category] || [];
    }

    public findFirstIncident(): TimelineEvent | undefined {
        return this.timeline.firstIncident;
    }

    public findFirstDetected(source: string): TimelineEvent | undefined {
        return this.findBySource(source).find(e => e.event === 'DETECTED');
    }

    public findUnhealthyEvents(sources: string[]): TimelineEvent[] {
        const events: TimelineEvent[] = [];
        for (const src of sources) {
            const srcEvents = this.timeline.eventsBySource[src] || [];
            events.push(...srcEvents);
        }
        return events.filter(e => {
            if (e.event === 'DETECTED') return true;
            if (e.category === 'AUDIT') {
                if (e.message && !e.message.startsWith('Audit:')) return true;
                const meta = e.metadata as any;
                if (meta && (meta.consecutiveFailures > 0 || meta.error || (meta.statusCode && meta.statusCode !== 200) || meta.connected === false || meta.status === 'disconnected')) {
                    return true;
                }
            }
            return false;
        });
    }

    public findFirstUnhealthy(sources: string[]): TimelineEvent | undefined {
        const unhealthy = this.findUnhealthyEvents(sources);
        return unhealthy.length > 0 ? unhealthy.sort((a, b) => a.timestamp - b.timestamp)[0] : undefined;
    }

    public findLatestDetected(source: string): TimelineEvent | undefined {
        const events = this.findBySource(source).filter(e => e.event === 'DETECTED');
        return events.length > 0 ? events[events.length - 1] : undefined;
    }

    public findLatestResolved(source: string): TimelineEvent | undefined {
        const events = this.findBySource(source).filter(e => e.event === 'RESOLVED');
        return events.length > 0 ? events[events.length - 1] : undefined;
    }

    public findLifecycle(source: string): TimelineEvent[] {
        return this.findBySource(source);
    }

    public findDetectedEvents(sources: string[]): TimelineEvent[] {
        return this.timeline.events.filter(e => sources.includes(e.source) && e.event === 'DETECTED');
    }

    public findActiveIncidents(): TimelineEvent[] {
        const lifecycles = Object.values(this.timeline.incidentLifecycles);
        const activeIds = lifecycles.filter(l => !l.isResolved).map(l => l.incidentId);
        return this.timeline.events.filter(e => e.entityId && activeIds.includes(e.entityId));
    }

    public exists(source: string): boolean {
        return this.findBySource(source).some(e => e.event === 'DETECTED');
    }

    public count(source: string): number {
        return this.findBySource(source).filter(e => e.event === 'DETECTED').length;
    }

    public findFirstInfrastructureIncident(): TimelineEvent | undefined {
        return this.findByCategory('INCIDENT').find(e => e.event === 'DETECTED' && IncidentClassifier.isInfrastructure(e.source));
    }

    public findFirstOperationsIncident(): TimelineEvent | undefined {
        return this.findByCategory('INCIDENT').find(e => e.event === 'DETECTED' && !IncidentClassifier.isInfrastructure(e.source));
    }

    public areConcurrent(e1: TimelineEvent, e2: TimelineEvent): boolean {
        return e1.isConcurrent && e2.isConcurrent && this.inSameCluster(e1, e2);
    }

    public inSameCluster(e1: TimelineEvent, e2: TimelineEvent): boolean {
        return this.timeline.concurrencyClusters.some(cluster => 
            cluster.some(e => e.id === e1.id) && cluster.some(e => e.id === e2.id)
        );
    }

    public isBefore(e1: TimelineEvent, e2: TimelineEvent): boolean {
        return e1.timestamp < e2.timestamp;
    }

    public isAfter(e1: TimelineEvent, e2: TimelineEvent): boolean {
        return e1.timestamp > e2.timestamp;
    }

    public areWithinWindow(e1: TimelineEvent, e2: TimelineEvent, windowMs: number): boolean {
        return Math.abs(e1.timestamp - e2.timestamp) <= windowMs;
    }
}

// Candidate Merger
export class CandidateMerger {
    public merge(matches: CandidateMatch[]): RootCauseCandidate[] {
        const merged = new Map<string, RootCauseCandidate>();
        
        for (const m of matches) {
            const existing = merged.get(m.candidateId);
            if (existing) {
                const matchedRules = Array.from(new Set([...existing.matchedRules, m.ruleName]));
                const supportingEvidence = Array.from(new Set([...existing.supportingEvidence, ...m.supportingEvidence]));
                const contradictingEvidence = Array.from(new Set([...existing.contradictingEvidence, ...m.contradictingEvidence]));
                const missingEvidence = Array.from(new Set([...existing.missingEvidence, ...m.missingEvidence]));
                const evidenceIds = Array.from(new Set([...existing.evidenceIds, ...supportingEvidence, ...contradictingEvidence]));
                const matchedSignals = Array.from(new Set([...existing.matchedSignals, ...m.matchedSignals]));
                const matchedConditions = Array.from(new Set([...existing.matchedConditions, ...m.matchedConditions]));

                const existingHintIds = new Set(existing.evaluationHints.map(h => h.id));
                const uniqueNewHints = m.evaluationHints.filter(h => !existingHintIds.has(h.id));
                const evaluationHints = [...existing.evaluationHints, ...uniqueNewHints];
                
                merged.set(m.candidateId, {
                    ...existing,
                    matchedRules,
                    evidenceIds,
                    supportingEvidence,
                    contradictingEvidence,
                    missingEvidence,
                    matchedSignals,
                    matchedConditions,
                    evaluationHints
                });
            } else {
                const evidenceIds = Array.from(new Set([...m.supportingEvidence, ...m.contradictingEvidence]));
                merged.set(m.candidateId, {
                    id: m.candidateId,
                    title: m.title,
                    description: m.description,
                    triggerSignal: m.triggerSignal,
                    hypothesisType: m.hypothesisType,
                    affectedLayer: m.affectedLayer,
                    evidenceIds,
                    supportingEvidence: m.supportingEvidence,
                    contradictingEvidence: m.contradictingEvidence,
                    missingEvidence: m.missingEvidence,
                    matchedSignals: m.matchedSignals,
                    matchedRules: [m.ruleName],
                    matchedConditions: m.matchedConditions,
                    evaluationHints: m.evaluationHints
                });
            }
        }
        return Array.from(merged.values());
    }
}

// Main Pluggable Candidate Generator
export class CandidateGenerator {
    private readonly merger = new CandidateMerger();

    constructor(private readonly rules: CandidateRule[]) {}

    public generateCandidates(timeline: Timeline): RootCauseCandidate[] {
        const query = new TimelineQuery(timeline);
        const matches: CandidateMatch[] = [];

        for (const rule of this.rules) {
            matches.push(...rule.evaluate(query));
        }

        return this.merger.merge(matches);
    }
}
