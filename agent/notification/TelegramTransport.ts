import { NotificationTransport, AlertPayload } from './types';

export class TelegramTransport implements NotificationTransport {
    async send(alert: AlertPayload): Promise<void> {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!token || !chatId) {
            console.warn('[Alerting] Telegram credentials (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) are missing from environment variables. Suppression fallback.');
            return;
        }

        const emojiMap: Record<string, string> = {
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
