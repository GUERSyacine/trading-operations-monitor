import * as http from 'http';
import { DeveloperConsoleController } from './DeveloperConsoleController';
import { DeveloperConsoleGateway } from './DeveloperConsoleGateway';
import { DASHBOARD_HTML } from './dashboardHtml';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario } from '../../shared/types/developer';
import { AgentStatusService } from './AgentStatusService';
import { prisma } from '../../shared/prisma';
import { Agent } from '@prisma/client';
import { ErrorCode, ErrorResponse } from '../../shared/types/errors';

import { EventPersistenceService } from '../../shared/services/EventPersistenceService';
import { OperationsSimulationService } from './OperationsSimulationService';
import { EventBus } from '../../shared/services/EventBus';
import { CommandRunner } from './CommandRunner';
import { InfrastructureController } from './InfrastructureController';
import { FailureInjectionService } from '../../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../../shared/services/FeatureFlagService';

export class DeveloperConsoleServer {
    private server?: http.Server;
    private sseClients = new Set<http.ServerResponse>();
    private heartbeatTimer?: NodeJS.Timeout;
    private readonly startedAt = Date.now();
    private statusService = new AgentStatusService();

    public static bootstrap(port?: number, host?: string): DeveloperConsoleServer {
        const persistence = new EventPersistenceService();
        const opsSim = new OperationsSimulationService(persistence);
        const eventBus = EventBus.getInstance();
        const cmdRunner = new CommandRunner();
        const infraCtrl = new InfrastructureController(cmdRunner, eventBus);
        const failures = new FailureInjectionService(eventBus);
        const flags = new FeatureFlagService(eventBus);
        const gateway = new DeveloperConsoleGateway(eventBus);
        const controller = new DeveloperConsoleController(failures, flags, infraCtrl, opsSim);

        return new DeveloperConsoleServer(controller, gateway, port, host);
    }

    constructor(
        private controller: DeveloperConsoleController,
        private gateway: DeveloperConsoleGateway,
        private port: number = Number(process.env.WATCHDOG_DEV_CONSOLE_PORT) || 3001,
        private host: string = process.env.WATCHDOG_DEV_CONSOLE_HOST || '127.0.0.1'
    ) {}

    private async seedQaToken(): Promise<void> {
        try {
            const token = 'QA-LAB-TOKEN-999';
            const existing = await prisma.registrationToken.findUnique({
                where: { token }
            });
            if (!existing) {
                await prisma.registrationToken.create({
                    data: {
                        token,
                        maxAgents: 100,
                        status: 'ACTIVE'
                    }
                });
                console.log(`[DevConsole] Seeded default QA registration token: ${token}`);
            }
        } catch (error: any) {
            console.error('[DevConsole] Failed to seed QA token:', error?.message || error);
        }
    }

    public start(): void {
        if (process.env.NODE_ENV !== 'production') {
            this.seedQaToken();
        }
        this.server = http.createServer(async (req, res) => {
            const rawUrl = req.url || '';
            const method = req.method || 'GET';

            // Safe parsing of pathname to strip query parameters & fragments
            const parsedUrl = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
            const pathname = parsedUrl.pathname;

            // CORS headers for local execution
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // 1. Static SPA Dashboard View
            if (pathname === '/' || pathname === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(DASHBOARD_HTML);
                return;
            }

            // 2. Health Endpoint
            if (pathname === '/health' && method === 'GET') {
                this.sendJson(res, 200, {
                    success: true,
                    message: 'Developer Console is UP',
                    data: {
                        status: 'UP',
                        version: '1.0.0',
                        uptime: (Date.now() - this.startedAt) / 1000,
                        startedAt: this.startedAt,
                        readOnly: this.controller.getReadOnlyStatus()
                    }
                });
                return;
            }

            // 3. SSE Stream (Versioned dashboard and legacy support)
            if ((pathname === '/api/v1/dashboard/events/stream' || pathname === '/api/v1/events/stream') && method === 'GET') {
                this.handleSseStream(req, res);
                return;
            }

            // 4. REST Router (Versioned)
            try {
                await this.handleRestRoute(req, res, pathname, rawUrl, method);
            } catch (err: any) {
                console.error(`[DevConsole] Error on route ${rawUrl}:`, err.message || err);
                this.sendError(res, 500, 'SERVER_ERROR', err.message || 'Internal Server Error');
            }
        });

        this.server.listen(this.port, this.host, () => {
            console.log(`[DevConsole] Server listening at http://${this.host}:${this.port}`);
        });

        // SSE Keep-Alive Ping Timer (every 20s)
        this.heartbeatTimer = setInterval(() => {
            this.broadcastSseHeartbeat();
        }, 20000);

        // Start offline agent scanner daemon
        this.statusService.start();
    }

