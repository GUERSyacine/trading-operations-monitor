import { prisma } from '../../prisma';
import { FeatureFlagService } from '../../layer-A(observation)/developer-console/FeatureFlagService';
import { FeatureFlag } from '../../layer-A(observation)/developer-console/types';
import { AlertPayload, AlertLevel, NotificationTransport } from './types';
import { CloudTransport } from './CloudTransport';
import { OutboxPublisher } from '../../layer-B(Assessement)/OutboxPublisher';
import { DefaultMachineInfoProvider } from '../../shared/contracts/DefaultMachineInfoProvider';
import { OutboxPublisherContract } from '../../shared/contracts/types';

export class AlertingService {
    private flags?: FeatureFlagService;
    private transport: NotificationTransport;

    // De-duplication Cache (In-Memory for now, or could use DB)
    private recentAlerts: Map<string, number> = new Map();
    private readonly COOLDOWN_MS = 15 * 60 * 1000; // 15 Minutes

    constructor(options: { 
        flags?: FeatureFlagService; 
        transport?: NotificationTransport;
        outboxPublisher?: OutboxPublisherContract;
    } = {}) {
        this.flags = options.flags;
        this.transport = options.transport ?? new CloudTransport(
            options.outboxPublisher ?? new OutboxPublisher(new DefaultMachineInfoProvider())
        );
    }

    /**
     * Dispatch an Alert
     */
    async sendAlert(alert: AlertPayload): Promise<void> {
        // 1. De-duplication Check
        const key = alert.dedupKey || `${alert.level}:${alert.title}:${alert.entityId || 'global'}`;
        const lastSent = this.recentAlerts.get(key);
        const now = Date.now();

        if (lastSent && (now - lastSent) < this.COOLDOWN_MS) {
            console.log(`[Alerting] Suppressed duplicate: ${alert.title}`);
            return;
        }

        // 2. Persist Alert
        try {
            await prisma.alertLog.create({
                data: {
                    level: alert.level,
                    title: alert.title,
                    message: alert.message,
                    entityId: alert.entityId
                }
            });
            console.log(`[ALERTER] [${alert.level}] ${alert.title}: ${alert.message}`);
            this.recentAlerts.set(key, now);
        } catch (error: any) {
            console.error('[Alerting] DB Error persisting alert log:', error?.message || error);
        }

        // 3. Channel Dispatch (Push/Telegram/Slack)
        if (alert.level === 'CRITICAL' || alert.level === 'WARNING') {
            if (this.flags && !this.flags.isFeatureEnabled(FeatureFlag.ALERTING)) {
                console.log(`[Alerting] Telegram notification suppressed by ALERTING feature flag: ${alert.title}`);
                return;
            }
            await this.transport.send(alert);
        }
    }

    /**
     * Periodic Health Check (Run via Cron or Loop)
     */
    async monitorSystemHealth(): Promise<void> {
        // Example check: Kill Switch
        try {
            const circuit = await prisma.circuitBreakerState.findUnique({
                where: { breakerType: 'DAILY_DD' }
            });
            if (circuit && circuit.status === 'TRIPPED') {
                await this.sendAlert({
                    level: 'CRITICAL',
                    title: 'Daily Drawdown Breaker TRIPPED',
                    message: `Drawdown at ${circuit.currentVal.toString()}% exceeds limit. Trading Halted.`,
                    dedupKey: 'dd_tripped_critical'
                });
            }
        } catch (error: any) {
            console.error('[Alerting] Failed to run system health check queries:', error?.message || error);
        }
    }
}
