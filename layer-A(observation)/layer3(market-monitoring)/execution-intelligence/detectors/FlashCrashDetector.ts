import { SymbolIncidentState } from '../types';
import { MVP_CONFIG } from '../../../../mvpConfig';

/**
 * Playbook 1: Flash Crash / Volatility Shock
 * 
 * Rules:
 * - Return > ATR * atrMultiplier
 * - Volume > Median * volMultiplier
 */
export function flashCrashDetector(
    symbol: string,
    return1m: number,
    atr1m: number,
    volumeCurrent: number,
    volumeMedian: number,
    atrMultiplier: number = MVP_CONFIG.INCIDENTS.FLASH_CRASH_ATR_MULT,
    volMultiplier: number = MVP_CONFIG.INCIDENTS.FLASH_CRASH_VOL_MULT
): SymbolIncidentState | null {
    // Guard: a zero ATR means no price history — any move would trigger; skip.
    if (atr1m <= 0) return null;
    // Guard: a zero volume median means no baseline — any volume would trigger; skip.
    if (volumeMedian <= 0) return null;

    const threshold1m = atrMultiplier * atr1m;
    const isPriceShock = Math.abs(return1m) > threshold1m;
    const isVolumeShock = volumeCurrent > volMultiplier * volumeMedian;

    if (isPriceShock && isVolumeShock) {
        return {
            symbol,
            level: 'HIGH',
            source: 'FLASH_CRASH',
            reason: `Flash Crash: Return ${(return1m * 100).toFixed(2)}% > ${atrMultiplier}*ATR, Vol > ${volMultiplier}x Median`,
            since: Date.now()
        };
    }
    return null;
}
