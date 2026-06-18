export type HealthSource =
    | 'VM'
    | 'DOCKER'
    | 'FREQTRADE'
    | 'NETWORK'
    | 'DNS'
    | 'EXCHANGE'
    | 'HEARTBEAT'
    | 'TRADE_FREQUENCY'
    | 'BROKER_CONNECTION'
    | 'MARKET_DATA'
    | 'ORDER_PIPELINE'
    | 'EXCHANGE_ACK'
    | 'LATENCY'
    | 'STRATEGY_HEALTH'
    | 'EXECUTION_QUALITY'
    | 'RISK';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface HealthCheckResult {
    source: HealthSource;
    healthy: boolean;
    checkedAt: Date;
    checkDurationMs: number;
    severity?: Severity;
    message?: string;
    metadata?: Record<string, any>;
}

export type HealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

export interface HealthNode {
    id: string;
    name: string;
    status: HealthStatus;
    message?: string;
    checkedAt: Date;
    children?: HealthNode[];
    metrics?: Record<string, any>;
}

export type LifecycleEventType =
    | 'SIGNAL'
    | 'ORDER_CREATED'
    | 'ORDER_SUBMITTED'
    | 'ORDER_ACKNOWLEDGED'
    | 'ORDER_OPEN'
    | 'ORDER_PARTIALLY_FILLED'
    | 'ORDER_FILLED'
    | 'ORDER_CANCELLED'
    | 'EXCHANGE_REJECTED'
    | 'ORDER_FAILED';

export type LifecycleSource =
    | 'FREQTRADE'
    | 'SIMULATOR'
    | 'BINANCE'
    | 'BYBIT';

export type PipelineVisibilityLevel =
    | 'NONE'
    | 'PARTIAL'
    | 'FULL';

export interface LifecycleEvent {
    schemaVersion: 1;
    eventId: string;
    tradeId: string;
    orderId?: string;
    correlationId?: string;
    eventType: LifecycleEventType;
    source: LifecycleSource;
    captureMethod: 'WEBHOOK' | 'POLLING';
    eventTimestamp: number;
    observedAt: number;
    symbol?: string;
    side?: 'BUY' | 'SELL';
    price?: number;
    amount?: number;
}


export interface SourceCapabilities {
    source: LifecycleSource;
    supportedEvents: LifecycleEventType[];
    visibility: PipelineVisibilityLevel;
}

export const SOURCE_CAPABILITIES: Record<LifecycleSource, SourceCapabilities> = {
    FREQTRADE: {
        source: 'FREQTRADE',
        visibility: 'PARTIAL',
        supportedEvents: ['SIGNAL', 'ORDER_OPEN', 'ORDER_FILLED', 'ORDER_CANCELLED']
    },
    SIMULATOR: {
        source: 'SIMULATOR',
        visibility: 'FULL',
        supportedEvents: [
            'SIGNAL',
            'ORDER_CREATED',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_OPEN',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    },
    BINANCE: {
        source: 'BINANCE',
        visibility: 'FULL',
        supportedEvents: [
            'SIGNAL',
            'ORDER_CREATED',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_OPEN',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    },
    BYBIT: {
        source: 'BYBIT',
        visibility: 'FULL',
        supportedEvents: [
            'SIGNAL',
            'ORDER_CREATED',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_OPEN',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    }
};

