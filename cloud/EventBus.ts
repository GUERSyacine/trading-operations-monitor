import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { WatchdogEvent, WatchdogEventType, EventCategory } from './types';

export class EventBus {
    private static instance: EventBus;
    private emitter = new EventEmitter();
    private buffer: WatchdogEvent[] = [];
    private readonly bufferLimit = 100;

    public static getInstance(): EventBus {
        if (!EventBus.instance) {
            EventBus.instance = new EventBus();
        }
        return EventBus.instance;
    }

    public emit(
        category: EventCategory,
        type: WatchdogEventType,
        source: string,
        payload: unknown,
        correlationId?: string
    ): void {
        const event: WatchdogEvent = {
            id: `evt_${crypto.randomUUID()}`,
            timestamp: Date.now(),
            category,
            type,
            source,
            payload,
            correlationId
        };
        
        // Save to RingBuffer
        this.buffer.push(event);
        if (this.buffer.length > this.bufferLimit) {
            this.buffer.shift();
        }

        this.emitter.emit('event', event);
    }

    public subscribe(callback: (event: WatchdogEvent) => void): () => void {
        this.emitter.on('event', callback);
        return () => this.emitter.off('event', callback);
    }

    public getRecentEvents(): WatchdogEvent[] {
        return [...this.buffer];
    }

    public clearBuffer(): void {
        this.buffer = [];
    }
}
