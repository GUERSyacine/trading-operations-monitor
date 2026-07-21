import {
    AgentRegisterRequest,
    AgentRegisterResponse,
    AgentHeartbeatRequest,
    AgentHeartbeatResponse,
    AgentApiStatus
} from '../../shared/types/registration';
import { MVP_CONFIG } from '../../shared/mvpConfig';

export interface AgentApiClient {
    register(req: AgentRegisterRequest): Promise<AgentRegisterResponse>;
    heartbeat(req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse>;
}

export class CloudAgentClient implements AgentApiClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number = 10_000; // 10 seconds timeout

    constructor(baseUrl?: string) {
        // Retrieve base URL from config or fallback
        const rawUrl = baseUrl || MVP_CONFIG.CLOUD.BASE_URL;
        // Ensure no trailing slash
        this.baseUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    }

    /**
     * Map HTTP status codes to AgentApiStatus.
     */
    private mapHttpStatusToStatus(httpStatus: number): AgentApiStatus {
        if (httpStatus === 401) {
            return 'UNAUTHORIZED';
        }
        if (httpStatus === 403) {
            return 'INVALID_TOKEN';
        }
        if (httpStatus >= 500) {
            return 'SERVER_ERROR';
        }
        return 'NETWORK_ERROR';
    }

    /**
     * Helper to perform fetch requests with timeout.
     */
    private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            throw error;
        }
    }

    /**
     * POST /api/v1/agent/register
     */
    public async register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
        const url = `${this.baseUrl}/api/v1/agent/register`;
        try {
            const response = await this.fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Agent-Version': req.version || '1.0.0',
                    'X-Agent-Capabilities': req.capabilities ? req.capabilities.join(',') : ''
                },
                body: JSON.stringify(req)
            });

            if (!response.ok) {
                const text = await response.text();
                let parsed: any = null;
                try {
                    parsed = JSON.parse(text);
                } catch {}

                const rawStatus = parsed?.error?.code || this.mapHttpStatusToStatus(response.status);
                const status: AgentApiStatus = ['SUCCESS', 'NETWORK_ERROR', 'SERVER_ERROR', 'UNAUTHORIZED', 'INVALID_TOKEN', 'TIMEOUT'].includes(rawStatus)
                    ? (rawStatus as AgentApiStatus)
                    : this.mapHttpStatusToStatus(response.status);

                const message = parsed?.error?.message || parsed?.message || `Registration failed with status ${response.status}: ${text}`;
                return {
                    success: false,
                    status,
                    message
                };
            }

            const data = (await response.json()) as AgentRegisterResponse;
            return {
                ...data,
                status: 'SUCCESS'
            };
        } catch (error: any) {
            const isTimeout = error?.name === 'AbortError';
            return {
                success: false,
                status: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
                message: isTimeout
                    ? `Registration timed out after ${this.timeoutMs}ms`
                    : `Network error during registration: ${error?.message || error}`
            };
        }
    }

    /**
     * POST /api/v1/agent/heartbeat
     */
    public async heartbeat(req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
        const url = `${this.baseUrl}/api/v1/agent/heartbeat`;
        try {
            const { capabilities, ...bodyWithoutCapabilities } = req;
            const response = await this.fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Agent-Id': req.agentId,
                    'X-Agent-Secret': req.agentSecret, // Authorization Header
                    'X-Agent-Version': req.version || '1.0.0',
                    'X-Agent-Capabilities': req.capabilities ? req.capabilities.join(',') : ''
                },
                body: JSON.stringify(bodyWithoutCapabilities)
            });

            if (!response.ok) {
                const text = await response.text();
                let parsed: any = null;
                try {
                    parsed = JSON.parse(text);
                } catch {}

                const rawStatus = parsed?.error?.code || this.mapHttpStatusToStatus(response.status);
                const status: AgentApiStatus = ['SUCCESS', 'NETWORK_ERROR', 'SERVER_ERROR', 'UNAUTHORIZED', 'INVALID_TOKEN', 'TIMEOUT'].includes(rawStatus)
                    ? (rawStatus as AgentApiStatus)
                    : this.mapHttpStatusToStatus(response.status);

                const message = parsed?.error?.message || parsed?.message || `Heartbeat failed with status ${response.status}: ${text}`;
                return {
                    success: false,
                    status,
                    message
                };
            }

            const data = (await response.json()) as AgentHeartbeatResponse;
            return {
                ...data,
                status: 'SUCCESS'
            };
        } catch (error: any) {
            const isTimeout = error?.name === 'AbortError';
            return {
                success: false,
                status: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
                message: isTimeout
                    ? `Heartbeat timed out after ${this.timeoutMs}ms`
                    : `Network error during heartbeat: ${error?.message || error}`
            };
        }
    }
}
