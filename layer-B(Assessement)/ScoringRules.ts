import { Timeline, TimelineEvent } from './TimelineReconstructor';
import { RootCauseCandidate, TimelineQuery } from './CandidateGenerator';

export interface ScoreContribution {
    readonly ruleId: string;
    readonly score: number;                 // Raw, unweighted score contribution
    readonly polarity: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    readonly reason: string;
    readonly evidenceIds: string[];
}

export interface ScoreRule {
    readonly ruleId: string;
    evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[];
}

// 1. Supporting Evidence Rule
export class SupportingEvidenceRule implements ScoreRule {
    public readonly ruleId = 'SCR_SUPPORTING';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const count = candidate.supportingEvidence.length;
        if (count === 0) return [];
        const score = count * this.config.supportingEvidenceWeight;
        return [{
            ruleId: this.ruleId,
            score,
            polarity: 'POSITIVE',
            reason: `Found ${count} supporting evidence event(s)`,
            evidenceIds: [...candidate.supportingEvidence]
        }];
    }
}

// 2. Contradiction Rule
export class ContradictionRule implements ScoreRule {
    public readonly ruleId = 'SCR_CONTRADICTION';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const count = candidate.contradictingEvidence.length;
        if (count === 0) return [];
        const score = -count * this.config.contradictionPenalty;
        return [{
            ruleId: this.ruleId,
            score,
            polarity: 'NEGATIVE',
            reason: `Found ${count} contradicting evidence event(s)`,
            evidenceIds: [...candidate.contradictingEvidence]
        }];
    }
}

// 3. Missing Evidence Rule
export class MissingEvidenceRule implements ScoreRule {
    public readonly ruleId = 'SCR_MISSING';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const count = candidate.missingEvidence.length;
        if (count === 0) return [];
        const score = -count * this.config.missingPenalty;
        return [{
            ruleId: this.ruleId,
            score,
            polarity: 'NEGATIVE',
            reason: `Expected but missing evidence components: ${candidate.missingEvidence.join(', ')}`,
            evidenceIds: []
        }];
    }
}

// 4. Concurrency Rule
export class ConcurrencyRule implements ScoreRule {
    public readonly ruleId = 'SCR_CONCURRENCY';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const supportEvents = timeline.events.filter(e => candidate.supportingEvidence.includes(e.id));
        if (supportEvents.length < 2) return [];

        const hasConcurrency = supportEvents.some((e1, i) =>
            supportEvents.some((e2, j) => i !== j && (query.inSameCluster(e1, e2) || query.areWithinWindow(e1, e2, 120_000)))
        );

        if (hasConcurrency) {
            return [{
                ruleId: this.ruleId,
                score: this.config.concurrencyBonus,
                polarity: 'POSITIVE',
                reason: 'Supporting evidence occurred concurrently',
                evidenceIds: supportEvents.map(e => e.id)
            }];
        }
        return [];
    }
}

// 5. Cascade Sequence Rule (Docker specific)
export class CascadeSequenceRule implements ScoreRule {
    public readonly ruleId = 'SCR_CASCADE_SEQUENCE';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        if (candidate.id !== 'DOCKER_CONTAINER_EXITED') return [];

        const de = query.findFirstDetected('DOCKER');
        const apiEvents = query.findBySource('FREQTRADE_API').filter(e => e.event === 'DETECTED');
        const hbEvents = query.findBySource('HEARTBEAT').filter(e => e.event === 'DETECTED');

        if (de && apiEvents.length > 0) {
            const api = apiEvents[0];
            const hasApiCascade = query.isBefore(de, api) && query.areWithinWindow(de, api, 120_000);
            if (hasApiCascade) {
                if (hbEvents.length > 0) {
                    const hb = hbEvents[0];
                    const hasFullCascade = query.isBefore(api, hb) && query.areWithinWindow(api, hb, 120_000);
                    if (hasFullCascade) {
                        return [{
                            ruleId: this.ruleId,
                            score: this.config.temporalBonus,
                            polarity: 'POSITIVE',
                            reason: 'Docker -> API -> Heartbeat cascade order matched',
                            evidenceIds: [de.id, api.id, hb.id]
                        }];
                    }
                }
            }
        }

        return [{
            ruleId: this.ruleId,
            score: -this.config.temporalBonus,
            polarity: 'NEGATIVE',
            reason: 'Docker to API/Heartbeat cascade sequence was broken or out-of-order',
            evidenceIds: []
        }];
    }
}

