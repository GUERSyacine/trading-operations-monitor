import { NotificationTransport, AlertPayload } from './types';
import { OutboxPublisherContract } from '../../shared/contracts/types';

export class CloudTransport implements NotificationTransport {
    constructor(private outboxPublisher: OutboxPublisherContract) {}

    async send(alert: AlertPayload): Promise<void> {
        await this.outboxPublisher.publishAlert({
            level: alert.level,
            title: alert.title,
            message: alert.message,
            entityId: alert.entityId,
            dedupKey: alert.dedupKey
        });
    }
}
