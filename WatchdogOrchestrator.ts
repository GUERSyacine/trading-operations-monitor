import { prisma } from './prisma';
import { AlertingService } from './layer-D(notification)/alerting/AlertingService';
import { IncidentManager } from './layer-B(Assessement)/IncidentManager';
import { InfrastructureWatchdogService } from './layer-A(observation)/layer1(infrastructure_monitoring)/InfrastructureWatchdogService';
import { OperationsWatchdogService } from './layer-A(observation)/layer2(trading_operations_monitoring)/OperationsWatchdogService';
import { RuntimeMonitorService } from './runtime/RuntimeMonitorService';
import { EventPersistenceService } from './adapters/base/EventPersistenceService';
import { FreqtradeAdapter } from './adapters/freqtrade/FreqtradeAdapter';
import { FreqtradeWebhookReceiver } from './layer-A(observation)/layer1(infrastructure_monitoring)/FreqtradeWebhookReceiver';
import { FreqtradeWebSocketAdapter } from './layer-A(observation)/layer1(infrastructure_monitoring)/FreqtradeWebSocketAdapter';
import { LifecycleAnomalyDetector } from './layer-B(Assessement)/LifecycleAnomalyDetector';
import { MVP_CONFIG } from './mvpConfig';

// Developer Console Core Imports
import { EventBus } from './layer-A(observation)/developer-console/EventBus';
import { CommandRunner } from './layer-A(observation)/developer-console/CommandRunner';
import { InfrastructureController } from './layer-A(observation)/developer-console/InfrastructureController';
import { FailureInjectionService } from './layer-A(observation)/developer-console/FailureInjectionService';
import { FeatureFlagService } from './layer-A(observation)/developer-console/FeatureFlagService';
import { DeveloperConsoleGateway } from './layer-A(observation)/developer-console/DeveloperConsoleGateway';
import { DeveloperConsoleController } from './layer-A(observation)/developer-console/DeveloperConsoleController';
import { DeveloperConsoleServer } from './layer-A(observation)/developer-console/DeveloperConsoleServer';

export class WatchdogOrchestrator {
    private alertingService: AlertingService;
    private incidentManager: IncidentManager;
    private infraService: InfrastructureWatchdogService;
    private opsService: OperationsWatchdogService;
    private runtimeService: RuntimeMonitorService;
    private freqtradeAdapter: FreqtradeAdapter;
    private webhookReceiver: FreqtradeWebhookReceiver;
    private freqtradeWsAdapter: FreqtradeWebSocketAdapter;
    private anomalyDetector: LifecycleAnomalyDetector;

    // Developer Console Server
    private devConsoleServer: DeveloperConsoleServer;

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
        this.alertingService = new AlertingService();
        this.incidentManager = new IncidentManager(this.alertingService);
        this.infraService = new InfrastructureWatchdogService(this.alertingService);

        const ftUrl = process.env.FREQTRADE_API_URL || 'http://localhost:8080/api/v1';
        const ftUser = process.env.FREQTRADE_API_USERNAME || 'freqtrader';
        const ftPass = process.env.FREQTRADE_API_PASSWORD || 'password123';
        const ftIntervalMs = Number(process.env.FREQTRADE_ADAPTER_INTERVAL_MS) || 15000;

        const persistence = new EventPersistenceService();
        this.freqtradeAdapter = new FreqtradeAdapter(
            {
                baseUrl: ftUrl,
                username: ftUser,
                password: ftPass,
                pollIntervalMs: ftIntervalMs
            },
            persistence
        );

        this.opsService = new OperationsWatchdogService(
            this.alertingService,
            this.incidentManager,
            this.freqtradeAdapter,
            MVP_CONFIG.OPERATIONS.HEARTBEAT_TIMEOUT_MS
        );
        this.runtimeService = new RuntimeMonitorService(this.alertingService);
        this.webhookReceiver = new FreqtradeWebhookReceiver(persistence);

        const ftWsToken = process.env.FREQTRADE_WS_TOKEN || 'bUSvW1ejp16EhdFuhZB_E81ZEcZssGxVSg';
        this.freqtradeWsAdapter = new FreqtradeWebSocketAdapter(
            {
                baseUrl: ftUrl,
                wsToken: ftWsToken
            },
            persistence
        );

        this.anomalyDetector = new LifecycleAnomalyDetector(this.incidentManager);

        // Instantiate Developer Console Services
        const eventBus = EventBus.getInstance();
        const cmdRunner = new CommandRunner();
        const infraController = new InfrastructureController(cmdRunner, eventBus);
        const failureService = new FailureInjectionService(eventBus);
        const featureFlagService = new FeatureFlagService(eventBus);
        const devConsoleGateway = new DeveloperConsoleGateway(eventBus);
        const devConsoleController = new DeveloperConsoleController(
            failureService,
            featureFlagService,
            infraController
        );
        this.devConsoleServer = new DeveloperConsoleServer(
            devConsoleController,
            devConsoleGateway
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
            console.warn('[Orchestrator] WARNING: Telegram configuration env variables are missing. Notifications will fallback to local/DB logs only.');
        } else {
            console.log('[Orchestrator] Telegram credentials verified.');
        }
    }

    /**
     * Startup the orchestrator loop schedulers.
     */
    async start(): Promise<void> {
        await this.validateStartup();

        console.log('[Orchestrator] Hydrating active incident engine state...');
        await this.incidentManager.init();

        console.log('[Orchestrator] Starting Freqtrade Ingestion Adapter...');
        this.freqtradeAdapter.start();

        console.log('[Orchestrator] Starting Freqtrade Webhook Receiver...');
        this.webhookReceiver.start();

        console.log('[Orchestrator] Starting Freqtrade WebSocket Ingestion Adapter...');
        this.freqtradeWsAdapter.connect();

        console.log('[Orchestrator] Starting Developer Control Console...');
        this.devConsoleServer.start();

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

        console.log('[Orchestrator] Stopping Developer Control Console...');
        await this.devConsoleServer.stop();
        
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
                    await check.fn();
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
