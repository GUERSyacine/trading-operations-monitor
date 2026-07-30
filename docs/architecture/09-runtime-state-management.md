# Execution Watchdog Architecture Manual
## Chapter IX — Runtime State Management

This chapter defines the state management architecture of the Execution Watchdog Agent. It details how the Agent tracks, transitions, aggregates, and recovers its system health model during runtime execution without introducing data inconsistency or redundant reporting overhead.

---

### 1. Purpose & Scope

The Agent must maintain a continuous, accurate representation of the system's operational state to determine when to trigger alerts, execute recovery policies, or halt trading processes. Rather than treating health status as transient detector outputs, the Agent coordinates its operational state via a structured runtime health model.

This chapter answers a key architectural question:
> **How does the Agent maintain, evolve, and recover its understanding of operational health during execution?**

---

### 2. State Ownership

State authority within the Agent is distributed according to clear ownership boundaries:

```
      Watchdog Detectors
              │
              ▼ proposes transitions
       Incident Manager
      (State Authority) ◄─── Runtime Queries
              │
              ▼ dispatches transitions
       Outbox Publisher
              │
              ▼
       External Systems
```

*   **Watchdog Detectors:** Act as observational sensors. They lack the authority to write or persist health states. Instead, they propose transition events based on local metrics and checks.
*   **Incident Manager:** The central State Authority. It owns, validates, and reconciles the active health state. It deduplicates incoming proposals and resolves conflicts.
*   **Outbox Publisher:** The event disseminator. It listens to committed state transitions from the Incident Manager and serializes them into outbox records for distribution to external systems.

---

### 3. State Hierarchy (Dual-Plane Model)

The Agent separates system health into two distinct, hierarchically related planes:

```
            [ Global State Plane ]
                      ▲
                      │ Aggregates
                      │
            [ Symbol State Plane ]
```

#### 3.A. Global State Plane
Represents system-wide operational health. Incidents in this plane reflect issues that affect the entire Agent process or dependencies (e.g., PostgreSQL connection failures, Telegram channel access outages, or overall memory exhaustion).

#### 3.B. Symbol State Plane
Represents localized, instrument-specific health. Incidents in this plane are bound to specific tradeable instruments (e.g., latency anomalies on `BTC/USDT`, or order placement timeouts for a single strategy).

#### 3.C. Hierarchical Aggregation
The Global Plane does not operate independently of the Symbol Plane. Instead, the Global Plane aggregates active Symbol-level incidents. A critical failure on a Symbol plane can propagate upward to degrade the overall Global State, ensuring that isolated faults are summarized in the top-level system health.

---

### 4. State Transition Model vs. Events

To maintain consistency, the Agent distinguishes between persistent states and the events that drive changes:

```
              [ Persistent States ]
             ┌─────────────────────┐
             │       Active        │
             └──────────┬──────────┘
                        │ RESOLVED Event
                        ▼
             ┌─────────────────────┐
             │      Resolved       │
             └─────────────────────┘
```

#### 4.A. Persistent Incident States
An incident exists in one of two mutually exclusive persistent states:
*   **Active:** The incident is currently affecting system health.
*   **Resolved:** The underlying condition is cleared, and the incident is closed.

#### 4.B. Incident Lifecycle Events
Transitions between persistent states are driven by sequence events:
*   **DETECTED:** Dispatched when a detector first identifies a new unhealthy condition, shifting the state from non-existent to `Active`.
*   **LEVEL_CHANGED:** Triggered when an active incident escalates or de-escalates in severity (e.g., moving from `WARNING` to `CRITICAL`).
*   **RESOLVED:** Dispatched when a condition returns to healthy parameters, shifting the state from `Active` to `Resolved`.

#### 4.C. Transition Actors
State changes are driven by four authorized actors:
*   **Watchdog Detectors:** Automated check routines that identify and report anomalies.
*   **Recovery Subsystems:** Automatic mechanisms that verify resolution and apply recovery scripts.
*   **User Actions:** Manual overrides and resolution requests triggered by operators.
*   **Automated Simulators:** Simulated event generators used for testing resilience.

---

### 5. Consistency & Rehydration

#### 5.A. Crash Recovery & Rehydration
To survive unexpected agent crashes, restarts, or power losses without losing state continuity, the Agent performs state rehydration on bootstrap. The Incident Manager reads all unresolved incidents from persistent storage and rebuilds its transient in-memory map. This ensures that:
*   Active incidents are not forgotten on restart.
*   Cooldown timers and monitoring cycles resume with accurate historical context.
*   The Agent does not dispatch duplicate "Incident Detected" notifications for pre-existing conditions.

