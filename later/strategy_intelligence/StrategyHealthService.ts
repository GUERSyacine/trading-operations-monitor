import { prisma } from '../prisma';

export type StrategyState = 'ACTIVE' | 'COOLING' | 'PROBATION' | 'DEAD';

export class StrategyHealthService {

    /**
     * Update Strategy Health based on recent trade outcome
     */
    async onTradeClosed(strategyId: string, pnl: number): Promise<void> {
        // Fetch current state
        let stateData;
        try {
            stateData = await prisma.strategyState.findUnique({
                where: { strategyId }
            });
        } catch (error: any) {
            console.error(`[StrategyHealth] Failed to load strategy state for ${strategyId}:`, error?.message || error);
            return;
        }

        if (!stateData) {
            // First time init
            await this.initState(strategyId);
            return;
        }

        let { state, lossStreak: loss_streak, cooldownUntil: cooldown_until, probationUntil: probation_until } = stateData;
        const now = new Date();

        // 1. Update Streak
        if (pnl < 0) {
            loss_streak += 1;
        } else {
            loss_streak = 0;
        }

        // 2. State Machine Transitions
        if (state === 'ACTIVE') {
            // Check for Cooldown Triggers
            if (loss_streak >= 3) {
                console.log(`[StrategyHealth] ${strategyId} entering COOLING (Loss streak 3).`);
                state = 'COOLING';
                cooldown_until = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 24h
            }
        } else if (state === 'COOLING') {
            // Check if Cooldown Over
            if (cooldown_until && new Date(cooldown_until) <= now) {
                console.log(`[StrategyHealth] ${strategyId} entering PROBATION (Cooldown done).`);
                state = 'PROBATION';
                probation_until = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(); // 48h Probation
            }
        } else if (state === 'PROBATION') {
            // Exit Probation if stable (simplified logic for now)
            if (probation_until && new Date(probation_until) <= now) {
                if (loss_streak === 0) {
                    console.log(`[StrategyHealth] ${strategyId} returning to ACTIVE (Probation passed).`);
                    state = 'ACTIVE';
                    cooldown_until = null;
                    probation_until = null;
                } else {
                    // Extend probation if still losing
                    console.log(`[StrategyHealth] ${strategyId} extending PROBATION (Still losing).`);
                    probation_until = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
                }
            }
        }

        // 3. Persist
        try {
            await prisma.strategyState.upsert({
                where: { strategyId },
                update: {
                    state,
                    lossStreak: loss_streak,
                    cooldownUntil: cooldown_until,
                    probationUntil: probation_until
                },
                create: {
                    strategyId,
                    state,
                    lossStreak: loss_streak,
                    cooldownUntil: cooldown_until,
                    probationUntil: probation_until
                }
            });
        } catch (error: any) {
            console.error(`[StrategyHealth] Failed to persist state for ${strategyId}:`, error?.message || error);
        }
    }

    /**
     * Force a Strategy into a specific Risk State (used by Runtime Monitor)
     */
    async forceState(strategyId: string, newState: StrategyState, reason: string): Promise<void> {
        console.log(`[StrategyHealth] Forcing ${strategyId} to ${newState}: ${reason}`);
        const now = new Date();
        let cooldownUntil: string | null = null;
        let probationUntil: string | null = null;

        if (newState === 'COOLING') {
            cooldownUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        } else if (newState === 'PROBATION') {
            probationUntil = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
        }

        try {
            await prisma.strategyState.upsert({
                where: { strategyId },
                update: {
                    state: newState,
                    cooldownUntil,
                    probationUntil,
                    lastUpdated: now
                },
                create: {
                    strategyId,
                    state: newState,
                    cooldownUntil,
                    probationUntil
                }
            });
        } catch (error: any) {
            console.error(`[StrategyHealth] Failed to force state for ${strategyId}:`, error?.message || error);
        }
    }

    private async initState(strategyId: string) {
        try {
            await prisma.strategyState.create({
                data: {
                    strategyId,
                    state: 'ACTIVE'
                }
            });
        } catch (error: any) {
            console.error(`[StrategyHealth] Failed to initialize state for ${strategyId}:`, error?.message || error);
        }
    }
}
