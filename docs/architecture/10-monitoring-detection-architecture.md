# Execution Watchdog Architecture Manual
## Chapter X — Monitoring & Detection Architecture

This chapter defines the monitoring and detection architecture of the Execution Watchdog Agent. It details how the Agent generates, evaluates, and classifies telemetry observations to identify operational and structural anomalies before proposing state transitions to the Incident Manager.

---

### 1. Purpose & Scope

To maintain system integrity, the Agent continuously observes host conditions, trading engine activities, and market executions. The monitoring and detection architecture acts as the observation plane of the Agent, producing raw measurements and proposing health transitions without owning or directly modifying the runtime health state.

This chapter answers a key architectural question:
> **How does the Agent generate, evaluate, and classify telemetry observations to identify operational and structural anomalies?**

---

### 2. Observation Planes (Domain Boundaries)

The Agent segregates its observation activities into three distinct **observation domains**. These domains define boundaries of what is being measured rather than severity levels or state ownership properties:

```
┌────────────────────────────────────────────────────────┐
│                  Observation Planes                    │
├───────────────────┬───────────────────┬────────────────┤
│  Infrastructure   │    Operations     │Market Execution│
│    Monitoring     │    Monitoring     │  Intelligence  │
└───────────────────┴───────────────────┴────────────────┘
```

*   **Infrastructure Monitoring:** Focuses on the physical and virtual boundaries enclosing the Agent and its local dependencies. It measures host resources (CPU, Memory, Disk space), Docker container health, local API reachability, and network/DNS resolution paths.
*   **Operations Monitoring:** Focuses on the behavioral progression of the trading execution pipeline. It tracks execution heartbeat latencies, order creation frequencies, pipeline lag, and message transmission.
*   **Market Execution Intelligence:** Focuses on transaction execution quality and anomaly detection on trading venues. It observes and analyzes trade slippage, order-book spread widening, and flash crash parameters.

---

### 3. Ingestion Paradigms (Behavioral Models)

Observations are processed using two behavioral ingestion models, matching the speed and nature of the measured events:

| Ingestion Model | Core Behavior | Implementation Examples |
| :--- | :--- | :--- |
| **Periodic Observation** | Scheduled polling sweeps. Best suited for resources that evolve steadily and do not require immediate reactive actions. | Querying host CPU/Memory averages every 60 seconds; verifying exchange API reachability at set intervals. |
| **Reactive Observation** | Event-driven streaming ingestion. Tailored for near-zero-latency metrics where immediate detection of critical anomalies is required. | Parsing webhook notifications or WebSocket streams from the Trading Platform to detect trade execution failures. |

---

### 4. Ingestion & Evaluation Lifecycle

Every telemetry observation progresses through a standardized ingestion lifecycle:

```
   [ Observe ]
        │
        ▼
  [ Evaluate ]
        │
        ▼
  [ Classify ]
        │
        ▼
   [ Propose ] ────────► (Transmitted to Incident Manager)
        │
        ▼
   [ Discard ] ────────► (Discarded if no state transition is required)
```

*   **Observe:** The detector gathers raw system parameters (either via a scheduled poll or a reactive stream push).
*   **Evaluate:** The detector compares the raw parameters against static limits or dynamic thresholds.
*   **Classify:** If an anomaly is identified, the engine classifies the occurrence to assign a standard severity level and identify its source.
*   **Propose:** The detector formulates an incident transition proposal containing the source, severity, and description, and dispatches it to the Incident Manager.
*   **Discard:** If the observation is within healthy parameters or matches the existing state (processed by the Incident Manager's deduplication logic), the proposal is discarded without triggering a state transition.

---

### 5. Telemetry Mapping & Contracts

To decouple detectors from the State Authority, observations are mapped into a standardized health evaluation result (represented in the codebase by the `HealthCheckResult` interface). 

This contract contains:
*   `healthy`: A boolean indicating whether the checked parameter is within healthy bounds.
*   `source`: A string representing the unique identifier of the telemetry source (e.g., `VM`, `DOCKER`, `ORDER_PIPELINE`).
*   `severity`: The designated severity level (e.g., `LOW`, `MEDIUM`, `WARNING`, `HIGH`, `CRITICAL`).
*   `message`: A descriptive explanation of the anomaly.

Detectors use this contract to propose `DETECTED` or `RESOLVED` transitions. A detector never updates the database or triggers alerts directly; it simply delivers these standard results to the Incident Manager.

---

### 6. Subsystem Roles

*   **Infrastructure Watchdog Service:** Orchestrates high-frequency and medium-frequency infrastructure sweeps, executing local host and Docker checking scripts.
*   **Operations Watchdog Service:** Monitoring coordinator for trade flow behaviors, evaluating broker connections, exchange confirmations, and latency loops.
*   **Runtime Monitor Service:** Audits business-level performance metrics, including trade frequencies, fill rates, and execution KPI trends.
*   **Execution Intelligence Service:** Manages market execution checks, orchestrating dedicated engines (such as slippage, spread, and flash crash detectors).

---

### 7. Operational Guarantees

*   **Sensor Isolation:** A delay, timeout, or crash in one detector (e.g., waiting for a slow exchange DNS lookup) will not block or stall the execution of adjacent detector loops.
*   **Startup Grace Tolerance:** Operational frequency detectors support a boot-up grace window. During this grace period, frequency checks are bypassed, preventing false alerts from triggering before the Trading Platform is fully synchronized.
*   **Observation Completeness:** The Agent guarantees that all observation proposals are fully populated with standardized metadata (source, severity, description) before propagation.

---

### 8. Design Principles

*   **Passive Observation:** Detectors are completely passive relative to alert outputs. They only formulate proposals; they never directly interact with notification services, recovery pipelines, or Gateway synchronizers.
*   **Domain Segregation:** Observation planes remain strictly isolated. Operational checkers are not aware of host disk metrics, and infrastructure checkers do not evaluate trading strategy performance.
*   **Configuration Compliance:** Check intervals and warning thresholds are hydrated dynamically from the configuration manager, adapting automatically to dynamic changes without requiring detector restarts.

---

### 9. Design Rationale

#### 9.A. Why Isolate Detectors into Domain Services instead of a Single Monitoring Engine?
Combining infrastructure, operations, and market intelligence into a single engine leads to tight coupling. A failure in a strategy latency checker could inadvertently crash the process and stop host CPU monitoring. Domain isolation ensures that each watchdog service operates as a separate logical component, improving testability and system resilience.

#### 9.B. Why Support Hybrid Polling and Event-Driven Ingestion?
Scheduled polling is efficient for metrics that change slowly (like disk capacity), avoiding system overhead. However, polling is inadequate for trade executions; waiting for a 30-second poll to detect a failed order could lead to major losses. A hybrid model combines the efficiency of periodic polling with the near-zero-latency safety of reactive event streams.

#### 9.C. Why Implement Startup Grace Windows?
When the Agent and the Trading Platform boot up, there is a natural delay as network sockets connect, configurations sync, and database connections initialize. Without a startup grace period, detectors would register these transient startup delays as operational execution failures, leading to false-positive alarms every time the system restarts.

---

### 10. Related Chapters

*   **Chapter III — Request Matrix:** Maps standard endpoints and frequencies for periodic observation requests.
*   **Chapter V — Configuration Protocol:** Details the dynamic configuration values consumed by detectors to update warning limits.
*   **Chapter VIII — Scheduler Architecture:** Explains the coordinate execution loops that trigger Periodic Observations.
*   **Chapter IX — Runtime State Management:** Explains how transition proposals generated by detectors are evaluated, consolidated, and written to state by the Incident Manager.
