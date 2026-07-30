# Execution Watchdog Architecture Manual
## Appendix A — Protocol Sequence Diagrams

This appendix compiles the sequence diagrams and communication sequences for the Execution Watchdog Agent's interaction protocols.

### Mapping of Diagrams to Chapters

| Sequence Diagram | Primary Related Chapter | Target Gateway Endpoint |
| :--- | :--- | :--- |
| **A.1. Agent Registration** | Chapter II — Identity & Registration | `POST /api/v1/agent/register` |
| **A.2. Configuration Synchronization** | Chapter V — Configuration Protocol | `GET /api/v1/agent/config` |
| **A.3. Heartbeat & Capability Negotiation** | Chapter VIII — Scheduler Architecture | `POST /api/v1/agent/heartbeat` |
| **A.4. Recovery & Re-Registration** | Chapter VII — Failure Recovery | `POST /api/v1/agent/register` |

---

### Appendix A.1. Agent Registration Sequence

The registration sequence is executed when the Agent boots up and finds no credentials cached in its local identity store, or when its cached credentials have been corrupted.

```mermaid
sequenceDiagram
    autonumber
    participant Agent as AgentIdentityService
    participant Store as IdentityStore (.agent-identity.json)
    participant Gateway as Cloud Gateway (/api/v1/agent/register)

    Agent->>Store: Read local credentials file
    Store-->>Agent: File missing or schema invalid
    Note over Agent: Generate unique hardware identifier (inst-uuid)
    
    loop Exponential Backoff (Capped at 60s)
        Agent->>Gateway: POST /register (License Token, Machine ID, Version, Capabilities)
        alt Success (200 OK)
            Gateway-->>Agent: Success Response (Agent ID, Agent Secret, Authorized Capabilities)
            Agent->>Store: Save credentials and capabilities locally
            Agent->>Agent: Transition state to RESOLVED
        else Unauthorized / Invalid Token (403 Forbidden)
            Gateway-->>Agent: Error Response (INVALID_TOKEN)
            Note over Agent: Terminate loop immediately. Manual action required.
        else Network / Gateway Timeout
            Gateway-->>Agent: Connection timeout or server error
            Note over Agent: Double retry interval and retry again
        end
    end
```

#### Key Characteristics
*   **Non-Blocking:** Registration runs on a background scheduler. The main orchestrator continues starting local services (adapters, controllers) to prevent registration delays from freezing local tools.
*   **Fast-Failure on Invalid Credentials:** If the token is invalid, retries are halted immediately, avoiding pointless connection cycles and gateway resource waste.

---

### Appendix A.2. Configuration Synchronization Sequence

The configuration synchronization protocol is executed periodically (default: 5 minutes) to sync settings (thresholds, timings) with the Cloud developer dashboard.

```mermaid
sequenceDiagram
    autonumber
    participant Sched as AgentConfigurationScheduler
    participant Mgr as AgentConfigurationManager
    participant Gateway as Cloud Gateway (/api/v1/agent/config)

    Sched->>Mgr: Query current config revision
    Mgr-->>Sched: Return Revision Number (e.g. Rev 14)
    Sched->>Gateway: GET /config (Headers: X-Agent-Id, X-Agent-Secret, X-Configuration-Revision: 14)
    
    alt Configuration Not Modified (304 Not Modified / Success)
        Gateway-->>Sched: Status: SUCCESS (notModified: true)
        Sched->>Mgr: Mark Sync Success (No changes, keep configuration)
    else Configuration Updated (200 OK)
        Gateway-->>Sched: Status: SUCCESS (New configuration JSON, Revision 15)
        Sched->>Mgr: Update Configuration (Store config & Apply Revision 15)
    else Gateway Connection Failure / 5xx Server Error
        Gateway-->>Sched: Connection timeout / Server error response
        Sched->>Mgr: Mark Sync Failed (Retain Revision 14, continue monitoring)
    end
```

