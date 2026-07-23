import { prisma } from '../shared/prisma';
import { promises as fs } from 'fs';
import * as path from 'path';
import { MVP_CONFIG } from '../shared/mvpConfig';
import { IdentityStore } from '../agent/identity/IdentityStore';
import { CloudAgentClient } from '../agent/identity/CloudAgentClient';
import { AgentIdentityService } from '../agent/identity/AgentIdentityService';
import { AgentHeartbeatScheduler } from '../agent/identity/AgentHeartbeatScheduler';
import { AgentConfigurationManager } from '../agent/identity/AgentConfigurationManager';
import { AgentConfigurationScheduler } from '../agent/identity/AgentConfigurationScheduler';
import { DeveloperConsoleController } from '../cloud/developer/DeveloperConsoleController';
import { DeveloperConsoleGateway } from '../cloud/developer/DeveloperConsoleGateway';
import { DeveloperConsoleServer } from '../cloud/developer/DeveloperConsoleServer';
import { OperationsSimulationService } from '../cloud/developer/OperationsSimulationService';
import { EventPersistenceService } from '../shared/services/EventPersistenceService';
import { EventBus } from '../shared/services/EventBus';
import { CommandRunner } from '../cloud/developer/CommandRunner';
import { InfrastructureController } from '../cloud/developer/InfrastructureController';
import { FailureInjectionService } from '../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../shared/services/FeatureFlagService';
import { AgentStatusService } from '../cloud/developer/AgentStatusService';
import { DefaultMachineInfoProvider } from '../shared/contracts/DefaultMachineInfoProvider';

