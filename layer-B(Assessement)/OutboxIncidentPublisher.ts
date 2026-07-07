import { IncidentPublisher, IncidentPayload, MachineInfoProvider } from '../shared/contracts/types';
import { prisma } from '../prisma';

export class OutboxIncidentPublisher implements IncidentPublisher {
    constructor(private machineProvider: MachineInfoProvider) {}

    async publishTransition(event: 'CREATED' | 'STATE_CHANGED' | 'RESOLVED', incident: IncidentPayload): Promise<void> {
        try {
            const machine = this.machineProvider.getMachineInfo();
            await prisma.incidentOutbox.create({
                data: {
                    payload: {
                        schemaVersion: 1,
                        event,
                        incident,
                        machine
                    } as any,
                    status: 'PENDING',
                    attempts: 0,
                    nextRetryAt: new Date(),
                    lastError: null
                }
            });
            console.log(`[OutboxPublisher] Enqueued transition [${event}] for incident ${incident.incidentId} (${incident.source})`);
        } catch (error: any) {
            console.error('[OutboxPublisher] Failed to write incident transition to local outbox:', error?.message || error);
            throw error;
        }
    }
}
