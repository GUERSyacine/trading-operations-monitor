# Execution Watchdog Data Flow Map
## Phase 4 — Data Lifecycle & Object Transmission

This document details the lifecycle and transmission paths of core objects within the Execution Watchdog platform, tracing their movement from generation on the Edge to processing in the Cloud.

---

## 1. Incident & Alert Lifecycle Flow

```
[Telemetry Source]
       │
       ▼ (Raw Metrics)
 [Telemetry Detector]
       │
       ▼ (Proposes Transition)
[Incident Proposal] ────────► [Incident Manager]
                                    │
                       ┌────────────┴────────────┐
                       ▼ (DB Transaction)        ▼ (Triggers Alert)
               [Incident & Transition]      [Alert Request]
                       │                         │
                       ▼                         ▼
               [Outbox Publisher]         [Alerting Service]
                       │ (Durable Write)         │ (Suppression / Formatter)
                       │                         ▼
                       └─────────────────► [Outbox Record]
                                                 │
                                                 ▼ (Asynchronous)
                                          [Outbox Sync Worker]
                                                 │
                                                 ▼ (HTTPS Outbound)
                                           [Cloud Gateway]
```

---

## 2. Object Lifecycle Definitions

### A. Incident Proposal
*   **Source:** Telemetry Detectors.
*   **Payload:** `{ level: IncidentSeverity, source: string, reason: string, symbol?: string, since: number }`
*   **Lifecycle:** 
    1. Instantiated by a detector during a violation tick.
    2. Sent to `IncidentManager.reportIncident()`.
    3. Evaluated against active in-memory incident keys.
    4. Discarded if duplicate. If level changes or incident is new, transitions to **Incident State**.

### B. Incident & Incident Transition (State)
*   **Source:** `IncidentManager`.
*   **Database Tables:** `Incident`, `IncidentTransition`, `IncidentGroup`.
*   **Lifecycle:**
    1. Committed inside a database transaction on the local PostgreSQL database.
    2. In parallel, `publishEvent` is called, compiling an outbox event.
    3. Triggers downstream alert requests.

### C. Alert Request
*   **Source:** `IncidentManager`.
*   **Payload:** `{ level: 'CRITICAL' | 'WARNING', title: string, message: string, entityId: string }`
*   **Lifecycle:**
    1. Dispatched immediately to `AlertingService.sendAlert()`.
    2. Checked against the local in-memory suppression cooldown cache.
    3. If suppressed, discarded. If fresh, formatted into a unified notification package.
    4. Written as an **Outbox Record** under the type `ALERT`.

### D. Outbox Record
*   **Source:** `IncidentManager` / `AlertingService`.
*   **Database Table:** `Outbox` queue.
*   **Lifecycle:**
    1. Saved to the local DB outbox table as JSON.
    2. Polled asynchronously by the `OutboxSyncWorker`.
    3. Sent chronologically to the Cloud Gateway `/api/v1/agent/incidents` or `/api/v1/agent/alerts`.
    4. On successful delivery confirmation (`HTTP 201 Created`), the record is deleted from the local database.

---

## 3. Administrative Control Flows

### A. Heartbeat Transmission
1. The **Heartbeat Scheduler** wakes up on the configured interval.
2. Queries agent environment properties and capabilities.
3. Makes an outbound POST request to the Gateway `/api/v1/agent/heartbeat`.
4. Gateway updates agent status to `ONLINE` in the Cloud DB and returns sync directives.

### B. Configuration Delivery
1. The **Config Scheduler** checks the last active revision ID.
2. Queries `/api/v1/agent/config` via GET, passing the revision ID in headers.
3. Gateway returns `notModified: true` or the new JSON configuration block.
4. **ConfigManager** performs schema verification and applies configuration parameters atomically in-memory.
