export enum SystemState {
    ACTIVE = 'ACTIVE',
    FROZEN = 'FROZEN'
}

export const MVP_CONFIG = {
    AUTOMATION: {
        RECOVERY_CONTROLLER: SystemState.ACTIVE // Set to FROZEN to suppress recovery quarantine actions
    },
    INCIDENTS: {
        FLASH_CRASH_ATR_MULT: Number(process.env.FLASH_CRASH_ATR_MULT) || 4.0,
        FLASH_CRASH_VOL_MULT: Number(process.env.FLASH_CRASH_VOL_MULT) || 3.0,
        LIQUIDITY_SPREAD_MULT: Number(process.env.LIQUIDITY_SPREAD_MULT) || 5.0,
        SLIPPAGE_MULT: Number(process.env.SLIPPAGE_MULT) || 2.0
    }
};
