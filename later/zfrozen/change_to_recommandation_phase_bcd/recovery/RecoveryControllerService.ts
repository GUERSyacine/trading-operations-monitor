import { prisma } from '../prisma';
import { StrategyState } from './StrategyHealthService';
import { MVP_CONFIG, SystemState } from '../mvpConfig';

export class RecoveryControllerService {

    /**
     * Apply Recovery Constraints to Capital Weight
     */
    async applyRecoveryConstraints(
        strategyId: string,
        proposedWeight: number
    ): Promise<number> {

        let state: StrategyState = 'ACTIVE';
        try {
            const data = await prisma.strategyState.findUnique({
                where: { strategyId }
            });
            if (data) {
                state = data.state as StrategyState;
            }
        } catch (error: any) {
            console.warn(`[RecoveryController] Failed to fetch strategy state for ${strategyId}:`, error?.message || error);
        }

        // 1. Cooldown -> 0 Capital
        if (state === 'COOLING') {
            return 0.0;
        }

        // 2. Probation -> Cap at 25% or Proposed, whichever is lower
        if (state === 'PROBATION') {
            // "probation_weight = min(0.25, base_weight)"
            return Math.min(0.25, proposedWeight);
        }

        // 3. Dead -> 0
        if (state === 'DEAD') {
            return 0.0;
        }

        // Active -> No override
        return proposedWeight;
    }

    /**
     * Check if Symbol is Quarantined
     */
    async isSymbolQuarantined(symbol: string): Promise<boolean> {
        try {
            const data = await prisma.symbolQuarantine.findUnique({
                where: { symbol }
            });

            if (!data) return false;

            const now = new Date();
            const until = data.quarantinedUntil;

            return until > now;
        } catch (error: any) {
            console.error(`[RecoveryController] Failed to fetch symbol quarantine status for ${symbol}:`, error?.message || error);
            return false;
        }
    }

    /**
     * Quarantine a Symbol
     */
    async quarantineSymbol(symbol: string, reason: string, durationMs: number): Promise<void> {

        // MVP FREEZE ENFORCEMENT
        if (MVP_CONFIG.AUTOMATION.RECOVERY_CONTROLLER === SystemState.FROZEN) {
            console.log(`[MVP_FROZEN] RecoveryController would have quarantined ${symbol} for ${reason}. Action Suppressed.`);
            return;
        }

        const until = new Date(Date.now() + durationMs);

        try {
            await prisma.symbolQuarantine.upsert({
                where: { symbol },
                update: {
                    quarantinedUntil: until,
                    reason
                },
                create: {
                    symbol,
                    quarantinedUntil: until,
                    reason
                }
            });
            console.log(`[RecoveryController] Quarantined ${symbol} for ${(durationMs / 60000).toFixed(0)}m: ${reason}`);
        } catch (error: any) {
            console.error(`[RecoveryController] Failed to quarantine ${symbol} in Prisma/Neon:`, error?.message || error);
        }
    }
}
