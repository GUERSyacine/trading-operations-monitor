import { IncidentPayload, MachineInfoProvider, OutboxAlertPayload, OutboxPublisherContract } from '../../../shared/contracts/types';
import { IIncidentOutboxRepository } from '../../../shared/repositories/interfaces';

export class OutboxPublisher implements OutboxPublisherContract {
    private outboxRepo: IIncidentOutboxRepository;

    constructor(
        private machineProvider: MachineInfoProvider,
        outboxRepo?: IIncidentOutboxRepository
    ) {
        if (outboxRepo) {
            this.outboxRepo = outboxRepo;
        } else {
            const { PrismaIncidentOutboxRepository } = require('../../../shared/repositories/PrismaRepositories');
            this.outboxRepo = new PrismaIncidentOutboxRepository();
        }
    }

    /**
     * Enqueue a generic payload to the Outbox table.
     */
    private async enqueue(payload: any): Promise<void> {
        await this.outboxRepo.create({
            payload,
            status: 'PENDING',
            attempts: 0,
            nextRetryAt: new Date(),
            lastError: null
        });
    }

    async publishTransition(event: 'CREATED' | 'STATE_CHANGED' | 'RESOLVED', incident: IncidentPayload): Promise<void> {
        try {
            const machine = this.machineProvider.getMachineInfo();
            const payload = {
                schemaVersion: 1,
                type: 'INCIDENT',
                event,
                incident,
                machine
            };
            await this.enqueue(payload);
            console.log(`[OutboxPublisher] Enqueued incident transition [${event}] for incident ${incident.incidentId}`);
        } catch (error: any) {
            console.error('[OutboxPublisher] Failed to write incident transition to local outbox:', error?.message || error);
            throw error;
        }
    }

    async publishAlert(alert: OutboxAlertPayload): Promise<void> {
        try {
            const machine = this.machineProvider.getMachineInfo();
            const payload = {
                schemaVersion: 1,
                type: 'ALERT',
                alert,
                machine
            };
            await this.enqueue(payload);
            console.log(`[OutboxPublisher] Enqueued alert: "${alert.title}" to local outbox.`);
        } catch (error: any) {
            console.error('[OutboxPublisher] Failed to write alert to local outbox:', error?.message || error);
            throw error;
        }
    }
}
