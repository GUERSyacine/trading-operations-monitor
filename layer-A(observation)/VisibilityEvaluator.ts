import { SourceCapabilities, LifecycleEventType, PipelineVisibilityLevel, LIFECYCLE_EVENT_PHASES } from './types';

export interface VisibilityEvaluationContext {
    capabilities: SourceCapabilities;
    observedClassifications: Set<string>;
}

export class VisibilityEvaluator {
    static evaluate(context: VisibilityEvaluationContext): {
        pipelineVisibility: 'LIMITED' | 'PARTIAL' | 'FULL' | 'NONE';
        visibilityReason: string;
        telemetryCoverage: {
            requiredCoverageRatio: number;
            requiredObserved: LifecycleEventType[];
            requiredMissing: LifecycleEventType[];
            optionalObserved: LifecycleEventType[];
            optionalMissing: LifecycleEventType[];
        };
    } {
        const { capabilities, observedClassifications } = context;

        // 1. Identify observed phases
        const hasIntermediate = Array.from(observedClassifications).some(
            c => LIFECYCLE_EVENT_PHASES[c] === 'INTERMEDIATE'
        );
        const hasCompletion = Array.from(observedClassifications).some(
            c => LIFECYCLE_EVENT_PHASES[c] === 'COMPLETION'
        );
        const signals = observedClassifications.has('SIGNAL') ? 1 : 0;

        // 2. Determine pipeline visibility level and reason
        let pipelineVisibility: 'LIMITED' | 'PARTIAL' | 'FULL' | 'NONE' = 'LIMITED';
        let visibilityReason = 'Adapter only emits ORDER completion telemetry.';

        if (observedClassifications.size === 0) {
            pipelineVisibility = 'LIMITED';
            visibilityReason = 'No telemetry events observed in the lookback window.';
        } else if (hasIntermediate && hasCompletion) {
            pipelineVisibility = 'FULL';
            visibilityReason = 'Complete execution lifecycle successfully reconstructed.';

            const supportsSignal = capabilities.requiredEvents.includes('SIGNAL') || 
                                   capabilities.optionalEvents.includes('SIGNAL');
            if (supportsSignal) {
                if (!observedClassifications.has('SIGNAL')) {
                    visibilityReason += ' Signal telemetry expected but missing.';
                }
            } else {
                visibilityReason += ' Signal telemetry not supported by current adapter.';
            }
        } else if (signals > 0 && hasCompletion) {
            pipelineVisibility = 'PARTIAL';
            visibilityReason = 'Ingesting SIGNAL and ORDER_FILLED events via Freqtrade WebSocket and Polling reconciliation.';
        } else if (signals > 0) {
            pipelineVisibility = 'PARTIAL';
            visibilityReason = 'Ingesting SIGNAL events only.';
        } else if (hasIntermediate) {
            pipelineVisibility = 'PARTIAL';
            visibilityReason = 'Ingesting intermediate order lifecycle events but no completion telemetry observed.';
        } else {
            pipelineVisibility = 'LIMITED';
            visibilityReason = 'Adapter only emits ORDER completion telemetry.';
        }

        // 3. Compute telemetry coverage
        const requiredObserved = capabilities.requiredEvents.filter(e => observedClassifications.has(e));
        const requiredMissing = capabilities.requiredEvents.filter(e => !observedClassifications.has(e));
        const optionalObserved = capabilities.optionalEvents.filter(e => observedClassifications.has(e));
        const optionalMissing = capabilities.optionalEvents.filter(e => !observedClassifications.has(e));

        const requiredCoverageRatio = capabilities.requiredEvents.length > 0 
            ? requiredObserved.length / capabilities.requiredEvents.length 
            : 1.0;

        return {
            pipelineVisibility,
            visibilityReason,
            telemetryCoverage: {
                requiredCoverageRatio,
                requiredObserved,
                requiredMissing,
                optionalObserved,
                optionalMissing
            }
        };
    }
}
