# Execution Watchdog Architecture Manual
## Chapter XIII — Security Architecture

This chapter defines the security architecture of the Execution Watchdog Agent. It details how the Agent secures credentials, validates telemetry integrity, isolates local execution, and authorizes capabilities during communication with the Cloud Gateway.

---

### 1. Purpose & Scope

The Agent operates in local edge environments, connecting to local trading engines and the remote Cloud Gateway. To ensure system reliability and data confidentiality, the Agent must establish explicit boundaries of trust. 

Rather than focusing on specific encryption libraries, the security architecture defines the system's trust model, credential hierarchy, capability authorization processes, and fault isolation mechanisms.

This chapter answers a key architectural question:
> **How does the Agent secure credentials, validate message integrity, isolate local execution, and authorize capabilities during communication with the Cloud Gateway?**

---

### 2. Trust Boundaries

The Agent's security model is structured around four distinct zones of trust. Data traversing these boundaries must be validated and authenticated at the transition interfaces:

##### Trust Boundary Model
```
          Customer
             │
             ▼ (Licensing Token / WAN)
          Gateway
             │
             ▼ (TLS / Authenticated WAN)
           Agent
             │
             ▼ (Loopback Trust Boundary LAN / VM)
       Trading Platform
```

*   **Customer Boundary:** The customer owns the root license token. This token acts as a master key used exclusively to register individual Agent runtimes.
*   **Gateway Boundary:** The Central Cloud service that authorizes agent execution. It validates customer identity, authorizes execution, and issues scoped Agent credentials.
*   **Agent Boundary:** The local runtime process running on the host system. It caches its own credentials, manages active telemetry loops, and enforces capability constraints.
*   **Trading Platform Boundary:** The local trading engine API. The Agent communicates with this engine via localized network paths.

---

### 3. Credential Hierarchy

To minimize the exposure of root secrets, credentials in the Agent ecosystem are organized into a tiered hierarchy based on scope and longevity:

```
        ┌────────────────────────────────────────────────────────┐
        │                   Customer Identity                    │
        │                  (License Token / Keys)                │
        ├────────────────────────────────────────────────────────┤
        │                     Agent Identity                     │
        │               (Agent ID & Agent Secret)                │
        ├────────────────────────────────────────────────────────┤
        │                   Service Credentials                  │
        │             (Telegram Tokens, DB Connection URL)       │
        ├────────────────────────────────────────────────────────┤
        │             Transport Security Credentials             │
        │                   (TLS Certificates)                   │
        └────────────────────────────────────────────────────────┘
```

#### 3.A. Customer Identity
The master key (License Token) that associates the Agent with a specific customer account. It is highly sensitive, long-lived, and used only during the initial Bootstrap/Registration handshake.

#### 3.B. Agent Identity
Transient, machine-scoped keys (Agent ID and Agent Secret) generated dynamically during registration. All operational API calls (heartbeats, config syncs, and outbox uploads) are signed or authenticated using these keys.

#### 3.C. Service Credentials
Environment-level integration keys, such as database connection paths or third-party API keys (e.g., Telegram Bot tokens). These are stored locally and are never transmitted back to the Cloud Gateway.

#### 3.D. Transport Security Credentials
System-level security tokens, such as TLS client certificates, used to verify the integrity and origin of communication channels.

---

### 4. Authentication & Handshake Lifecycle

The Agent's identity progresses through a lifecycle of discovery, validation, and self-healing recovery:

1.  **Handshake Registration:** When the Agent starts without cached credentials, it sends its licensing token and a dynamically generated machine identifier (`inst-uuid`) to the Gateway. If valid, the Gateway returns a dedicated Agent ID and Agent Secret.
2.  **Durable Caching:** The Agent writes these credentials to its local identity store file. On subsequent boots, the Agent reads this file directly, avoiding redundant registrations.
3.  **Self-Healing Key Rotation:** If the Cloud Gateway rejects the Agent's credentials during operational runs (e.g., returning `401 Unauthorized` due to administrative revocation), the Agent intercepts the failure. It halts normal scheduling loops, purges the local identity cache, and automatically restarts the registration sequence to negotiate a fresh identity.

---

### 5. Dynamic Capability Negotiation

The Agent's authorization model enforces functional restrictions dynamically. Runtimes can only execute monitoring routines that have been explicitly authorized:

