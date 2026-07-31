export type HealthSource =
    | 'VM'
    | 'DOCKER'
    | 'FREQTRADE'
    | 'NETWORK'
    | 'DNS'
    | 'EXCHANGE_REACHABILITY'
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

export enum TradeDirection {
    ENTRY = 'ENTRY',
    EXIT = 'EXIT',
    UNKNOWN = 'UNKNOWN'
}

export interface LifecycleEvent {
    schemaVersion: 1;
    eventId: string;
    tradeId: string;
    orderId?: string;
    correlationId?: string;
    eventType: LifecycleEventType;
    source: LifecycleSource;
    captureMethod: 'WEBHOOK' | 'POLLING' | 'WEBSOCKET';
    eventTimestamp: number;
    observedAt: number;
    occurredAt?: number;
    symbol?: string;
    side?: 'BUY' | 'SELL';
    price?: number;
    amount?: number;
    direction?: TradeDirection;
}


export type LifecycleEventPhase = 'SIGNAL' | 'INTERMEDIATE' | 'COMPLETION';

export const LIFECYCLE_EVENT_PHASES: Record<string, LifecycleEventPhase> = {
    SIGNAL: 'SIGNAL',
    ORDER_CREATED: 'INTERMEDIATE',
    ORDER_SUBMITTED: 'INTERMEDIATE',
    ORDER_SENT: 'INTERMEDIATE',
    ORDER_ACKNOWLEDGED: 'INTERMEDIATE',
    ORDER_ACK: 'INTERMEDIATE',
    ORDER_OPEN: 'INTERMEDIATE',
    ORDER_PARTIALLY_FILLED: 'INTERMEDIATE',
    ORDER_FILLED: 'COMPLETION',
    ORDER_CANCELLED: 'COMPLETION',
    EXCHANGE_REJECTED: 'COMPLETION',
    ORDER_FAILED: 'COMPLETION',
    // Fallback for legacy audits
    ORDER: 'COMPLETION'
};

export interface SourceCapabilities {
    source: LifecycleSource;
    requiredEvents: LifecycleEventType[];
    optionalEvents: LifecycleEventType[];
}

export const SOURCE_CAPABILITIES: Record<LifecycleSource, SourceCapabilities> = {
    FREQTRADE: {
        source: 'FREQTRADE',
        requiredEvents: ['ORDER_CREATED', 'ORDER_FILLED'],
        optionalEvents: ['SIGNAL', 'ORDER_OPEN', 'ORDER_CANCELLED']
    },
    SIMULATOR: {
        source: 'SIMULATOR',
        requiredEvents: ['ORDER_CREATED', 'ORDER_OPEN', 'ORDER_FILLED'],
        optionalEvents: [
            'SIGNAL',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    },
    BINANCE: {
        source: 'BINANCE',
        requiredEvents: ['ORDER_CREATED', 'ORDER_OPEN', 'ORDER_FILLED'],
        optionalEvents: [
            'SIGNAL',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    },
    BYBIT: {
        source: 'BYBIT',
        requiredEvents: ['ORDER_CREATED', 'ORDER_OPEN', 'ORDER_FILLED'],
        optionalEvents: [
            'SIGNAL',
            'ORDER_SUBMITTED',
            'ORDER_ACKNOWLEDGED',
            'ORDER_PARTIALLY_FILLED',
            'ORDER_CANCELLED',
            'EXCHANGE_REJECTED',
            'ORDER_FAILED'
        ]
    }
};

export interface Evidence {
    id: string;
    groupId: number;
    sequence: number;
    category: 'INCIDENT' | 'AUDIT' | 'GROUP';
    source: string;
    event: 'DETECTED' | 'RESOLVED' | 'CREATED' | 'OBSERVED';
    timestamp: number;
    origin: 'OBSERVATION' | 'ASSESSMENT' | 'SYSTEM';
    entityId?: string;
    severity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
    symbol?: string;
    correlationKey?: string;
    message?: string;
    metadata?: Record<string, unknown>;
}

export const INFRASTRUCTURE_SOURCE_PREFIXES = [
    'CPU', 'MEMORY', 'DISK', 'DOCKER_CONTAINER', 
    'DNS', 'NETWORK', 'FREQTRADE_API', 'EXCHANGE_REACHABILITY',
    'VM', 'DOCKER', 'FREQTRADE'
];

export function isInfrastructureSource(source: string): boolean {
    for (const prefix of INFRASTRUCTURE_SOURCE_PREFIXES) {
        if (source.startsWith(prefix)) return true;
    }
    return source === 'INFRASTRUCTURE';
}

