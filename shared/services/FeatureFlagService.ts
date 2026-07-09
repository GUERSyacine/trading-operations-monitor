import { FeatureFlag, WatchdogEventType, EventCategory } from '../types/developer';
import { EventBus } from './EventBus';

export interface FeatureFlagMetadata {
    name: string;
    description: string;
}

export const FEATURE_FLAG_METADATA: Record<FeatureFlag, FeatureFlagMetadata> = {
    [FeatureFlag.WEBSOCKET]: {
        name: 'WebSocket Ingestion',
        description: 'Realtime WebSocket telemetry stream'
    },
    [FeatureFlag.POLLING]: {
        name: 'HTTP Polling Fallback',
        description: 'Fallback REST API polling mechanism'
    },
    [FeatureFlag.ALERTING]: {
        name: 'Alert Notifications',
        description: 'Outbound Telegram alerting pipeline'
    },
    [FeatureFlag.REPORTING]: {
        name: 'Daily Reporting',
        description: 'Compiled summary reporting engine'
    },
    [FeatureFlag.REPLAY]: {
        name: 'Replay Engine',
        description: 'Simulation replay capability'
    }
};

export class FeatureFlagService {
    private flags = new Map<FeatureFlag, boolean>();

    constructor(private eventBus: EventBus = EventBus.getInstance()) {}

    public setFeatureFlag(flag: FeatureFlag, enabled: boolean, reason: string = 'Developer Console', correlationId?: string): void {
        const oldValue = this.isFeatureEnabled(flag);
        if (oldValue === enabled) {
            return; // Refuse duplicate changes to avoid timeline noise
        }
        this.flags.set(flag, enabled);
        this.eventBus.emit(
            EventCategory.SYSTEM,
            WatchdogEventType.FEATURE_FLAG_CHANGED,
            'FeatureFlagService',
            { flag, oldValue, newValue: enabled, enabled, reason },
            correlationId
        );
    }

    public isFeatureEnabled(flag: FeatureFlag): boolean {
        return this.flags.get(flag) ?? true; // Default to true
    }
}
