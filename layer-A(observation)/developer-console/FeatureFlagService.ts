import { FeatureFlag, WatchdogEventType, EventCategory } from './types';
import { EventBus } from './EventBus';

export class FeatureFlagService {
    private flags = new Map<FeatureFlag, boolean>();

    constructor(private eventBus: EventBus = EventBus.getInstance()) {}

    public setFeatureFlag(flag: FeatureFlag, enabled: boolean, correlationId?: string): void {
        this.flags.set(flag, enabled);
        this.eventBus.emit(EventCategory.SYSTEM, WatchdogEventType.FEATURE_FLAG_CHANGED, 'FeatureFlagService', { flag, enabled }, correlationId);
    }

    public isFeatureEnabled(flag: FeatureFlag): boolean {
        return this.flags.get(flag) ?? true; // Default to true
    }
}
