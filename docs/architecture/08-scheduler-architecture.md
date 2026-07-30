# Execution Watchdog Architecture Manual
## Chapter VIII — Scheduler Architecture

This chapter defines the scheduling architecture of the Execution Watchdog Agent. It outlines how the Agent coordinates periodic runtime activities, manages scheduler execution states, and aggregates telemetry metrics without coupling individual tasks or introducing execution blockages.

---

### 1. Purpose & Scope

The Agent coordinates multiple parallel processes, including telemetry publication, configuration synchronization, incident outbox processing, software update checks, and real-time watchdog monitoring. To ensure execution reliability, the scheduler acts strictly as a **coordination layer**.

This chapter answers a key architectural question:
> **How are all of the Agent's independent runtime activities coordinated?**

The scheduler handles the timing, execution guards, and lifecycle of these activities, but it contains no monitoring, configuration validation, or recovery business logic. 

---

### 2. Scheduler Lifecycle

Every scheduler within the Agent follows a standardized runtime lifecycle:

```
      [ Initialized ]
             │
             │ Start Trigger
             ▼
       [ Scheduled ]
             │
             │ Timer Triggered
             ▼
         [ Running ] <───────┐
             │               │
             ├───────────────┤ (Interval Recovers)
             │               │
             │ Failure       │
             ▼               │
          [ Paused ] ────────┘
             │
             │ Stop Trigger
             ▼
         [ Stopped ]
```

*   **Initialized:** The scheduler instance is instantiated, its dependencies are injected, and configuration limits are set. No timers are active.
*   **Scheduled:** The scheduler is registered, and its primary timer loop is active. It is waiting for the next execution interval tick.
*   **Running:** An execution interval has triggered, and the task cycle is actively running. Re-entrancy guards prevent overlapping runs.
*   **Paused:** A scheduled loop experiences a blocking dependency failure (such as revoked credentials). The scheduler halts execution ticks and enters an inactive state until resolved.
*   **Stopped:** The scheduler is explicitly terminated, clearing all timers and awaiting the completion of any in-flight execution tasks.

---

### 3. Scheduler Topology

Periodic activities are categorized into four frequency classes to decouple execution cadences:

| Frequency Class | Responsibilities | Target Lifecycle Characteristics |
| :--- | :--- | :--- |
| **High-Frequency Loops** | Metric collection, heartbeat delivery, outbox transmission. | Requires fast execution and low latency. Drop-tolerant on failure (transient data). |
| **Medium-Frequency Loops**| Configuration synchronization. | Validates state transitions. Retains Last Known Good configuration on failure. |
| **Low-Frequency Loops** | Software version update checks. | Execute periodically (e.g., daily) to pull release advisory data. Non-blocking. |
| **Event-Driven Loops** | Immediate error reports, emergency protection halts. | Execute immediately upon local trigger, bypassing standard polling schedules. |

---

### 4. Asynchronous Execution Model

The scheduler is governed by three primary execution rules:

#### 4.A. Independent Asynchronous Execution
To keep the Agent resource-neutral and portable, activities execute asynchronously. In the current runtime environment, this is implemented using an asynchronous, event-driven loop. Tasks run non-blockingly, ensuring that latency in remote requests does not stall the execution of adjacent tasks.

#### 4.B. Re-Entrancy Guards (Overlap Prevention)
When network latency exceeds a scheduler's interval length, a naive scheduler might trigger a new execution cycle while the previous one is still in-flight. Schedulers enforce re-entrancy safety via state flags (e.g., `isExecuting`). If a tick triggers while a previous cycle is running, the tick is discarded to prevent memory leaks and process pileups.

#### 4.C. Scheduler Independence
Schedulers do not invoke or depend on one another. The Configuration Scheduler cannot trigger the Heartbeat Scheduler, and the Outbox Sync Scheduler does not coordinate with the Update Scheduler. All coordination and communication happen strictly through shared state, adapters, or databases:

