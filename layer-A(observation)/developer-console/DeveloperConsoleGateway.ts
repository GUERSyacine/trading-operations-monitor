import { EventBus } from './EventBus';
import { WatchdogEvent, WatchdogEventType } from './types';

export interface UiMessage {
    id: string;
    timestamp: number;
    category: string;
    type: string;
    source: string;
    correlationId?: string;
    title: string;
    description: string;
    severity: 'info' | 'warning' | 'critical' | 'success';
    color: string;
    icon: string;
    data: any;
}

export class DeveloperConsoleGateway {
    constructor(private eventBus: EventBus = EventBus.getInstance()) {}

    public getInitialEvents(): UiMessage[] {
        return this.eventBus.getRecentEvents()
            .map(event => this.mapToUiMessage(event))
            .filter((msg): msg is UiMessage => msg !== null);
    }

    public startStreaming(sendToClient: (msg: UiMessage) => void): () => void {
        return this.eventBus.subscribe((event: WatchdogEvent) => {
            const uiMsg = this.mapToUiMessage(event);
            if (uiMsg) {
                sendToClient(uiMsg);
            }
        });
    }

    private mapToUiMessage(event: WatchdogEvent): UiMessage | null {
        let severity: 'info' | 'warning' | 'critical' | 'success' = 'info';
        let color = '#3b82f6'; // default blue
        let icon = 'ℹ️';

        switch (event.type) {
            case WatchdogEventType.ALERT_RAISED:
            case WatchdogEventType.INCIDENT_CREATED:
                severity = 'critical';
                color = '#ef4444'; // red
                icon = '🚨';
                break;
            case WatchdogEventType.ALERT_RESOLVED:
            case WatchdogEventType.INCIDENT_RESOLVED:
                severity = 'success';
                color = '#10b981'; // green
                icon = '✅';
                break;
            case WatchdogEventType.FAILURE_INJECTED:
                severity = 'warning';
                color = '#f59e0b'; // orange
                icon = '⚠️';
                break;
            case WatchdogEventType.FAILURE_CLEARED:
                severity = 'success';
                color = '#10b981';
                icon = '🧹';
                break;
            case WatchdogEventType.COMMAND_EXECUTED:
                severity = 'info';
                color = '#8b5cf6'; // purple
                icon = '⚙️';
                break;
        }

        return {
            id: event.id,
            timestamp: event.timestamp,
            category: event.category.toLowerCase(),
            type: event.type,
            source: event.source,
            correlationId: event.correlationId,
            title: `${event.source} - ${event.type.replace(/_/g, ' ')}`,
            description: JSON.stringify(event.payload),
            severity,
            color,
            icon,
            data: event.payload
        };
    }
}