async function runIdentityIntegrationSuite() {
    console.log('🧪 Starting Agent Identity Integration Test Suite...');

    // 1. Clean slate: purge old agent/heartbeat data
    console.log('[TestSetup] Purging agents, heartbeats, tokens...');
    await prisma.agentHeartbeat.deleteMany({});
    await prisma.agent.deleteMany({});
    await prisma.registrationToken.deleteMany({});

    // Create a fresh test token
    const token = 'TEST-TOKEN-123';
    await prisma.registrationToken.create({
        data: {
            token,
            maxAgents: 2,
            status: 'ACTIVE'
        }
    });

    const testStorePath = path.resolve(process.cwd(), '.test-agent-identity-flow.json');
    try {
        await fs.unlink(testStorePath);
    } catch {}

    // 2. Start Developer Console Server on a custom port
    const testPort = 3333;
    const persistence = new EventPersistenceService();
    const opsSim = new OperationsSimulationService(persistence);
    const eventBus = EventBus.getInstance();
    const cmdRunner = new CommandRunner();
    const infraCtrl = new InfrastructureController(cmdRunner, eventBus);
    const failures = new FailureInjectionService(eventBus);
    const flags = new FeatureFlagService(eventBus);
    const gateway = new DeveloperConsoleGateway(eventBus);

    const controller = new DeveloperConsoleController(failures, flags, infraCtrl, opsSim);
    let server = new DeveloperConsoleServer(controller, gateway, testPort, '127.0.0.1');

    console.log('[TestServer] Starting test gateway server...');
    server.start();

    // Give the server a small moment to boot
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
        // 3. Initial Registration Flow
        console.log('[TestAgent] Initializing identity store and client...');
        const store = new IdentityStore(testStorePath);
        const client = new CloudAgentClient(`http://127.0.0.1:${testPort}`);
        const service = new AgentIdentityService(store, client, token);

        console.log('[TestAgent] Starting AgentIdentityService...');
        const initResultImmediate = await service.initialize();
        if (initResultImmediate) {
            throw new Error('Assertion Failed: initial initialization should return false (non-blocking bg register).');
        }

        // Poll for registration completion
        console.log('[TestAgent] Waiting for registration to succeed...');
        let registered = false;
        for (let i = 0; i < 20; i++) {
            if (service.isRegistered()) {
                registered = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (!registered) {
            throw new Error('Assertion Failed: Agent failed to register within timeout.');
        }

        const identity = service.getIdentity();
        if (!identity || !identity.agentId || !identity.agentSecret) {
            throw new Error('Assertion Failed: Identity missing agentId or agentSecret.');
        }

        // Verify file contents
        const fileContentStr = await fs.readFile(testStorePath, 'utf-8');
        const fileJson = JSON.parse(fileContentStr);
        if (fileJson.licenseToken !== undefined) {
            throw new Error('Assertion Failed: licenseToken should NOT be cached in identity JSON file.');
        }
        if (!fileJson.agentId || !fileJson.agentSecret || !fileJson.machineId) {
            throw new Error('Assertion Failed: Cached file missing agentId, agentSecret or machineId.');
        }

        console.log('✅ Initial registration verified successfully.');

        // 4. Idempotency Check
        console.log('[TestAgent] Checking identity idempotency...');
        const secondServiceInstance = new AgentIdentityService(store, client, token);
        const secondInitResult = await secondServiceInstance.initialize();
        if (!secondInitResult) {
            throw new Error('Assertion Failed: second initialize with cached credentials should return true immediately.');
        }

        const totalAgents = await prisma.agent.count();
        if (totalAgents !== 1) {
            throw new Error(`Assertion Failed: Expected exactly 1 agent record in DB, got ${totalAgents}`);
        }
        console.log('✅ Idempotency verified successfully (credentials reused, no duplicate agents).');

        // 5. Fresh Install Re-registration
        console.log('[TestAgent] Deleting cached identity to simulate fresh install...');
        await fs.unlink(testStorePath);

        const thirdServiceInstance = new AgentIdentityService(store, client, token);
        await thirdServiceInstance.initialize();

        // Wait for registration
        let thirdRegistered = false;
        for (let i = 0; i < 20; i++) {
            if (thirdServiceInstance.isRegistered()) {
                thirdRegistered = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (!thirdRegistered) {
            throw new Error('Assertion Failed: Re-registration failed after cache deletion.');
        }

        const totalAgentsAfterFreshInstall = await prisma.agent.count();
        if (totalAgentsAfterFreshInstall !== 2) {
            throw new Error(`Assertion Failed: Expected exactly 2 agent records in DB, got ${totalAgentsAfterFreshInstall}`);
        }
        console.log('✅ Fresh install recovery and re-registration verified successfully.');

        // 6. Heartbeat Validation
        console.log('[TestAgent] Gaining telemetry and submitting heartbeat...');
        const scheduler = new AgentHeartbeatScheduler(thirdServiceInstance, client, 15000);
        scheduler.start();

        // Wait a bit for the automatic background heartbeat cycle to finish
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const heartbeatsCount = await prisma.agentHeartbeat.count();
        if (heartbeatsCount !== 1) {
            throw new Error(`Assertion Failed: Expected exactly 1 heartbeat record, got ${heartbeatsCount}`);
        }

        const hb = await prisma.agentHeartbeat.findFirst({});
        if (!hb) {
            throw new Error('Assertion Failed: AgentHeartbeat record not found.');
        }

        if (hb.agentVersion !== MVP_CONFIG.AGENT.VERSION) {
            throw new Error(`Assertion Failed: Invalid heartbeat version: ${hb.agentVersion}`);
        }
        if (Number(hb.cpuPct) < 0 || Number(hb.cpuPct) > 100) {
            throw new Error(`Assertion Failed: CPU percent out of range: ${hb.cpuPct}`);
        }
        if (!hb.databaseHealthy || !hb.freqtradeHealthy) {
            throw new Error('Assertion Failed: Expected healthy state database & freqtrade indicators.');
        }

        console.log('✅ Telemetry collection and heartbeat formatting verified.');

        // 7. Security Check (Revocation / Secret Mismatch)
        console.log('[TestSecurity] Sending heartbeat request with modified secret...');
        const rogueReq = {
            agentId: thirdServiceInstance.getIdentity()!.agentId,
            agentSecret: 'WRONG-SECRET',
            hostname: 'rogue-host',
            version: MVP_CONFIG.AGENT.VERSION,
            capabilities: MVP_CONFIG.AGENT.CAPABILITIES,
            status: 'ONLINE',
            uptime: 120,
            metrics: { cpuPct: 10, memoryPct: 15, diskPct: 20 },
            health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
        };

        const rogueResponse = await client.heartbeat(rogueReq);
        if (rogueResponse.success || rogueResponse.status !== 'UNAUTHORIZED') {
            throw new Error(`Assertion Failed: Rogue heartbeat should be rejected with UNAUTHORIZED status, got: ${rogueResponse.status}`);
        }
        console.log('✅ Heartbeat security mismatch (403/UNAUTHORIZED) verified successfully.');

        // 8. Cloud Offline Resilience
        console.log('[TestResilience] Stopping Cloud server to simulate gateway downtime...');
        scheduler.stop();
        thirdServiceInstance.stop();
        await server.stop();

        // Give server a bit of time to stop
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Submit heartbeat while offline
        console.log('[TestResilience] Sending heartbeat while gateway is offline...');
        const offlineResponse = await client.heartbeat(rogueReq);
        if (offlineResponse.success || offlineResponse.status !== 'NETWORK_ERROR') {
            throw new Error(`Assertion Failed: Heartbeat should return NETWORK_ERROR when server is down, got ${offlineResponse.status}`);
        }
        console.log('✅ Offline agent resilience verified successfully (handled without crashing).');

        // 9. Cloud Recovery
        console.log('[TestResilience] Restarting server to simulate gateway recovery...');
        server = new DeveloperConsoleServer(controller, gateway, testPort, '127.0.0.1');
        server.start();

        await new Promise((resolve) => setTimeout(resolve, 500));

        const recoveryReq = {
            agentId: thirdServiceInstance.getIdentity()!.agentId,
            agentSecret: thirdServiceInstance.getIdentity()!.agentSecret,
            hostname: 'recovered-host',
            version: MVP_CONFIG.AGENT.VERSION,
            capabilities: MVP_CONFIG.AGENT.CAPABILITIES,
            status: 'ONLINE',
            uptime: 150,
            metrics: { cpuPct: 12, memoryPct: 18, diskPct: 22 },
            health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
        };

        console.log('[TestResilience] Dispatching heartbeat post-recovery...');
        const recoveryResponse = await client.heartbeat(recoveryReq);
        if (!recoveryResponse.success) {
            throw new Error(`Assertion Failed: Recovered heartbeat failed: ${recoveryResponse.message}`);
        }
        console.log('✅ Heartbeat recovered successfully.');

        // 10. Config Override Hooks
        console.log('[TestConfig] Setting custom server config overrides...');
        process.env.MOCK_CONFIG_OVERRIDES = '{"heartbeatIntervalMs": 5000, "customFlag": true}';

        const configOverrideResponse = await client.heartbeat(recoveryReq);
        if (!configOverrideResponse.success || !configOverrideResponse.configOverrides) {
            throw new Error('Assertion Failed: Config overrides not received.');
        }

        if (configOverrideResponse.configOverrides.heartbeatIntervalMs !== 5000) {
            throw new Error(`Assertion Failed: Expected heartbeatIntervalMs 5000, got ${configOverrideResponse.configOverrides.heartbeatIntervalMs}`);
        }
        console.log('✅ Config overrides received by agent successfully:', JSON.stringify(configOverrideResponse.configOverrides));
        delete process.env.MOCK_CONFIG_OVERRIDES;

        // C6 Configuration Subsystem Integration Tests
        console.log('[TestConfigSubsystem] Verifying configuration endpoint and scheduler...');
        
        // Ensure mock config overrides environment variable is set
        process.env.MOCK_CONFIG_OVERRIDES = '{"heartbeatIntervalMs": 10000, "logLevel": "DEBUG"}';

        // 1. Initial configuration fetch
        const configReq = {
            agentId: thirdServiceInstance.getIdentity()!.agentId,
            agentSecret: thirdServiceInstance.getIdentity()!.agentSecret,
            version: MVP_CONFIG.AGENT.VERSION,
            capabilities: MVP_CONFIG.AGENT.CAPABILITIES
        };
        const initialConfigRes = await client.getConfig(configReq);
        if (!initialConfigRes.success) {
            throw new Error(`Assertion Failed: getConfig failed: ${initialConfigRes.message}`);
        }
        if (initialConfigRes.configurationRevision !== 1) {
            throw new Error(`Assertion Failed: Expected initial revision 1, got ${initialConfigRes.configurationRevision}`);
        }
        if (initialConfigRes.notModified) {
            throw new Error('Assertion Failed: Expected notModified to be false on initial call.');
        }
        if (initialConfigRes.configuration?.heartbeatIntervalMs !== 10000) {
            throw new Error(`Assertion Failed: Expected config value heartbeatIntervalMs 10000, got ${initialConfigRes.configuration?.heartbeatIntervalMs}`);
        }
        console.log('✅ C6: Initial config fetch and revision 1 verified.');

        // 2. Fetch config again with same revision -> notModified: true
        const cachedRevision = initialConfigRes.configurationRevision;
        const conditionalConfigRes = await client.getConfig({
            ...configReq,
            configurationRevision: cachedRevision
        });
        if (!conditionalConfigRes.success) {
            throw new Error(`Assertion Failed: conditional getConfig failed: ${conditionalConfigRes.message}`);
        }
        if (!conditionalConfigRes.notModified) {
            throw new Error('Assertion Failed: Expected notModified: true for same revision.');
        }
        if (conditionalConfigRes.configuration) {
            throw new Error('Assertion Failed: Expected configuration to be undefined/empty when notModified is true.');
        }
        console.log('✅ C6: Conditional fetch (304 Not Modified simulation) verified.');

        // 3. Update configuration -> revision increments monotonically
        process.env.MOCK_CONFIG_OVERRIDES = '{"heartbeatIntervalMs": 20000, "logLevel": "INFO"}';
        const updatedConfigRes = await client.getConfig({
            ...configReq,
            configurationRevision: cachedRevision
        });
        if (!updatedConfigRes.success) {
            throw new Error(`Assertion Failed: updated getConfig failed: ${updatedConfigRes.message}`);
        }
        if (updatedConfigRes.configurationRevision !== 2) {
            throw new Error(`Assertion Failed: Expected configurationRevision to increment to 2, got ${updatedConfigRes.configurationRevision}`);
        }
        if (updatedConfigRes.notModified) {
            throw new Error('Assertion Failed: Expected notModified: false after revision change.');
        }
        if (updatedConfigRes.configuration?.heartbeatIntervalMs !== 20000) {
            throw new Error(`Assertion Failed: Expected config value heartbeatIntervalMs 20000, got ${updatedConfigRes.configuration?.heartbeatIntervalMs}`);
        }
        console.log('✅ C6: Monotonic revision increment and conditional update retrieval verified.');

        // 4. Verify AgentConfigurationManager state management and AgentConfigurationScheduler loop
        const configManager = AgentConfigurationManager.getInstance();
        const configScheduler = new AgentConfigurationScheduler(thirdServiceInstance, client, 5000);
        
        // Mark as running so syncConfig executes, but DO NOT start the background loops/timers
        (configScheduler as any).isRunning = true;
        // Manually trigger configuration synchronization
        await configScheduler.syncConfig();

        const activeConfig = configManager.getAppliedConfig();
        const activeRevision = configManager.getRevision();
        const activeStatus = configManager.getSyncStatus();

        if (activeRevision !== 2) {
            throw new Error(`Assertion Failed: Expected Manager revision 2, got ${activeRevision}`);
        }
        if (activeConfig.heartbeatIntervalMs !== 20000) {
            throw new Error(`Assertion Failed: Expected Manager config heartbeatIntervalMs 20000, got ${activeConfig.heartbeatIntervalMs}`);
        }
        if (activeStatus.syncStatus !== 'SUCCESS') {
            throw new Error(`Assertion Failed: Expected Manager syncStatus SUCCESS, got ${activeStatus.syncStatus}`);
        }
        if (!activeStatus.lastSuccessfulSync || !activeStatus.lastUpdated) {
            throw new Error('Assertion Failed: Expected lastSuccessfulSync and lastUpdated to be populated.');
        }
        if (activeStatus.consecutiveFailures !== 0) {
            throw new Error(`Assertion Failed: Expected 0 consecutive failures, got ${activeStatus.consecutiveFailures}`);
        }
        console.log('✅ C6: AgentConfigurationManager integration and active status verified.');

        // 5. Test consecutive failures on network/server failure
        // Stop server temporarily
        configScheduler.stop();
        await server.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const failingScheduler = new AgentConfigurationScheduler(thirdServiceInstance, client, 1000);
        // Mark as running so syncConfig executes, but DO NOT start the background loops/timers
        (failingScheduler as any).isRunning = true;
        await failingScheduler.syncConfig();

        const failingStatus = configManager.getSyncStatus();
        if (failingStatus.syncStatus !== 'ERROR') {
            throw new Error(`Assertion Failed: Expected Manager syncStatus ERROR, got ${failingStatus.syncStatus}`);
        }
        if (failingStatus.consecutiveFailures !== 1) {
            throw new Error(`Assertion Failed: Expected 1 consecutive failure, got ${failingStatus.consecutiveFailures}`);
        }
        if (!failingStatus.errorMessage) {
            throw new Error('Assertion Failed: Expected error message to be set.');
        }

        failingScheduler.stop();
        console.log('✅ C6: Sync error handling and consecutive failure tracking verified.');

        // Restart server for the remainder of the test suite
        server = new DeveloperConsoleServer(controller, gateway, testPort, '127.0.0.1');
        server.start();
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        // Clean up environment override
        delete process.env.MOCK_CONFIG_OVERRIDES;

        // 11. Offline Status Scan Daemon Check
        console.log('[TestDaemon] Simulating offline agent scan...');
        const statusService = new AgentStatusService(500, 1000); // scan every 500ms, timeout 1000ms

        // Update database record lastHeartbeatAt to be older than 1000ms
        const activeAgentId = thirdServiceInstance.getIdentity()!.agentId;
        await prisma.agent.update({
            where: { id: activeAgentId },
            data: {
                status: 'ONLINE',
                lastHeartbeatAt: new Date(Date.now() - 3000) // 3 seconds ago (exceeds 1s threshold)
            }
        });

        // Trigger manual scan
        const offlineCount = await statusService.scanAndTransitionOfflineAgents();
        if (offlineCount === 0) {
            throw new Error(`Assertion Failed: AgentStatusService should transition agents to OFFLINE, got: ${offlineCount}`);
        }

        const transitionedAgent = await prisma.agent.findUnique({
            where: { id: activeAgentId }
        });
        if (!transitionedAgent || transitionedAgent.status !== 'OFFLINE') {
            throw new Error(`Assertion Failed: Agent status should be OFFLINE, got: ${transitionedAgent?.status}`);
        }
        console.log('✅ Offline agent transition scan verified successfully.');

        // 12. Agent Recovery (OFFLINE -> ONLINE transition)
        console.log('[TestRecovery] Simulating agent recovery (OFFLINE -> ONLINE)...');
        const recoveryResponse2 = await client.heartbeat(recoveryReq);
        if (!recoveryResponse2.success) {
            throw new Error(`Assertion Failed: Recovery heartbeat failed: ${recoveryResponse2.message}`);
        }

        const recoveredAgent = await prisma.agent.findUnique({
            where: { id: activeAgentId }
        });
        if (!recoveredAgent || recoveredAgent.status !== 'ONLINE') {
            throw new Error(`Assertion Failed: Agent status should have recovered to ONLINE, got: ${recoveredAgent?.status}`);
        }
        console.log('✅ Agent recovery (OFFLINE -> ONLINE) verified successfully.');

        // 13. Self-Healing Database Reset Recovery
        console.log('[TestSelfHealing] Simulating database reset / identity revocation...');
        await prisma.agentHeartbeat.deleteMany({ where: { agentId: activeAgentId } });
        await prisma.agent.delete({ where: { id: activeAgentId } });
        console.log('[TestSelfHealing] Agent deleted from database. Triggering heartbeat cycle...');
        
        // Ensure scheduler is running so that it doesn't return early due to !this.isRunning
        (scheduler as any).isRunning = true;
        await scheduler.executeHeartbeatCycle();
        
        // Now wait for background registration to complete
        console.log('[TestSelfHealing] Waiting for self-healing re-registration...');
        let selfHealed = false;
        for (let i = 0; i < 20; i++) {
            if (thirdServiceInstance.isRegistered()) {
                const newId = thirdServiceInstance.getIdentity()?.agentId;
                if (newId && newId !== activeAgentId) {
                    selfHealed = true;
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (!selfHealed) {
            throw new Error('Assertion Failed: Agent failed to auto-recover and re-register after database wipe.');
        }

        // Verify that the new agent is in the database and is ONLINE
        const newAgentId = thirdServiceInstance.getIdentity()!.agentId;
        const newAgent = await prisma.agent.findUnique({
            where: { id: newAgentId }
        });

        if (!newAgent || newAgent.status !== 'ONLINE') {
            throw new Error(`Assertion Failed: New registered agent should exist in DB and be ONLINE, got: ${newAgent?.status}`);
        }
        
        // Also verify the local identity file exists and contains the new credentials
        const updatedFileContentStr = await fs.readFile(testStorePath, 'utf-8');
        const updatedFileJson = JSON.parse(updatedFileContentStr);
        if (updatedFileJson.agentId !== newAgentId) {
            throw new Error(`Assertion Failed: Identity file should contain new agentId ${newAgentId}, got: ${updatedFileJson.agentId}`);
        }

        console.log('✅ Self-healing database reset recovery verified successfully.');

        // 14. Cold Boot Heartbeat Loop and Dynamic Machine ID Verification
        console.log('[TestColdBoot] Simulating cold boot / agent restart with cached identity...');
        scheduler.stop();

        const coldBootIdentityService = new AgentIdentityService(store, client, token);
        const coldBootMachineProvider = new DefaultMachineInfoProvider(
            () => coldBootIdentityService.getIdentity()?.machineId || coldBootIdentityService.getActiveMachineId()
        );

        // Before initialize, machine provider resolves to 'local-vps'
        if (coldBootMachineProvider.getMachineInfo().machineId !== 'local-vps') {
            throw new Error(`Assertion Failed: Expected default machineId 'local-vps' before initialization, got: ${coldBootMachineProvider.getMachineInfo().machineId}`);
        }

        const coldBootInitResult = await coldBootIdentityService.initialize();
        if (!coldBootInitResult) {
            throw new Error('Assertion Failed: Cold boot initialize should return true (credentials loaded from cache).');
        }

        // Initialize has run: machine provider should now resolve to the cached machine ID
        const cachedIdentity = coldBootIdentityService.getIdentity()!;
        if (coldBootMachineProvider.getMachineInfo().machineId !== cachedIdentity.machineId) {
            throw new Error(`Assertion Failed: MachineInfo machineId ${coldBootMachineProvider.getMachineInfo().machineId} does not match cached identity machineId ${cachedIdentity.machineId}`);
        }
        console.log('✅ Dynamic machine ID resolution verified successfully.');

        const coldBootScheduler = new AgentHeartbeatScheduler(coldBootIdentityService, client, 15000);
        coldBootScheduler.start();

        // Verify that the heartbeat scheduler loop is immediately configured (intervalId is set)
        if (!(coldBootScheduler as any).intervalId) {
            throw new Error('Assertion Failed: Heartbeat scheduler loop was not configured on cold boot startup.');
        }
        console.log('✅ Cold boot heartbeat scheduler auto-start verified successfully.');

        coldBootScheduler.stop();

        // Stop services
        await server.stop();
        try {
            await fs.unlink(testStorePath);
        } catch {}

        console.log('🎉 ALL AGENT IDENTITY INTEGRATION TESTS PASSED SUCCESSFULLY!');

    } catch (err: any) {
        console.error('❌ Integration Test Suite Failed:', err.message || err);
        // Ensure cleanup
        await server.stop().catch(() => {});
        try {
            await fs.unlink(testStorePath);
        } catch {}
        process.exit(1);
    }
}

runIdentityIntegrationSuite();
