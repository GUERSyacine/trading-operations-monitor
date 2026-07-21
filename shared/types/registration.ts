export type AgentApiStatus = 'SUCCESS' | 'NETWORK_ERROR' | 'SERVER_ERROR' | 'UNAUTHORIZED' | 'INVALID_TOKEN' | 'TIMEOUT';

export interface AgentRegisterRequest {
    licenseToken: string;
    machineId: string;
    hostname: string;
    version: string;
    capabilities: string[];
}

export interface AgentRegisterResponse {
    success: boolean;
    status: AgentApiStatus;
    agentId?: string;
    agentSecret?: string;
    message?: string;
    warning?: string;
    authorizedCapabilities?: string[];
}

export interface AgentHeartbeatRequest {
    agentId: string;
    agentSecret: string;
    hostname: string;
    version: string;
    status: string;
    uptime: number;
    metrics: {
        cpuPct: number;
        memoryPct: number;
        diskPct: number;
    };
    health: {
        outboxPendingCount: number;
        databaseHealthy: boolean;
        freqtradeHealthy: boolean;
    };
    capabilities?: string[];
}

export interface AgentHeartbeatResponse {
    success: boolean;
    status: AgentApiStatus;
    configOverrides?: Record<string, any>;
    message?: string;
    warning?: string;
    authorizedCapabilities?: string[];
}
