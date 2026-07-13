import * as http from 'http';
import { DeveloperConsoleController } from './DeveloperConsoleController';
import { DeveloperConsoleGateway } from './DeveloperConsoleGateway';
import { DASHBOARD_HTML } from './dashboardHtml';
import { FailureType, FailureScope, FeatureFlag, SystemCommand, OperationScenario } from '../../shared/types/developer';
import { AgentStatusService } from './AgentStatusService';

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

    public start(): void {
        this.server = http.createServer(async (req, res) => {
            const url = req.url || '';
            const method = req.method || 'GET';

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
            if (url === '/' || url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(DASHBOARD_HTML);
                return;
            }

            // 2. Health Endpoint
            if (url === '/health' && method === 'GET') {
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

            // 3. SSE Stream
            if (url === '/api/v1/events/stream' && method === 'GET') {
                this.handleSseStream(req, res);
                return;
            }

            // 4. REST Router (Versioned)
            try {
                await this.handleRestRoute(req, res, url, method);
            } catch (err: any) {
                console.error(`[DevConsole] Error on route ${url}:`, err.message || err);
                this.sendJson(res, 500, { success: false, message: err.message || 'Internal Server Error' });
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

    private async handleRestRoute(req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string): Promise<void> {
        if (method === 'GET') {
            // Route 4.4a: Get Feature Flags
            if (url === '/api/v1/flags') {
                try {
                    const flags = this.controller.getAllFeatureFlags();
                    this.sendJson(res, 200, { success: true, data: flags });
                } catch (err: any) {
                    this.sendJson(res, 500, { success: false, message: err.message });
                }
                return;
            }
        }

        if (method === 'PUT') {
            // Route 4.4b: Update Feature Flag
            if (url.startsWith('/api/v1/flags/')) {
                const flagStr = url.substring('/api/v1/flags/'.length).toUpperCase();
                if (!Object.values(FeatureFlag).includes(flagStr as FeatureFlag)) {
                    this.sendJson(res, 400, { success: false, message: `Invalid flag: ${flagStr}` });
                    return;
                }

                const body = await this.readRequestBody(req);
                let payload: any;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (e) {
                    this.sendJson(res, 400, { success: false, message: 'Invalid JSON payload' });
                    return;
                }

                const { enabled, reason, correlationId } = payload;
                if (enabled === undefined) {
                    this.sendJson(res, 422, { success: false, message: 'Field "enabled" is required.' });
                    return;
                }

                try {
                    this.controller.setFeatureFlag(flagStr as FeatureFlag, enabled, reason, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Updated feature flag ${flagStr} to ${enabled}` });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
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
                this.sendJson(res, 400, { success: false, message: 'Invalid JSON payload' });
                return;
            }

            // Agent Registration Route
            if (url === '/api/v1/agents/register') {
                try {
                    const result = await this.controller.registerAgent(payload);
                    this.sendJson(res, result.success ? 200 : (result.status === 'INVALID_TOKEN' ? 403 : 400), result);
                } catch (err: any) {
                    this.sendJson(res, 500, { success: false, message: err.message || 'Internal registration error' });
                }
                return;
            }

            // Agent Heartbeat Route
            if (url === '/api/v1/agents/heartbeat') {
                const headerSecret = req.headers['x-agent-secret'] as string | undefined;
                try {
                    const result = await this.controller.receiveHeartbeat(payload, headerSecret);
                    this.sendJson(res, result.success ? 200 : (result.status === 'UNAUTHORIZED' ? 401 : (result.status === 'INVALID_TOKEN' ? 403 : 400)), result);
                } catch (err: any) {
                    this.sendJson(res, 500, { success: false, message: err.message || 'Internal heartbeat error' });
                }
                return;
            }

            // Route 4.1: Inject Failure
            if (url === '/api/v1/failures/inject') {
                const { type, scope, ttlSeconds, correlationId } = payload;
                if (!type || !scope) {
                    this.sendJson(res, 400, { success: false, message: 'Fields type and scope are required.' });
                    return;
                }
                try {
                    this.controller.injectFailure(type as FailureType, scope as FailureScope, ttlSeconds, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Successfully injected failure: ${type}` });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.2: Clear Failure
            if (url === '/api/v1/failures/clear') {
                const { type, correlationId } = payload;
                if (!type) {
                    this.sendJson(res, 400, { success: false, message: 'Field type is required.' });
                    return;
                }
                try {
                    this.controller.clearFailure(type as FailureType, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Successfully cleared failure: ${type}` });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.3: Clear All Failures
            if (url === '/api/v1/failures/clear-all') {
                const { correlationId } = payload;
                try {
                    this.controller.clearAllFailures(correlationId);
                    this.sendJson(res, 200, { success: true, message: 'Cleared all injected failures' });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.5: Execute Infrastructure Command
            if (url === '/api/v1/infra/command') {
                const { command, correlationId } = payload;
                if (!command) {
                    this.sendJson(res, 400, { success: false, message: 'Field command is required.' });
                    return;
                }
                try {
                    await this.controller.executeInfraCommand(command as SystemCommand, correlationId);
                    this.sendJson(res, 200, { success: true, message: `Command executed: ${command}` });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.6: Run Operations Scenario
            if (url === '/api/v1/operations/run') {
                const { scenario, tradeId, symbol, timestampOffset, correlationId } = payload;
                if (!scenario) {
                    this.sendJson(res, 400, { success: false, message: 'Field scenario is required.' });
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
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.7: Reset Operations Simulation Lab
            if (url === '/api/v1/operations/reset' || url === '/api/v1/dev/lab/reset') {
                const { correlationId } = payload;
                try {
                    await this.controller.resetSimulationLab(correlationId);
                    this.sendJson(res, 200, { success: true, message: 'Successfully reset operations simulation lab' });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }

            // Route 4.8: Mock Cloud Gateway Endpoint
            if (url.startsWith('/api/v1/cloud/incidents')) {
                if (url.includes('fail=true') || req.headers['x-mock-fail'] === 'true') {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mock cloud gateway internal failure' }));
                    return;
                }

                const type = payload.type;
                if (type !== 'INCIDENT' && type !== 'ALERT') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Bad Request: Unsupported payload type "${type}"` }));
                    return;
                }

                if (type === 'ALERT') {
                    if (payload.alert) {
                        console.log(`[MockCloudGateway] Received ALERT [${payload.alert.level}]: "${payload.alert.title}"`);
                        this.dispatchTelegramAlert(payload.alert).catch(err => {
                            console.error('[MockCloudGateway] Failed to dispatch Telegram alert:', err);
                        });
                    }
                } else if (type === 'INCIDENT') {
                    console.log(`[MockCloudGateway] Received INCIDENT transition [${payload.event}] for incident ${payload.incident?.incidentId}`);
                }

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true }));
                return;
            }

            // Route 4.9: Retry Failed Outbox Entries
            if (url === '/api/v1/dev/outbox/retry-failed') {
                try {
                    const ids = payload.ids;
                    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'number'))) {
                        this.sendJson(res, 400, { success: false, message: 'Field "ids" must be an array of numbers.' });
                        return;
                    }

                    const count = await this.controller.retryFailedOutbox(ids);
                    this.sendJson(res, 200, {
                        success: true,
                        retried: count,
                        status: 'QUEUED'
                    });
                } catch (err: any) {
                    this.sendJson(res, 403, { success: false, message: err.message });
                }
                return;
            }
        }

        if (method === 'GET') {
            // Route 4.6: Get Freqtrade Status
            if (url === '/api/v1/infra/status') {
                const status = await this.controller.getFreqtradeStatus();
                this.sendJson(res, 200, { success: true, message: 'Successfully fetched status', data: { status } });
                return;
            }
        }

        // Endpoint 404 fallback
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Not Found', timestamp: Date.now() }));
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

    private sendJson(res: http.ServerResponse, statusCode: number, payload: any): void {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...payload, timestamp: Date.now() }));
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