*   **Capability Declaration:** During registration and heartbeats, the Agent declares its supported local capability profile (e.g., `FREQTRADE_MONITOR`, `INFRASTRUCTURE_MONITOR`).
*   **Gateway Authorization:** The Gateway evaluates the Agent's license limits and returns the authorized capability list.
*   **Local Enforcement:** The Agent updates its active scheduler loops to match the authorized capabilities list. If a capability is removed, its associated scheduler or detector loop is paused locally, ensuring the Agent complies with active licensing policies.

---

### 6. Secure Edge Execution & Fault Isolation

*   **Credential Fault Isolation:** Subsystems fail-gracefully if service-level secrets are missing or invalid. For instance, if a Telegram token is unconfigured, the Alerting Service records a local warning and continues executing core monitoring loops. The absence of optional messaging credentials does not degrade the core state machine.
*   **Forensic Artifact Preservation:** If the Agent's local identity cache file is corrupted or contains schema errors, the system does not simply overwrite or delete the file. It preserves the corrupted file as a backup artifact for administrative analysis and forensic review, then generates a fresh identity state to restore monitoring services.

---

### 7. Transport Security (WAN vs LAN)

*   **WAN Transport Security:** All traffic traversing the public network to the Cloud Gateway is encrypted using TLS (HTTPS/WSS). Operational requests contain headers validating the Agent ID and Agent Secret.
*   **LAN Transport Security:** The connection between the Agent and the local Trading Platform is confined to a loopback trust boundary (such as `localhost` loopbacks or isolated host-only network interfaces). This isolation ensures that the trading engine's administrative API is never exposed to the public WAN, relying on network-level containment rather than complex transit encryption at the host level.

---

### 8. Design Principles

*   **Least Privilege:** The Agent executes under the minimum set of authorized capabilities required for its environment, reducing the impact of compromised client environments.
*   **Fail-Closed Identity:** When authentication fails or credentials are rejected, the Agent immediately halts operational reports and enters a re-negotiation state, preventing unauthenticated operations.
*   **Edge-Trust Autonomy:** The Agent remains self-sufficient when disconnected. Local diagnostic loops, database transactions, and safety halts continue running normally at the edge without requiring validation from the Cloud Gateway.

---

### 9. Design Rationale

#### 9.A. Why Separate the License Token from the Operational Agent Secret?
The customer's license token represents billing and account ownership. If the Agent used this token directly for every telemetry heartbeat, the key would be exposed to memory sniffing or storage extraction attacks on the edge server. Using the license token only once to negotiate a machine-scoped Agent Secret limits exposure. If an edge machine is compromised, only that specific Agent Secret is leaked, and it can be revoked on the Gateway without forcing the customer to change their root license token.

#### 9.B. Why Isolate Trading Platform APIs behind Loopback Network Interfaces?
Algorithmic trading engines provide powerful administrative ports that can execute trades, cancel orders, or modify strategy parameters. Exposing these interfaces to the WAN, even with password authentication, creates a high-risk security target. Confining these connections to a loopback trust boundary ensures they are physically unreachable from outside the host VM, relying on network isolation as the primary defense.

#### 9.C. Why Run Background Registration Loops on Exponential Backoff instead of Failing-Fast?
If the registration process failed-fast and exited the daemon during gateway maintenance or network outages, administrative intervention would be required to restart the supervisor. Running background loops with exponential backoff ensures the Agent recovers automatically as soon as the connection is restored, without flooding the Cloud Gateway with high-frequency retry attempts.

#### 9.D. Why Preserve Corrupted Identity Artifacts instead of Deleting Them?
Directly deleting a corrupted credentials file makes it impossible for system administrators to diagnose the cause of the failure (e.g., filesystem corruption, storage device failures, or unauthorized write attempts). Saving the corrupted payload as a backup artifact preserves forensic evidence while allowing the Agent to rebuild its identity state automatically.

---

### 10. Related Chapters

*   **Chapter I — Agent Lifecycle:** Outlines the boot sequence and identity loading transitions.
*   **Chapter II — Communication Model:** Describes the transport layers used for outbound requests.
*   **Chapter V — Configuration Protocol:** Details how synced settings are validated for consistency.
*   **Chapter XII — Persistence Architecture:** Explains how credentials and capabilities are stored in local persistent tables.
