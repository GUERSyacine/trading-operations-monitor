/**
 * Bandit Allocation Service (Step 24)
 * 
 * Responsibility: Adaptive Capital Sizing via Contextual UCB.
 * Principle: "Learn edge safely, locally."
 */

import { supabase } from '../supabase';
import * as crypto from 'crypto';
import { MVP_CONFIG, SystemState } from '../mvpConfig';

export interface BanditContext {
    cluster: string;         // 'major' | 'alt'
    regime: string;          // 'trend' | 'range' | 'chaos'
    volatilityBucket: string;// 'low' | 'mid' | 'high'
    correlationState: string;// 'low' | 'high'
}

export type BanditArm = 0.5 | 0.75 | 1.0 | 1.25;
const AVAILABLE_ARMS: BanditArm[] = [0.5, 0.75, 1.0, 1.25];

export class BanditAllocationService {

    /**
     * Select Capital Multiplier (Action)
     */
    async selectArm(ctx: BanditContext): Promise<BanditArm> {
        const hash = this.computeContextHash(ctx);

        const { data: arms } = await supabase
            .from('bandit_state')
            .select('*')
            .eq('context_hash', hash);

        // If cold start (no data), explore conservatively or default to 1.0?
        // Let's default to 1.0 if effectively no info, or explore if low risk?
        // Safe Default: 1.0
        if (!arms || arms.length === 0) return 1.0;

        // Calculate UCB for each arm
        let bestArm: BanditArm = 1.0;
        let maxUCB = -Infinity;

        const totalPulls = arms.reduce((sum, a) => sum + a.pulls, 0);
        // Avoid log(0)
        const logT = totalPulls > 0 ? Math.log(totalPulls) : 0;

        for (const armDef of AVAILABLE_ARMS) {
            const state = arms.find(a => Math.abs(a.arm - armDef) < 0.01);

            if (!state || state.pulls === 0) {
                // Unexplored arm -> Prioritize exploring

                // If LIVE, we return the exploration arm.
                // If SHADOW, we record that we WOULD have explored.
                if (MVP_CONFIG.STRATEGY.BANDIT_ALLOCATION === SystemState.LIVE) {
                    return armDef;
                } else {
                    bestArm = armDef;
                    maxUCB = Infinity;
                    // Continue to find if there's another unexplored arm? Or break?
                    // Standard UCB breaks on first unexplored usually.
                }
            } else {
                const mean = Number(state.mean_reward);
                const pulls = Number(state.pulls);

                // UCB = Mean + C * sqrt(ln(T) / N)
                // C = 1.0 usually. 
                const ucb = mean + 1.0 * Math.sqrt((2 * logT) / pulls);

                if (ucb > maxUCB) {
                    maxUCB = ucb;
                    bestArm = armDef;
                }
            }
        }

        // --- MVP FREEZE ENFORCEMENT ---
        if (MVP_CONFIG.STRATEGY.BANDIT_ALLOCATION !== SystemState.LIVE) {
            if (Math.abs(bestArm - 1.0) > 0.01) {
                console.log(`[MVP_SHADOW] Bandit would have selected arm ${bestArm} for hash ${hash.substring(0, 8)}. Forcing 1.0.`);
            }
            return 1.0;
        }

        return bestArm;
    }

    /**
     * Update Bandit State (Reward)
     * Call this when trade closes.
     */
    async updateReward(ctx: BanditContext, arm: number, pnl: number, risk: number): Promise<void> {

        // MVP FREEZE ENFORCEMENT
        if (MVP_CONFIG.STRATEGY.BANDIT_ALLOCATION !== SystemState.LIVE) {
            // In shadow mode, we refrain from polluting the bandits with forced-neutral data if we can avoid it.
            // Or we could log it.
            return;
        }

        const hash = this.computeContextHash(ctx);
        const reward = Math.max(-1, Math.min(1, pnl / (risk || 1))); // Clamp [-1, 1]

        // 1. Fetch current state
        const { data: state } = await supabase
            .from('bandit_state')
            .select('*')
            .eq('context_hash', hash)
            .gte('arm', arm - 0.01)
            .lte('arm', arm + 0.01)
            .single();

        let oldPulls = 0;
        let oldMean = 0;

        if (state) {
            oldPulls = state.pulls;
            oldMean = state.mean_reward;
        }

        const newPulls = oldPulls + 1;
        const newMean = oldMean + (reward - oldMean) / newPulls; // Incremental mean

        // 2. Upsert
        await supabase.from('bandit_state').upsert({
            context_hash: hash,
            arm: arm,
            pulls: newPulls,
            mean_reward: newMean,
            last_updated: new Date().toISOString()
        });
    }

    private computeContextHash(ctx: BanditContext): string {
        const str = `${ctx.cluster}|${ctx.regime}|${ctx.volatilityBucket}|${ctx.correlationState}`;
        return crypto.createHash('sha256').update(str).digest('hex');
    }
}
