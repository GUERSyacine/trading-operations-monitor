# Freqtrade WebSocket Event Observations & Payload Contract

This document outlines the observed message schemas and JSON structures captured from the live Freqtrade WebSocket interface (`/api/v1/message/ws`) during initial integration tests. These payload schemas serve as the contract for designing the translation mapping layers in Phase 2.

---

## 1. Connection & Subscription Payload
To subscribe to Freqtrade bot events, the client connects to:
`ws://<host>:<port>/api/v1/message/ws?token=<ws_token>`

Upon connection, the client must send a JSON subscription request specifying the target RPC message types:
```json
{
    "type": "subscribe",
    "data": [
        "entry",
        "entry_fill",
        "entry_cancel",
        "exit",
        "exit_fill",
        "exit_cancel",
        "status",
        "warning",
        "startup"
    ]
}
```

---

## 2. Observed Message Payload (Contract)

### `entry` Message Type (Order Placement / SIGNAL Event)
Fires when the Freqtrade bot initiates/enters a new order (either manually via `forceenter` or programmatically via a strategy signal).

#### Observed JSON Structure
```json
{
  "trade_id": 34,
  "type": "entry",
  "buy_tag": "force_entry",
  "enter_tag": "force_entry",
  "exchange": "Binance",
  "pair": "BTC/USDT",
  "leverage": 1.0,
  "direction": "Long",
  "limit": 10000.0,
  "order_rate": 10000.0,
  "open_rate": 10000.0,
  "order_type": "limit",
  "stake_amount": 100.0,
  "stake_currency": "USDT",
  "base_currency": "BTC",
  "quote_currency": "USDT",
  "fiat_currency": "USD",
  "amount": 0.01,
  "open_date": "2026-06-20T16:43:36.645024+00:00",
  "current_rate": 63998.87,
  "sub_trade": false
}
```

---

## 3. Payload Fields Mapping Schema (for Phase 2 Mapper)

| Field Name | Type | Description | Required | Map Target (Canonical Event) |
| :--- | :--- | :--- | :--- | :--- |
| **`trade_id`** | `number` | Unique ID of the trade in Freqtrade bot | Yes | `tradeId` (stringified) |
| **`type`** | `string` | RPCMessageType value (e.g. `entry`, `entry_fill`) | Yes | Map to canonical `eventType` (e.g., `entry` -> `SIGNAL`) |
| **`pair`** | `string` | Trading pair (e.g. `BTC/USDT`) | Yes | `symbol` (remove `/` -> `BTCUSDT`) |
| **`direction`** | `string` | Direction of the trade (`Long` / `Short`) | Yes | `side` (`Long` -> `BUY`, `Short` -> `SELL`) |
| **`limit`** | `number` | Order entry limit rate | No | `price` |
| **`amount`** | `number` | Size of the order in base currency | Yes | `amount` |
| **`open_date`** | `string` | Timestamp in ISO 8601 format | Yes | `eventTimestamp` (epoch ms) |
| **`order_id`** | `string` | The exchange order ID (if already submitted/created) | No | `orderId` |

---

## 4. Mapper Normalization Rules
1. **Event Types Mapping**:
   * `"entry"` / `"exit"` $\rightarrow$ `SIGNAL`
   * `"entry_fill"` / `"exit_fill"` $\rightarrow$ `ORDER_FILLED`
   * `"entry_cancel"` / `"exit_cancel"` $\rightarrow$ `ORDER_CANCELLED`
2. **Symbol Mapping**: Convert `/` slashed pairs (e.g. `BTC/USDT`) to canonical uppercase symbols (e.g. `BTCUSDT`).
3. **Price/Amount**: Coerce to standard JavaScript float numbers.
4. **Timestamp**: Parse ISO 8601 dates (e.g. `open_date`) into epoch milliseconds (`Date.getTime()`).
