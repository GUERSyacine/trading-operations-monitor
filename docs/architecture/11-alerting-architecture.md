# Execution Watchdog Architecture Manual
## Chapter XI — Alerting Architecture

This chapter defines the alerting architecture of the Execution Watchdog Agent. It details how the Agent formats, deduplicates, and delivers notifications to external channels when incidents occur, ensuring that operators receive critical information without suffering alert fatigue.

---

### 1. Purpose & Scope

The Agent must notify operators and external systems of changes in system health. The alerting architecture defines the communication path through which state transitions are published. By isolating notifications from the core health state, the Agent can throttle, format, and route alerts dynamically without impacting the underlying state model.

This chapter answers a key architectural question:
> **How does the Agent route, format, deduplicate, and deliver notifications to various channels when incidents occur?**

---

### 2. Notification Ownership

State authority and communication responsibilities are separated into distinct boundaries:

```
            Incident Manager
         (State Change Trigger)
                   │
                   ▼ requests alert
            Alerting Service
     (Formatter, Deduplicator, Router)
                   │
                   ▼ routes alert
         Notification Transport
          (Channel Abstraction)
         ┌─────────┴─────────┐
         ▼                   ▼
  Cloud Transport     Direct Transport
```

*   **Incident Manager:** Initiates alert requests. It does not know how alerts are structured or where they are sent; it simply triggers notification requests on state transitions.
*   **Alerting Service:** Coordinates formatting, suppression checks, and transport routing. It decides whether an alert is allowed to proceed and which channels it should target.
*   **Notification Transport:** Decouples specific channels from the service core. Transports act as adapters, formatting payloads and executing final transmissions.

---

### 3. Notification Delivery Lifecycle

Notifications progress through a structured delivery lifecycle. Suppressed alerts are audited as filtered events, ensuring that rate-limiting decisions are fully recorded:

```
          [ State Transition ]
                   │
                   ▼
               [ Format ]
                   │
                   ▼
             [ Suppress? ]
            ├── Yes ──► [ Audit ] (Suppressed)
            └── No
                 │
                 ▼
              [ Route ]
                 │
                 ▼
            [ Transmit ]
                 │
                 ▼
              [ Audit ] (Transmitted)
```

*   **Format:** The Alerting Service hydrates raw incident parameters (severity, source, title, description) into user-friendly layouts (e.g., mapping levels to visual emojis and timestamps).
*   **Suppress?:** The engine checks the active cooldown cache. If an identical alert key was recently transmitted, the notification is suppressed and marked as audited.
*   **Route:** The service matches the alert severity with active channels (e.g., routing `CRITICAL` warnings to direct edge channels and cloud queues simultaneously).
*   **Transmit:** The designated transport adapters perform the API or pipeline calls.
*   **Audit:** The outcome (transmitted or suppressed) is written to local persistent log records for system auditing.

---

### 4. Alert Suppression & Cooldown

To prevent notification bursts during flapping failure cycles, the Alerting Service implements three layers of communication filtering:

#### 4.A. Keyed Cooldown Cache
Every incoming alert is mapped to a unique deduplication signature based on its level, title, and target entity identifier:
$$\text{Deduplication Key} = \text{Severity} + \text{Title} + \text{Entity ID}$$

If an alert matching this key is requested within a configured cooldown window (e.g., 15 minutes), the Alerting Service suppresses the notification. Crucially, **suppression affects only delivery, not runtime state.** The underlying incident state remains active in the Incident Manager; only the notification is rate-limited.

#### 4.B. Feature Flag Suppression
Alert delivery can be toggled system-wide or per-environment using feature flags. When the alerting capability is disabled via the feature flag service, transport transmissions are bypassed, while local database audit records continue to be written.

---

### 5. Channel Transport Abstraction

The Agent interacts with external channels via a standardized notification transport contract (implemented in the current codebase by the `NotificationTransport` interface). This contract isolates delivery mechanisms into two primary patterns:

