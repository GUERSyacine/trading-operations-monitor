# Execution Watchdog Ownership Map
## Phase 2 — Subsystem Responsibilities & Boundaries

This document maps every subsystem in the Execution Watchdog platform to a single, exclusive set of responsibilities. It defines who owns the component, who is allowed to call it, what it may read/write, and what it is strictly forbidden to do.

---

## 1. Edge Agent Subsystems

### Watchdog Orchestrator (Composition Root)
*   **Description:** The bootstrap entry point of the Agent process.
*   **Owns:** Process initialization, graceful shutdown orchestration, and composition of dependencies.
*   **Who is allowed to call it:** Systemd / Process supervisor.
*   **What it may read:** Environment variables, local filesystem config file.
*   **What it may write:** Process logs (stdout/stderr).
*   **FORBIDDEN to do:** Contain any business logic, telemetry rules, or database transactions.

---

### Schedulers (Heartbeat, Config, Task)
*   **Description:** Coordination of recurring tasks and execution loops.
*   **Owns:** Execution timing, interval triggers, tick cycles, and concurrency/re-entrancy locks.
*   **Who is allowed to call it:** Watchdog Orchestrator.
*   **What it may read:** Scheduler intervals (from Config).
*   **What it may write:** In-memory execution timestamps.
*   **FORBIDDEN to do:** Evaluate telemetry, decide incident state transitions, execute database queries, or write retry business rules.

---

### Telemetry Detectors (Observation Layer)
*   **Description:** Observers of infrastructure, operations, and execution feeds.
*   **Owns:** Raw metric ingestion, limit/rule threshold checking, and transition Proposals.
*   **Who is allowed to call it:** Schedulers (on ticks) or Event Bus.
*   **What it may read:** Active config, system metrics, adapters API, process files.
*   **What it may write:** Local memory cache of recent metrics.
*   **FORBIDDEN to do:** Write to SQL database tables, update global incident state directly, send alerts to users, or invoke network clients.

---

### Incident Manager (Edge State Authority)
*   **Description:** State machine for runtime system health.
*   **Owns:** In-memory Global & Symbol-level incident states, deduplication cooldowns, and lifecycle state transitions.
*   **Who is allowed to call it:** Detectors (via Proposals), Recovery Service.
*   **What it may read:** Active config, local DB (for rehydration only).
*   **What it may write:** Local state memory, local DB (`Incident` & `IncidentTransition` records via transaction), Outbox (via OutboxPublisher).
*   **FORBIDDEN to do:** Format notifications, communicate with notification channels, or run scoring/RCA rules.

---

### Edge Forensics (Evidence Collector)
*   **Description:** Evidence gathering at the moment of failure.
*   **Owns:** Snapping system logs, Docker exit codes, and process memory configurations.
*   **Who is allowed to call it:** Incident Manager (when transition is committed).
*   **What it may read:** Docker socket API, local process logs, system memory files.
*   **What it may write:** Outbox (packages evidence into the outbox event payload).
*   **FORBIDDEN to do:** Determine the root cause of the incident, score severity, or communicate with the Cloud.

---

### Local Persistence (Database)
*   **Description:** Durable edge storage.
*   **Owns:** Relational database schemas, schema constraints, and transactional consistency.
*   **Who is allowed to call it:** Incident Manager, Identity Service, Reporting Service, Outbox Sync Worker.
*   **What it may read:** SQL query instructions.
*   **What it may write:** SQL table rows.
*   **FORBIDDEN to do:** Contain state evaluation rules, triggers, or stored procedures that decide incident status.

---

### Alerting Service (Edge Communicator)
*   **Description:** Local alert packager.
*   **Owns:** Alert template compilation, local suppression/rate-limiting caching.
*   **Who is allowed to call it:** Incident Manager.
*   **What it may read:** Cooldown limits, active communication parameters.
*   **What it may write:** In-memory alert cooldown timestamps, Outbox (via OutboxPublisher).
*   **FORBIDDEN to do:** Alter incident state, query active incidents, or directly store third-party credentials (in standard SaaS mode).

---

### Outbox Sync Subsystem (Synchronization)
*   **Description:** Durable, asynchronous event forwarding.
*   **Owns:** Outbox table rows queueing, sync worker timers, retries, and REST calls to the Cloud Gateway.
*   **Who is allowed to call it:** Incident Manager, Alerting Service (for writes); Scheduler (for sync ticks).
*   **What it may read:** Queued outbox rows, Gateway API endpoints, Agent Identity.
*   **What it may write:** Local outbox rows status (success/failed), network requests to Gateway.
*   **FORBIDDEN to do:** Evaluate or change the health status of incidents, or bypass the outbox table to talk to the Gateway.

---

### Identity & Config Services (Edge Government)
*   **Description:** Credentials and settings management.
*   **Owns:** Registration tokens, local Agent secret keys, local active config parameters, and atomic config swap locks.
*   **Who is allowed to call it:** Orchestrator, Schedulers, Detectors, Outbox Worker.
*   **What it may read:** Identity file, Gateway registration API responses.
*   **What it may write:** Local config files, identity token files.
*   **FORBIDDEN to do:** Own incident states or dispatch system alerts.

---

## 2. Cloud Gateway & SaaS Subsystems

### Cloud Gateway API (Authentication & Ingestion)
*   **Description:** Front door of the SaaS system.
*   **Owns:** API routing, Agent authorization (secret verification), request validation, config delivery, and heartbeat collection.
*   **Who is allowed to call it:** Edge Agent Outbox Worker, Client dashboard.
*   **What it may read:** Central database (`Agent`, `License`, `Config` tables).
*   **What it may write:** Heartbeat timestamp logs, agent metadata tables.
*   **FORBIDDEN to do:** Execute real-time Edge observation, or direct-dispatch edge notifications without delegating to Notification Service.

---

### Central Notification Service (SaaS Alerts Dispatcher)
*   **Description:** User alert dispatcher.
*   **Owns:** Encrypted communication credentials (Telegram bot tokens, Slack webhooks), channel templates, and direct network connections to alert APIs.
*   **Who is allowed to call it:** Cloud Gateway Ingestion API (triggered by synced outbox alerts).
*   **What it may read:** User profile configuration, encrypted secrets.
*   **What it may write:** Delivery status logs.
*   **FORBIDDEN to do:** Evaluate edge health state or bypass the gateway's validation rules.

---

### Cloud Analysis (Diagnostics Engine)
*   **Description:** Centralized timeline diagnostics and scoring.
*   **Owns:** Timeline Reconstruction, Root Cause Scoring, Classifier reasoning, and scoring rules.
*   **Who is allowed to call it:** Cloud Gateway Ingestion API (triggered by synced incident evidence payloads).
*   **What it may read:** Central incident database, historical agent records.
*   **What it may write:** Timeline diagrams, scored root cause records, candidate recommendation cards.
*   **FORBIDDEN to do:** Initiate connection back to the Agent, or modify the Edge Agent's real-time state.
