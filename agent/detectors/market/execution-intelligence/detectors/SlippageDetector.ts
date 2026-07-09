import { SymbolIncidentState } from '../types';
import { MVP_CONFIG } from '../../../../../mvpConfig';

/**
 * Playbook 4: Slippage / Fill Anomaly
 * 
 * Rule: SlippagePct > allowedPct * multiplier
 */
export function slippageIncident(
    symbol: string,
    expectedPrice: number,
    filledPrice: number,
    allowedSlippagePct: number,
    multiplier: number = MVP_CONFIG.INCIDENTS.SLIPPAGE_MULT
): SymbolIncidentState | null {
    if (expectedPrice <= 0) return null;       // Protect division
    if (allowedSlippagePct <= 0) return null;  // Zero tolerance is a config problem, not an anomaly

    // Protect against NaN/Infinity from broken exchange data
    if (
        !Number.isFinite(expectedPrice) ||
        !Number.isFinite(filledPrice) ||
        !Number.isFinite(allowedSlippagePct)
    ) return null;

    const slippagePct = Math.abs(filledPrice - expectedPrice) / expectedPrice;
    const threshold = allowedSlippagePct * multiplier;

    if (slippagePct > threshold) {
        return {
            symbol,
            level: 'HIGH',
            source: 'SLIPPAGE',
            reason: `Slippage Anomaly: ${(slippagePct * 100).toFixed(2)}% > ${(threshold * 100).toFixed(2)}% (expected=${expectedPrice}, filled=${filledPrice})`,
            since: Date.now()
        };
    }
    return null;
}
