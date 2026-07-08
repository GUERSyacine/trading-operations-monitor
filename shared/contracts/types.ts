export interface MachineInfo {
    machineId: string;
    botId: string;
    licenseKey: string;
    hostname: string;
    os: string;
    dockerVersion: string;
    freqtradeVersion: string;
    adapter: string;
    environment: string;
    agentVersion: string;
    schemaVersion: number;
}

export interface IncidentPayload {
    incidentId: string;
    source: string;
    level: string;
    reason: string;
    detectedAt: number;
    resolvedAt?: number | null;
    rootCauseAnalysis?: {
        winner: string;
        confidence: number;
        topCandidates: Array<{ id: string; score: number }>;
        supportingEvidence?: string[];
    } | null;
}

export interface MachineInfoProvider {
    /**
     * Retrieves static and dynamic details about the local running agent machine.
     */
    getMachineInfo(): MachineInfo;
}

export interface IncidentPublisher {
    /**
     * Enqueues an incident lifecycle state transition to the local Outbox.
     */
    publishTransition(event: 'CREATED' | 'STATE_CHANGED' | 'RESOLVED', incident: IncidentPayload): Promise<void>;
}

export interface LicenseProvider {
    /**
     * Checks client feature entitlement tier (defaults to PRO in Version 1).
     */
    verifyLicense(licenseKey: string): Promise<{ valid: boolean; tier: 'FREE' | 'PRO' }>;
}

export interface ConfigProvider {
    /**
     * Returns remote config overrides (defaults to {} in Version 1).
     */
    fetchRemoteConfig(): Promise<Record<string, any>>;
}

export interface OutboxAlertPayload {
    level: string;
    title: string;
    message: string;
    entityId?: string;
    dedupKey?: string;
}

export interface OutboxPublisherContract extends IncidentPublisher {
    publishTransition(event: 'CREATED' | 'STATE_CHANGED' | 'RESOLVED', incident: IncidentPayload): Promise<void>;
    publishAlert(alert: OutboxAlertPayload): Promise<void>;
}

