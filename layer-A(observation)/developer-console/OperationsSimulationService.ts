import { EventPersistenceService } from '../../agent/adapters/base/EventPersistenceService';
import { OperationScenario, WatchdogEventType, EventCategory } from './types';
import { EventBus } from './EventBus';
import { LifecycleEvent, LifecycleEventType, TradeDirection } from '../../agent/detectors/types';

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
        const persistSimulatedEvent = async (
            eventType: LifecycleEventType,
            ageMs: number,
            direction: TradeDirection,
            typeTag: string,
            orderId?: string
        ) => {
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
                symbol,
                direction
            };

            const rawPayload = {
                simulated: true,
                trade_id: Number(tradeId.replace(/[^\d]/g, '')) || 999,
                type: typeTag,
                pair: symbol,
                amount: 1.0,
                open_rate: 65000,
                close_rate: 65100
            };

            await this.persistence.persistLifecycleEvent(lifecycleEvent, rawPayload);
        };

        switch (scenario) {
            case OperationScenario.ENTRY_EXECUTION:
                // Expected healthy entry flow: Created -> Open -> Filled (C1)
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.ENTRY, 'entry');
                await persistSimulatedEvent('ORDER_OPEN', 3000, TradeDirection.ENTRY, 'order_open');
                await persistSimulatedEvent('ORDER_FILLED', 1000, TradeDirection.ENTRY, 'entry_fill');
                break;

            case OperationScenario.ORDER_CANCEL:
                // Expected healthy cancellation flow: Created -> Cancelled (C2)
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.ENTRY, 'entry');
                await persistSimulatedEvent('ORDER_CANCELLED', 1000, TradeDirection.ENTRY, 'entry_cancel');
                break;

            case OperationScenario.POSITION_EXIT:
                // Expected healthy exit flow: Created -> Open -> Filled (C3)
                // Independent exit trade sequence with its own orderId (e.g. exit_order_${tradeId})
                const exitOrderId = `exit_order_${tradeId}`;
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.EXIT, 'exit', exitOrderId);
                await persistSimulatedEvent('ORDER_OPEN', 3000, TradeDirection.EXIT, 'order_open', exitOrderId);
                await persistSimulatedEvent('ORDER_FILLED', 1000, TradeDirection.EXIT, 'exit_fill', exitOrderId);
                break;

            case OperationScenario.OPEN_ORDER_TIMEOUT:
                // Create an order 70 seconds ago that remains unfilled/unresolved
                await persistSimulatedEvent('ORDER_CREATED', 70000, TradeDirection.ENTRY, 'entry');
                break;

            case OperationScenario.BACKWARD_TRANSITION:
                // Regression transition sequence
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.ENTRY, 'entry');
                await persistSimulatedEvent('ORDER_CANCELLED', 3000, TradeDirection.ENTRY, 'entry_cancel');
                await persistSimulatedEvent('ORDER_OPEN', 1000, TradeDirection.ENTRY, 'order_open');
                break;

            case OperationScenario.DUPLICATE_FILL:
                // Standard flow ending with duplicate execution fills
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.ENTRY, 'entry');
                await persistSimulatedEvent('ORDER_OPEN', 4000, TradeDirection.ENTRY, 'order_open');
                await persistSimulatedEvent('ORDER_FILLED', 2000, TradeDirection.ENTRY, 'entry_fill');
                await persistSimulatedEvent('ORDER_FILLED', 1000, TradeDirection.ENTRY, 'entry_fill');
                break;

            case OperationScenario.UNEXPECTED_FILL:
                // Terminal fill without prior lifecycle events
                await persistSimulatedEvent('ORDER_FILLED', 1000, TradeDirection.ENTRY, 'entry_fill');
                break;

            case OperationScenario.CANCEL_AFTER_FILL:
                // Violates mutation guard: terminal mutation from FILLED -> CANCELLED
                await persistSimulatedEvent('ORDER_CREATED', 5000, TradeDirection.ENTRY, 'entry');
                await persistSimulatedEvent('ORDER_OPEN', 4000, TradeDirection.ENTRY, 'order_open');
                await persistSimulatedEvent('ORDER_FILLED', 2000, TradeDirection.ENTRY, 'entry_fill');
                await persistSimulatedEvent('ORDER_CANCELLED', 1000, TradeDirection.ENTRY, 'entry_cancel');
                break;

            default:
                throw new Error(`Unknown operation scenario: ${scenario}`);
        }

        // Emit SIMULATION_COMPLETED event to EventBus
        EventBus.getInstance().emit(
            EventCategory.SYSTEM,
            WatchdogEventType.SIMULATION_COMPLETED,
            'OperationsSimulationService',
            { scenario, tradeId, symbol }
        );
    }
}
