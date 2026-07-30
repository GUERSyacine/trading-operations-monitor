# Execution Watchdog Architecture Manual
## Chapter VII — Failure Recovery

This chapter defines the failure recovery and resilience models for the Execution Watchdog platform. It outlines the taxonomy of expected system failures, details the lifecycle of recovery states, and describes the retry mechanisms, autonomy guarantees, and queue drainage protocols that protect operations during outages.

---

### 1. Purpose & Scope

The Agent operates as an autonomous edge sentinel in environments where internet connectivity, identity validation, or software configurations may fail. To maintain absolute protection over trading operations, the Agent cannot depend on uninterrupted Gateway availability to execute its core monitoring loops.

This chapter answers a key architectural question:
> **How does the Agent continue operating when parts of the system fail?**

This chapter details retry scheduling, local persistence buffering, independent failure loops, and resynchronization sequencing. Hardware recovery, operating system crashes, or host-level orchestration (e.g., Docker restarts) remain outside the scope of this protocol manual.

---

### 2. Failure Classifications

System anomalies and interruptions are classified into five distinct operational failure modes:
1.  **Transient Network Failures:** Short-lived communication issues (e.g., DNS resolution delays, packet loss, or request timeouts) that resolve quickly and are mitigated by minor retries.
2.  **Persistent Outages:** Extended periods of Gateway unreachability (lasting minutes, hours, or days) due to severe routing issues or server-side down-times, requiring local degraded operations.
3.  **Authentication Failures:** The Gateway explicitly rejects the Agent's credentials with authentication error responses. This indicates credential invalidity, requiring the Agent to halt registration retries to avoid security lockouts.
4.  **Configuration Validation Failures:** The Gateway responds successfully with a configuration payload, but the payload is corrupted or invalid. The Agent rejects the settings update and continues running with its Last Known Good (LKG) configuration.
5.  **Buffer Congestion:** Persistent network outages prevent the transmission of critical incident logs, causing outbox records to accumulate in the local database.

---

### 3. Recovery State Model

The Agent transitions through a standardized resilience lifecycle during failure events:

```
    ┌──────────────────────────────────┐
    │             Healthy              │
    └─────────────────┬────────────────┘
                      │
                      │ Failure Detected
                      ▼
    ┌──────────────────────────────────┐
    │        Retrying / Degraded       │
    │  (Local Autonomous Monitoring &  │
    │   Durable Incident Persistence)  │
    └─────────────────┬────────────────┘
                      │
                      │ Gateway Connectivity Restored
                      ▼
    ┌──────────────────────────────────┐
    │             Recovery             │
    │      (Identity Re-Verified)      │
    └─────────────────┬────────────────┘
                      │
                      │
                      ▼
    ┌──────────────────────────────────┐
    │        Resynchronization         │
    │  (Monotonic Outbox Queue Drain)  │
    └─────────────────┬────────────────┘
                      │
                      │ Re-Sync Complete
                      ▼
    ┌──────────────────────────────────┐
    │             Healthy              │
    └──────────────────────────────────┘
```

*   **Healthy:** All periodic loops execute successfully. Telemetry is collected, configurations are synchronized, and the incident outbox is empty or draining immediately.
*   **Retrying / Degraded:** A loop encounters a failure. The scheduler enters a retry cycle. The Agent continues local monitoring autonomously, persisting incidents locally.
*   **Recovery:** Connectivity to the Gateway is re-established. The Agent re-verifies its credentials, updates its sync statuses, and resumes heartbeats.
*   **Resynchronization:** The Agent drains accumulated incidents from local persistence to the Gateway before returning to the Healthy state.

---

### 4. Recovery Policies & Backoff Dynamics

#### 4.A. Exponential Backoff with Jitter
To protect both the Agent's resources and the Gateway's capacity, reconnection loops employ exponential backoff with randomized jitter. When consecutive failures occur, the retry interval increases exponentially. A random noise offset is added to each calculated interval, ensuring that multiple recovery loops do not execute on synchronized intervals.

