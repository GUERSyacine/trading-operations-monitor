# Phase 6: Architecture Gap Report & Migration Plan

This report synthesizes the architectural violations identified during the **Phase 5: Implementation Audit** into a severity-ranked list. It outlines the operational impact of each gap and provides a structured, Jira-like migration backlog with implementation instructions and validation steps to transition the system from its current coupled implementation to the target architecture.

---

## Migration Principles

All migration tasks must preserve externally observable behavior. 

Each migration task shall:
1. Introduce the new abstraction.
2. Redirect existing callers.
3. Remove the legacy implementation.
4. Verify identical runtime behavior.
5. Compile.
6. Pass tests.
7. Commit before continuing.

Large-scale rewrites are prohibited.

---

## 1. Severity-Ranked Architectural Gaps

| Severity | ID | Subsystem | Target File(s) | Violation Summary | Operational Impact |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 🔴 **CRITICAL** | **GAP-1** | Composition Root (Edge) | [WatchdogOrchestrator.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/WatchdogOrchestrator.ts) | Opens HTTP server port 3001 on the Edge Agent; imports cloud-gateway control modules directly. | Violates the **No Inbound Connections** invariant (Rule VII.1). Exposes edge processes to WAN network attacks and limits edge autonomy. |
| 🔴 **CRITICAL** | **GAP-2** | Analysis & Rules (Edge) | `agent/incident/analysis/*`, `agent/incident/rules/*` | Heavy analytical engines (RCA, Timeline Reconstructor) located on the Edge Agent. | Violates the **Centralized RCA** invariant (Rule VIII.1). Bloats edge runtime resources and couples policy logic to edge execution. |
| 🟡 **MAJOR** | **GAP-3** | Detectors (Edge) | [OperationsWatchdog.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/operations/OperationsWatchdogService.ts), [InfrastructureWatchdog.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/infrastructure/InfrastructureWatchdogService.ts), [RuntimeMonitor.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/detectors/operations/RuntimeMonitorService.ts) | Directly import `prisma` to query and write to the PostgreSQL database. | Violates the **Detector &rarr; Persistence** dependency constraint. Database latency or connection dropouts can block or crash real-time observation routines. |
| 🟡 **MAJOR** | **GAP-4** | Alerting (Edge) | [AlertingService.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/notification/AlertingService.ts) | Performs direct writes to `prisma.alertLog` and implements a health check loop querying `circuitBreakerState`. | Violates the **Zero Health Ownership** (Rule V.2) and **Alerting &rarr; Persistence** dependency constraint. Alerting service is evaluating policy and querying raw DB tables. |
| 🟢 **MINOR** | **GAP-5** | Edge Forensics | [EvidenceCollector.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/EvidenceCollector.ts) | Queries Prisma database to fetch historical incident logs to build evidence payloads. | Violates permitted forensics read actions (which are limited to OS logs, docker metrics, and process states). |
| 🟢 **MINOR** | **GAP-6** | Incident Manager | [IncidentManager.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/manager/IncidentManager.ts) | Direct import of `IncidentClassifier` to check classification categories. | Violates contract-based dependency bounds (Rule XI.2) by coupling the core state machine to analytical classifier logic. |

---

## 2. Migration Backlog (Roadmap)

### TASK-1: Move Analytical Modules to Cloud Gateway
*   **Target Files:**
    *   `agent/incident/analysis/TimelineReconstructor.ts` &rarr; `cloud/analysis/TimelineReconstructor.ts`
    *   `agent/incident/analysis/RootCauseScoringEngine.ts` &rarr; `cloud/analysis/RootCauseScoringEngine.ts`
    *   `agent/incident/analysis/HealthTreeService.ts` &rarr; `cloud/analysis/HealthTreeService.ts`
    *   `agent/incident/analysis/IncidentClassifier.ts` &rarr; `cloud/analysis/IncidentClassifier.ts`
    *   `agent/incident/rules/*` &rarr; `cloud/rules/*`
*   **Execution Instructions:**
    1.  Physically move the files using filesystem operations.
    2.  Update all imports in `tests/` and scratch scripts to point to the new `cloud/` paths.
    3.  Keep the classification rule as **domain metadata** rather than executable logic in the analysis layer. Specifically:
        *   Define an incident source enum (or use existing type constants) and a static lookup map (`INCIDENT_SOURCE_GROUP`) directly within `shared/types/telemetry.ts`.
        *   Refactor `IncidentManager.ts` to read this static metadata mapping directly.
        *   Remove all imports and references to the `IncidentClassifier` class/rules from `IncidentManager.ts`, resolving the dependency loop without introducing a helper utility.
