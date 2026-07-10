# Architectural Guidelines & Dependency Rules

This document outlines the architectural contract governing the separation of concerns between the **Agent**, **Cloud**, and **Shared** domains. Developers must adhere to these rules when introducing new modules or refactoring existing ones.

---

## 1. Domain Directory Structure

The codebase is split into three primary namespaces:

1. **`shared/`**: Genuinely cross-cutting, stateless utilities, data models, persistence adapters, and contracts. It contains no domain-specific business logic or service runners.
2. **`agent/`**: The background monitoring daemon. It handles real-time telemetry observation, detection loops, alerting triggers, and incident management.
3. **`cloud/`**: The developer console dashboard and administration API. It exposes web servers, control panels, command runners, and simulation tools.

---

## 2. Dependency Rules (The Contract)

To maintain a Directed Acyclic Graph (DAG) and prevent circular dependencies, import boundaries are strictly enforced:

```
          shared
         /      \
        /        \
    agent      cloud
```

### Allowed Imports
* `agent/` &rarr; `shared/` &nbsp; ✔
* `cloud/` &rarr; `shared/` &nbsp; ✔
* `tests/` &rarr; any directory &nbsp; ✔
* `scratch/` &rarr; any directory &nbsp; ✔

### Prohibited Imports
* `shared/` &rarr; `agent/` &nbsp; ✘ (Shared must remain entirely independent)
* `shared/` &rarr; `cloud/` &nbsp; ✘ (Shared must remain entirely independent)
* `cloud/` &rarr; `agent/` &nbsp; ✘ (No compile-time coupling between console and daemon)
* `agent/` &rarr; `cloud/` &nbsp; ✘ (The agent must remain lightweight and deployable without web assets)

---

## 3. Temporary Adaptations & Cleanups

* **Legacy Compatibility Cleanup**: During Phase 4 / Step 9, all direct dependencies on old type files were successfully migrated to reference `shared/types/telemetry.ts` directly, and the legacy compatibility re-export file `agent/detectors/types.ts` was deleted. Import boundaries are now clean and direct.

---

## 4. Runtime Decoupling Model

* **Compile-Time Isolation**: No TypeScript imports cross the `agent` <&rarr;> `cloud` boundary.
* **Runtime Communication**: 
  * **Current Implementation**: Interactions are mediated asynchronously through the database (PostgreSQL via Prisma) and event states. There are currently no direct RPC, HTTP, or WebSocket connections between the Agent and the Cloud Console. The Agent logs telemetry events and status states to `DecisionAudit`, and inserts outgoing system incidents into `IncidentOutbox`. The Cloud Developer Console reads these records to construct dashboard views, and writes control configurations (Feature Flags, Failure Injections) back to the database.
  * **Future Scale**: In a production SaaS setup, future interfaces (such as licensing, authentication, updates, or remote heartbeats) may expose direct HTTPS connections to a Cloud API. This is permissible provided it does not tightly couple the codebase's domain logic.

---

## 5. How to Classify New Code

When introducing a new file, module, or helper, refer to this checklist to determine the appropriate namespace:

* **Does this execute watchdog monitoring, health-checking, real-time alerting, or trade protection logic?**
  &rarr; Place it in **`agent/`** (e.g., detectors, notification gateways, active trading adapters).
* **Does this expose a UI, dashboard, management server, simulation API, or administrative CLI?**
  &rarr; Place it in **`cloud/`** (e.g., developer console controllers, HTML templates, simulated incident triggers).
* **Is it a contract, database client instance, DTO type definition, system configuration file, event persistence service, or utility function used by both domains?**
  &rarr; Place it in **`shared/`** (e.g., types, prisma instance, configuration schemas, failure injection structures). *Remember: Shared must contain no domain-specific business logic.*
