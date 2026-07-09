import { prisma } from '../../../shared/prisma';
import { LifecycleEvent, LifecycleEventType } from '../../detectors/types';


export interface NormalizedEvent {
    classification:
        | 'HEARTBEAT'
        | 'SIGNAL'
        | 'ORDER'
        | 'BROKER_CONNECTION'
        | 'MARKET_DATA'
        | 'ORDER_FILLED'
        | 'ORDER_CREATED'
        | 'ORDER_SUBMITTED'
        | 'ORDER_ACKNOWLEDGED'
        | 'ORDER_OPEN'
        | 'ORDER_PARTIALLY_FILLED'
        | 'ORDER_CANCELLED'
        | 'EXCHANGE_REJECTED'
        | 'ORDER_FAILED';
    systemRiskState?: string;
    rejectionReason?: string;
    metadata?: Record<string, any>;
    createdAt?: Date;
}

export class EventPersistenceService {
    /**
     * Persist a normalized event to the decision_audit table.
     */
    async persistEvent(event: NormalizedEvent): Promise<void> {
        try {
            await prisma.decisionAudit.create({
                data: {
                    classification: event.classification,
                    systemRiskState: event.systemRiskState || 'NORMAL',
                    rejectionReason: event.rejectionReason || null,
                    metadata: event.metadata || undefined,
                    createdAt: event.createdAt || new Date()
                }
            });
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to persist event ${event.classification}:`, error?.message || error);
        }
    }

    /**
     * Retrieve the timestamp of the last event for a given classification and sourceSystem.
     * Used for rate-limiting/suppressing excessive heartbeat and broker connection events.
     */
    async getLastEventTime(classification: string, sourceSystem: string): Promise<number> {
        try {
            const lastEvent = await prisma.decisionAudit.findFirst({
                where: {
                    classification,
                    metadata: {
                        path: ['sourceSystem'],
                        equals: sourceSystem
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });
            return lastEvent ? lastEvent.createdAt.getTime() : 0;
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to retrieve last event time for ${classification}:`, error?.message || error);
            return 0;
        }
    }

    /**
     * Check if a trade/order execution has already been recorded in decision_audit.
     */
    async hasOrderEvent(orderId: string): Promise<boolean> {
        try {
            const existing = await prisma.decisionAudit.findFirst({
                where: {
                    classification: 'ORDER',
                    metadata: {
                        path: ['orderId'],
                        equals: orderId
                    }
                }
            });
            return existing !== null;
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to check existing order ${orderId}:`, error?.message || error);
            return false;
        }
    }

    /**
     * Persist a canonical LifecycleEvent to the database along with the raw payload.
     */
    async persistLifecycleEvent(event: LifecycleEvent, rawPayload: any): Promise<void> {
        try {
            await prisma.decisionAudit.create({
                data: {
                    classification: event.eventType,
                    systemRiskState: 'NORMAL',
                    rejectionReason: null,
                    metadata: {
                        telemetrySource: event.source,
                        lifecycleEvent: event as any,
                        rawPayload: rawPayload,
                        websocketEventType: rawPayload?.type || null,
                        websocketDirection: rawPayload?.direction || null
                    } as any,
                    createdAt: new Date(event.observedAt)
                }
            });
            console.log(`[EventPersistenceService] Persisted ${event.eventType} event. eventId: ${event.eventId}`);
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to persist lifecycle event ${event.eventType}:`, error?.message || error);
        }
    }

    /**
     * Check the database for the existence of a deterministic eventId to prevent duplicates.
     */
    async hasLifecycleEvent(eventId: string): Promise<boolean> {
        try {
            const existing = await prisma.decisionAudit.findFirst({
                where: {
                    metadata: {
                        path: ['lifecycleEvent', 'eventId'],
                        equals: eventId
                    }
                }
            });
            return existing !== null;
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to check lifecycle event ${eventId}:`, error?.message || error);
            return false;
        }
    }

    /**
     * Check if a specific lifecycle event has already been recorded for a trade/order.
     * Queries by orderId (if provided) or falls back to tradeId + eventType correlation.
     * Prevents cross-source duplicate persistence by auto-binding orderIds to unbound WebSocket events.
     */
    async hasEquivalentLifecycleEvent(tradeId: string, eventType: LifecycleEventType, orderId?: string): Promise<boolean> {
        try {
            // 1. If orderId is provided, first search for an exact match on orderId
            if (orderId && orderId !== 'undefined' && orderId !== 'null') {
                const exactMatch = await prisma.decisionAudit.findFirst({
                    where: {
                        classification: eventType,
                        metadata: {
                            path: ['lifecycleEvent', 'orderId'],
                            equals: orderId
                        }
                    }
                });
                if (exactMatch) {
                    return true;
                }

                // 2. If no exact match on orderId, search for any unbound record for the same tradeId
                // (e.g. created by WebSocket which does not contain orderId)
                const unboundMatches = await prisma.decisionAudit.findMany({
                    where: {
                        classification: eventType,
                        metadata: {
                            path: ['lifecycleEvent', 'tradeId'],
                            equals: tradeId
                        }
                    }
                });

                for (const match of unboundMatches) {
                    const metadata = match.metadata as any;
                    const eventOrderId = metadata?.lifecycleEvent?.orderId;
                    if (!eventOrderId || eventOrderId === 'undefined' || eventOrderId === 'null') {
                        // Bind the orderId to this record to reconcile it!
                        const updatedMetadata = {
                            ...metadata,
                            lifecycleEvent: {
                                ...metadata.lifecycleEvent,
                                orderId: orderId
                            }
                        };
                        await prisma.decisionAudit.update({
                            where: { id: match.id },
                            data: { metadata: updatedMetadata }
                        });
                        console.log(`[EventPersistenceService] Reconciled and bound orderId ${orderId} to existing unbound ${eventType} event (trade ${tradeId})`);
                        return true;
                    }
                }
            } else {
                // Fallback for when no orderId is provided (e.g. checking by tradeId only)
                const existing = await prisma.decisionAudit.findFirst({
                    where: {
                        classification: eventType,
                        metadata: {
                            path: ['lifecycleEvent', 'tradeId'],
                            equals: tradeId
                        }
                    }
                });
                return existing !== null;
            }

            return false;
        } catch (error: any) {
            console.error(`[EventPersistenceService] Failed to check equivalent lifecycle event for trade ${tradeId} (order ${orderId}):`, error?.message || error);
            return false;
        }
    }
}
