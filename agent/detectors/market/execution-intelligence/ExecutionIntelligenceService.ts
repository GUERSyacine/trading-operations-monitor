import { SymbolIncidentState } from './types';
import { IncidentManager } from '../../../incident/manager/IncidentManager';
import { flashCrashDetector } from './detectors/FlashCrashDetector';
import { spreadAnomalyDetector } from './detectors/SpreadDetector';
import { slippageIncident } from './detectors/SlippageDetector';

export class ExecutionIntelligenceService {
    constructor(private incidentManager: IncidentManager) {}

    /**
     * Run all active detectors, collect triggered incidents, and report them to IncidentManager.
     */
    async runDetectors(params: {
        symbol: string;
        return1m?: number;
        atr1m?: number;
        volumeCurrent?: number;
        volumeMedian?: number;
        expectedPrice?: number;
        filledPrice?: number;
        allowedSlippagePct?: number;
        currentSpread?: number;
        medianSpread?: number;
    }): Promise<SymbolIncidentState[]> {
        const flash = (params.return1m !== undefined && params.atr1m !== undefined && params.volumeCurrent !== undefined && params.volumeMedian !== undefined)
            ? flashCrashDetector(params.symbol, params.return1m, params.atr1m, params.volumeCurrent, params.volumeMedian)
            : null;

        const spread = (params.currentSpread !== undefined && params.medianSpread !== undefined)
            ? spreadAnomalyDetector(params.symbol, params.currentSpread, params.medianSpread)
            : null;

        const slip = (params.expectedPrice !== undefined && params.filledPrice !== undefined && params.allowedSlippagePct !== undefined)
            ? slippageIncident(params.symbol, params.expectedPrice, params.filledPrice, params.allowedSlippagePct)
            : null;

        const incidents = [flash, spread, slip].filter(Boolean) as SymbolIncidentState[];

        for (const incident of incidents) {
            await this.incidentManager.reportIncident(incident);
        }

        return incidents;
    }
}
