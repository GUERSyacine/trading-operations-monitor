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
