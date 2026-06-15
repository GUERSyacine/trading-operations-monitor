import * as http from 'http';
import { EventPersistenceService } from '../../adapters/base/EventPersistenceService';

export class FreqtradeWebhookReceiver {
    private server?: http.Server;

    constructor(
        private persistence: EventPersistenceService,
        private port: number = Number(process.env.WATCHDOG_WEBHOOK_PORT) || 9000,
        private host: string = process.env.WATCHDOG_WEBHOOK_HOST || '0.0.0.0'
    ) {}

    /**
     * Start the HTTP server.
     */
    start(): void {
        if (this.server) {
            console.warn('[WebhookReceiver] Server is already running.');
            return;
        }

        this.server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/webhooks/freqtrade') {
                let body = '';
                
                req.on('data', chunk => {
                    body += chunk.toString();
                });

                req.on('end', async () => {
                    try {
                        const payload = JSON.parse(body);
                        await this.handleWebhook(payload);
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success' }));
                    } catch (error: any) {
                        console.error('[WebhookReceiver] Error handling payload:', error?.message || error);
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: error?.message || 'Invalid payload' }));
                    }
                });
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: 'Not Found' }));
            }
        });

        this.server.listen(this.port, this.host, () => {
            console.log(`[WebhookReceiver] Listening for Freqtrade webhooks at http://${this.host}:${this.port}/webhooks/freqtrade`);
        });
    }

    /**
     * Stop the HTTP server.
     */
    stop(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('[WebhookReceiver] HTTP server stopped and port released.');
                    resolve();
                });
                this.server = undefined;
            } else {
                resolve();
            }
        });
    }

    /**
     * Internal webhook parsing, normalization, and persistence logic.
     */
    private async handleWebhook(payload: any): Promise<void> {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Payload must be a valid JSON object.');
        }

        const type = this.extractField(payload, ['type', 'event']);
        if (!type || typeof type !== 'string') {
            throw new Error('Missing or invalid "type" or "event" parameter.');
        }

        const normalizedType = type.toLowerCase();

        // 1. Determine classification
        let classification: 'SIGNAL' | 'ORDER_FILLED';
        if (normalizedType === 'entry' || normalizedType === 'exit') {
            classification = 'SIGNAL';
        } else if (normalizedType === 'entry_fill' || normalizedType === 'exit_fill') {
            classification = 'ORDER_FILLED';
        } else {
            // Ignore other webhook event types (or throw, but ignoring keeps it robust)
            console.warn(`[WebhookReceiver] Received unhandled webhook event type: ${type}`);
            return;
        }

        // 2. Extract and normalize fields
        const rawTradeId = this.extractField(payload, ['trade_id', 'tradeId']);
        const tradeId = rawTradeId !== undefined && rawTradeId !== null ? String(rawTradeId) : undefined;
        
        const rawOrderId = this.extractField(payload, ['order_id', 'orderId']);
        const orderId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : undefined;

        const rawSymbol = this.extractField(payload, ['symbol', 'pair']);
        const symbol = typeof rawSymbol === 'string' ? rawSymbol.replace('/', '') : undefined;

        const rawStrategy = this.extractField(payload, ['strategy', 'strategyId', 'strategy_id']);
        const strategy = typeof rawStrategy === 'string' ? rawStrategy : 'SampleStrategy';

        const rawSide = this.extractField(payload, ['side', 'direction']);
        const side = typeof rawSide === 'string' ? rawSide.toUpperCase() : undefined;

        const rawPrice = this.extractField(payload, ['price', 'rate', 'limit_price', 'open_rate', 'close_rate']);
        const price = rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : undefined;

        const rawAmount = this.extractField(payload, ['amount', 'volume']);
        const amount = rawAmount !== undefined && rawAmount !== null ? Number(rawAmount) : undefined;

        const rawTimestamp = this.extractField(payload, ['timestamp', 'date', 'open_date', 'close_date']);
        const createdAt = rawTimestamp ? new Date(rawTimestamp) : new Date();

        // 3. Persist Event
        await this.persistence.persistEvent({
            classification,
            systemRiskState: 'NORMAL',
            createdAt,
            metadata: {
                adapter: 'freqtrade',
                adapterVersion: '1.0.0',
                sourceSystem: 'freqtrade',
                tradeId,
                orderId,
                symbol,
                strategyId: strategy,
                side,
                price,
                amount
            }
        });

        console.log(`[WebhookReceiver] Successfully persisted ${classification} event for tradeId ${tradeId}`);
    }

    /**
     * Helper to retrieve value from payload using prioritized keys.
     */
    private extractField(payload: any, keys: string[]): any {
        for (const key of keys) {
            if (payload[key] !== undefined && payload[key] !== null) {
                return payload[key];
            }
        }
        return undefined;
    }
}
