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
        SLIPPAGE_MULT:           envNumber(process.env.SLIPPAGE_MULT,           2.0),
        GROUPING_WINDOW_MS:      envNumber(process.env.INCIDENT_GROUP_WINDOW_MS, 120 * SECOND),
        CONCURRENCY_THRESHOLD_MS: envNumber(process.env.RCA_CONCURRENCY_THRESHOLD_MS, 1000)
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
        LATENCY_ROLLING_COUNT:     envNumber(process.env.OPS_LATENCY_ROLLING_COUNT,     5),
        SIGNAL_FILL_TIMEOUT_MS:    envNumber(process.env.OPS_SIGNAL_FILL_TIMEOUT_MS,    1 * HOUR)
    },
    RISK_PROTECTION: {
        PROTECTION_MODE: (process.env.RISK_PROTECTION_MODE || 'ALERT_ONLY') as CapitalProtectionMode,
        CONFIDENCE_WARNING_THRESHOLD: envNumber(process.env.RISK_CONFIDENCE_WARNING, 0.95),
        CONFIDENCE_CRITICAL_THRESHOLD: envNumber(process.env.RISK_CONFIDENCE_CRITICAL, 0.80),
        CONSECUTIVE_CONFIDENCE_WARNING: envNumber(process.env.RISK_CONFIDENCE_BREACHES_WARNING, 3),
        CONSECUTIVE_CONFIDENCE_CRITICAL: envNumber(process.env.RISK_CONFIDENCE_BREACHES_CRITICAL, 5),
        CONSECUTIVE_STRUCTURAL_WARNING: envNumber(process.env.RISK_STRUCTURAL_BREACHES_WARNING, 1),
        CONSECUTIVE_STRUCTURAL_CRITICAL: envNumber(process.env.RISK_STRUCTURAL_BREACHES_CRITICAL, 3)
    },
    RCA: {
        DOCKER_CASCADE_WINDOW_MS: envNumber(process.env.RCA_DOCKER_CASCADE_WINDOW_MS, 120_000),
        TELEMETRY_WINDOW_MS: envNumber(process.env.RCA_TELEMETRY_WINDOW_MS, 120_000),
        VM_EXHAUSTION_WINDOW_MS: envNumber(process.env.RCA_VM_EXHAUSTION_WINDOW_MS, 120_000),
        NETWORK_OUTAGE_WINDOW_MS: envNumber(process.env.RCA_NETWORK_OUTAGE_WINDOW_MS, 60_000),
        SCORING: {
            baseScore: 40,
            supportingEvidenceWeight: 5,
            contradictionPenalty: 15,
            missingPenalty: 8,
            concurrencyBonus: 10,
            temporalBonus: 12,
            durationBonus: 8,
            hintBonus: 5,
            hintPenalty: 5,
            maxScore: 100,
            ruleWeights: {
                SCR_SUPPORTING: 1.0,
                SCR_CONTRADICTION: 1.0,
                SCR_MISSING: 1.0,
                SCR_CONCURRENCY: 0.9,
                SCR_CASCADE_SEQUENCE: 1.0,
                SCR_FIRST_OCCURRENCE: 0.85,
                SCR_LIFECYCLE_DURATION: 0.9,
                SCR_EVALUATION_HINT: 0.95
            }
        }
    },
    CLOUD_SYNC: {
        GATEWAY_URL: process.env.CLOUD_GATEWAY_URL || 'http://127.0.0.1:3001/api/v1/cloud/incidents',
        SYNC_INTERVAL_MS: envNumber(process.env.CLOUD_SYNC_INTERVAL_MS, 5_000),
        MAX_ATTEMPTS: envNumber(process.env.CLOUD_SYNC_MAX_ATTEMPTS, 5),
        BACKOFF_BASE_MS: envNumber(process.env.CLOUD_SYNC_BACKOFF_BASE_MS, 1_000),
        BATCH_SIZE: envNumber(process.env.CLOUD_SYNC_BATCH_SIZE, 50),
        TIMEOUT_MS: envNumber(process.env.CLOUD_SYNC_TIMEOUT_MS, 5_000)
    },
    AGENT: {
        HEARTBEAT_INTERVAL_MS: envNumber(process.env.WATCHDOG_HEARTBEAT_INTERVAL_MS, 30_000),
        LICENSE_TOKEN: process.env.WATCHDOG_LICENSE_TOKEN || 'DEFAULT-TOKEN-XYZ'
    },
    CLOUD: {
        OFFLINE_TIMEOUT_MS: envNumber(process.env.WATCHDOG_OFFLINE_TIMEOUT_MS, 90_000)
    }
};

export type CapitalProtectionMode = 'ALERT_ONLY' | 'STOP_BUY' | 'STOP';