#### 4.B. Recovery Independence
Each scheduler (Registration, Heartbeat, Configuration Sync, Update Check, and Outbox Sync) maintains its own independent retry state machine. A persistent failure in the Outbox Sync loop must never block or delay the Configuration Sync scheduler from pulling settings or the Update Scheduler from checking release version information.

#### 4.C. Degraded Execution Mode (Local Autonomy)
When the Gateway is completely offline, the Agent's core detectors and the Trading Platform monitoring adapters remain fully functional. The Agent continues evaluating metrics, checking order pipeline stages, and executing risk protection halts (such as stop-buy triggers) entirely at the edge without requiring remote coordination.

#### 4.D. Re-Sync Sequencing
Upon recovering connectivity, the Agent resumes incident publishing using a batch-draining sequence. The outbox processor uploads buffered events starting with the oldest pending records to ensure the Gateway receives incident details in chronological order, protecting timeline reconstructability.

---

### 5. Subsystem Roles

Three subsystems manage failure detection and recovery:
*   **Agent Identity Service:** Evaluates registration and credential errors, halting registration schedules on authentication failures while keeping existing credentials cached.
*   **Outbox Sync Worker:** Manages database persistence, tracking attempt counts, applying retry timing to pending incidents, and executing batch uploads upon recovery.
*   **Agent Heartbeat and Configuration Schedulers:** Independent loop runners that track their individual connectivity status and apply backoff rules during transport failures.

---

### 6. Resilience Guarantees

The architecture enforces three core resilience guarantees:
*   **Autonomy Invariant:** Local monitoring loops, anomaly detection routines, and safety triggers run independently of Gateway availability. Loss of network connectivity does not degrade protection capabilities.
*   **Durable Incident Persistence:** Generated incidents are written immediately to local persistent storage before network transmission is attempted. This ensures that critical system incidents are not lost even if the Agent process crashes or the host reboots during an outage.
*   **Monotonic Queue Drainage:** Buffered outbox records are transmitted in strict chronological order based on their creation sequence, maintaining event integrity at the Gateway.

---

### 7. Design Principles

Three principles guide system resilience:
*   **Local detection and protection execute autonomously from network connectivity:** Edge safety loops must run with zero remote dependencies.
*   **Edge persistence guarantees zero telemetry loss for generated incidents:** Critical audit data is saved to durable local storage before network publishing.
*   **Reconnection schedules employ jittered exponential backoffs:** Edge systems must cooperate to prevent thundering herd scenarios on central infrastructure.

---

### 8. Design Rationale

#### 8.A. Why Local Database Persistence for Offline Incidents?
Relying on in-memory buffers to queue incidents during a network outage introduces data loss risk. If the host machine suffers a power loss or the Agent daemon crashes before connection recovery, all queued incident details are lost. By writing incidents immediately to local database storage, the Agent guarantees incident durability and ensure compliant audit trails.

#### 8.B. Why Add Randomized Jitter to Backoff Timers?
When central Gateway infrastructure recovers from a major outage, thousands of edge agents attempt to reconnect simultaneously. If agents retry at fixed or deterministic exponential intervals, their requests will arrive in synchronized spikes, resulting in a thundering herd that can crash the recovered Gateway. Introducing randomized jitter scatters request timings, smoothing traffic demand.

#### 8.C. Why Drop Missed Heartbeats while Retrying Incidents Indefinitely?
Heartbeats represent transient telemetry; a missed heartbeat becomes obsolete the moment a newer heartbeat succeeds, as only the latest state is operationally useful. In contrast, incidents represent compliance records and diagnostic audit logs. If an incident is dropped, the system loses the history of a critical event (such as a trade execution halt). Therefore, heartbeats are dropped on failure, while incidents are retried until they are successfully acknowledged or reach maximum attempt limits.

---

### 9. Related Chapters

*   **Chapter I — Agent Lifecycle:** Defines how the Agent transitions to offline and warning states.
*   **Chapter II — Communication Model:** Explains the outbound REST channels that experience failures.
*   **Chapter III — Request Matrix:** Details the retry triggers for each query request.
*   **Chapter V — Configuration Protocol:** Explains the fallback to Last Known Good (LKG) configurations during sync outages.
*   **Chapter VI — Update Protocol:** Describes the non-blocking execution of version checks.