    public async stop(): Promise<void> {
        this.statusService.stop();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        
        // Terminate active client streams
        for (const client of this.sseClients) {
            client.end();
        }
        this.sseClients.clear();

        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('[DevConsole] Server stopped.');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private async handleRestRoute(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        pathname: string,
        rawUrl: string,
        method: string
    ): Promise<void> {
        if (method === 'GET') {
            // Dashboard: Get Feature Flags
            if (pathname === '/api/v1/dashboard/flags' || pathname === '/api/v1/flags') {
                try {
                    const flags = this.controller.getAllFeatureFlags();
                    this.sendJson(res, 200, { success: true, data: flags });
                } catch (err: any) {
                    this.sendError(res, 500, 'SERVER_ERROR', err.message);
                }
                return;
            }

            // Dashboard: Get Freqtrade Status
            if (pathname === '/api/v1/dashboard/infra/status' || pathname === '/api/v1/infra/status') {
                const status = await this.controller.getFreqtradeStatus();
                this.sendJson(res, 200, { success: true, message: 'Successfully fetched status', data: { status } });
                return;
            }

            // Agent: Get Config (Reserved)
            if (pathname === '/api/v1/agent/config') {
                const authResult = await this.authenticateAgent(req);
                if (!authResult.success) {
                    this.sendJson(res, authResult.statusCode, authResult.body);
                    return;
                }
                this.sendJson(res, 200, { success: true, config: {} });
                return;
            }

            // Agent: Get Update (Reserved)
            if (pathname === '/api/v1/agent/update') {
                const authResult = await this.authenticateAgent(req);
                if (!authResult.success) {
                    this.sendJson(res, authResult.statusCode, authResult.body);
                    return;
                }
                this.sendJson(res, 200, { success: true, updateAvailable: false });
                return;
            }

            // QA: Get Registered Agents list
            if (pathname === '/api/v1/qa/agents') {
                try {
                    const agents = await this.controller.getAgentsStatus();
                    this.sendJson(res, 200, { success: true, data: agents });
                } catch (err: any) {
                    this.sendError(res, 500, 'SERVER_ERROR', err.message);
                }
                return;
            }
        }

        if (method === 'PUT') {
            // Dashboard: Update Feature Flag
            if (pathname.startsWith('/api/v1/dashboard/flags/') || pathname.startsWith('/api/v1/flags/')) {
                const prefix = pathname.startsWith('/api/v1/dashboard/flags/') ? '/api/v1/dashboard/flags/' : '/api/v1/flags/';
                const flagStr = pathname.substring(prefix.length).toUpperCase();
                if (!Object.values(FeatureFlag).includes(flagStr as FeatureFlag)) {
                    this.sendError(res, 400, 'BAD_REQUEST', `Invalid flag: ${flagStr}`);
                    return;
                }

                const body = await this.readRequestBody(req);
                let payload: any;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (e) {
                    this.sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON payload');
                    return;
                }

                const { enabled, reason, correlationId } = payload;
                if (enabled === undefined) {
                    this.sendError(res, 422, 'UNPROCESSABLE_ENTITY', 'Field "enabled" is required.');
                    return;
                }

                try {
                    this.controller.setFeatureFlag(flagStr as FeatureFlag, enabled, reason, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Updated feature flag ${flagStr} to ${enabled}` });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }
        }

        if (method === 'POST') {
            const body = await this.readRequestBody(req);
            let payload: any;
            try {
                payload = JSON.parse(body || '{}');
            } catch (e) {
                this.sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON payload');
                return;
            }

            // Agent: Register Agent
            if (pathname === '/api/v1/agent/register' || pathname === '/api/v1/agents/register') {
                try {
                    const result = await this.controller.registerAgent(payload);
                    if (result.success) {
                        this.sendJson(res, 200, result);
                    } else {
                        const statusCode = result.status === 'INVALID_TOKEN' ? 403 : 400;
                        const code: ErrorCode = result.status === 'INVALID_TOKEN' ? 'INVALID_TOKEN' : 'BAD_REQUEST';
                        this.sendError(res, statusCode, code, result.message || 'Registration failed');
                    }
                } catch (err: any) {
                    this.sendError(res, 500, 'SERVER_ERROR', err.message || 'Internal registration error');
                }
                return;
            }

            // Agent: Agent Heartbeat
            if (pathname === '/api/v1/agent/heartbeat' || pathname === '/api/v1/agents/heartbeat') {
                const authResult = await this.authenticateAgent(req);
                if (!authResult.success) {
                    this.sendJson(res, authResult.statusCode, authResult.body);
                    return;
                }
                try {
                    const result = await this.controller.receiveHeartbeat(payload, authResult.agent.agentSecret);
                    if (result.success) {
                        this.sendJson(res, 200, result);
                    } else {
                        const statusCode = result.status === 'UNAUTHORIZED' ? 401 : (result.status === 'INVALID_TOKEN' ? 403 : 400);
                        let code: ErrorCode = 'BAD_REQUEST';
                        if (result.status === 'UNAUTHORIZED') code = 'UNAUTHORIZED';
                        else if (result.status === 'INVALID_TOKEN') code = 'INVALID_TOKEN';
                        this.sendError(res, statusCode, code, result.message || 'Heartbeat failed');
                    }
                } catch (err: any) {
                    this.sendError(res, 500, 'SERVER_ERROR', err.message || 'Internal heartbeat error');
                }
                return;
            }

            // Admin: Inject Failure
            if (pathname === '/api/v1/admin/failures/inject' || pathname === '/api/v1/failures/inject') {
                const { type, scope, ttlSeconds, correlationId } = payload;
                if (!type || !scope) {
                    this.sendError(res, 400, 'BAD_REQUEST', 'Fields type and scope are required.');
                    return;
                }
                try {
                    this.controller.injectFailure(type as FailureType, scope as FailureScope, ttlSeconds, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Successfully injected failure: ${type}` });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Clear Failure
            if (pathname === '/api/v1/admin/failures/clear' || pathname === '/api/v1/failures/clear') {
                const { type, correlationId } = payload;
                if (!type) {
                    this.sendError(res, 400, 'BAD_REQUEST', 'Field type is required.');
                    return;
                }
                try {
                    this.controller.clearFailure(type as FailureType, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Successfully cleared failure: ${type}` });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Clear All Failures
            if (pathname === '/api/v1/admin/failures/clear-all' || pathname === '/api/v1/failures/clear-all') {
                const { correlationId } = payload;
                try {
                    this.controller.clearAllFailures(correlationId);
                    this.sendJson(res, 200, { success: true, message: 'Cleared all injected failures' });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Execute Infrastructure Command
            if (pathname === '/api/v1/admin/infra/command' || pathname === '/api/v1/infra/command') {
                const { command, correlationId } = payload;
                if (!command) {
                    this.sendError(res, 400, 'BAD_REQUEST', 'Field command is required.');
                    return;
                }
                try {
                    await this.controller.executeInfraCommand(command as SystemCommand, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Command executed: ${command}` });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Run Operations Scenario
            if (pathname === '/api/v1/admin/operations/run' || pathname === '/api/v1/operations/run') {
                const { scenario, tradeId, symbol, timestampOffset, correlationId } = payload;
                if (!scenario) {
                    this.sendError(res, 400, 'BAD_REQUEST', 'Field scenario is required.');
                    return;
                }
                try {
                    await this.controller.runOperationsScenario(
                        scenario as OperationScenario,
                        { tradeId, symbol, timestampOffset: timestampOffset ? Number(timestampOffset) : undefined },
                        correlationId
                    );
                    this.sendJson(res, 200, { success: true, message: `Successfully executed operations scenario: ${scenario}` });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Reset Operations Simulation Lab
            if (pathname === '/api/v1/admin/operations/reset' || pathname === '/api/v1/dev/lab/reset' || pathname === '/api/v1/qa/reset') {
                const { correlationId } = payload;
                try {
                    await this.controller.resetSimulationLab(correlationId);
                    this.sendJson(res, 200, { success: true, message: 'Successfully reset operations simulation lab' });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Admin: Retry Failed Outbox Entries
            if (pathname === '/api/v1/admin/outbox/retry-failed' || pathname === '/api/v1/dev/outbox/retry-failed') {
                try {
                    const ids = payload.ids;
                    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'number'))) {
                        this.sendError(res, 400, 'BAD_REQUEST', 'Field "ids" must be an array of numbers.');
                        return;
                    }

                    const count = await this.controller.retryFailedOutbox(ids);
                    this.sendJson(res, 200, {
                        success: true,
                        retried: count,
                        status: 'QUEUED'
                    });
                } catch (err: any) {
                    this.sendError(res, 403, 'FORBIDDEN', err.message);
                }
                return;
            }

            // Agent: Ingest Incidents
            if (pathname === '/api/v1/agent/incidents') {
                if (rawUrl.includes('fail=true') || req.headers['x-mock-fail'] === 'true') {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mock cloud gateway internal failure' }));
                    return;
                }

                const authResult = await this.authenticateAgent(req);
                if (!authResult.success) {
                    this.sendJson(res, authResult.statusCode, authResult.body);
                    return;
                }

                const agentId = authResult.agent.id;

                console.log(`======================================================
INCIDENT RECEIVED
======================================================
Hostname   : ${authResult.agent.hostname}
Machine    : ${authResult.agent.machineId}
Agent      : ${agentId}

Incident   : ${payload.incident?.incidentId || 'unknown'}
Severity   : ${payload.incident?.level || 'unknown'}
Transition : ${payload.event || 'unknown'}
======================================================`);

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true }));
                return;
            }

            // Agent: Ingest Alerts
            if (pathname === '/api/v1/agent/alerts') {
                return this.handleAgentAlert(req, res, payload);
            }
        }

        // Endpoint 404 fallback
        this.sendError(res, 404, 'NOT_FOUND', 'Not Found');
    }

    private async handleAgentAlert(req: http.IncomingMessage, res: http.ServerResponse, payload: any): Promise<void> {
        if (req.url?.includes('fail=true') || req.headers['x-mock-fail'] === 'true') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mock cloud gateway internal failure' }));
            return;
        }

        const authResult = await this.authenticateAgent(req);
        if (!authResult.success) {
            this.sendJson(res, authResult.statusCode, authResult.body);
            return;
        }

        if (payload.alert) {
            console.log(`======================================================
ALERT RECEIVED
======================================================
Hostname : ${authResult.agent.hostname}
Machine  : ${authResult.agent.machineId}

Severity : ${payload.alert.level || 'unknown'}
Title    : ${payload.alert.title || 'unknown'}
======================================================`);
            this.dispatchTelegramAlert(payload.alert).catch(err => {
                console.error('[MockCloudGateway] Failed to dispatch Telegram alert:', err);
            });
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
    }

    private handleSseStream(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('\n');

        // Flush past timeline events immediately to historical context
        const initial = this.gateway.getInitialEvents();
        for (const msg of initial) {
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }

        // Store client
        this.sseClients.add(res);

        // Stream new events
        const stopStream = this.gateway.startStreaming((msg) => {
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
        });

        req.on('close', () => {
            stopStream();
            this.sseClients.delete(res);
        });
    }

    private broadcastSseHeartbeat(): void {
        for (const client of this.sseClients) {
            client.write(':ping\n\n');
        }
    }

    private async authenticateAgent(
        req: http.IncomingMessage
    ): Promise<
        | { success: true; agent: Agent }
        | { success: false; statusCode: number; body: ErrorResponse }
    > {
        const headerAgentId = req.headers['x-agent-id'] as string | undefined;
        const headerSecret = req.headers['x-agent-secret'] as string | undefined;

        if (!headerAgentId || !headerSecret) {
            return {
                success: false,
                statusCode: 401,
                body: {
                    success: false,
                    status: 'UNAUTHORIZED',
                    message: 'Authentication headers X-Agent-Id and X-Agent-Secret are required.',
                    error: {
                        code: 'UNAUTHORIZED',
                        message: 'Authentication headers X-Agent-Id and X-Agent-Secret are required.'
                    }
                }
            };
        }

        try {
            const agent = await prisma.agent.findUnique({
                where: { id: headerAgentId }
            });

            if (!agent) {
                console.warn(`[Authentication] Agent not found in DB: ${headerAgentId}`);
                return {
                    success: false,
                    statusCode: 403,
                    body: {
                        success: false,
                        status: 'INVALID_TOKEN',
                        message: 'Agent not found.',
                        error: {
                            code: 'INVALID_TOKEN',
                            message: 'Agent not found.'
                        }
                    }
                };
            }

            if (agent.agentSecret !== headerSecret) {
                console.warn(`[Authentication] Secret mismatch for agent ID: ${agent.id}`);
                return {
                    success: false,
                    statusCode: 401,
                    body: {
                        success: false,
                        status: 'UNAUTHORIZED',
                        message: 'Authentication secret mismatch.',
                        error: {
                            code: 'UNAUTHORIZED',
                            message: 'Authentication secret mismatch.'
                        }
                    }
                };
            }

            return { success: true, agent };
        } catch (err: any) {
            console.error(`[Authentication] Database error: ${err.message}`);
            return {
                success: false,
                statusCode: 403,
                body: {
                    success: false,
                    status: 'INVALID_TOKEN',
                    message: 'Agent lookup error (invalid ID format).',
                    error: {
                        code: 'INVALID_TOKEN',
                        message: 'Agent lookup error (invalid ID format).'
                    }
                }
            };
        }
    }

    private sendJson(res: http.ServerResponse, statusCode: number, payload: any): void {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...payload, timestamp: Date.now() }));
    }

    private sendError(res: http.ServerResponse, statusCode: number, code: ErrorCode, message: string, details?: Record<string, unknown>): void {
        this.sendJson(res, statusCode, {
            success: false,
            status: code,
            message,
            error: {
                code,
                message,
                details
            }
        });
    }

    private readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => resolve(body));
        });
    }

    private async dispatchTelegramAlert(alert: any): Promise<void> {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!token || !chatId) {
            console.warn('[MockCloudGateway] Telegram credentials are missing on the central mock server. Suppressing message forwarding.');
            return;
        }

        const emojiMap: Record<string, string> = {
            CRITICAL: '🚨',
            WARNING: '⚠️',
            INFO: 'ℹ️'
        };

        const emoji = emojiMap[alert.level] || '🔔';
        const formattedText = `☁️ *[Cloud Dispatch]* ${emoji} *[${alert.level}] ${alert.title}*\n\n${alert.message}\n\n_System Time: ${new Date().toISOString()}_`;

        try {
            const url = `https://api.telegram.org/bot${token}/sendMessage`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: formattedText,
                    parse_mode: 'Markdown'
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error(`[MockCloudGateway] Telegram dispatch error: ${response.status}`, errorBody);
            } else {
                console.log(`[MockCloudGateway] Telegram alert successfully dispatched centrally for: ${alert.title}`);
            }
        } catch (err: any) {
            console.error('[MockCloudGateway] Telegram network call failed:', err?.message || err);
        }
    }
}
