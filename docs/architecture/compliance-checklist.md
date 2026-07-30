# Phase 7: Architecture Compliance Checklist

This compliance checklist must be completed and validated for every pull request, major refactoring, or feature addition to the **Execution Watchdog** platform. It acts as the final gate to prevent regression, preserve architectural boundaries, and enforce the system laws defined in the **Architecture Constitution**.

---

## Pre-Merge Verification Checklist

### 1. Security & Edge Autonomy Boundary
*   [ ] **Outbound-Only Communication:** Does the change introduce any inbound listening ports, public REST/GraphQL APIs, or WebSocket listeners to the Edge Agent? (Agent must *never* open inbound ports; Rule VII.1).
*   [ ] **Zero-Cloud Boot Dependency:** Can the Edge Agent boot, monitor, persist events, and perform state transitions while the Cloud Gateway is completely offline? (Rule XII.2, Rule XIII.1).
*   [ ] **Credential Isolation:** Are Agent credentials (secrets, keys) stored purely in the local identity file without being leaked to central dashboards or hardcoded in source control? (Rule VII.3).

### 2. Dependency & Code Boundaries
*   [ ] **Strict Clean Boundary (Agent &rarr; Cloud):** Does any module in `agent/` import files or classes from `cloud/`? (Direct imports from `cloud/` are strictly forbidden; Rule XI.1).
*   [ ] **Contract Inversion (Prisma Bypass):** Do any telemetry detectors or alerting services directly import `prisma` or execute SQL queries? (Rule XI.2, Rule II.2).
*   [ ] **Interface Segregation:** Are data queries in detectors routed through purpose-specific, narrow domain ports (e.g., `DecisionAuditReader`, `TradeHistoryProvider`, `TelemetryLogger`) rather than fat database repositories or direct ORM models? (GAP-3).
*   [ ] **Analytical Containment:** Are root cause analysis (RCA), scoring heuristic models, or timeline reconstruction algorithms located entirely inside `cloud/`? (Rule VIII.1).

### 3. State & Event Flow
*   [ ] **Single Source of State Authority:** Is `IncidentManager` the *only* component declaring, mutating, or transitioning global or symbol-level system health states? (Rule I.1).
*   [ ] **Unidirectional Event Flow:** Does the change follow the strict unidirectional pipeline? 
    $$\text{Observation} \rightarrow \text{Proposal} \rightarrow \text{State Transition} \rightarrow \text{Persistence} \rightarrow \text{Communication}$$
    (No reverse loops are allowed; Rule X.1).
*   [ ] **Pure Schedulers:** Do the scheduling and orchestration components contain zero business logic or state threshold rules? (Rule III.2).

### 4. Alerting & Forensics
*   [ ] **Stateless Downstream Alerting:** Is the Alerting Service completely free of system health checking or active monitoring logic? (Rule V.2).
*   [ ] **Outbox Delivery Pattern:** Are alerts and incident transitions saved to the local outbox first before transport dispatch? (Rule VI.1).
*   [ ] **Non-Analytical Forensics:** Does `EvidenceCollector` limit its role to capturing system logs, container exit codes, and process dumps without executing diagnostic scoring or timeline reconstruction? (Rule VIII.2).

### 5. Documentation Integrity
*   [ ] **No Drift:** Does this change modify component ownership, compile-time dependencies, runtime sequencing, or data flow?
    *   *If yes:* Update the corresponding architecture document (`ownership-map.md`, `dependency-map.md`, `runtime-sequence-map.md`, `data-flow-map.md`) before merging.

### 6. Architecture Decisions
*   [ ] **Specification First:** Does this PR/change introduce a new subsystem, a new dependency vector, or a new runtime sequence?
    *   *If yes:* Update the architecture documents to specify and justify the addition *before* starting the implementation.

---

## Checklist Execution Guide

### Step 1: Automatic Import Audit
Run a static import audit to verify that no agent files reference cloud packages or Prisma:
```bash
# Verify no agent references to cloud modules
grep -rn "from '.*cloud/" agent/

# Verify no detector or alerting references to prisma
grep -rn "import { prisma }" agent/detectors/ agent/notification/
```

### Step 2: Edge Autonomy Verification Test
1. Boot the database and the Edge Agent.
2. Terminate the Cloud Gateway process/mock server.
3. Inject a failure (e.g., mock a broker disconnection).
4. Verify that:
   - The appropriate detector notices the failure.
   - A proposal is generated and sent to `IncidentManager`.
   - The state transition is committed to the local database.
   - An outbox item is queued.
   - The Edge Agent remains running and stable.

### Step 3: Compile & Test Suite Checks
Ensure all TypeScript definitions compile cleanly and unit tests pass:
```bash
npm run build
npm run test
```
