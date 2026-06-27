import { prisma } from '../../prisma';
import { FeatureFlagService } from '../../layer-A(observation)/developer-console/FeatureFlagService';
import { FeatureFlag } from '../../layer-A(observation)/developer-console/types';

export type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

interface AlertPayload {
    level: AlertLevel;
    title: string;
    message: string;
    entityId?: string;
    dedupKey?: string; // If provided, used for de-duplication
}

export class AlertingService {
    constructor(private flags?: FeatureFlagService) {}

    // De-duplication Cache (In-Memory for now, or could use DB)
    private recentAlerts: Map<string, number> = new Map();
    private readonly COOLDOWN_MS = 15 * 60 * 1000; // 15 Minutes

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
            await this.dispatchTelegram(alert);
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

    private async dispatchTelegram(alert: AlertPayload): Promise<void> {
        if (this.flags && !this.flags.isFeatureEnabled(FeatureFlag.ALERTING)) {
            console.log(`[Alerting] Telegram notification suppressed by ALERTING feature flag: ${alert.title}`);
            return;
        }

        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!token || !chatId) {
            console.warn('[Alerting] Telegram credentials (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) are missing from environment variables. Suppression fallback.');
            return;
        }

        const emojiMap: Record<AlertLevel, string> = {
            CRITICAL: '🚨',
            WARNING: '⚠️',
            INFO: 'ℹ️'
        };

        const emoji = emojiMap[alert.level] || '🔔';
        const formattedText = `${emoji} *[${alert.level}] ${alert.title}*\n\n${alert.message}\n\n_System Time: ${new Date().toISOString()}_`;

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
                console.error(`[Alerting] Telegram API error status ${response.status}:`, errorBody);
            } else {
                console.log(`[Alerting] Live Telegram notification successfully dispatched for: ${alert.title}`);
            }
        } catch (err: any) {
            console.error('[Alerting] Failed to execute Telegram API network call:', err?.message || err);
        }
    }
}
