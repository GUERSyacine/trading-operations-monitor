/**
 * Regime Fitness Service (Pre-TG5)
 * 
 * Responsibility: Compute Regime-Conditional Eligibility Multipliers.
 * Principle: Strategy fitness is a context input, not an authoritative permission.
 * 
 * Logic:
 * Fitness Multiplier = Base Fitness * Confidence * Volatility
 */

import { supabase } from '../supabase';
import { BehaviorClass } from '../signals/shared/types';

type Regime = 'trend' | 'range' | 'breakout' | 'chaos';

// Static Fitness Matrix (Step 19.2)
const REGIME_FITNESS: Record<string, Record<Regime, number>> = {
    // Strategy Hashes or Names (Using descriptive keys for now, mapped later)
    'TREND_LTF': { trend: 1.0, range: 0.3, breakout: 0.7, chaos: 0.0 },
    'BREAKOUT_HTF': { trend: 0.6, range: 0.2, breakout: 1.0, chaos: 0.4 },
    'MEAN_REVERT': { trend: 0.2, range: 1.0, breakout: 0.1, chaos: 0.3 },
    // Default fallback
    'DEFAULT': { trend: 0.8, range: 0.8, breakout: 0.8, chaos: 0.2 }
};

export class RegimeFitnessService {

    /**
     * Compute Dynamic Weight for a Strategy
     */
    computeRegimeWeight(
        strategyName: string,
        baseWeight: number,
        htfState: {
            confidence: number;
            dominance_ratio: number;
            dominant_regime: BehaviorClass | 'neutral';
        },
        atrFactor: number // Normalized [0, 1] (Low vol -> 0, High -> 1)
    ): number {
        // 1. Resolve Regime
        const regime = this.resolveRegime(htfState);

        // 2. Regime Fitness
        // Lookup by name or default
        const fitnessMap = REGIME_FITNESS[strategyName] ?? REGIME_FITNESS['DEFAULT'];
        const fitness = fitnessMap[regime];

        // 3. Confidence Gate (Soft)
        const confidenceMult = this.confidenceMultiplier(htfState.confidence);

        // 4. Volatility Guardrail
        const volMult = this.volatilityMultiplier(atrFactor);

        // 5. Final Calculation
        return baseWeight * fitness * confidenceMult * volMult;
    }

    private resolveRegime(state: { dominance_ratio: number; dominant_regime: string }): Regime {
        if (state.dominance_ratio < 1.2) return 'chaos';

        // Map BehaviorClass to Regime
        switch (state.dominant_regime) {
            case 'trend': return 'trend';
            case 'reversion': return 'range';
            case 'breakout': return 'breakout';
            default: return 'chaos'; // Neutral/Unknown
        }
    }

    private confidenceMultiplier(conf: number): number {
        if (conf < 0.4) return 0.0;
        if (conf < 0.6) return 0.5;
        if (conf < 0.8) return 0.8;
        return 1.0;
    }

    private volatilityMultiplier(atrFactor: number): number {
        // High atrFactor (1.0) -> Reduce weight. 
        // Formula: 1 - 0.5 * factor
        // If Max Vol (1.0) -> 0.5 capital.
        // If Low Vol (0.0) -> 1.0 capital.
        return 1.0 - (0.5 * Math.min(1.0, Math.max(0, atrFactor)));
    }
}
