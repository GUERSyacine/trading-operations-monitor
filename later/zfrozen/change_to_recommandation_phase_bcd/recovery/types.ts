/**
 * Recovery Logic Types
 */

export type StrategyStatusType =
    | 'ACTIVE'
    | 'DEGRADED'
    | 'HALTED'
    | 'RECOVERING_P0' // Observation (No Trading)
    | 'RECOVERING_P1' // Probe (10% Size, 1 Position)
    | 'RECOVERING_P2' // Limited (25% Size)
    | 'RECOVERING_P3'; // Controlled (50% Size)

export interface RecoveryState {
    status: StrategyStatusType;
    reason?: string;
    since: number;
}
