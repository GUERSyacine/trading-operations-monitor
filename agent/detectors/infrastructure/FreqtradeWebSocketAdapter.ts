import WebSocket from 'ws';
import { EventPersistenceService } from '../../adapters/base/EventPersistenceService';
import { TelemetryMapper } from '../TelemetryMapper';
import { FeatureFlagService } from '../../../shared/services/FeatureFlagService';
import { EventBus } from '../../../shared/services/EventBus';
import { FeatureFlag, WatchdogEventType, EventCategory } from '../../../shared/types/developer';

export interface FreqtradeWebSocketAdapterConfig {
    baseUrl: string; // e.g. http://localhost:8080/api/v1
    wsToken: string; // ws_token from Freqtrade config.json
}

export class FreqtradeWebSocketAdapter {
    private ws: WebSocket | null = null;
    private isConnected = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private shouldReconnect = true;

    constructor(
        private config: FreqtradeWebSocketAdapterConfig,
        private persistence: EventPersistenceService,
        private flags?: FeatureFlagService,
        private eventBus?: EventBus
    ) {
        if (this.eventBus) {
            this.eventBus.subscribe((event) => {
                if (event.type === WatchdogEventType.FEATURE_FLAG_CHANGED) {
                    const payload = event.payload as { flag: FeatureFlag; enabled: boolean };
                    if (payload && payload.flag === FeatureFlag.WEBSOCKET) {
                        if (payload.enabled) {
                            console.log('[WS] Enabling WebSocket via feature flag trigger...');
                            this.connect();
                        } else {
                            console.log('[WS] Disabling WebSocket via feature flag trigger...');
                            this.disconnect();
                        }
                    }
                }
            });
        }
    }

    /**
     * Establish connection to Freqtrade WebSocket server.
     */
    public connect(): void {
        this.shouldReconnect = true;
        this.establishConnection();
    }

    /**
     * Disconnect from the WebSocket server and disable reconnection.
     */
    public disconnect(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        console.log('[WS] Disconnected manually');
    }

    private establishConnection(): void {
        if (this.flags && !this.flags.isFeatureEnabled(FeatureFlag.WEBSOCKET)) {
            console.log('[WS] Connection attempt cancelled: FeatureFlag.WEBSOCKET disabled.');
            return;
        }

        if (this.ws) {
            try {
                this.ws.close();
            } catch (err) {}
            this.ws = null;
        }

        // Derive WS URL from HTTP baseUrl
        let wsUrl = this.config.baseUrl;
        if (wsUrl.startsWith('https://')) {
            wsUrl = 'wss://' + wsUrl.substring(8);
        } else if (wsUrl.startsWith('http://')) {
            wsUrl = 'ws://' + wsUrl.substring(7);
        }

        if (wsUrl.endsWith('/')) {
            wsUrl = wsUrl.slice(0, -1);
        }

        // Append ws path and query token (aliased as 'token' in validate_ws_token)
        const fullUrl = `${wsUrl}/message/ws?token=${encodeURIComponent(this.config.wsToken)}`;
        console.log(`[WS] Connecting to Freqtrade WebSocket: ${wsUrl}/message/ws?token=***`);

        this.ws = new WebSocket(fullUrl);

        this.ws.on('open', () => {
            this.isConnected = true;
            console.log('[WS] Connected');
            this.subscribe();
        });

        this.ws.on('message', async (rawData: WebSocket.Data) => {
            const observedAt = Date.now();
            try {
                const messageStr = rawData.toString();
                const payload = JSON.parse(messageStr);
                console.log('[WS RAW]', payload);

                const event = TelemetryMapper.mapFreqtradeWebSocket(payload, observedAt);
                if (event) {
                    const exists = await this.persistence.hasLifecycleEvent(event.eventId);
                    if (!exists) {
                        await this.persistence.persistLifecycleEvent(event, payload);
                        console.log(`[WS] Persisted event: ${event.eventType} for trade ${event.tradeId}`);
                    } else {
                        console.log(`[WS] Duplicate event ignored: ${event.eventId}`);
                    }
                }
            } catch (err: any) {
                console.error(`[WS] Failed to parse/process message: ${err.message || err}`);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnected = false;
            console.log(`[WS] Connection closed (code: ${code}, reason: ${reason?.toString() || 'none'})`);
            this.handleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error('[WS] Connection error:', error.message || error);
        });
    }

    private subscribe(): void {
        if (!this.ws || !this.isConnected) return;

        const subPayload = {
            type: 'subscribe',
            data: [
                'entry',
                'entry_fill',
                'entry_cancel',
                'exit',
                'exit_fill',
                'exit_cancel',
                'status',
                'warning',
                'startup'
            ]
        };

        console.log('[WS] Sending subscription payload:', JSON.stringify(subPayload));
        this.ws.send(JSON.stringify(subPayload));
    }

    private handleReconnect(): void {
        if (!this.shouldReconnect) return;
        if (this.flags && !this.flags.isFeatureEnabled(FeatureFlag.WEBSOCKET)) {
            console.log('[WS] Reconnect attempt bypassed: FeatureFlag.WEBSOCKET disabled.');
            return;
        }
        if (this.reconnectTimeout) return;

        console.log('[WS] Attempting reconnection in 5 seconds...');
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.establishConnection();
        }, 5000);
    }
}
