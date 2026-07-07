export type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertPayload {
    level: AlertLevel;
    title: string;
    message: string;
    entityId?: string;
    dedupKey?: string;
}

export interface NotificationTransport {
    /**
     * Dispatches the alert to the target destination (e.g. Telegram or SaaS central endpoint).
     */
    send(alert: AlertPayload): Promise<void>;
}
