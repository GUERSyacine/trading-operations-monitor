import { prisma } from '../shared/prisma';
import { AlertingService } from './notification/AlertingService';
import { IncidentManager } from './incident/manager/IncidentManager';
import { InfrastructureWatchdogService } from './detectors/infrastructure/InfrastructureWatchdogService';
import { OperationsWatchdogService } from './detectors/operations/OperationsWatchdogService';
import { RuntimeMonitorService } from './detectors/operations/RuntimeMonitorService';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { FreqtradeAdapter } from './adapters/freqtrade/FreqtradeAdapter';
import { FreqtradeWebhookReceiver } from './detectors/infrastructure/FreqtradeWebhookReceiver';
import { FreqtradeWebSocketAdapter } from './detectors/infrastructure/FreqtradeWebSocketAdapter';
import { LifecycleAnomalyDetector } from './incident/manager/LifecycleAnomalyDetector';
import { MVP_CONFIG } from '../shared/mvpConfig';

// Developer Console Core Imports
import { EventBus } from '../shared/services/EventBus';
import { CommandRunner } from '../cloud/developer/CommandRunner';
import { InfrastructureController } from '../cloud/developer/InfrastructureController';
import { FailureInjectionService } from '../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../shared/services/FeatureFlagService';
import { DeveloperConsoleGateway } from '../cloud/developer/DeveloperConsoleGateway';
import { DeveloperConsoleController } from '../cloud/developer/DeveloperConsoleController';
import { DeveloperConsoleServer } from '../cloud/developer/DeveloperConsoleServer';
import { OperationsSimulationService } from '../cloud/developer/OperationsSimulationService';

import { DefaultMachineInfoProvider } from '../shared/contracts/DefaultMachineInfoProvider';
import { OutboxPublisher } from './incident/outbox/OutboxPublisher';
import { OutboxSyncWorker } from './incident/outbox/OutboxSyncWorker';

// Agent Identity & Telemetry Imports
import { IdentityStore } from './identity/IdentityStore';
import { CloudAgentClient } from './identity/CloudAgentClient';
import { AgentIdentityService } from './identity/AgentIdentityService';
import { AgentHeartbeatScheduler } from './identity/AgentHeartbeatScheduler';

export class WatchdogOrchestrator {
    private alertingService: AlertingService;
    private incidentManager: IncidentManager;
    private syncWorker: OutboxSyncWorker;
    private infraService: InfrastructureWatchdogService;
    private opsService: OperationsWatchdogService;
    private runtimeService: RuntimeMonitorService;
    private freqtradeAdapter: FreqtradeAdapter;
    private webhookReceiver: FreqtradeWebhookReceiver;
    private freqtradeWsAdapter: FreqtradeWebSocketAdapter;
    private anomalyDetector: LifecycleAnomalyDetector;
    private startedAt = Date.now();

    // Developer Console Server
    private devConsoleServer: DeveloperConsoleServer;

    // Agent Identity & Heartbeat Services
    private identityService: AgentIdentityService;
    private heartbeatScheduler: AgentHeartbeatScheduler;

    // Concurrency flags
    private infraRunning = false;
    private opsRunning = false;
    private runtimeRunning = false;
    private resolutionRunning = false;
    private anomalyRunning = false;

    // Schedulers
    private infraInterval?: NodeJS.Timeout;
    private opsInterval?: NodeJS.Timeout;
    private runtimeInterval?: NodeJS.Timeout;
    private resolutionInterval?: NodeJS.Timeout;
    private anomalyInterval?: NodeJS.Timeout;