```
               Orchestrator
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
 Heartbeat      Configuration      Update
 Scheduler       Scheduler        Scheduler
      │              │              │
      └──────────────┼──────────────┘
                     ▼
              Shared Runtime Services
              (Identity / Outbox / DB)
```

---

### 5. Telemetry Collection Domain

The Telemetry Scheduler collects system state data and groups it into four distinct functional categories:
*   **Host Resources:** Host metrics including CPU utilization, system memory consumption, and disk space limits.
*   **Runtime Health:** Process metrics such as Agent uptime, scheduler cycle latency, and local file access metrics.
*   **Local Services:** Status checks of local dependencies, including PostgreSQL connection availability and Freqtrade connection states.
*   **Queue Health:** Tracking variables showing backlog metrics (e.g., the number of pending incidents in the local outbox).

---

### 6. Runtime Capability Synchronization

While the communication protocol manages capability evaluation, the Heartbeat scheduler is responsible for triggering **Runtime Capability Synchronization**. When a heartbeat response arrives containing new `authorizedCapabilities`, the scheduler dispatches the updated capabilities to the Identity Service, which updates the local cache and triggers dynamic configuration and detector adjustments.

---

### 7. Subsystem Roles

*   **Orchestrator:** The bootstrapper responsible for instantiating and starting schedulers during Agent startup, and shutting them down during process termination. It does not participate in loop execution.
*   **Agent Heartbeat Scheduler:** Oversees high-frequency telemetry collection, capability synchronization triggers, and heartbeat delivery.
*   **Agent Configuration Scheduler:** Coordinates medium-frequency configuration retrieval and verification loops.
*   **Agent Update Scheduler:** Directs low-frequency software release checking.
*   **Outbox Sync Worker:** Manages the retry loop and batch sending of incidents buffered in the local database.

---

### 8. Operational Guarantees

*   **Re-Entrancy Safety:** Active scheduler ticks are guarded. A lagging remote connection will not cause multiple active tasks of the same scheduler to run concurrently.
*   **Scheduler Independence:** A failure or blocking delay in one scheduler (e.g., configuration synchronization timeout) will not delay or block other schedulers.
*   **Graceful Shutdown:** Upon shutdown signals, all scheduler timers are cleared, and active loops are given a termination window to finalize in-flight tasks before the process exits.
*   **Bounded Resource Usage:** Metric aggregation and queue drainage limits are capped to prevent execution spikes from exhausting system memory or CPU.

---

### 9. Design Rationale

#### 9.A. Why Independent Scheduler Loops instead of a Single Central Tick-Loop?
Running all checks and updates inside a single execution loop would mean that a delay in one task (e.g., waiting 10 seconds for a configuration download) would block all other tasks (such as sending critical heartbeats or checking metrics). Using independent loops ensures that time-sensitive telemetry remains uninterrupted by low-frequency synchronization delays.

#### 9.B. Why Schedule by Responsibility instead of One Centralized Polling Loop?
Separating schedulers by responsibility (e.g., separating heartbeats from configuration updates) keeps the code modular. It isolates logic changes—such as tweaking how heartbeat metrics are retrieved—from impacting update checks, making testing and maintenance safer.

#### 9.C. Why Enforce Strict Re-Entrancy Checks?
In degraded network environments, requests can hang. Without re-entrancy checks, the system would continually spawn new connection tasks, piling up memory and connection sockets. This could eventually lead to process exhaustion or inadvertently perform a denial-of-service attack on the Gateway when connection recovers.

---

### 10. Related Chapters

*   **Chapter I — Agent Lifecycle:** Explains how process-level states relate to scheduler lifecycles.
*   **Chapter III — Request Matrix:** Specifies the default intervals and endpoint mappings for periodic checks.
*   **Chapter V — Configuration Protocol:** Details the configuration sync flow triggered by the Configuration Scheduler.
*   **Chapter VI — Update Protocol:** Explains the update checks triggered by the Update Scheduler.
*   **Chapter VII — Failure Recovery:** Outlines the retry and backoff actions executed when scheduler tasks fail.
