# Phase 5: Implementation Audit

This document presents a formal, module-by-module architectural audit of the active TypeScript modules in the `agent/` and `cloud/` directories. Each module is evaluated against the four governing specifications: the **Architecture Constitution**, **Ownership Map**, **Dependency Map**, and **Data Flow Map**.

---

## 1. Composition Root & Orchestrator

### Module: [WatchdogOrchestrator](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/WatchdogOrchestrator.ts)
*   **Role in Ownership Map:** Watchdog Orchestrator (Composition Root)
*   **Permitted Actions:** Process initialization, composition of dependencies, graceful shutdown orchestration.
*   **Permitted Dependencies:** All Edge components (constructors only).
*   **Audit Observations:**
    *   **Inbound Server Boot:** Imports `DeveloperConsoleServer` from `../cloud/developer/DeveloperConsoleServer` and conditionally starts the server (`this.devConsoleServer.start()`) based on the environment variable `WATCHDOG_START_DEV_CONSOLE`.
    *   **Direct Cloud Imports:** Direct dependency imports from the `cloud/` package (`CommandRunner`, `InfrastructureController`, `DeveloperConsoleGateway`, `DeveloperConsoleController`, `DeveloperConsoleServer`, `OperationsSimulationService`).
*   **Violations:**
    *   🔴 **Rule VII.1 (No Inbound Connections):** Starts a local HTTP server on port 3001 within the Edge Agent daemon process, exposing inbound REST endpoints and Server-Sent Events (SSE).
    *   🔴 **Rule XI.1 (Dependency Invariants):** Imports and instantiates Cloud control-plane classes (`cloud/developer/*`) inside the Agent bundle, violating boundaries between edge and cloud code.

---

## 2. Telemetry Detectors

### Module: [OperationsWatchdogService](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/operations/OperationsWatchdogService.ts)
*   **Role in Ownership Map:** Telemetry Detector (Observation Layer)
*   **Permitted Actions:** Ingestion, threshold evaluation, proposing transitions.
*   **Permitted Dependencies:** `IdentityStore`, `AgentConfigurationManager`, `Incident Reporting Port` (represented by `IncidentManager` interface).
*   **Audit Observations:**
    *   **Direct Persistence Imports:** Directly imports `prisma` from `../../../shared/prisma`.
    *   **Raw DB Reads:** Directly queries `prisma.decisionAudit.findFirst` for heartbeat checks, `prisma.decisionAudit.findMany` for trade frequency checks, `prisma.decisionAudit.findFirst` for broker pings, and `prisma.decisionAudit.findFirst` for market data feeds.
    *   **Coupling to IncidentManager:** Tightly coupled to the concrete class `IncidentManager` (calls `this.incidentManager.reportIncident` and `this.incidentManager.resolveIncidentBySource`).
*   **Violations:**
    *   🔴 **Dependency Map (Detector &rarr; Persistence):** Performs raw SQL table reads via Prisma instead of utilizing decoupled telemetry repositories or state observers.
    *   🔴 **Rule XI.2 (Contract-Based Interfaces):** Depends directly on the implementation of `IncidentManager` rather than an inverted reporting port/interface.

### Module: [InfrastructureWatchdogService](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/infrastructure/InfrastructureWatchdogService.ts)
*   **Role in Ownership Map:** Telemetry Detector (Observation Layer)
*   **Permitted Actions:** Ingestion, threshold evaluation, proposing transitions.
*   **Audit Observations:**
    *   **Direct Persistence Writes:** Directly imports `prisma` and executes `prisma.decisionAudit.create` to insert `VM_HEALTH`, `DOCKER_HEALTH`, `FREQTRADE_API`, `NETWORK_HEALTH`, and `EXCHANGE_HEALTH` events into the `decisionAudit` table.
*   **Violations:**
    *   🔴 **Dependency Map (Detector &rarr; Persistence):** Directly inserts rows into local SQL tables.
    *   🔴 **Rule II.2 (No Side-Effects):** Performs direct-writes to SQL tables inside observation routines.

### Module: [RuntimeMonitorService](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/operations/RuntimeMonitorService.ts)
*   **Role in Ownership Map:** Telemetry Detector (Observation Layer)
*   **Permitted Actions:** Ingestion, threshold evaluation, proposing transitions.
*   **Audit Observations:**
    *   **Direct Persistence Reads:** Directly imports `prisma` and performs `prisma.decisionAudit.findMany` queries to aggregate PnL, fill rates, and execution latencies over rolling windows (up to 7 days).
