import { AgentIdentityService } from '../agent/identity/AgentIdentityService';
import { AgentHeartbeatScheduler } from '../agent/identity/AgentHeartbeatScheduler';
import { AgentApiClient } from '../agent/identity/CloudAgentClient';
import { IdentityStore } from '../agent/identity/IdentityStore';
import { prisma } from '../shared/prisma';
import { promises as fs } from 'fs';
import * as path from 'path';

async function runHeartbeatSchedulerSuite() {
    console.log('🧪 Starting AgentHeartbeatScheduler Test Suite...');

    // Clean up any pre-existing active HEARTBEAT / BROKER_CONNECTION incidents in the test database
    await prisma.incident.deleteMany({
        where: {
            source: { in: ['HEARTBEAT', 'BROKER_CONNECTION'] }
        }
    });

    // 1. Mocking AgentApiClient
    let heartbeatRequests: any[] = [];
    const mockClient: AgentApiClient = {
        register: async () => ({
            success: true,
            status: 'SUCCESS',
            agentId: 'mock-agent-123',
            agentSecret: 'mock-secret-456'
        }),
        heartbeat: async (req) => {
            heartbeatRequests.push(req);
            return {
                success: true,
                status: 'SUCCESS',
                configOverrides: { heartbeatIntervalMs: 15000 }
            };
        },
        getConfig: async () => ({
            success: true,
            status: 'SUCCESS',
            configurationRevision: 1,
            configuration: {}
        }),
        getUpdate: async () => ({
            success: true,
            status: 'SUCCESS',
            updateAvailable: false
        })
    };

    // 2. Setup real/mock store
    const testStorePath = path.join(__dirname, '../.test-heartbeat-identity.json');
    try {
        await fs.unlink(testStorePath);
    } catch {}
    const store = new IdentityStore(testStorePath);

    const identityService = new AgentIdentityService(store, mockClient, 'test-token');
    await identityService.initialize();

    // 3. Setup Scheduler
    const scheduler = new AgentHeartbeatScheduler(identityService, mockClient, 30_000);

    let registeredCallbackTriggered = false;
    identityService.onRegistered((identity) => {
        registeredCallbackTriggered = true;
    });

    // Start scheduler
    scheduler.start();

    // Trigger mock registration to invoke subscription
    // wait a bit for background loop to complete
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (!registeredCallbackTriggered) {
        throw new Error('Assertion Failed: registration callback should be triggered.');
    }

    const identity = identityService.getIdentity();
    if (!identity) {
        throw new Error('Assertion Failed: identity should be resolved.');
    }

    if (identity.agentId !== 'mock-agent-123') {
        throw new Error(`Assertion Failed: agentId mismatch, got ${identity.agentId}`);
    }

    // 4. Force a manual heartbeat execution to test telemetry gather
    await scheduler.executeHeartbeatCycle();

    if (heartbeatRequests.length === 0) {
        throw new Error('Assertion Failed: No heartbeats were sent.');
    }

    const lastReq = heartbeatRequests[heartbeatRequests.length - 1];
    console.log('Collected Heartbeat Payload:', JSON.stringify(lastReq, null, 2));

    if (lastReq.agentId !== 'mock-agent-123') {
        throw new Error(`Assertion Failed: agentId in heartbeat mismatch: ${lastReq.agentId}`);
    }
    if (lastReq.agentSecret !== 'mock-secret-456') {
        throw new Error('Assertion Failed: agentSecret mismatch');
    }
    if (typeof lastReq.metrics.cpuPct !== 'number' || lastReq.metrics.cpuPct < 0 || lastReq.metrics.cpuPct > 100) {
        throw new Error(`Assertion Failed: Invalid cpuPct: ${lastReq.metrics.cpuPct}`);
    }
    if (typeof lastReq.metrics.memoryPct !== 'number' || lastReq.metrics.memoryPct < 0 || lastReq.metrics.memoryPct > 100) {
        throw new Error(`Assertion Failed: Invalid memoryPct: ${lastReq.metrics.memoryPct}`);
    }
    if (typeof lastReq.metrics.diskPct !== 'number' || lastReq.metrics.diskPct < 0 || lastReq.metrics.diskPct > 100) {
        throw new Error(`Assertion Failed: Invalid diskPct: ${lastReq.metrics.diskPct}`);
    }
    if (typeof lastReq.health.databaseHealthy !== 'boolean') {
        throw new Error('Assertion Failed: databaseHealthy must be boolean');
    }
    if (typeof lastReq.health.freqtradeHealthy !== 'boolean') {
        throw new Error('Assertion Failed: freqtradeHealthy must be boolean');
    }
    if (typeof lastReq.health.outboxPendingCount !== 'number') {
        throw new Error('Assertion Failed: outboxPendingCount must be number');
    }

    // 5. Test Freqtrade unhealthy state detection when there is an active HEARTBEAT incident
    console.log('Testing Freqtrade unhealthy state detection...');
    const testIncident = await prisma.incident.create({
        data: {
            source: 'HEARTBEAT',
            level: 'CRITICAL',
            reason: 'Test Freqtrade Heartbeat Loss',
            detectedAt: BigInt(Date.now())
        }
    });

    heartbeatRequests = [];
    await scheduler.executeHeartbeatCycle();
    if (heartbeatRequests.length === 0) {
        throw new Error('Assertion Failed: Heartbeat did not send after mock incident insertion');
    }

    const unhealthyReq = heartbeatRequests[0];
    if (unhealthyReq.health.freqtradeHealthy !== false) {
        // clean up first
        await prisma.incident.delete({ where: { id: testIncident.id } });
        throw new Error('Assertion Failed: Freqtrade should be reported unhealthy when active HEARTBEAT incident exists.');
    }

    // Resolve incident to test self-healing
    await prisma.incident.update({
        where: { id: testIncident.id },
        data: { resolvedAt: BigInt(Date.now()) }
    });

    heartbeatRequests = [];
    await scheduler.executeHeartbeatCycle();
    const selfHealedReq = heartbeatRequests[0];
    if (selfHealedReq.health.freqtradeHealthy !== true) {
        await prisma.incident.delete({ where: { id: testIncident.id } });
        throw new Error('Assertion Failed: Freqtrade health did not restore after incident resolution.');
    }

    // Cleanup
    await prisma.incident.delete({ where: { id: testIncident.id } });

    scheduler.stop();
    identityService.stop();

    try {
        await fs.unlink(testStorePath);
    } catch {}

    console.log('🎉 ALL AgentHeartbeatScheduler TESTS PASSED SUCCESSFULLY!');
}

runHeartbeatSchedulerSuite().catch((err) => {
    console.error('❌ AgentHeartbeatScheduler Test Suite Failed:', err.message || err);
    process.exit(1);
});
