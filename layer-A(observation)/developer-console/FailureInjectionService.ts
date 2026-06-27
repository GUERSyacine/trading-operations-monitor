import { FailureType, FailureScope, WatchdogEventType, EventCategory } from './types';
import { EventBus } from './EventBus';

export interface InjectedFailure {
    type: FailureType;
    scope: FailureScope;
    injectedAt: number;
    ttlSeconds?: number;
    expiresAt?: number;
    source: string;
    reason?: string;
}

export class FailureInjectionService {
    private failures = new Map<FailureType, InjectedFailure>();

    constructor(private eventBus: EventBus = EventBus.getInstance()) {}

    public injectFailure(
        type: FailureType,
        scope: FailureScope,
        ttlSeconds?: number,
        correlationId?: string,
        source: string = 'developer_console',
        reason?: string
    ): void {
        const injectedAt = Date.now();
        const expiresAt = ttlSeconds ? injectedAt + (ttlSeconds * 1000) : undefined;
        this.failures.set(type, { type, scope, injectedAt, ttlSeconds, expiresAt, source, reason });
        
        this.eventBus.emit(
            EventCategory.FAILURE,
            WatchdogEventType.FAILURE_INJECTED,
            'FailureInjectionService',
            { type, scope, ttlSeconds, source, reason, expiresAt },
            correlationId
        );
    }

    public clearFailure(type: FailureType, correlationId?: string): void {
        if (this.failures.has(type)) {
            this.failures.delete(type);
            this.eventBus.emit(EventCategory.FAILURE, WatchdogEventType.FAILURE_CLEARED, 'FailureInjectionService', { type }, correlationId);
        }
    }

    public clearAll(correlationId?: string): void {
        this.failures.clear();
        this.eventBus.emit(EventCategory.FAILURE, WatchdogEventType.FAILURE_CLEARED, 'FailureInjectionService', { all: true }, correlationId);
    }

    public isFailureActive(type: FailureType): boolean {
        const failure = this.failures.get(type);
        if (!failure) return false;

        if (failure.expiresAt && Date.now() > failure.expiresAt) {
            this.failures.delete(type);
            this.eventBus.emit(EventCategory.FAILURE, WatchdogEventType.FAILURE_CLEARED, 'FailureInjectionService', { type, reason: 'TTL_EXPIRED' });
            return false;
        }
        return true;
    }

    public cleanupExpired(): void {
        const now = Date.now();
        for (const [type, failure] of this.failures.entries()) {
            if (failure.expiresAt && now > failure.expiresAt) {
                this.failures.delete(type);
                this.eventBus.emit(EventCategory.FAILURE, WatchdogEventType.FAILURE_CLEARED, 'FailureInjectionService', { type, reason: 'TTL_EXPIRED' });
            }
        }
    }

    public async intercept<T>(opts: {
        type: FailureType;
        component: string;
        operation: string;
        real: () => Promise<T> | T;
        simulate: () => Promise<T> | T;
    }): Promise<T> {
        if (this.isFailureActive(opts.type)) {
            return Promise.resolve(opts.simulate());
        }
        return Promise.resolve(opts.real());
    }
}
