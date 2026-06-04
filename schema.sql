-- ============================================================================
-- EXECUTION WATCHDOG DATABASE SCHEMA (POSTGRESQL)
-- Clean, optimized DDL schema script for retail and institutional algo trading.
-- ============================================================================

-- Enable JSONB extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Decision Audit Table (Used for inactivity audits and kill switch checks)
CREATE TABLE IF NOT EXISTS decision_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    classification VARCHAR(50) NOT NULL, -- e.g., 'REJECTION', 'ORDER', 'WARNING'
    rejection_reason TEXT,              -- Vague or detailed reasons
    system_risk_state VARCHAR(50) NOT NULL, -- e.g., 'NORMAL', 'PROTECTION'
    htf JSONB,                          -- Higher Time Frame tradability objects
    metadata JSONB,                     -- Orders, sides, sizes, client details
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_audit_classification ON decision_audit(classification);
CREATE INDEX IF NOT EXISTS idx_decision_audit_created_at ON decision_audit(created_at DESC);

-- 2. Incidents Table (Tracks Global and Symbol level incidents with severity)
CREATE TABLE IF NOT EXISTS incidents (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20),                 -- NULL for global incidents
    level VARCHAR(20) NOT NULL,         -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
    source VARCHAR(50) NOT NULL,        -- 'FLASH_CRASH', 'SPREAD', 'SLIPPAGE', 'HEARTBEAT', etc.
    reason TEXT NOT NULL,
    detected_at BIGINT NOT NULL,        -- Unix epoch millisecond timestamp
    resolved_at BIGINT                  -- Unix epoch millisecond timestamp, NULL if active
);

CREATE INDEX IF NOT EXISTS idx_incidents_symbol ON incidents(symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_level ON incidents(level);
CREATE INDEX IF NOT EXISTS idx_incidents_resolved ON incidents(resolved_at) WHERE resolved_at IS NULL;

-- 3. Alert Log Table (Deduplicated System Warnings)
CREATE TABLE IF NOT EXISTS alert_log (
    id SERIAL PRIMARY KEY,
    level VARCHAR(50) NOT NULL,         -- INFO, WARNING, CRITICAL
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    entity_id VARCHAR(100),
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Circuit Breaker State Table (Protections like drawdowns)
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    id SERIAL PRIMARY KEY,
    breaker_type VARCHAR(50) UNIQUE NOT NULL, -- e.g., 'DAILY_DD'
    status VARCHAR(50) NOT NULL,             -- e.g., 'CLOSED', 'TRIPPED'
    current_val NUMERIC(10, 4) NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Monitored Bot Table (Multi-client support structure)
CREATE TABLE IF NOT EXISTS monitored_bot (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL,
    strategy_name VARCHAR(100) NOT NULL,
    broker VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