*   **Verification:**
    *   Execute compilation checks to verify `agent/` has zero references to these analytical services.
    *   Run analytical unit tests (`tests/debugPipeline.ts` or similar) pointing to the new cloud paths.

### TASK-2: De-couple and Remove Inbound Server from Edge Agent
*   **Target Files:**
    *   [WatchdogOrchestrator.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/WatchdogOrchestrator.ts)
*   **Execution Instructions:**
    1.  Remove all imports referencing `cloud/developer/*` in `WatchdogOrchestrator.ts`.
    2.  Remove `this.devConsoleServer` property, initialization, and lifecycle methods (`start`/`stop`) from the orchestrator class.
    3.  To preserve local simulation capability during QA/tests, ensure the dev console runs in a separate process spawned via a separate NPM task (e.g. `npm run dev:cloud`), which runs `cloud/main.ts`.
*   **Verification:**
    *   Confirm the Edge Agent process starts up and runs without opening port 3001 (verify using `netstat` or `ss`).
    *   Confirm the agent communicates with the separately running Cloud Gateway via standard outbound HTTP requests.

### TASK-3: Introduce Domain Ports
*   **Target Files:**
    *   `agent/detectors/*` (Infrastructure, Operations, and Runtime Monitor)
*   **Execution Instructions:**
    1.  Design purpose-specific domain interfaces (Domain Ports) rather than a single monolithic telemetry repository. The interfaces must specify the minimum required data boundaries for detectors to enforce dependency inversion:
        *   `DecisionAuditReader`: For detectors to check past heartbeat signals, broker pings, and recent telemetry events.
        *   `TradeHistoryProvider`: Specifically for `RuntimeMonitorService` to query rolling win rates, latencies, and metrics.
        *   `TelemetryLogger`: For writing metrics, pings, or heartbeats out of detectors without direct Prisma coupling.
    2.  Place these port definitions in `shared/contracts/` or `agent/detectors/ports/`.
    3.  Implement these interfaces as Prisma-backed adapters in `shared/services/` (e.g. `PrismaDecisionAuditReader`, `PrismaTradeHistoryProvider`, `PrismaTelemetryLogger`).
    4.  Inject the relevant domain port interfaces into the constructor of `OperationsWatchdogService`, `InfrastructureWatchdogService`, and `RuntimeMonitorService`.
    5.  Refactor detectors to depend exclusively on these interfaces, stripping all direct `prisma` imports.
*   **Verification:**
    *   Verify the detectors compile with zero references to Prisma.
    *   Construct mocks for `DecisionAuditReader`, `TradeHistoryProvider`, and `TelemetryLogger` to test all detection loops offline.

### TASK-4: Refactor Alerting Service & Relocate Health Checks
*   **Target Files:**
    *   [AlertingService.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/notification/AlertingService.ts)
*   **Execution Instructions:**
    1.  Remove direct `prisma` imports and database writes (`prisma.alertLog.create`) from `AlertingService.ts`. Logs should instead be written to standard out / process file logger or forwarded as a lightweight local memory event, or published via `OutboxPublisher` to let the sync-worker handle persistence.
    2.  Remove the `monitorSystemHealth` method from `AlertingService`.
    3.  Migrate the drawdown breaker state verification logic to a new detector (e.g. `DrawdownDetector.ts` in `agent/detectors/operations/`) which proposes a transition to the `IncidentManager` if the drawdown limit is breached.
*   **Verification:**
    *   Verify that `AlertingService` is 100% database-free.
    *   Assert that alerting continues to route notifications correctly via the outbound Outbox sync pipeline.

### TASK-5: Refactor Forensics Collector
*   **Target Files:**
    *   [EvidenceCollector.ts](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/incident/analysis/EvidenceCollector.ts)
*   **Execution Instructions:**
    1.  Relocate the file from `agent/incident/analysis/` to `agent/forensics/EvidenceCollector.ts`.
    2.  Refactor `EvidenceCollector` to fetch its context via local memory snapshots, OS log outputs, or process states instead of querying the Prisma relational DB. 
    3.  If historical incidents are required for packaging, the `IncidentManager` must pass the in-memory array of active/recent incidents directly as arguments.
*   **Verification:**
    *   Run forensics gathering simulations to verify that the outbox payload includes correctly structured evidence without hitting the local PostgreSQL database.
