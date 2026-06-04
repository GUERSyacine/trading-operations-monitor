/**
 * Live vs Backtest Divergence Service (Step 13)
 * 
 * Responsibility: Detect structural drift.
 * Philosophy: PnL is lagging. Distribution shift is leading.
 * 
 * Logic:
 * - Fetch live metrics (rolling)
 * - Fetch frozen baselines
 * - Compute Z-scores
 * - Compute Composite Divergence Index (CDI)
 */

import { supabase } from '../supabase';

export interface DivergenceState {
    cdi: number;
    actions: {
        level: 'NORMAL' | 'WARNING' | 'CRITICAL';
        sizeMultiplier: number; // 0.25 to 1.0
        haltStrategy: boolean;
    };
    zScores: Record<string, number>;
}

export class LiveBacktestDivergenceService {

    /**
     * Compute current divergence state
     * Typically run periodically (e.g. daily or per-trade batch)
     */
    async computeDivergenceState(): Promise<DivergenceState> {
        // Fetch Baselines
        const { data: baselines } = await supabase.from('strategy_baselines').select('*');
        if (!baselines || baselines.length === 0) {
            // No baselines = New deployment assumption. Return Normal.
            return this.createState(0, {}, 'NORMAL');
        }

        // Fetch latest live metrics (simplified: just get most recent row per metric)
        // In real system, we'd query rolling views. Here we just fetch last 100 rows and aggregate locally or fetch pre-calc.
        // For canonical implementation, let's assume 'live_metrics' contains PRE-CALCULATED rolling values inserted by another job.
        // We just grab the latest '1w' or '50_trades' window value for each metric.
        const { data: liveData } = await supabase.from('live_metrics').select('*').order('recorded_at', { ascending: false }).limit(50);

        const zScores: Record<string, number> = {};

        for (const base of baselines) {
            const liveMetric = liveData?.find((m: any) => m.metric === base.metric);
            if (liveMetric) {
                const z = (liveMetric.value - base.mean) / base.std;
                zScores[base.metric] = z;
            } else {
                zScores[base.metric] = 0; // No data yet
            }
        }

        // Compute CDI
        // Weights: Signal(0.35), Execution(0.25), Regime(0.20), Correlation(0.20)
        // Mapping metrics to categories:
        // 'win_rate' -> Signal
        // 'avg_slippage_bps' -> Execution
        // ... (assume standard names)

        // Simplified Logic: Weighted average of all available Z-scores
        // Real implementation would group them strictly.
        // Let's assume keys map implicitly.

        let weightedSum = 0;
        let totalWeight = 0;

        const weights: Record<string, number> = {
            'win_rate': 0.35,
            'avg_slippage_bps': 0.25,
            'regime_count': 0.20,
            'avg_correlation': 0.20
        };

        for (const metric in weights) {
            if (zScores[metric] !== undefined) {
                weightedSum += Math.abs(zScores[metric]) * weights[metric];
                totalWeight += weights[metric];
            }
        }

        const cdi = totalWeight > 0 ? weightedSum / totalWeight : 0;

        // Determine Action
        let level: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';
        if (cdi >= 2.0) level = 'CRITICAL';
        else if (cdi >= 1.5) level = 'WARNING'; // 1.5 - 2.0

        return this.createState(cdi, zScores, level);
    }

    private createState(cdi: number, zScores: Record<string, number>, level: 'NORMAL' | 'WARNING' | 'CRITICAL'): DivergenceState {
        let sizeMultiplier = 1.0;
        let haltStrategy = false;

        if (level === 'WARNING') {
            sizeMultiplier = 0.5; // "Reduce size 50%" - prompt says 1.5-2.0 -> 50%, 1.0-1.5 -> 25% trim?
            // Prompt: 1.0-1.5 -> Reduce 25% (Mult 0.75)
            // 1.5-2.0 -> Reduce 50% (Mult 0.50)
            // > 2.0 -> Halt
        } else if (level === 'CRITICAL') {
            haltStrategy = true;
            sizeMultiplier = 0.0;
        } else {
            // Check lower band 1.0 - 1.5
            if (cdi >= 1.0 && cdi < 1.5) {
                sizeMultiplier = 0.75;
            }
        }

        return {
            cdi,
            zScores,
            actions: {
                level,
                sizeMultiplier,
                haltStrategy
            }
        };
    }
}
