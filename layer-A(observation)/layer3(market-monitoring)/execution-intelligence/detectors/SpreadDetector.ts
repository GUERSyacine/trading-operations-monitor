import { SymbolIncidentState } from '../types';
import { MVP_CONFIG } from '../../../../mvpConfig';

/**
 * Playbook 2: Liquidity Vacuum / Spread Explosion
 * 
 * Rule: Spread > Rolling Median * spreadMultiplier
 */
export function spreadAnomalyDetector(
    symbol: string,
    currentSpread: number,
    medianSpread: number,
    spreadMultiplier: number = MVP_CONFIG.INCIDENTS.LIQUIDITY_SPREAD_MULT
): SymbolIncidentState | null {
    if (medianSpread <= 0) return null;

    if (
        !Number.isFinite(currentSpread) ||
        !Number.isFinite(medianSpread)
    ) {
        return null;
    }

    const threshold = spreadMultiplier * medianSpread;

    if (currentSpread > threshold) {
        return {
            symbol,
            level: 'HIGH',
            source: 'SPREAD',
            reason: `Spread Explosion: ${currentSpread.toFixed(6)} > ${threshold.toFixed(6)} (multiplier: ${spreadMultiplier}x, median: ${medianSpread.toFixed(6)})`,
            since: Date.now()
        };
    }
    return null;
}