#### 5.B. Transition Deduplication
Detectors publish check results at regular intervals. To prevent state database bloat and excessive alert notifications, the Incident Manager performs Transition Deduplication. If a detector proposes a transition with a severity level matching an already active incident for that source and symbol, the proposal is discarded, and no transition event is written or published.

---

### 6. State Consolidation & Escalation

#### 6.A. Deterministic Roll-Up
The overall global health status (`globalLevel`) is determined by aggregating all active incidents. This roll-up is deterministic and follows a strict severity hierarchy:
$$\text{Global Severity} = \max(\text{Active Global Incidents}, \text{Active Symbol Incidents})$$

If any single active incident (global or symbol-specific) escalates to `CRITICAL`, the global state immediately transitions to `CRITICAL`, triggers alert services, and signals safety-halt procedures.

#### 6.B. Correlation & Grouping
To minimize alert fatigue during cascading failures, the Incident Manager groups related incidents into a single **Incident Group** using a temporal correlation key.
*   *Infrastructure Incidents:* Grouped system-wide under a global infrastructure key (e.g., `INFRA:GLOBAL`).
*   *Operations Incidents:* Grouped by symbol (e.g., `OPS:BTC/USDT` or `OPS:GLOBAL`).

Incidents occurring within a configurable grouping window are associated with the same Incident Group, allowing external alerting adapters to summarize multiple related events as a single parent alert.

---

### 7. Subsystem Roles

*   **Incident Manager:** The central state broker. It coordinates in-memory state, executes transition rules, manages auto-resolution timers (TTLs), and enforces deduplication. It handles incident classification internally.
*   **Outbox Publisher:** Dispatches transition events to the incident outbox for asynchronous synchronization.
*   **Persistent Database:** Provides durable local storage, housing tables for incidents, transition histories, and grouped events.

---

### 8. Operational Guarantees

*   **State Rehydration Guarantee:** The Incident Manager rehydrates its active memory map on startup, ensuring no loss of unresolved health states across process restarts.
*   **Idempotency & Noise Mitigation:** Multiple matching reports from a detector produce a single transition event, preventing outbox clutter and notification duplication.
*   **Safe-Halt Execution:** A transition of the global health state to `CRITICAL` (such as a `LIFECYCLE_INTEGRITY` anomaly) is guaranteed to be queryable by execution components to halt trading operations immediately.

---

### 9. Design Principles

*   **Single Source of Health Truth:** The Incident Manager is the sole authority for queryable health states. No component queries detectors directly to evaluate system state.
*   **Localized Isolation:** Failures occurring within the Symbol State Plane do not interfere with adjacent symbol processing loops.
*   **Asynchronous Transition Dispatch:** Event publishing is offloaded to the Outbox Publisher to prevent database locking or network latency from blocking the main State Broker thread.

---

### 10. Design Rationale

#### 10.A. Why Roll Up Multiple Incidents instead of Manually Modifying Global State?
A manual or ad-hoc global state update is error-prone and risks leaving the system in an incorrect state when one of several concurrent failures is resolved. Aggregating active incidents dynamically ensures that the global health status is always a precise, deterministic reflection of all individual system faults.

#### 10.B. Why Use a Transaction-Based Transition Outbox instead of Immediate Alert Dispatch?
If detectors or the Incident Manager sent alert messages directly over HTTP/WebSocket, a network disconnect during a state transition would cause alerts to be lost forever. Saving transitions inside the database outbox as part of the state write transaction guarantees that every state transition is durably written before publication is attempted, providing a reliable audit trail and guaranteed alert delivery.

#### 10.C. Why Support Automated TTL Resolution?
Certain passive checks do not have a corresponding "healthy" resolution signal. For example, a missing heartbeat is identified by the absence of an event, but the source may never send a recovery signal. Automated Time-To-Live (TTL) checks ensure that such passive alerts are automatically resolved after a set period of silence, preventing stale incidents from locking the system in a degraded state.

---

### 11. Related Chapters

*   **Chapter I — Agent Lifecycle:** Describes process-level bootstrapping during which state rehydration occurs.
*   **Chapter VII — Failure Recovery:** Details the backoff and retry rules triggered by incident state changes.
*   **Chapter VIII — Scheduler Architecture:** Explains the coordinate execution loops that run detectors and check auto-resolution TTLs.
*   **Chapter X — Monitoring & Detection:** Outlines how detectors observe parameters and propose incident transitions.