#### Key Characteristics
*   **Revision Header:** The header `X-Configuration-Revision` enables the gateway to return `304 Not Modified` when no updates have been made.
*   **LKG Retention:** If the sync fails due to gateway outages or timeouts, the configuration manager retains its current configuration and revision, keeping the agent monitoring continuously.

---

### Appendix A.3. Heartbeat & Capability Negotiation Sequence

The heartbeat sequence is executed periodically (default: 30 seconds) to notify the Cloud Gateway that the Agent is online, publish local telemetry metrics, and negotiate capabilities.

```mermaid
sequenceDiagram
    autonumber
    participant Sched as AgentHeartbeatScheduler
    participant Identity as AgentIdentityService
    participant Gateway as Cloud Gateway (/api/v1/agent/heartbeat)

    Note over Sched: Triggered every 30 seconds
    Sched->>Sched: Gather metrics (CPU, RAM, Disk, DB Health, Freqtrade Status, Outbox Backlog)
    Sched->>Gateway: POST /heartbeat (Agent ID, Secret, Telemetry metrics, capabilities)
    
    alt Heartbeat Acknowledged (200 OK)
        Gateway-->>Sched: Acknowledged (status: SUCCESS, authorizedCapabilities: [Caps])
        alt Capabilities Changed
            Sched->>Identity: Update authorizedCapabilities list
            Identity->>Identity: Persist updated capabilities to local store
        end
    else Gateway Credentials Rejected (401 Unauthorized / INVALID_TOKEN)
        Gateway-->>Sched: Rejection Response (status: UNAUTHORIZED)
        Note over Sched: Trigger Re-Registration Flow (See Appendix A.4)
    else Gateway Offline / Timeout
        Gateway-->>Sched: Connection timeout / Network offline
        Note over Sched: Log error, retry at next interval (30s)
    end
```

#### Key Characteristics
*   **Telemetry Gathering:** The heartbeat aggregates CPU load, RAM usage, root partition disk blocks, PostgreSQL connectivity, and Outbox backlog size.
*   **Dynamic Capabilities:** The gateway can update the Agent's allowed capabilities in the heartbeat response, enabling/disabling monitoring routines dynamically.

---

### Appendix A.4. Recovery & Re-Registration Sequence

When the Cloud Gateway rejects the Agent's credentials (returning `401 Unauthorized` or `INVALID_TOKEN` during a heartbeat or config cycle), the Agent self-heals by purging its cache and re-registering.

```mermaid
sequenceDiagram
    autonumber
    participant Sched as AgentHeartbeatScheduler
    participant Identity as AgentIdentityService
    participant Store as IdentityStore
    participant Gateway as Cloud Gateway (/api/v1/agent/register)

    Note over Sched: Heartbeat returns 401/403 (UNAUTHORIZED)
    Sched->>Sched: Stop Heartbeat Scheduler timer
    Sched->>Identity: Trigger Reset and Re-Registration
    Identity->>Store: Delete local `.agent-identity.json` file
    Identity->>Identity: Reset credentials memory cache
    Note over Identity: Generate fresh Persistent Machine ID
    
    loop Background Registration Loop
        Identity->>Gateway: POST /register (License Token, Machine ID, Version, Capabilities)
        alt Success (200 OK)
            Gateway-->>Identity: Success (New Agent ID, Secret, Capabilities)
            Identity->>Store: Save new credentials locally
            Identity->>Identity: Transition state to RESOLVED
            Identity->>Sched: Restart Heartbeat Scheduler
        else Unauthorized (403 Forbidden / INVALID_TOKEN)
            Gateway-->>Identity: Error (INVALID_TOKEN)
            Note over Identity: Stop retries. Wait for manual intervention.
        end
    end
```

#### Key Characteristics
*   **Automated Recovery:** The Agent handles invalid credentials automatically, purging the local database/cache configuration and re-negotiating identity without requiring manual restarts of the daemon process.