    constructor() {
        const persistence = new EventPersistenceService();
        const operationsSimulationService = new OperationsSimulationService(persistence);

        // Instantiate Developer Console Services first for constructor injection
        const eventBus = EventBus.getInstance();
        const cmdRunner = new CommandRunner();
        const infraController = new InfrastructureController(cmdRunner, eventBus);
        const failureService = new FailureInjectionService(eventBus);
        const featureFlagService = new FeatureFlagService(eventBus);
        const devConsoleGateway = new DeveloperConsoleGateway(eventBus);

        const machineProvider = new DefaultMachineInfoProvider(
            () => this.identityService?.getIdentity()?.machineId || this.identityService?.getActiveMachineId()
        );
        const outboxPublisher = new OutboxPublisher(machineProvider);
        this.alertingService = new AlertingService({ flags: featureFlagService, outboxPublisher });
        this.incidentManager = new IncidentManager(this.alertingService, outboxPublisher);
        this.infraService = new InfrastructureWatchdogService(this.alertingService, failureService, featureFlagService);

        const ftUrl = process.env.FREQTRADE_API_URL || 'http://localhost:8080/api/v1';
        const ftUser = process.env.FREQTRADE_API_USERNAME || 'freqtrader';
        const ftPass = process.env.FREQTRADE_API_PASSWORD || 'password123';
        const ftIntervalMs = Number(process.env.FREQTRADE_ADAPTER_INTERVAL_MS) || 15000;

        this.freqtradeAdapter = new FreqtradeAdapter(
            {
                baseUrl: ftUrl,
                username: ftUser,
                password: ftPass,
                pollIntervalMs: ftIntervalMs
            },
            persistence,
            featureFlagService
        );

        this.opsService = new OperationsWatchdogService(
            this.alertingService,
            this.incidentManager,
            this.freqtradeAdapter,
            MVP_CONFIG.OPERATIONS.HEARTBEAT_TIMEOUT_MS,
            failureService,
            featureFlagService
        );

        const devConsoleController = new DeveloperConsoleController(
            failureService,
            featureFlagService,
            infraController,
            operationsSimulationService
        );
        this.devConsoleServer = new DeveloperConsoleServer(
            devConsoleController,
            devConsoleGateway
        );

        // Instantiate Agent Identity & Heartbeat
        const identityStore = new IdentityStore();
        const cloudAgentClient = new CloudAgentClient();
        this.identityService = new AgentIdentityService(
            identityStore,
            cloudAgentClient,
            MVP_CONFIG.AGENT.LICENSE_TOKEN
        );
        this.heartbeatScheduler = new AgentHeartbeatScheduler(
            this.identityService,
            cloudAgentClient,
            MVP_CONFIG.AGENT.HEARTBEAT_INTERVAL_MS
        );

        this.runtimeService = new RuntimeMonitorService(this.alertingService);
        this.webhookReceiver = new FreqtradeWebhookReceiver(persistence);

        const ftWsToken = process.env.FREQTRADE_WS_TOKEN || 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg';
        this.freqtradeWsAdapter = new FreqtradeWebSocketAdapter(
            {
                baseUrl: ftUrl,
                wsToken: ftWsToken
            },
            persistence,
            featureFlagService,
            eventBus
        );

        this.anomalyDetector = new LifecycleAnomalyDetector(this.incidentManager);
        this.syncWorker = new OutboxSyncWorker(
            undefined, // cloudGatewayUrl
            undefined, // syncIntervalMs
            undefined, // maxAttempts
            undefined, // backoffBaseMs
            undefined, // batchSize
            undefined, // timeoutMs
            () => this.identityService?.getIdentity()?.agentId,
            () => this.identityService?.getIdentity()?.agentSecret,
            () => MVP_CONFIG.AGENT.VERSION,
            () => MVP_CONFIG.AGENT.CAPABILITIES
        );
    }


