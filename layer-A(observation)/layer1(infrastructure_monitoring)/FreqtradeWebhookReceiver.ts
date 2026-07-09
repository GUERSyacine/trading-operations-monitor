import * as http from 'http';
import { EventPersistenceService } from '../../agent/adapters/base/EventPersistenceService';
import { TelemetryMapper } from '../TelemetryMapper';

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
        const observedAt = Date.now();
        const event = TelemetryMapper.mapFreqtradeWebhook(payload, observedAt);
        if (event) {
            await this.persistence.persistLifecycleEvent(event, payload);
            console.log(`[WebhookReceiver] Successfully persisted ${event.eventType} event via TelemetryMapper. eventId: ${event.eventId}`);
        } else {
            console.warn(`[WebhookReceiver] Received webhook payload that could not be mapped to a LifecycleEvent:`, JSON.stringify(payload));
        }
    }
}

