import {
    AgentRegisterRequest,
    AgentRegisterResponse,
    AgentHeartbeatRequest,
    AgentHeartbeatResponse
} from '../../shared/types/registration';

export interface AgentApiClient {
    register(req: AgentRegisterRequest): Promise<AgentRegisterResponse>;
    heartbeat(req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse>;
}

export class CloudAgentClient implements AgentApiClient {
    private readonly baseUrl: string;

    constructor(baseUrl?: string) {
        // Default base URL is read from environment or falls back to localhost developer server port
        const rawUrl = baseUrl || process.env.CLOUD_BASE_URL || 'http://127.0.0.1:3001';
        // Ensure no trailing slash
        this.baseUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    }

    /**
     * POST /api/v1/agents/register
     */
    public async register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
        const url = `${this.baseUrl}/api/v1/agents/register`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(req)
            });

            if (!response.ok) {
                const text = await response.text();
                return {
                    success: false,
                    message: `Registration failed with status ${response.status}: ${text}`
                };
            }

            const data = (await response.json()) as AgentRegisterResponse;
            return data;
        } catch (error: any) {
            return {
                success: false,
                message: `Network error during registration: ${error?.message || error}`
            };
        }
    }

    /**
     * POST /api/v1/agents/heartbeat
     */
    public async heartbeat(req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
        const url = `${this.baseUrl}/api/v1/agents/heartbeat`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(req)
            });

            if (!response.ok) {
                const text = await response.text();
                return {
                    success: false,
                    status: 'ERROR',
                    message: `Heartbeat failed with status ${response.status}: ${text}`
                };
            }

            const data = (await response.json()) as AgentHeartbeatResponse;
            return data;
        } catch (error: any) {
            return {
                success: false,
                status: 'ERROR',
                message: `Network error during heartbeat: ${error?.message || error}`
            };
        }
    }
}