*   **Violations:**
    *   🔴 **Dependency Map (Detector &rarr; Persistence):** Direct SQL reads.
    *   🔴 **Rule VIII (Centralized RCA) / Rule XII (Policy vs. Execution):** Calculates rolling strategy win rates, win rate collapses, and fills/slippage on the Edge. Since this logic aggregates historical data, it borders on analytical processing which is reserved for the Cloud.

---

## 3. Incident State Machine

### Module: [IncidentManager](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/manager/IncidentManager.ts)
*   **Role in Ownership Map:** Incident Manager (Edge State Authority)
*   **Permitted Actions:** Mutate global & symbol state, rehydrate state from DB, write to Incident tables, publish to Outbox.
*   **Permitted Dependencies:** `Alerting Service` (Alerting Port), `Outbox` (Outbox Port), `Local Persistence (Prisma)`.
*   **Audit Observations:**
    *   **Analytical Imports:** Directly imports `IncidentClassifier` from `../analysis/IncidentClassifier`.
    *   **Analytical Invocation:** Calls `IncidentClassifier.isInfrastructure(source)` inside `getGroupTypeAndCorrelationKey` to categorize incidents.
*   **Violations:**
    *   🔴 **Rule XI.2 (Dependency Invariants):** Violates "IncidentManager has no dependencies on analysis internals" by importing the `IncidentClassifier`.
    *   🔴 **Rule VIII.1 (Centralized RCA):** Direct coupling to analytical modules residing on the Edge.

---

## 4. Alerting & Notification

### Module: [AlertingService](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/notification/AlertingService.ts)
*   **Role in Ownership Map:** Alerting Service (Edge Communicator)
*   **Permitted Actions:** Template formatting, local suppression, publishing to Outbox.
*   **Permitted Dependencies:** `Outbox` (Outbox Port), local state memory.
*   **Audit Observations:**
    *   **Direct Persistence Writes:** Imports `prisma` and performs `prisma.alertLog.create` to insert alert history entries directly into the database.
    *   **Direct Persistence Reads:** Queries `prisma.circuitBreakerState.findUnique` inside `monitorSystemHealth()`.
    *   **Business Logic Leakage:** Implements a system health monitoring loop (`monitorSystemHealth`) to evaluate drawdown states and declare critical alerts.
*   **Violations:**
    *   🔴 **Dependency Map (Alerting &rarr; Persistence):** Writes to database tables directly instead of routing alert logs through the Outbox/Sync subsystem.
    *   🔴 **Rule V.2 (Zero Health Ownership):** Actively queries `circuitBreakerState` to evaluate health status and declare incidents, violating the rule that Alerting must never determine system health.
    *   🔴 **Rule IX (Ownership Invariants):** Co-owns system health observation with detectors by running its own query-based health check.

---

## 5. Edge Forensics

### Module: [EvidenceCollector](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/EvidenceCollector.ts)
*   **Role in Ownership Map:** Edge Forensics (Evidence Collector)
*   **Permitted Actions:** Snap process data, write payload to Outbox.
*   **Permitted Dependencies:** `Outbox` (Outbox Port).
*   **Audit Observations:**
    *   **Direct Persistence Reads:** Directly imports and queries `prisma.incidentGroup.findUnique`, `prisma.incident.findMany`, and `prisma.decisionAudit.findMany` to build the evidence timeline.
*   **Violations:**
    *   🔴 **Dependency Map (Forensics &rarr; Persistence):** Direct SQL reads via Prisma. Forensics is not listed under subsystems allowed to call Local Persistence.
    *   🔴 **Location Mismatch:** Placed under `agent/incident/analysis/` alongside Cloud analytical modules instead of a dedicated diagnostics or forensics directory.

---

## 6. Analytical Services

### Modules:
*   [TimelineReconstructor](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/TimelineReconstructor.ts)
*   [RootCauseScoringEngine](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/RootCauseScoringEngine.ts)
*   [HealthTreeService](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/HealthTreeService.ts)
*   [IncidentClassifier](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/IncidentClassifier.ts)
*   [CandidateGenerator](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/rules/CandidateGenerator.ts)
*   [CandidateRules](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/rules/CandidateRules.ts)
*   [ScoringRules](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/rules/ScoringRules.ts)
*   **Role in Ownership Map:** Cloud Analysis (Diagnostics Engine)
*   **Permitted Location:** strictly within `cloud/` package.
*   **Audit Observations:**
    *   All these modules reside under the Edge Agent package (`agent/incident/analysis/` and `agent/incident/rules/`).
*   **Violations:**
    *   🔴 **Rule VIII.1 (Centralized RCA):** Analytical processing blocks reside in the Edge Agent bundle, violating centralized policy mapping.
    *   🔴 **Rule XI.1 (Dependency Invariants):** Edge folders contain Cloud modules, resulting in compile-time pollution.
