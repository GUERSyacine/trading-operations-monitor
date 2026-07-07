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

export interface IncidentPublisher {
    /**
     * Enqueues an incident payload to the local Outbox.
     */
    enqueueIncident(incident: IncidentPayload, machine: MachineInfo): Promise<void>;
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