// 6. First Occurrence Rule (Generic)
export class FirstOccurrenceRule implements ScoreRule {
    public readonly ruleId = 'SCR_FIRST_OCCURRENCE';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const trigger = candidate.triggerSignal;
        const firstTriggerEv = query.findFirstDetected(trigger);
        if (!firstTriggerEv) return [];

        const firstGlobalIncident = query.findFirstIncident();
        if (firstGlobalIncident && firstGlobalIncident.id === firstTriggerEv.id) {
            return [{
                ruleId: this.ruleId,
                score: this.config.temporalBonus,
                polarity: 'POSITIVE',
                reason: `Trigger signal ${trigger} was the absolute first incident detected in the group`,
                evidenceIds: [firstTriggerEv.id]
            }];
        } else {
            return [{
                ruleId: this.ruleId,
                score: -this.config.temporalBonus,
                polarity: 'NEGATIVE',
                reason: `Trigger signal ${trigger} was NOT the first incident detected in the group`,
                evidenceIds: [firstTriggerEv.id]
            }];
        }
    }
}

// 7. Lifecycle Duration Rule
export class LifecycleDurationRule implements ScoreRule {
    public readonly ruleId = 'SCR_LIFECYCLE_DURATION';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const trigger = candidate.triggerSignal;
        const lifecycles = timeline.incidentLifecycles;

        const matches = Object.values(lifecycles).filter((l: any) => {
            const ev = timeline.events.find(e => e.id === l.incidentId);
            return ev && ev.source === trigger;
        });

        if (matches.length === 0) return [];

        const hasPersistentIncident = matches.some((l: any) => {
            if (!l.isResolved) return true;
            const resolvedEv = timeline.events.find(e => e.entityId === l.incidentId && e.event === 'RESOLVED');
            const detectedEv = timeline.events.find(e => e.id === l.incidentId && e.event === 'DETECTED');
            if (detectedEv && resolvedEv) {
                return (resolvedEv.timestamp - detectedEv.timestamp) >= 5000;
            }
            return false;
        });

        const isTransientIncident = matches.every((l: any) => {
            if (!l.isResolved) return false;
            const resolvedEv = timeline.events.find(e => e.entityId === l.incidentId && e.event === 'RESOLVED');
            const detectedEv = timeline.events.find(e => e.id === l.incidentId && e.event === 'DETECTED');
            if (detectedEv && resolvedEv) {
                return (resolvedEv.timestamp - detectedEv.timestamp) < 1000;
            }
            return false;
        });

        if (hasPersistentIncident) {
            return [{
                ruleId: this.ruleId,
                score: this.config.durationBonus,
                polarity: 'POSITIVE',
                reason: `Trigger source ${trigger} incident was persistent (>= 5000ms or unresolved)`,
                evidenceIds: matches.map((l: any) => l.incidentId)
            }];
        } else if (isTransientIncident) {
            return [{
                ruleId: this.ruleId,
                score: -this.config.durationBonus,
                polarity: 'NEGATIVE',
                reason: `Trigger source ${trigger} incident was highly transient (< 1000ms)`,
                evidenceIds: matches.map((l: any) => l.incidentId)
            }];
        }

        return [];
    }
}

// 8. Evaluation Hint Rule
export class EvaluationHintRule implements ScoreRule {
    public readonly ruleId = 'SCR_EVALUATION_HINT';

    constructor(private readonly config: any) {}

    public evaluate(candidate: RootCauseCandidate, timeline: Timeline, query: TimelineQuery): ScoreContribution[] {
        const contributions: ScoreContribution[] = [];
        for (const hint of candidate.evaluationHints) {
            if (hint.polarity === 'POSITIVE') {
                contributions.push({
                    ruleId: this.ruleId,
                    score: this.config.hintBonus,
                    polarity: 'POSITIVE',
                    reason: `Positive hint: ${hint.description}`,
                    evidenceIds: [...hint.evidenceIds]
                });
            } else if (hint.polarity === 'NEGATIVE') {
                contributions.push({
                    ruleId: this.ruleId,
                    score: -this.config.hintPenalty,
                    polarity: 'NEGATIVE',
                    reason: `Negative hint: ${hint.description}`,
                    evidenceIds: [...hint.evidenceIds]
                });
            }
        }
        return contributions;
    }
}