*   **Cloud Transport:** Publishes outbound notifications to an asynchronous communication pipeline. The pipeline handles queued message buffering and synchronization with the Central Gateway.
*   **Direct Transport:** Direct integration adapters (such as `TelegramTransport` or custom webhooks) that deliver notifications directly to end-user systems. These run as local HTTP REST calls from the edge, bypassing Gateway infrastructure entirely.

---

### 6. Durable Auditing (Alert Logs)

The alerting architecture maintains a separate database persistence plane (`alertLog`) that is decoupled from active incident records. 
*   An active incident tracks the *state* of a system component (which remains `Active` until resolved).
*   Alert logs track the *history of communication* associated with that state (recording when messages were sent, to which channels, or if they were suppressed).

This separation prevents database locking issues on active health states and ensures a complete audit trail of notification attempts across the lifespan of a single system failure.

---

### 7. Subsystem Roles

*   **Alerting Service:** The central notification coordinator. It handles input validation, generates deduplication keys, executes cooldown lookups, evaluates feature flags, and dispatches messages to active transports.
*   **Notification Transport:** The interface contract specifying the `send()` parameters that all channel adapters must implement.
*   **Telegram Transport:** A direct transport adapter that formats Markdown payloads and transmits them directly via the Telegram Bot API.
*   **Cloud Transport:** A transport adapter that serializes payloads for publication through the Agent's asynchronous communication queue.
*   **Persistent Database:** Durable local storage housing the `AlertLog` table for historical audit logs.

---

### 8. Operational Guarantees

*   **Rate-Limiting (Burst Protection):** The Agent guarantees that repeated alerts matching the same deduplication key will be suppressed during active cooldown windows, preventing external API rate-limit exhaustion.
*   **Credential Fault Isolation:** Missing channel credentials (e.g., absent environment tokens) or network timeouts during direct REST pings will fail-gracefully. They generate local diagnostic warnings but do not block the execution loops of the State Broker.
*   **Audit Log Completeness:** The Agent guarantees that every alert attempt is logged locally in the persistent database before transmission, ensuring audit records are preserved even if network connectivity fails during delivery.

---

### 9. Design Principles

*   **Transport Extensibility:** Adding a new communication channel (such as Slack or Discord) requires only implementing the `NotificationTransport` interface, without modifying the Alerting Service or the Incident Manager.
*   **Local Autonomy:** Direct transports operate entirely at the edge, allowing the Agent to notify operators of critical failures even when connections to the Central Gateway are offline.
*   **Keyed Suppression:** Cooldown rules are isolated to specific incident signatures, ensuring that rate-limiting a specific symbol's warning does not block warning notifications from unrelated system sources.

---

### 10. Design Rationale

#### 10.A. Why Separate Alert Logs from Active Incident States?
An active system incident can remain open for hours or days while recovery attempts are processed. During this window, operators might receive multiple alert updates (e.g., initial warning, escalation, and periodic reminders). Treating state and notifications as a single model would result in duplicate state records or lost audit histories. Decoupling them allows a single incident state to map cleanly to a series of distinct communication events.

#### 10.B. Why Support Direct API Transports alongside Cloud Transports?
If all notifications were routed exclusively through the Cloud Transport, any network failure separating the Agent from the Central Gateway would leave the operators blind. Providing direct edge transports (like Telegram) allows the Agent to bypass the central pipeline during catastrophic network failures, delivering critical telemetry directly from the edge.

#### 10.C. Why Implement an In-Memory Cooldown Cache rather than Database Lookups?
Querying database tables to verify if an alert was sent in the last 15 minutes introduces disk I/O and query latency. During rapid incident flapping cycles, this lookup overhead could bottleneck the State Broker. An in-memory cache provides near-instantaneous deduplication checks, protecting database performance.

---

### 11. Related Chapters

*   **Chapter II — Communication Model:** Describes the transport sockets used by the Cloud pipeline to sync with the Gateway.
*   **Chapter VII — Failure Recovery:** Details recovery actions triggered alongside notification dispatches.
*   **Chapter IX — Runtime State Management:** Explains how incident state transitions are evaluated and routed to trigger alerting pipelines.