    /**
     * Startup verification: fail-fast on database configuration or connection failure.
     */
    async validateStartup(): Promise<void> {
        console.log('[Orchestrator] Starting verification of system requirements...');

        if (!process.env.DATABASE_URL) {
            throw new Error('Startup validation failed: DATABASE_URL environment variable is missing.');
        }

        try {
            // Attempt to connect to Postgres/Prisma database
            await prisma.$connect();
            console.log('[Orchestrator] Database connection verified successfully.');
        } catch (err: any) {
            throw new Error(`Startup validation failed: Could not establish connection to the database. Error: ${err.message || err}`);
        }

        if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
            console.warn('[Orchestrator] WARNING: Telegram credentials (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) are missing. Central Mock Cloud Gateway will not forward notifications.');
        } else {
            console.log('[Orchestrator] Central Mock Cloud Gateway Telegram credentials verified.');
        }
    }

    /**
     * Startup the orchestrator loop schedulers.
     */
    async start(): Promise<void> {
        await this.validateStartup();
        this.startedAt = Date.now();

        console.log('[Orchestrator] Hydrating active incident engine state...');
        await this.incidentManager.init();

        console.log('[Orchestrator] Starting Freqtrade Ingestion Adapter...');
        this.freqtradeAdapter.start();

        console.log('[Orchestrator] Starting Freqtrade Webhook Receiver...');
        this.webhookReceiver.start();

        console.log('[Orchestrator] Starting Freqtrade WebSocket Ingestion Adapter...');
        this.freqtradeWsAdapter.connect();

        const startConsole = process.env.WATCHDOG_START_DEV_CONSOLE !== 'false';
        if (startConsole) {
            console.log('[Orchestrator] Starting Developer Control Console...');
            this.devConsoleServer.start();
        } else {
            console.log('[Orchestrator] Standing alone: Skipping Developer Control Console local start.');
        }

        console.log('[Orchestrator] Starting Outbox Sync Worker...');
        this.syncWorker.start();

        console.log('[Orchestrator] Initializing Agent Identity Service...');
        this.identityService.initialize().catch((err) => {
            console.error('[Orchestrator] Failed to initialize Agent Identity Service:', err?.message || err);
        });

        console.log('[Orchestrator] Starting Agent Heartbeat Scheduler...');
        this.heartbeatScheduler.start();

        console.log('[Orchestrator] Launching scheduler intervals...');

        // 1. Infrastructure checks (Default: 60s)
        const infraTime = Number(process.env.WATCHDOG_INFRA_INTERVAL_MS) || 60_000;
        this.infraInterval = setInterval(() => this.runInfraLoop(), infraTime);

        // 2. Operations checks (Default: 30s)
        const opsTime = Number(process.env.WATCHDOG_OPS_INTERVAL_MS) || 30_000;
        this.opsInterval = setInterval(() => this.runOpsLoop(), opsTime);

        // 3. Runtime Strategy Performance checks (Default: 1 Hour)
        const runtimeTime = Number(process.env.WATCHDOG_RUNTIME_INTERVAL_MS) || 3_600_000;
        this.runtimeInterval = setInterval(() => this.runRuntimeLoop(), runtimeTime);

        // 4. Incident Auto-Resolution check (Default: 30s)
        const resolutionTime = Number(process.env.WATCHDOG_RESOLUTION_INTERVAL_MS) || 30_000;
        this.resolutionInterval = setInterval(() => this.runResolutionLoop(), resolutionTime);

        // 5. Lifecycle Anomaly Detector check (Default: 30s)
        const anomalyTime = Number(process.env.WATCHDOG_ANOMALY_INTERVAL_MS) || 30_000;
        this.anomalyInterval = setInterval(() => this.runAnomalyLoop(), anomalyTime);

        // Execute immediately on startup
        this.runInfraLoop().catch(err => console.error('[Orchestrator] Initial infra execution failure:', err));
        this.runOpsLoop().catch(err => console.error('[Orchestrator] Initial ops execution failure:', err));
        this.runAnomalyLoop().catch(err => console.error('[Orchestrator] Initial anomaly execution failure:', err));

        console.log('[Orchestrator] Watchdog Orchestrator initialized successfully.');
    }

    /**
     * Gracefully shutdown loop schedulers and disconnect prisma.
     */
    async stop(): Promise<void> {
        console.log('[Orchestrator] Initiating graceful shutdown...');

        console.log('[Orchestrator] Stopping Agent Heartbeat Scheduler...');
        this.heartbeatScheduler.stop();

        console.log('[Orchestrator] Stopping Agent Identity Service...');
        this.identityService.stop();

        const startConsole = process.env.WATCHDOG_START_DEV_CONSOLE !== 'false';
        if (startConsole) {
            console.log('[Orchestrator] Stopping Developer Control Console...');
            await this.devConsoleServer.stop();
        }

        console.log('[Orchestrator] Stopping Outbox Sync Worker...');
        this.syncWorker.stop();
        
        console.log('[Orchestrator] Stopping Freqtrade Ingestion Adapter...');
        this.freqtradeAdapter.stop();

        console.log('[Orchestrator] Stopping Freqtrade Webhook Receiver...');
        await this.webhookReceiver.stop();

        console.log('[Orchestrator] Stopping Freqtrade WebSocket Ingestion Adapter...');
        this.freqtradeWsAdapter.disconnect();

        if (this.infraInterval) clearInterval(this.infraInterval);
        if (this.opsInterval) clearInterval(this.opsInterval);
        if (this.runtimeInterval) clearInterval(this.runtimeInterval);
        if (this.resolutionInterval) clearInterval(this.resolutionInterval);
        if (this.anomalyInterval) clearInterval(this.anomalyInterval);

        try {
            await prisma.$disconnect();
            console.log('[Orchestrator] Database connection disconnected.');
        } catch (err: any) {
            console.error('[Orchestrator] Error during database disconnect:', err.message || err);
        }

        console.log('[Orchestrator] Shutdown complete.');
    }

    /**
     * Loop: Infrastructure Watchdog
     */
    private async runInfraLoop(): Promise<void> {
        if (this.infraRunning) {
            console.warn('[Orchestrator] Overlap detected: Infrastructure loop execution is already active. Skipping current run.');
            return;
        }
        this.infraRunning = true;
        try {
            console.log('[Orchestrator] Running Infrastructure Watchdog Checks...');
            
            const checks = [
                { name: 'VM Health', fn: () => this.infraService.checkVMHealth() },
                { name: 'Docker Health', fn: () => this.infraService.checkDockerContainerHealth() },
                { name: 'Freqtrade API', fn: () => this.infraService.checkFreqtradeAPI() },
                { name: 'Host Network', fn: () => this.infraService.checkHostNetwork() },
                { name: 'Exchange Reachability', fn: () => this.infraService.checkExchangeReachability() },
                { name: 'DNS Resolution', fn: () => this.infraService.checkDnsResolution() }
            ];

            for (const check of checks) {
                try {
                    const result = await check.fn();
                    if (!result.healthy) {
                        if (!result.severity) {
                            console.error(`[Orchestrator] [ERROR] HealthCheckResult from ${check.name} is unhealthy but missing severity!`);
                            continue;
                        }
                        await this.incidentManager.reportIncident({
                            level: result.severity,
                            source: result.source,
                            reason: result.message || `${check.name} critical failure`
                        });
                    } else {
                        await this.incidentManager.resolveIncidentBySource(result.source);
                    }
                } catch (e: any) {
                    console.error(`[Orchestrator] [ERROR] Infrastructure check failed (${check.name}):`, e.message || e);
                }
            }
        } catch (err: any) {
            console.error('[Orchestrator] Fatal error in Infrastructure loop root:', err.message || err);
        } finally {
            this.infraRunning = false;
        }
    }

    /**
     * Loop: Operations Watchdog
     */
    private async runOpsLoop(): Promise<void> {
        if (this.opsRunning) {
            console.warn('[Orchestrator] Overlap detected: Operations loop execution is already active. Skipping current run.');
            return;
        }
        this.opsRunning = true;
        try {
            const gracePeriod = Number(process.env.WATCHDOG_STARTUP_GRACE_PERIOD_MS) || 60_000;
            const isGraceActive = (Date.now() - this.startedAt) < gracePeriod;
            this.opsService.setStartupGraceActive(isGraceActive);

            console.log('[Orchestrator] Running Operations Watchdog Checks...');

            const coreChecks = [
                { name: 'Heartbeat', fn: () => this.opsService.checkHeartbeat() },
                { name: 'Broker Connection', fn: () => this.opsService.checkBrokerConnection() },
                { name: 'Order Pipeline', fn: () => this.opsService.checkOrderPipeline() },
                { name: 'Exchange Ack', fn: () => this.opsService.checkExchangeAck() }
            ];

            for (const check of coreChecks) {
                try {
                    await check.fn();
                } catch (e: any) {
                    console.error(`[Orchestrator] [ERROR] Operations check failed (${check.name}):`, e.message || e);
                }
            }

            try {
                await this.opsService.checkMarketDataFeed();
            } catch (e: any) {
                console.error('[Orchestrator] [ERROR] Operations check failed (Market Feed):', e.message || e);
            }

            const monitoredStrategies = (process.env.MONITORED_STRATEGIES || 'TREND_RIDER').split(',');
            for (const strat of monitoredStrategies) {
                const trimmed = strat.trim();
                if (!trimmed) continue;
                try {
                    await this.opsService.checkLatency(trimmed);
                    await this.opsService.checkTradeFrequency(trimmed);
                } catch (e: any) {
                    console.error(`[Orchestrator] [ERROR] Operations check failed (Strategy ${trimmed}):`, e.message || e);
                }
            }

        } catch (err: any) {
            console.error('[Orchestrator] Fatal error in Operations loop root:', err.message || err);
        } finally {
            this.opsRunning = false;
        }
    }

    /**
     * Loop: Runtime Performance Checks (Business KPIs)
     */
    private async runRuntimeLoop(): Promise<void> {
        if (this.runtimeRunning) {
            console.warn('[Orchestrator] Overlap detected: Runtime Performance loop is already active. Skipping current run.');
            return;
        }
        this.runtimeRunning = true;
        try {
            console.log('[Orchestrator] Running Runtime Strategy Performance Checks...');
            
            const monitoredStrategies = (process.env.MONITORED_STRATEGIES || 'TREND_RIDER').split(',');
            for (const strat of monitoredStrategies) {
                const trimmed = strat.trim();
                if (!trimmed) continue;
                try {
                    await this.runtimeService.checkTradeFrequency(trimmed);
                    await this.runtimeService.checkWinRate(trimmed);
                    await this.runtimeService.checkFillRate(trimmed);
                    await this.runtimeService.checkLatency(trimmed);
                } catch (e: any) {
                    console.error(`[Orchestrator] [ERROR] Runtime performance check failed (Strategy ${trimmed}):`, e.message || e);
                }
            }
        } catch (err: any) {
            console.error('[Orchestrator] Fatal error in Runtime loop root:', err.message || err);
        } finally {
            this.runtimeRunning = false;
        }
    }

    /**
     * Loop: Incident Manager Auto-Resolution Checks
     */
    private async runResolutionLoop(): Promise<void> {
        if (this.resolutionRunning) return;
        this.resolutionRunning = true;
        try {
            await this.incidentManager.checkAutoResolutions();
        } catch (err: any) {
            console.error('[Orchestrator] Error running Incident Auto-Resolution check:', err.message || err);
        } finally {
            this.resolutionRunning = false;
        }
    }

    /**
     * Loop: Lifecycle Anomaly Detector
     */
    private async runAnomalyLoop(): Promise<void> {
        if (this.anomalyRunning) {
            console.warn('[Orchestrator] Overlap detected: Anomaly loop execution is already active. Skipping current run.');
            return;
        }
        this.anomalyRunning = true;
        try {
            console.log('[Orchestrator] Running Lifecycle Anomaly Detector...');
            const stuckTimeout = Number(process.env.WATCHDOG_STUCK_TIMEOUT_MS) || 60_000;
            const lookback = Number(process.env.WATCHDOG_ANOMALY_LOOKBACK_MS) || 3_600_000;
            await this.anomalyDetector.checkAnomalies(stuckTimeout, lookback);
        } catch (err: any) {
            console.error('[Orchestrator] Fatal error in Anomaly loop:', err.message || err);
        } finally {
            this.anomalyRunning = false;
        }
    }
}
