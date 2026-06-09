export enum SystemState {
    ACTIVE = 'ACTIVE',
    FROZEN = 'FROZEN'
}

/** Safe numeric env reader — treats X=0 as 0, not as the fallback. */
function envNumber(value: string | undefined, fallback: number): number {
    return value !== undefined ? Number(value) : fallback;
}

/** Readable time-unit helpers. */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;

export const MVP_CONFIG = {
    AUTOMATION: {
        RECOVERY_CONTROLLER: SystemState.ACTIVE // Set to FROZEN to suppress recovery quarantine actions
    },
    INCIDENTS: {
        FLASH_CRASH_ATR_MULT:    envNumber(process.env.FLASH_CRASH_ATR_MULT,    4.0),
        FLASH_CRASH_VOL_MULT:    envNumber(process.env.FLASH_CRASH_VOL_MULT,    3.0),
        LIQUIDITY_SPREAD_MULT:   envNumber(process.env.LIQUIDITY_SPREAD_MULT,   5.0),
        SLIPPAGE_MULT:           envNumber(process.env.SLIPPAGE_MULT,           2.0)
    },
    INFRASTRUCTURE: {
        CPU_WARNING_THRESHOLD:      envNumber(process.env.INFRA_CPU_WARNING_THRESHOLD,      80.0),
        CPU_CRITICAL_THRESHOLD:     envNumber(process.env.INFRA_CPU_CRITICAL_THRESHOLD ?? process.env.INFRA_CPU_THRESHOLD,      95.0),
        MEMORY_WARNING_THRESHOLD:   envNumber(process.env.INFRA_MEMORY_WARNING_THRESHOLD,   80.0),
        MEMORY_CRITICAL_THRESHOLD:  envNumber(process.env.INFRA_MEMORY_CRITICAL_THRESHOLD ?? process.env.INFRA_MEMORY_THRESHOLD, 95.0),
        DISK_WARNING_THRESHOLD:     envNumber(process.env.INFRA_DISK_WARNING_THRESHOLD,     80.0),
        DISK_CRITICAL_THRESHOLD:    envNumber(process.env.INFRA_DISK_CRITICAL_THRESHOLD ?? process.env.INFRA_DISK_THRESHOLD,    95.0),
        DOCKER_CONTAINER_NAME:    process.env.INFRA_DOCKER_CONTAINER_NAME || 'freqtrade',
        DOCKER_RESTART_THRESHOLD: envNumber(process.env.INFRA_DOCKER_RESTART_THRESHOLD, 5),
        FREQTRADE_API_URL:        process.env.INFRA_FREQTRADE_API_URL  || 'http://localhost:8080/api/v1/ping',
        NETWORK_TARGETS:          (process.env.INFRA_NETWORK_TARGETS   || '1.1.1.1,8.8.8.8').split(','),
        EXCHANGE_PING_URL:        process.env.INFRA_EXCHANGE_PING_URL  || 'https://api.binance.com/api/v3/ping',
        DNS_RESOLVE_HOST:         process.env.INFRA_DNS_RESOLVE_HOST   || 'api.binance.com'
    },
    OPERATIONS: {
        HEARTBEAT_TIMEOUT_MS:      envNumber(process.env.OPS_HEARTBEAT_TIMEOUT_MS,      5 * MINUTE),
        TRADE_SILENCE_MS:          envNumber(process.env.OPS_TRADE_SILENCE_MS,          24 * HOUR),
        BROKER_TIMEOUT_MS:         envNumber(process.env.OPS_BROKER_TIMEOUT_MS,         5 * MINUTE),
        MARKET_DATA_STALE_MS:      envNumber(process.env.OPS_MARKET_DATA_STALE_MS,      60 * SECOND),
        ORDER_PIPELINE_WINDOW_MS:  envNumber(process.env.OPS_ORDER_PIPELINE_WINDOW_MS,  1 * HOUR),
        EXCHANGE_ACK_WINDOW_MS:    envNumber(process.env.OPS_EXCHANGE_ACK_WINDOW_MS,    15 * MINUTE),
        EXCHANGE_ACK_MAX_TIMEOUTS: envNumber(process.env.OPS_EXCHANGE_ACK_MAX_TIMEOUTS, 3),
        LATENCY_THRESHOLD_MS:      envNumber(process.env.OPS_LATENCY_THRESHOLD_MS,      1 * SECOND),
        LATENCY_ROLLING_COUNT:     envNumber(process.env.OPS_LATENCY_ROLLING_COUNT,     5)
    }
};
