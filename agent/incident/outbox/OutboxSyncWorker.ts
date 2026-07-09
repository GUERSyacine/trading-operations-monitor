import { prisma } from '../../../shared/prisma';
import { MVP_CONFIG } from '../../../shared/mvpConfig';

export class OutboxSyncWorker {
    private nextTimeout?: NodeJS.Timeout;
    private isRunning = false;
    private isSyncing = false;

    constructor(
        private readonly cloudGatewayUrl: string = MVP_CONFIG.CLOUD_SYNC.GATEWAY_URL,
        private readonly syncIntervalMs: number = MVP_CONFIG.CLOUD_SYNC.SYNC_INTERVAL_MS,
        private readonly maxAttempts: number = MVP_CONFIG.CLOUD_SYNC.MAX_ATTEMPTS,
        private readonly backoffBaseMs: number = MVP_CONFIG.CLOUD_SYNC.BACKOFF_BASE_MS,
        private readonly batchSize: number = MVP_CONFIG.CLOUD_SYNC.BATCH_SIZE,
        private readonly timeoutMs: number = MVP_CONFIG.CLOUD_SYNC.TIMEOUT_MS
    ) {}

    /**
     * Start the sync worker scheduler.
     */
    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[SyncWorker] Starting Outbox Sync Worker (interval=${this.syncIntervalMs}ms, batchSize=${this.batchSize})`);
        this.scheduleNext();
    }

    /**
     * Stop the sync worker scheduler.
     */
    public stop(): void {
        this.isRunning = false;
        if (this.nextTimeout) {
            clearTimeout(this.nextTimeout);
            this.nextTimeout = undefined;
        }
        console.log('[SyncWorker] Stopped Outbox Sync Worker.');
    }

    /**
     * Schedule the next sync cycle using a recursive timeout.
     */
    private scheduleNext(): void {
        if (!this.isRunning) return;
        this.nextTimeout = setTimeout(async () => {
            try {
                await this.syncCycle();
            } catch (err: any) {
                console.error('[SyncWorker] Unhandled error during sync cycle:', err.message || err);
            } finally {
                this.scheduleNext();
            }
        }, this.syncIntervalMs);
    }

    /**
     * A single execution cycle of the sync loop.
     */
    public async syncCycle(): Promise<void> {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            const now = new Date();
            const records = await prisma.incidentOutbox.findMany({
                where: {
                    status: 'PENDING',
                    attempts: { lt: this.maxAttempts },
                    OR: [
                        { nextRetryAt: { lte: now } }
                    ]
                },
                orderBy: { id: 'asc' },
                take: this.batchSize
            });

            if (records.length === 0) {
                return;
            }

            const startTime = Date.now();
            const successIds: number[] = [];
            let failCount = 0;

            for (const record of records) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

                    const response = await fetch(this.cloudGatewayUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(record.payload),
                        signal: controller.signal
                    }).finally(() => clearTimeout(timeoutId));

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const resBody = await response.json() as any;
                    if (resBody && resBody.received === true) {
                        successIds.push(record.id);
                    } else {
                        throw new Error('Response body did not contain { received: true }');
                    }
                } catch (error: any) {
                    failCount++;
                    const attempts = record.attempts + 1;
                    const delayMs = this.backoffBaseMs * Math.pow(2, attempts);
                    const nextRetryAt = new Date(Date.now() + delayMs);
                    const status = attempts >= this.maxAttempts ? 'FAILED' : 'PENDING';
                    const errMsg = error.name === 'AbortError' ? 'Request timed out' : (error.message || String(error));

                    await prisma.incidentOutbox.update({
                        where: { id: record.id },
                        data: {
                            status,
                            attempts,
                            lastError: errMsg,
                            nextRetryAt
                        }
                    });
                }
            }

            if (successIds.length > 0) {
                await prisma.incidentOutbox.updateMany({
                    where: { id: { in: successIds } },
                    data: {
                        status: 'SENT',
                        lastError: null
                    }
                });
            }

            const duration = Date.now() - startTime;
            console.log(`[SyncWorker] Processed batch: ${successIds.length} sent, ${failCount} failed, duration=${duration}ms`);
        } catch (globalErr: any) {
            console.error('[SyncWorker] Critical error inside sync cycle:', globalErr.message || globalErr);
        } finally {
            this.isSyncing = false;
        }
    }
}
