# System Architecture Overview

This document introduces the architectural principles, system topology, responsibility boundaries, and security invariants that govern the Execution Watchdog platform.

---

## 1. System Vision

The Execution Watchdog is an edge-native monitoring and protection platform for algorithmic trading. Instead of acting as a passive stream log aggregator, the system runs as a localized reasoning service co-located directly with the trading engine. It observes real-time system state, diagnoses issues on the fly, and can trigger local, fail-closed safety isolation steps without relying on remote network availability.

---

## 2. Core Philosophies & Invariants

The design of the Watchdog is governed by two fundamental system invariants:

> [!IMPORTANT]
> **Architectural Invariant 1: Edge-Native Reasoning**
> *"Process data where it is produced. Transmit only decisions, not raw telemetry."*
>
> The Client Agent acts as a local evaluator. Rather than continuously uploading thousands of raw CPU spikes, connection heartbeats, or log lines to the cloud, the Agent evaluates telemetry locally, resolves issues using rule engines, and transmits only high-level status alerts and consolidated Incident reports. This keeps bandwidth low, protects operational privacy, and ensures the system operates efficiently even with thousands of concurrent edge installations.

> [!WARNING]
> **Architectural Invariant 2: Zero-Inbound Network Footprint**
> *"The Cloud Gateway never initiates connections to Agent instances. Agents expose no public management API and accept no inbound control traffic from the Internet. All communication is client-initiated outbound over HTTPS/WSS."*
>
> To safeguard edge VPS trading hosts, the Agent opens no listening ports to the WAN and accepts no remote execution payloads. Consequently, the Cloud Gateway cannot execute arbitrary code or initiate management operations on client Agents. If the Cloud Gateway is compromised, the attacker has no network route to access or run code on client trading platforms. Command syncs and configuration updates are pulled asynchronously by the Agent using outbound requests.

---

## 3. High-Level Topology

The physical layout places the reasoning agent alongside the trading components, using outbound communication routes to upload diagnostic status updates to the Central Cloud:

```
                  Cloud Gateway
                        │
                        ▼ (Outbound HTTPS/WSS)
       ───────────────────────────────────────────────────
       Edge VM Host (Deployment & Execution Boundary)
       ───────────────────────────────────────────────────
       systemd (Service Supervision)
           │
           ▼ (Process Monitoring)
       Watchdog Client Agent (Edge Node.js Daemon)
           │
           ├────► Trading Platform (Loopback LAN Trust Zone)
           │
           └────► Local Persistence Service (PostgreSQL DB)
```

---

## 4. Distributed Split of Responsibilities

The system is split into two primary operational areas:

### The Client Agent (Intelligence Plane)
Owns all data ingestion, heuristic processing, state tracking, and local protective measures:
```
  Observe       ──►       Detect       ──►       Assess       ──►      Incident      ──►      Outbox      ──►     Sync
(Log / API)          (Rule Engines)         (Heuristics)          (Aggregation)         (DB Queue)        (Outbound)
```

### The Cloud Gateway (Operations Plane)
Provides fleet management, customer licensing, notification routing, and configuration services:
```
Receive Incident ──► Store & Audit ──► Sync Config ──► Dashboard ──► Notification Dispatch (Telegram/SMS)
```

---

## 5. Codebase Directory Structure & Dependency Rules

To maintain codebase health and prevent circular dependency loops, imports between namespaces are strictly constrained to a Directed Acyclic Graph (DAG):

```
          shared
         /      \
        /        \
    agent      cloud
```

### Namespace Directories
1.  **`shared/`**: Genuinely cross-cutting, stateless models, DB clients, and configuration contracts. Contains no runtime business logic.
2.  **`agent/`**: The local edge daemon code. Contains sensors, incident engines, outbox writers, and local loopback adapters.
3.  **`cloud/`**: The Central console api, dashboards, licensing services, and alert dispatchers.

### Import Rules
*   `agent/` &rarr; `shared/` &nbsp; ✔
*   `cloud/` &rarr; `shared/` &nbsp; ✔
*   `shared/` &rarr; `agent/` or `cloud/` &nbsp; ✘ (Shared must remain entirely independent)
*   `agent/` &rarr; `cloud/` or vice versa &nbsp; ✘ (No compile-time imports across agent and cloud)

---

## 6. Architecture Manual Reference Index

For deep-dives into specific subsystems, refer to the **Architecture Manual** chapters located in [`docs/architecture/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/):

### Foundation
*   **[Chapter I: Agent Lifecycle](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/01-agent-lifecycle.md)** — Core orchestrator, startup steps, operational loops, and shutdown sequences.
*   **[Chapter II: Communication Model](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/02-communication-model.md)** — Message formats, outbound REST/WS patterns, and WAN payloads.
*   **[Chapter III: Request Matrix](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/03-request-matrix.md)** — Network protocol routing matrix, request/response models, and error behaviors.
*   **[Chapter IV: Metadata Contracts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/04-metadata-contracts.md)** — Structure, serialization, and lifecycle mappings of state metadata.

### Protocols
*   **[Chapter V: Configuration Protocol](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/05-configuration-protocol.md)** — Fetching, validating, and activating runtime configs from the Cloud.
*   **[Chapter VI: Update Protocol](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/06-update-protocol.md)** — Version checks, deprecation rules, and integrity validation pipelines.

### Resilience
*   **[Chapter VII: Failure Recovery](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/07-failure-recovery.md)** — Incident queueing, exponential backoffs, and outbox buffering policies during outages.

### Runtime
*   **[Chapter VIII: Scheduler Architecture](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/08-scheduler-architecture.md)** — Loop timing coordinates, re-entrancy protection, and queue task managers.
*   **[Chapter IX: Runtime State Management](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/09-runtime-state-management.md)** — Health aggregation planes, status consolidation, and in-memory states.
*   **[Chapter X: Monitoring & Detection](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/10-monitoring-detection-architecture.md)** — Telemetry sensor ingestion, evaluation phases, and watchdog heuristics.
*   **[Chapter XI: Alerting Architecture](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/11-alerting-architecture.md)** — Routing alerts, suppression cooldown checks, and transport channels.

### Data
*   **[Chapter XII: Persistence Architecture](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/12-persistence-architecture.md)** — DB structures, database write limits, and Outbox database transaction rules.

### Security
*   **[Chapter XIII: Security Architecture](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/13-security-architecture.md)** — Trust boundaries, credential tiers, key rotations, and edge isolation.

### Deployment
*   **[Chapter XIV: Deployment Architecture](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/14-deployment-architecture.md)** — Physical VM layout, systemd background runners, build vs. deploy divisions, and user container limits.
