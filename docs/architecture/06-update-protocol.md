# Execution Watchdog Architecture Manual
## Chapter VI — Update Protocol

This chapter defines the update advisory protocol for the Execution Watchdog platform. It outlines how the Agent queries the Cloud Gateway for version information, how version policy is evaluated and classified, and the non-blocking guarantees that prevent update notifications from impacting real-time monitoring operations.

---

### 1. Purpose & Scope

In production environments, Agent software must remain secure and compatible with the latest Gateway features. However, automating agent updates directly can introduce severe operational risks, such as process crashes or privilege-escalation vulnerabilities in the host environment.

This protocol answers a key architectural question:
> **How does the Agent learn about software releases?**

This chapter details the mechanisms of release checks, severity classification, and operational decoupling. The installation and packaging details of updates remain out of scope for the protocol, which acts strictly as a secure advisory mechanism.

---

### 2. Version Authority

The update protocol maintains a strict division of version and release policy ownership between components:
*   **The Agent owns its Current Runtime Version:** The Agent is the authoritative source of its active version information, which is declared in the immutable local Runtime Manifest and sent with every update query.
*   **The Gateway owns the Release Policy:** The Gateway is the authoritative source for defining the latest recommended version, deprecation thresholds, severity classifications, and minimum supported version policies across the entire system.

---

### 3. Update Classifications

When an update check is performed, the Gateway maps the comparison between the Agent's reported version and the active policies into one of three classifications:
1.  **Up-to-Date:** The Agent is running the latest recommended release or a version equal to or newer than the target release. No action is required.
2.  **Optional Update:** A newer recommended version is available, but the Agent's current version remains supported. The system notifies the operator but continues normal execution without warnings.
3.  **Mandatory Update:** The Agent's version has fallen below the minimum supported version threshold or has been flagged as deprecated due to critical security issues or API changes. The Agent enters an advisory warning state.

---

### 4. Advisory Protocol Flow

Update checks operate as a unidirectional pull-based advisory flow. The protocol cycle proceeds through four distinct stages:

```
      [ 1. Query Stage ]
   Agent packages active version
   and capability metadata.
              │
              ▼
   [ 2. Gateway Evaluation ]
   Gateway evaluates version
   against active release policies.
              │
              ▼
  [ 3. Severity Classification ]
   Gateway classifies update type
   (Up-to-Date / Optional / Mandatory).
              │
              ▼
    [ 4. Operator Advisory ]
   Agent dispatches alerts or warning
   flags to the environment.
```

1.  **Query:** The Agent extracts its version from the local Runtime Manifest and initiates a version check query, conveying the version alongside its active capability profile to the Gateway.
2.  **Gateway Evaluation:** The Gateway evaluates the incoming metadata against current release tracking databases.
3.  **Severity Classification:** The Gateway determines the update classification, constructs metadata including the target version, update description, package locations, and cryptographic integrity hashes, and responds.
4.  **Operator Advisory:** The Agent receives the update classification. If an optional or mandatory update is indicated, the Agent dispatches notifications via configured channels. For mandatory updates, the Agent raises local warning flags while keeping its monitoring runtime active.

---

### 5. Subsystem Roles

Three subsystems cooperate to execute the update protocol:
*   **Agent Update Scheduler:** Manages the update check loop (e.g., executing checks at startup and daily intervals) and handles retry backoffs on communication failures.
*   **Runtime Manifest:** Serves as the immutable local repository containing the current build version string, capability schema version, and compiler parameters.
*   **Alerting Service:** Consumes update notifications dispatched by the update loop and formats them as system alerts for delivery to external channels (e.g., system logs, notification streams).

---

### 6. Protocol Guarantees

The update protocol guarantees system reliability and security through three key invariants:
*   **Non-Blocking Advisory:** Version checks are executed asynchronously outside the critical path of the main monitoring loop. A delayed or failed update query must never block, lag, or interrupt live Trading Platform tracking or local metric collection.
*   **Integrity Verification:** Update information returned by the Gateway contains cryptographic integrity metadata. Before any operator installation or download utility executes, the downloaded package must be verified against this signature to protect the edge environment against unauthorized package modification during distribution.
*   **Operational Decoupling:** The Agent behaves as a passive reporter and advisory consumer. It never modifies its own binary or executes self-replacement routines. All update installations are decoupled and left to external operators or container orchestration managers.

---

### 7. Design Principles

Three principles guide the update advisory protocol:
*   **Update checks execute as non-blocking advisory routines:** Release detection is isolated from core system telemetry loops.
*   **Severity tiers are determined by minimum version constraints:** Update severity is classified on the server side to maintain dynamic policy management.
*   **Update packages are bound to verifiable integrity signatures:** Software distribution requires end-to-end cryptographic verification to secure edge endpoints.

---

### 8. Design Rationale

#### 8.A. Why Advise instead of Self-Updating?
Self-updating software agents require the runtime process to run with elevated filesystem write permissions, significantly increasing the attack surface. Furthermore, self-updating can result in unstable, half-written binaries during unexpected power outages. By operating strictly as an advisory system, the Agent maintains a read-only filesystem profile, ensuring predictable deployment managed via container restart policies or system operators.

#### 8.B. Why Decouple Update Checks from Configuration Checks?
Configuration state revisions synchronize frequently (typically every few minutes) to allow rapid adjustment of monitoring thresholds. In contrast, new software releases occur infrequently (weekly or monthly). Decoupling these processes prevents the high-frequency configuration checks from carrying heavier release check payloads, optimizing database and edge network processing overhead.

#### 8.C. Why Enforce Minimum Version Constraints at the Gateway?
By shifting version deprecation logic to the Gateway, operators can dynamically enforce system compatibility. If a critical vulnerability is discovered in an older protocol handler, the Gateway can instantly raise the minimum supported version, causing affected agents to trigger immediate deprecation warnings during their next periodic check without requiring code changes to the running agents.

---

### 9. Related Chapters

*   **Chapter III — Request Matrix:** Details the execution triggers and metadata parameters of the update query.
*   **Chapter IV — Metadata Contracts:** Explains how the Agent's identity, version, and capabilities are formatted for the Gateway.
*   **Chapter V — Configuration Protocol:** Compares the update loop architecture with high-frequency configuration sync loops.
