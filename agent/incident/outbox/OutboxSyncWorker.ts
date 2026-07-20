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
        private readonly timeoutMs: number = MVP_CONFIG.CLOUD_SYNC.TIMEOUT_MS,
        private readonly getAgentId?: () => string | undefined,
        private readonly getAgentSecret?: () => string | undefined,
        private readonly getAgentVersion?: () => string | undefined
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
            let lastErrorMsg = '';
            let lastRecordAttempt = 0;
            let lastDelayMs = 0;
            let lastNextRetryAt: Date = new Date();

            for (const record of records) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

                    const payloadObj = typeof record.payload === 'object' && record.payload !== null ? (record.payload as any) : {};
                    const targetUrl = payloadObj.type === 'ALERT'
                        ? this.cloudGatewayUrl.replace('/incidents', '/alerts')
                        : this.cloudGatewayUrl;

                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json'
                    };
                    if (this.getAgentId) {
                        const agentId = this.getAgentId();
                        if (agentId) {
                            headers['X-Agent-Id'] = agentId;
                        }
                    }
                    if (this.getAgentSecret) {
                        const agentSecret = this.getAgentSecret();
                        if (agentSecret) {
                            headers['X-Agent-Secret'] = agentSecret;
                        }
                    }
                    const agentVersion = this.getAgentVersion ? this.getAgentVersion() : undefined;
                    if (agentVersion) {
                        headers['X-Agent-Version'] = agentVersion;
                    } else {
                        headers['X-Agent-Version'] = '1.0.0';
                    }

                    const response = await fetch(targetUrl, {
                        method: 'POST',
                        headers,
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

                    lastErrorMsg = errMsg;
                    lastRecordAttempt = attempts;
                    lastDelayMs = delayMs;
                    lastNextRetryAt = nextRetryAt;

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

            // Fetch remaining backlog count in local database outbox
            let remainingCount = 0;
            try {
                remainingCount = await prisma.incidentOutbox.count({
                    where: { status: 'PENDING' }
                });
            } catch (err) {
                // Suppress or log error without failing sync cycle
            }

            if (failCount > 0) {
                const delaySeconds = Math.round(lastDelayMs / 1000);
                console.log(`======================================================
❌ OUTBOX PUBLISHER - SYNC FAILURE
======================================================
Batch Size:   ${records.length}
Status:       FAILED
Processed:    ${successIds.length} sent, ${failCount} failed

Retry Context
-------------
Attempt:      ${lastRecordAttempt} / ${this.maxAttempts}
Backoff:      ${lastDelayMs} ms
Next Retry:   in ${delaySeconds} seconds (${lastNextRetryAt.toISOString()})
Reason:       ${lastErrorMsg}
======================================================`);
            } else {
                console.log(`======================================================
📦 OUTBOX PUBLISHER - BATCH SYNCED
======================================================
Batch Size:   ${records.length}
Status:       SUCCESS
Processed:    ${successIds.length} sent, ${failCount} failed
Duration:     ${duration} ms

Backlog
-------
Remaining:    ${remainingCount} pending events in local outbox
======================================================`);
            }
        } catch (globalErr: any) {
            console.error('[SyncWorker] Critical error inside sync cycle:', globalErr.message || globalErr);
        } finally {
            this.isSyncing = false;
        }
    }
}
