import { Timeline } from './TimelineReconstructor';
import { RootCauseCandidate, TimelineQuery } from './CandidateGenerator';
import { ScoreRule, ScoreContribution } from './ScoringRules';

export interface ScoreMetadata {
    readonly candidateId: string;
    readonly evaluatedAt: number;
    readonly rulesExecuted: number;
    readonly positiveContributions: number;
    readonly negativeContributions: number;
    readonly executionTimeMs: number;
}

export interface WeightedScoreContribution {
    readonly ruleId: string;
    readonly rawScore: number;
    readonly weightedScore: number;
    readonly polarity: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    readonly reason: string;
    readonly evidenceIds: string[];
}

export interface ScoredCandidate {
    readonly candidate: RootCauseCandidate;
    readonly rawScore: number;
    readonly normalizedScore: number;
    readonly confidence: number; // 0.0 - 1.0
    readonly metadata: ScoreMetadata;
    readonly contributions: WeightedScoreContribution[];
}

export class RootCauseScoringEngine {
    constructor(
        private readonly rules: ScoreRule[],
        private readonly config: {
            baseScore: number;
            maxScore: number;
            ruleWeights: Record<string, number>;
        }
    ) {}

    public scoreCandidates(candidates: RootCauseCandidate[], timeline: Timeline): ScoredCandidate[] {
        const query = new TimelineQuery(timeline);
        const scoredCandidates: ScoredCandidate[] = [];

        for (const candidate of candidates) {
            const startTime = Date.now();
            const rawContributions: ScoreContribution[] = [];

            // 1. Execute rules to collect raw contributions
            for (const rule of this.rules) {
                try {
                    const contributions = rule.evaluate(candidate, timeline, query);
                    rawContributions.push(...contributions);
                } catch (e: any) {
                    console.error(`[ScoringEngine] Rule ${rule.ruleId} failed on candidate ${candidate.id}:`, e.message || e);
                }
            }

            // 2. Apply weights and aggregate scores
            let aggregatedRawScore = this.config.baseScore;
            const weightedContributions: WeightedScoreContribution[] = [];
            let positiveCount = 0;
            let negativeCount = 0;

            for (const contrib of rawContributions) {
                const weight = this.config.ruleWeights[contrib.ruleId] !== undefined
                    ? this.config.ruleWeights[contrib.ruleId]
                    : 1.0;
                
                const weightedScore = contrib.score * weight;
                aggregatedRawScore += weightedScore;

                if (weightedScore > 0) {
                    positiveCount++;
                } else if (weightedScore < 0) {
                    negativeCount++;
                }

                weightedContributions.push({
                    ruleId: contrib.ruleId,
                    rawScore: contrib.score,
                    weightedScore,
                    polarity: contrib.polarity,
                    reason: contrib.reason,
                    evidenceIds: contrib.evidenceIds
                });
            }

            // 3. Normalization & Confidence calculation
            const normalizedScore = Math.max(0, Math.min(this.config.maxScore, aggregatedRawScore));
            const confidence = normalizedScore / this.config.maxScore;
            const endTime = Date.now();
            const executionTimeMs = endTime - startTime;

            scoredCandidates.push({
                candidate,
                rawScore: aggregatedRawScore,
                normalizedScore,
                confidence,
                metadata: {
                    candidateId: candidate.id,
                    evaluatedAt: startTime,
                    rulesExecuted: this.rules.length,
                    positiveContributions: positiveCount,
                    negativeContributions: negativeCount,
                    executionTimeMs
                },
                contributions: weightedContributions
            });
        }

        // 4. Sort descending by rawScore (tie-breaking mechanism)
        return scoredCandidates.sort((a, b) => b.rawScore - a.rawScore);
    }
}
