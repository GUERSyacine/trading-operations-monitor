# Execution Watchdog Architecture Constitution
## Phase 1 — Non-Negotiable System Invariants

This document establishes the **Architecture Constitution** for the Execution Watchdog. It compiles the absolute, non-negotiable invariants governing the execution, state ownership, and communication boundaries across the Edge Agent and the Cloud Gateway. 

Every implementation, refactoring, and code change must comply with these rules to preserve the integrity of the distributed system.

---

## I. State Ownership Invariants

1. **Sole State Authority:** The `IncidentManager` is the **only** component authorized to declare, transition, or mutate the runtime health state of the system (both Global and Symbol-level states).
2. **Read-Only Exposure:** Other components must only access system health state via read-only interfaces or event subscriptions. They must never directly alter the in-memory state or the underlying database status fields.
3. **Graceful Rehydration:** The runtime health state must be fully rehydrated from the local persistence layer upon startup to ensure crash-recovery safety.
4. **Idempotence:** State transitions proposed to the `IncidentManager` must be processed idempotently; duplicate proposals must be discarded without writing redundant transition entries.

---

## II. Telemetry & Ingestion Invariants (Detectors)

1. **Stateless Observation:** Detectors (Infrastructure, Operations, and Execution Intelligence) are stateless observers. Their only job is to gather raw metrics, evaluate them against configured rules, and propose state transitions.
2. **No Side-Effects:** Detectors must **never**:
   * Direct-write to incident database tables.
   * Dispatch notifications or messages to users.
   * Halt, start, or restart other services directly.
3. **Isolation:** A failure in one detector must not propagate or cause the failure of other detectors or the core scheduler.

---

## III. Timing & Coordination Invariants (Schedulers)

1. **Pure Coordination:** Schedulers (Heartbeat, Config, and Task schedulers) are responsible **only** for timing, interval triggers, cycle ticks, and re-entrancy protection.
2. **Zero Business Logic:** Schedulers must not contain business logic, telemetry evaluation rules, retry algorithms, or state transition rules. They delegate all tasks to dedicated services.

---

## IV. Persistence Invariants

1. **State Storage Only:** The persistence layer (PostgreSQL / Prisma ORM) exists solely to store transition histories, configurations, credentials, and outbox logs.
2. **Zero State Evaluation:** Databases must never contain trigger logic or stored procedures that evaluate health state, compute severity levels, or decide active incident transitions. All reasoning happens in application code.

---

## V. Alerting & Communication Invariants

1. **Communication Delivery Only:** The Alerting subsystem is responsible only for formatting messages, applying local rate-limiting (suppression cooldowns), and dispatching messages.
2. **Zero Health Ownership:** The Alerting subsystem must never determine system health, declare incidents, or track runtime status. It is a downstream receiver of events.
3. **Edge Privacy & Transports:** In the standard SaaS deployment, notification credentials are Cloud-managed. If an alternative deployment model enables direct transports, those credentials remain isolated to the Alerting subsystem and must never influence runtime state.

---

## VI. Outbox & Sync Invariants

1. **Durable Queuing:** The Outbox must persist all state transitions and alert records to local storage before attempt-delivery.
2. **Non-Blocking Asynchrony:** Outbox synchronization must operate asynchronously in the background. WAN network latency, gateway timeouts, or network outages must never block the Agent's real-time observation and evaluation cycles.
3. **Monotonicity:** Incident records must be synced to the Cloud in strict chronological order to preserve the timeline integrity for Cloud-side diagnostics.

---

## VII. Security & Network Invariants

1. **No Inbound Connections:** The Edge Agent must expose no public management APIs, open no listening ports to the WAN, and accept no inbound control traffic. 
2. **Outbound-Only Init:** All communication between the Agent and the Cloud Gateway must be initiated by the Agent via outbound HTTPS/WSS requests.
3. **Credential Sandboxing:** Access to local credentials, keys, and session tokens must be isolated via file-permission restrictions and local identity stores.

---

## VIII. Cloud Analysis & Diagnostics Invariants

1. **Centralized RCA:** Deep Root Cause Analysis (RCA), timeline reconstruction, multi-agent correlation, and historical analysis are owned exclusively by the Cloud.
2. **Evidence Collection:** The Agent is responsible only for capturing real-time evidence logs and process metadata (Forensics) at the moment of failure and queueing them into the Outbox. It does not score or diagnose the root cause locally.

---

## IX. Ownership Invariants

1. **Strict Single Ownership:** Every responsibility has exactly one owner. A subsystem may own, consume, or publish, but it must never share ownership of a single concern with another subsystem. If two components "co-own" the same responsibility, the architecture is violating this rule.

---

## X. Event Flow Invariants

1. **Strict Unidirectional Flow:** The flow of data and events must be strictly unidirectional:
   ```
   Observation → Proposal → State Transition → Persistence → Communication
   ```
2. **No Reverse Dependencies:** Reverse dependencies are forbidden (e.g., Alerting cannot modify IncidentManager state, Outbox cannot modify Incident state, and Gateway responses cannot directly mutate detector logic).

---

## XI. Dependency Invariants

1. **Directional Dependency:** Higher-level services may depend on lower-level abstractions, but lower-level services must never depend on higher-level orchestration (e.g., Schedulers call Detectors, not the other way around).
2. **Contract-Based Interfaces:** Downstream services (such as Alerting) must never know the internals of upstream components (such as `IncidentManager`); they must only interact via their public contracts.

---

## XII. Policy vs. Execution Invariants

1. **Cloud Decides, Agent Executes:** The Cloud Gateway owns policy (licensing, configurations, capabilities authorization, and updates). The Agent owns execution (monitoring, protection, persistence, and telemetry). 
2. **Execution Independence:** The Agent must never depend on active Cloud decisions or availability to execute its core protection and monitoring loops.

---

## XIII. Local Autonomy Invariants

1. **Survival During Outages:** Loss of Cloud connectivity must never degrade the local Agent's capability to protect the edge system. All monitoring, local state transitions, persistence, safety halts, and evidence collection must continue functioning autonomously. Only sync operations are allowed to pause or retry.
