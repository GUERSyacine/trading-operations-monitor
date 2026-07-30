# Execution Watchdog Architecture Manual
## Chapter XII — Persistence Architecture

This chapter defines the persistence architecture of the Execution Watchdog Agent. It details how the Agent models, persists, queues, and audits system states locally while ensuring operational isolation and data synchronization with the Cloud Gateway.

---

### 1. Purpose & Scope

The Agent operates as an autonomous edge supervisor. It requires a local database plane that is independent of centralized cloud persistence to guarantee durability and operational autonomy. 

The persistence architecture does not own system state; rather, it provides the storage engine and transactional structures that allow runtime state to survive crashes, network failures, and host reboots.

This chapter answers a key architectural question:
> **How does the Agent model, persist, queue, and audit system states locally while ensuring operational isolation and data synchronization with the Cloud Gateway?**

---

### 2. Persistence Boundaries & Ownership

Database schemas and operations are isolated by subsystem boundaries. Subsystems own specific domains of the local database schema, preventing overlapping database writes and locking conflicts:

```
Incident Manager
       │
       ├────────────► Incident
       ├────────────► IncidentTransition
       └────────────► IncidentGroup

Alerting Service
       │
       └────────────► AlertLog

Outbox Worker
       │
       └────────────► IncidentOutbox

Identity Service
       │
       └────────────► Agent
```

*   **Incident Manager:** Authoritative owner of health state records. It reads and writes the `Incident`, `IncidentGroup`, and `IncidentTransition` tables.
*   **Alerting Service:** Owner of historical communication logs. It writes to the `AlertLog` table to preserve notification audit histories independently of active incidents.
*   **Outbox Sync Worker:** Owner of outbound message buffering. It manages the queue in `IncidentOutbox` to ensure guaranteed, chronological delivery to the Cloud Gateway.
*   **Identity Service:** Owner of edge licensing and authorization data. It manages the `Agent` credential records and capability list.

#### ORM Abstraction Layer
The Agent accesses the local database engine via an Object-Relational Mapping (ORM) contract (implemented in the codebase by the Prisma client). This abstraction decouples the TypeScript application code from physical database dialects, allowing query definition without leaking database driver configurations into core business logic.

---

### 3. Data Schema Classification

To clarify operational purpose, the local database schema is organized into four conceptual persistence domains:

```
        ┌────────────────────────────────────────────────────────┐
        │                   Tenant & Identity                    │
        │       (Agent, RegistrationToken, MonitoredBot)         │
        ├────────────────────────────────────────────────────────┤
        │                     Runtime State                      │
        │  (Incident, IncidentGroup, IncidentTransition, etc.)   │
        ├────────────────────────────────────────────────────────┤
        │                     Communication                      │
        │                   (IncidentOutbox)                     │
        ├────────────────────────────────────────────────────────┤
        │                         Audit                          │
        │           (DecisionAudit, AlertLog, etc.)              │
        └────────────────────────────────────────────────────────┘
```

#### 3.A. Tenant & Identity Domain
Maintains the Agent's identity, licensing contracts, and system targets.
*   `Agent`: Stores agent instance identification (UUID, hardware ID, secret keys) and authorized capabilities.
*   `RegistrationToken`: Handles registration token parameters and active agent limits.
*   `MonitoredBot`: Identifies target trading platform client instances running on the host.

#### 3.B. Runtime State Domain
Stores the authoritative operational health metrics.
*   `Incident`: Durable records of system component failures, levels, and detection times.
*   `IncidentGroup`: Aggregated groups of correlated incidents.
*   `IncidentTransition`: Detailed audit transitions tracking levels, actors, and timelines.
*   `CircuitBreakerState`: Current state and numeric indicators for risk safety halts.

#### 3.C. Communication Domain
Handles asynchronous message queueing.
*   `IncidentOutbox`: A persistent buffer table storing incident JSON payloads queued for gateway synchronization.

#### 3.D. Audit Domain
Maintains long-term diagnostics for post-mortem verification and compliance.
*   `DecisionAudit`: Records trading rejections, system risk indicators, and higher-timeframe metrics, proving that inactivity always has a legitimate reason.
*   `AlertLog`: Captures historical notification deliveries, including those filtered by suppression cooldowns.
*   `AgentHeartbeat`: Historical logs of the Agent's hardware resource profiles.

---

### 4. Transactional Outbox Pattern

To bridge local state changes with external cloud communication without introducing distributed transactions or network blocking loops, the Agent utilizes a RDBMS-backed **Transactional Outbox** pattern:

