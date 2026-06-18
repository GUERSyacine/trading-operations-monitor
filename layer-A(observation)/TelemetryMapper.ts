import { LifecycleEvent, LifecycleEventType } from './types';

export class TelemetryMapper {
    /**
     * Map a raw webhook payload from Freqtrade into a LifecycleEvent.
     */
    static mapFreqtradeWebhook(payload: any, observedAt: number): LifecycleEvent | null {
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        const type = payload.type || payload.event;
        if (!type || typeof type !== 'string') {
            return null;
        }

        const normalizedType = type.toLowerCase();
        let eventType: LifecycleEventType;

        if (normalizedType === 'entry' || normalizedType === 'exit') {
            eventType = 'SIGNAL';
        } else if (normalizedType === 'entry_fill' || normalizedType === 'exit_fill') {
            eventType = 'ORDER_FILLED';
        } else if (
            normalizedType === 'entry_cancel' ||
            normalizedType === 'exit_cancel' ||
            normalizedType === 'order_cancelled' ||
            normalizedType === 'order_cancel'
        ) {
            eventType = 'ORDER_CANCELLED';
        } else if (normalizedType === 'order_created') {
            eventType = 'ORDER_CREATED';
        } else if (normalizedType === 'order_submitted' || normalizedType === 'order_sent') {
            eventType = 'ORDER_SUBMITTED';
        } else if (normalizedType === 'order_acknowledged' || normalizedType === 'order_ack') {
            eventType = 'ORDER_ACKNOWLEDGED';
        } else if (normalizedType === 'order_open') {
            eventType = 'ORDER_OPEN';
        } else if (normalizedType === 'order_partially_filled' || normalizedType === 'order_partial_fill') {
            eventType = 'ORDER_PARTIALLY_FILLED';
        } else if (normalizedType === 'exchange_rejected') {
            eventType = 'EXCHANGE_REJECTED';
        } else if (normalizedType === 'order_failed') {
            eventType = 'ORDER_FAILED';
        } else {
            return null;
        }

        const rawTradeId = payload.trade_id || payload.tradeId;
        const tradeId = rawTradeId !== undefined && rawTradeId !== null ? String(rawTradeId) : 'unknown';

        const rawOrderId = payload.order_id || payload.orderId;
        const orderId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : undefined;

        const rawSymbol = payload.symbol || payload.pair;
        const symbol = typeof rawSymbol === 'string' ? rawSymbol.replace('/', '') : undefined;

        const rawSide = payload.side || payload.direction;
        let side: 'BUY' | 'SELL' | undefined = undefined;
        if (typeof rawSide === 'string') {
            const sideUpper = rawSide.toUpperCase();
            if (sideUpper === 'BUY' || sideUpper === 'LONG') {
                side = 'BUY';
            } else if (sideUpper === 'SELL' || sideUpper === 'SHORT') {
                side = 'SELL';
            }
        }

        const rawPrice = payload.price || payload.rate || payload.limit_price || payload.open_rate || payload.close_rate;
        const price = rawPrice !== undefined && rawPrice !== null ? Number(rawPrice) : undefined;

        const rawAmount = payload.amount || payload.volume;
        const amount = rawAmount !== undefined && rawAmount !== null ? Number(rawAmount) : undefined;

        const rawTimestamp = payload.timestamp || payload.date || payload.open_date || payload.close_date;
        const eventTimestamp = rawTimestamp ? new Date(rawTimestamp).getTime() : observedAt;

        // Deterministic eventId: `${source}:${orderId || tradeId}:${eventType}:${timestamp}`
        const identifier = orderId || tradeId;
        const eventId = `FREQTRADE:${identifier}:${eventType}:${eventTimestamp}`;

        return {
            schemaVersion: 1,
            eventId,
            tradeId,
            orderId,
            eventType,
            source: 'FREQTRADE',
            captureMethod: 'WEBHOOK',
            eventTimestamp,
            observedAt,
            symbol,
            side,
            price,
            amount
        };
    }

    /**
     * Map a polled order from Freqtrade REST API /trades endpoint into a LifecycleEvent.
     */
    static mapFreqtradePolledOrder(
        order: any,
        trade: any,
        eventType: LifecycleEventType,
        observedAt: number
    ): LifecycleEvent {
        const tradeId = String(trade.trade_id || 'unknown');
        const orderId = String(order.order_id);
        const symbol = typeof order.pair === 'string' ? order.pair.replace('/', '') : undefined;
        
        let side: 'BUY' | 'SELL' | undefined = undefined;
        if (typeof order.ft_order_side === 'string') {
            const sideUpper = order.ft_order_side.toUpperCase();
            if (sideUpper === 'BUY') {
                side = 'BUY';
            } else if (sideUpper === 'SELL') {
                side = 'SELL';
            }
        }

        const price = order.average !== undefined && order.average !== null ? Number(order.average) : Number(order.price);
        const amount = order.filled !== undefined && order.filled !== null ? Number(order.filled) : Number(order.amount);
        
        const eventTimestamp = order.order_filled_timestamp || order.order_timestamp || observedAt;

        // Deterministic eventId: `${source}:${orderId || tradeId}:${eventType}:${timestamp}`
        const eventId = `FREQTRADE:${orderId}:${eventType}:${eventTimestamp}`;

        return {
            schemaVersion: 1,
            eventId,
            tradeId,
            orderId,
            eventType,
            source: 'FREQTRADE',
            captureMethod: 'POLLING',
            eventTimestamp,
            observedAt,
            symbol,
            side,
            price,
            amount
        };
    }
}
