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
    if (currentSpread > spreadMultiplier * medianSpread) {
        return {
            symbol,
            level: 'HIGH',
            source: 'SPREAD',
            reason: `Spread Explosion: ${currentSpread} > ${spreadMultiplier}x Median`,
            since: Date.now()
        };
    }
    return null;
}
