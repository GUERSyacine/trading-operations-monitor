/**
 * Incident Types and State Definitions
 */

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SymbolIncidentState {
    symbol: string;
    level: IncidentSeverity;
    source: string;
    reason: string;
    since: number; // Unix timestamp
}

export interface IncidentControllerState {
    globalLevel: IncidentSeverity | 'NORMAL';
    globalReason?: string;
    symbols: Record<string, SymbolIncidentState>;
}

// Persisted shape matches SQL but we mainly use in-memory state for guard
export interface IncidentRecord {
    id?: number;
    symbol: string | null;
    level: IncidentSeverity;
    source: string;
    reason: string;
    detected_at: number;
    resolved_at?: number;
}
