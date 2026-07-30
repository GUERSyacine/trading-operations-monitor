# Execution Watchdog Architecture Manual
## Chapter V — Configuration Protocol

This chapter defines the configuration synchronization protocol for the Execution Watchdog platform. It outlines how the Agent queries the Cloud Gateway for updates, verifies configuration versioning, validates and applies parameters atomically, and maintains operations using fallback policies during cloud outages or configuration errors.

---

### 1. Purpose & Scope

To maintain reliable and dynamic operations, the Agent's monitoring thresholds, connection parameters, and risk policies must remain synchronized with the developer dashboard. However, in a distributed and stateless system, synchronization cannot rely on sticky connections or manual operator pushes.

This protocol answers a key architectural question:
> **How does the Agent sync and apply configuration updates from the Gateway?**

This chapter details the synchronization states, execution flows, and consistency rules that govern how configurations propagate from the Gateway to the Agent's memory loops without exposing database schemas, JSON schemas, or network transport details.

---

### 2. Configuration Domains

Configuration parameters are grouped into three distinct functional domains:
1.  **Diagnostic Rules:** Numeric bounds and evaluation thresholds used to assess the host environment's health (e.g., CPU, memory, and disk utilization warning/critical triggers).
2.  **Platform Parameters:** Connection parameters and query intervals used to monitor the Trading Platform (e.g., polling intervals and database connection checks).
3.  **Protection Directives:** Control rules that define active mitigation steps (e.g., `STOP_BUY` or `STOP` directives) when critical anomalies are detected on the Trading Platform.

---

### 3. Synchronization Protocol Flow

Configuration synchronization operates as a pull-based state alignment routine. The lifecycle of a single configuration sync request proceeds through the following phases:

```
    [ 1. Query Phase ]
  Agent packages active revision
  and capabilities metadata.
            │
            ▼
   [ 2. Decision Phase ]
  Gateway evaluates metadata.
  If revision is match  ──► [ 3. Skip Phase (304) ]
  If revision is newer ───► [ 4. Validation Phase ]
                                 │
                     ┌───────────┴───────────┐
                     ▼                       ▼
            [ Success Path ]         [ Failure Path ]
         * Validation Success *   * Validation Failed *
                     │                       │
                     ▼                       ▼
         [ 5. Activation Phase ]     [ 6. Discard Phase ]
         Applies settings memory.   Discards new payload.
         Updates revision index.    Retains LKG state.
```

1.  **Query:** The Agent reads its current Configuration State Revision and Capability set, packaging them into request metadata.
2.  **Decision:** The Gateway compares the Agent's active revision against the database target revision.
    *   *If matching:* The Gateway returns a `Not Modified` response. The Agent updates its sync status and completes the cycle without parsing a payload.
    *   *If newer:* The Gateway returns the complete configuration payload accompanied by the new target revision number.
3.  **Validation:** The Agent receives the newer configuration payload. The `AgentConfigurationManager` checks the structure and integrity of the payload.
    *   *Validation Success:* The Agent proceeds to the **Activation** phase.
    *   *Validation Failure:* The Agent proceeds to the **Discard** phase, logging a configuration warning.
4.  **Activation:** The Agent applies the validated parameters atomically in memory and updates its active Configuration State Revision index.
5.  **Discard:** The Agent rejects the invalid configuration payload, discards the transaction, and continues executing with its active Last Known Good (LKG) parameters.
6.  **Connection Fallback:** If the query request fails due to network transport, DNS, or server errors, the Agent preserves its active in-memory parameters (LKG state) and registers a synchronization failure warning.

---

### 4. Subsystem Roles

Three subsystems cooperate to execute the configuration protocol:
*   **Agent Configuration Scheduler:** Manages the periodic synchronization loop timer, initiating requests and managing error backoff cycles when the Gateway is unreachable.
*   **Agent Configuration Manager:** Acts as the authoritative global singleton memory store for active configuration parameters and the current revision index.
*   **Trading Platform Monitoring Adapter:** Dynamically consumes values from the `AgentConfigurationManager` to adjust its monitoring frequency, heartbeat thresholds, and webhook endpoints without restarting the process.

---

### 5. Consistency Guarantees

The configuration protocol is governed by three core consistency invariants:
*   **Atomic Commits:** Configuration updates are strictly all-or-nothing. The Agent validates the entire settings payload before modifying its memory store. If any validation rule fails, the entire transaction is discarded, preventing half-applied configurations.
*   **Revision Monotonicity:** Configuration State Revisions are strictly sequential integers. The Agent will only apply configurations with a revision index greater than its current index. Older or matching revision payloads are ignored.
*   **Capability-Bounded Settings Alignment:** The Gateway filters configuration properties based on the Agent's declared capability metadata. The Gateway will not serve monitoring rules for features (e.g., Docker container monitoring) that the Agent has not declared as an active capability.

---

### 6. Design Principles

Four principles guide configuration management:
*   **State synchronization uses monotonic revision metadata:** Network exchanges are minimized by evaluating revision numbers before transmitting payloads.
*   **Configuration updates apply atomically:** The Agent guarantees that monitoring loops never execute using a partial or corrupted settings state.
*   **System falls back to the Last Known Good state on sync failure:** The Agent maintains operations locally during Gateway outages or validation errors rather than shutting down or stalling.
*   **Configuration rules are bound to declared capabilities:** The Gateway and Agent align configuration scope to prevent execution of unconfigured or unsupported monitoring routines.

---

### 7. Design Rationale

#### 7.A. Why Polling instead of Push (WebSockets)?
Using a WebSocket push model to sync configurations requires maintaining thousands of persistent, idle TCP connections at the Gateway layer, introducing significant state management and socket overhead. Furthermore, configurations change infrequently—typically when an operator alters settings in the dashboard. Polling (default: 5 minutes) provides firewall and NAT transparency, lowers system overhead, and ensures configuration updates arrive in a timely, predictable manner.

#### 7.B. Why In-Memory Configuration Caching?
The Execution Watchdog chooses an in-memory runtime configuration model because the Gateway is the authoritative source of configuration state, while the Agent is the authoritative owner of its local runtime application. This division of responsibility simplifies state consistency across distributed instances and eliminates local file storage as an operational dependency, avoiding potential startup blocks caused by corrupted disk persistence.

#### 7.C. Why Revision-Based Optimization (304)?
Exchanging large JSON payloads every 5 minutes wastes network bandwidth and requires constant database query executions at the Gateway layer. By passing the `Configuration State Revision` in metadata, the Gateway can perform a quick numeric comparison. If they match, the Gateway immediately returns a lightweight response without loading or serializing the full configuration dataset, optimizing performance across both nodes.

---

### 8. Related Chapters

*   **Chapter II — Communication Model:** Defines the outbound REST transport channel used to request configurations.
*   **Chapter III — Request Matrix:** Details the trigger conditions, ownership, and state mutations of the Configuration sync request.
*   **Chapter IV — Metadata Contracts:** Explains how the `Configuration State Revision` is packaged and propagated.
*   **Chapter VII — Failure Recovery:** Documents the retry and backoff policies used when configuration queries encounter network errors.
