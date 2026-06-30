import { EventPersistenceService } from '../../adapters/base/EventPersistenceService';
import { OperationScenario, WatchdogEventType, EventCategory } from './types';
import { EventBus } from './EventBus';
import { LifecycleEvent, LifecycleEventType } from '../types';

/**
 * OperationsSimulationService
 * 
 * Adapter-agnostic service to simulate operational lifecycle scenarios for testing.
 * Uses the production EventPersistenceService to persist canonical simulated events,
 * ensuring they pass through the exact same duplicate detection and audit pipeline.
 */
export class OperationsSimulationService {
    constructor(private persistence: EventPersistenceService) {}

    public async runScenario(
        scenario: OperationScenario,
        meta: { tradeId?: string; symbol?: string; timestampOffset?: number }
    ): Promise<void> {
        const tradeId = meta.tradeId || `sim_trade_${Math.floor(1000000 + Math.random() * 9000000)}`;
        const symbol = meta.symbol || 'BTCUSDT';
        const offset = meta.timestampOffset || 0;
        const now = Date.now() - offset;

        // Emit SIMULATION_STARTED to the EventBus for live timeline visualization
        EventBus.getInstance().emit(
            EventCategory.SYSTEM,
            WatchdogEventType.SIMULATION_STARTED,
            'OperationsSimulationService',
            { scenario, tradeId, symbol, timestampOffset: offset }
        );

        // Helper to construct a LifecycleEvent and call the persistence service
        const persistSimulatedEvent = async (eventType: LifecycleEventType, ageMs: number, orderId?: string) => {
            const observedAt = now - ageMs;
            const eventId = `SIM:${tradeId}:${eventType}:${observedAt}`;
            
            const lifecycleEvent: LifecycleEvent = {
                schemaVersion: 1,
                eventId,
                tradeId,
                orderId: orderId || `order_${tradeId}`,
                eventType,
                source: 'SIMULATOR',
                captureMethod: 'WEBSOCKET',
                eventTimestamp: observedAt,
                observedAt,
                symbol
            };

            const rawPayload = {
                simulated: true,
                trade_id: Number(tradeId.replace(/[^\d]/g, '')) || 999,
                type: eventType === 'ORDER_CREATED' ? 'enter' 
                    : eventType === 'ORDER_CANCELLED' ? 'enter_cancel' 
                    : eventType === 'ORDER_FILLED' ? 'exit' 
                    : 'order_open',
                pair: symbol,
                amount: 1.0,
                open_rate: 65000,
                close_rate: 65100
            };

            await this.persistence.persistLifecycleEvent(lifecycleEvent, rawPayload);
        };

        switch (scenario) {
            case OperationScenario.HAPPY_PATH:
                // Expected healthy flow: Created -> Open -> Filled (C1)
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_OPEN', 3000);
                await persistSimulatedEvent('ORDER_FILLED', 1000);
                break;

            case OperationScenario.ORDER_CANCEL:
                // Expected healthy cancellation flow: Created -> Cancelled (C2)
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_CANCELLED', 1000);
                break;

            case OperationScenario.NORMAL_EXIT:
                // Expected healthy exit flow: Created -> Open -> Filled (C3)
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_OPEN', 3000);
                await persistSimulatedEvent('ORDER_FILLED', 1000);
                break;

            case OperationScenario.OPEN_ORDER_TIMEOUT:
                // Create an order 70 seconds ago that remains unfilled/unresolved
                await persistSimulatedEvent('ORDER_CREATED', 70000);
                break;

            case OperationScenario.BACKWARD_TRANSITION:
                // Regression transition sequence
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_CANCELLED', 3000);
                await persistSimulatedEvent('ORDER_OPEN', 1000);
                break;

            case OperationScenario.DUPLICATE_FILL:
                // Standard flow ending with duplicate execution fills
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_OPEN', 4000);
                await persistSimulatedEvent('ORDER_FILLED', 2000);
                await persistSimulatedEvent('ORDER_FILLED', 1000);
                break;

            case OperationScenario.UNEXPECTED_FILL:
                // Terminal fill without prior lifecycle events
                await persistSimulatedEvent('ORDER_FILLED', 1000);
                break;

            case OperationScenario.CANCEL_AFTER_FILL:
                // Violates mutation guard: terminal mutation from FILLED -> CANCELLED
                await persistSimulatedEvent('ORDER_CREATED', 5000);
                await persistSimulatedEvent('ORDER_OPEN', 4000);
                await persistSimulatedEvent('ORDER_FILLED', 2000);
                await persistSimulatedEvent('ORDER_CANCELLED', 1000);
                break;

            default:
                throw new Error(`Unknown operation scenario: ${scenario}`);
        }
    }
}
