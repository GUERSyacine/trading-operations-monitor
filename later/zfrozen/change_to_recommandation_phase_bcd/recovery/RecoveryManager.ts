import { prisma } from '../prisma';
import { StrategyStatusType, RecoveryState } from './types';

export class RecoveryManager {
    constructor(private strategyId: string = 'DEFAULT_STRATEGY') {}

    /**
     * Get current status (single truth per strategy)
     */
    async getStatus(): Promise<RecoveryState> {
        try {
            const data = await prisma.strategyStatus.findUnique({
                where: { strategyId: this.strategyId }
            });

            if (!data) {
                console.warn(`[RecoveryManager] [${this.strategyId}] No status row found, defaulting to HALTED.`);
                return { status: 'HALTED', since: Date.now(), reason: 'Not Initialized' };
            }

            return {
                status: data.status as StrategyStatusType,
                reason: data.reason || undefined,
                since: data.since.getTime()
            };
        } catch (error: any) {
            console.error(`[RecoveryManager] [${this.strategyId}] Failed to fetch status:`, error?.message || error);
            return { status: 'HALTED', since: Date.now(), reason: 'State Fetch Fail' };
        }
    }

    /**
     * Transition State (Strict State Machine per strategy)
     */
    async setStatus(newStatus: StrategyStatusType, reason: string): Promise<void> {
        const now = new Date();

        try {
            await prisma.strategyStatus.upsert({
                where: { strategyId: this.strategyId },
                update: {
                    status: newStatus,
                    reason,
                    lastUpdated: now
                },
                create: {
                    strategyId: this.strategyId,
                    status: newStatus,
                    reason,
                    since: now,
                    lastUpdated: now
                }
            });
            console.log(`[RecoveryManager] [${this.strategyId}] Transitioned to ${newStatus}: ${reason}`);
        } catch (error: any) {
            console.error(`[RecoveryManager] [${this.strategyId}] Failed to set status to ${newStatus}:`, error?.message || error);
        }
    }

    /**
     * Log Recovery Milestone
     */
    async logRecoveryPhase(phase: string, metricsSnapshot: any, exitReason?: string) {
        try {
            await prisma.recoveryLog.create({
                data: {
                    phase,
                    metricsSnapshot,
                    exitReason
                }
            });
        } catch (error: any) {
            console.error(`[RecoveryManager] [${this.strategyId}] Failed to write recovery log:`, error?.message || error);
        }
    }

    /**
     * Check Logic for Transition (Called by cron or monitoring job)
     * For Step 14 canonical implementation, we define the logic structure.
     */
    // Logic for transitioning specific phases goes here (e.g., check CDI < 1.2, elapsed time > cooldown)
}
