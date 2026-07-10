import { SourceCapabilities, LifecycleSource } from '../../../shared/types/telemetry';
import { FeatureFlagService } from '../../../shared/services/FeatureFlagService';
import { FeatureFlag, EventCategory, WatchdogEventType } from '../../../shared/types/developer';
import { EventBus } from '../../../shared/services/EventBus';

export interface AdapterConfig {
    baseUrl: string;
    username?: string;
    password?: string;
    pollIntervalMs: number;
}

export abstract class TradingAdapter {
    protected intervalId?: NodeJS.Timeout;
    protected isPolling = false;

    abstract readonly capabilities: SourceCapabilities;
    abstract readonly sourceSystem: LifecycleSource;

    abstract executeActiveHalt(type: 'STOP_BUY' | 'STOP'): Promise<void>;

    constructor(
        protected config: AdapterConfig,
        protected flags?: FeatureFlagService
    ) {}

    /**
     * Start the periodic polling scheduler.
     */
    start(): void {
        if (this.intervalId) {
            console.warn(`[Adapter:${this.sourceSystem}] Already started.`);
            return;
        }
        console.log(`[Adapter:${this.sourceSystem}] Starting polling loop at ${this.config.pollIntervalMs}ms...`);
        this.intervalId = setInterval(() => this.runPoll(), this.config.pollIntervalMs);
        
        // Immediate trigger on startup
        this.runPoll().catch(err => console.error(`[Adapter:${this.sourceSystem}] Initial poll cycle failed:`, err));
    }

    /**
     * Stop the periodic polling scheduler.
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
            console.log(`[Adapter:${this.sourceSystem}] Polling loop stopped.`);
        }
    }

    private async runPoll(): Promise<void> {
        if (this.flags && !this.flags.isFeatureEnabled(FeatureFlag.POLLING)) {
            console.warn(`[Adapter:${this.sourceSystem}] Polling skipped: FeatureFlag.POLLING disabled.`);
            EventBus.getInstance().emit(
                EventCategory.SYSTEM,
                WatchdogEventType.SYSTEM_STATUS_CHANGED,
                `Adapter:${this.sourceSystem}`,
                { message: 'Polling skipped: FeatureFlag.POLLING disabled' }
            );
            return;
        }

        if (this.isPolling) {
            console.warn(`[Adapter:${this.sourceSystem}] Warning: previous poll loop is still running. Skipping current cycle.`);
            return;
        }
        this.isPolling = true;
        try {
            await this.poll();
        } catch (error: any) {
            console.error(`[Adapter:${this.sourceSystem}] Poll cycle encountered error:`, error?.message || error);
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Implementation-specific polling logic.
     */
    protected abstract poll(): Promise<void>;
}