```
    Incident Manager
           │
           ▼ (Start Transaction)
  ┌─────────────────────────────────┐
  │  Write IncidentTransition       │
  │  Write Incident / IncidentGroup  │
  │  Write IncidentOutbox           │
  └─────────────────────────────────┘
           │
           ▼ (Commit Transaction)
    Database Store (Local PostgreSQL)
           │
  =========│========= [Asynchronous Boundary]
           ▼ (Poll Outbox)
     Outbox Worker ──► Transmit REST ──► Cloud Gateway
```

1.  **Atomic Transaction:** When an incident changes state, the Incident Manager opens a local database transaction. It writes the state updates (to `Incident` or `IncidentGroup`), creates the lifecycle event record (`IncidentTransition`), and serializes the notification payload into `IncidentOutbox` within the **same database transaction**.
2.  **Asynchronous Drainage:** The Outbox Sync Worker periodically polls `IncidentOutbox` for entries matching `status = 'PENDING'`. It transmits them to the Gateway in batches.
3.  **Completion Verification:** Upon successful API acknowledgment, the worker marks the record as completed or otherwise removes it from the active delivery queue according to the configured retention strategy, ensuring delivery is guaranteed.

---

### 5. Operational Guarantees

*   **Atomic State-Outbox Invariant:** The Agent guarantees that an incident transition cannot be committed to local state without its corresponding outbox notification being queued. This eliminates "ghost incidents" where local states and cloud indicators diverge.
*   **Storage Space Control (Hygiene & Purging):** The database runtime enforces size hygiene. The Agent provides purge procedures (such as deleting synthetic simulator audit logs and cleaning heartbeats older than a retention threshold) to protect against local disk resource exhaustion on edge servers.
*   **Query Performance Isolation:** Database query layouts are structured to match dominant runtime access patterns. Index strategies prioritize:
    *   *Outbox Drainage:* Composite lookups on pending status and scheduling timestamps.
    *   *Audit Analysis:* Fast lookups on decision classifications and chronological ordering.
    *   *Incident Correlation:* Quick lookups on active incident groups and symbol identifiers.

---

### 6. Design Principles

*   **Local Autonomy:** The local database acts as the single source of truth for the edge node. The Agent does not perform synchronous external database queries during monitoring loops, guaranteeing continuous execution during cloud outages.
*   **Transactional Isolation:** All transaction boundaries are kept strictly local to the edge database instance. The system avoids distributed locking or two-phase commits.
*   **Atomic State Propagation:** State changes are propagated asynchronously using the database transaction log as a reliable message queue, separating core transaction speed from network conditions.

---

### 7. Design Rationale

#### 7.A. Why Use PostgreSQL instead of Lightweight Embedded Databases (e.g., SQLite)?
While SQLite requires no background service daemon, it locks the entire database file during write transactions. The Agent operates high-frequency parallel scheduling loops (e.g., polling resources, ingestion streams, configuration checks). SQLite's database-level locking would lead to transaction timeouts and thread starvation under peak monitoring load. PostgreSQL supports row-level locking, concurrent connections, and strong relational schema validation, fitting the requirements of a high-concurrency edge supervisor.

#### 7.B. Why Use an ORM Abstraction instead of Raw SQL?
Directly embedding raw SQL queries couples the TypeScript application code to a specific database dialect, complicating maintenance and migration. An ORM abstraction provides compile-time type safety for database structures, reducing execution bugs and decoupling the schema definition from vendor-specific drivers.

#### 7.C. Why Use RDBMS as a Queue instead of Dedicated Message Brokers (e.g., RabbitMQ, Redis)?
Deploying a secondary message broker like RabbitMQ or Redis would increase the memory and CPU footprint of the edge system, adding deployment complexity. Utilizing PostgreSQL tables (`IncidentOutbox`) for queueing leverages the existing transactional engine, guaranteeing message durability and atomicity without additional infrastructure overhead.

#### 7.D. Why Enforce a Strict Purging Policy for Synthetic Simulator Data?
During system integration testing, automated simulators generate large volumes of telemetry and audit decisions. If left unchecked, this synthetic testing data would clutter production tables and consume disk space on the edge server. A dedicated purge protocol ensures that test metrics can be wiped completely without impacting genuine production logs.

---

### 8. Related Chapters

*   **Chapter II — Communication Model:** Explains how the Outbox Worker transports synchronized records across firewalls.
*   **Chapter VII — Failure Recovery:** Details the backoff parameters applied to the outbox retry loops during network outages.
*   **Chapter IX — Runtime State Management:** Explains how the Incident Manager decides on state transitions before persisting them.
*   **Chapter XI — Alerting Architecture:** Describes how historical communications are saved in the `AlertLog`.
