# Execution Watchdog Architecture Manual
## Chapter XIV — Deployment Architecture

This chapter defines the physical deployment architecture of the Execution Watchdog Agent. It details how the Agent is packaged, supervised, provisioned, and lifecycle-managed on target host environments.

---

### 1. Purpose & Scope

The Agent operates as a daemon process inside localized execution environments. To ensure operational stability, the deployment architecture must establish clear physical boundaries, compilation sequences, process lifecycles, and host resource sandboxing.

Rather than providing a step-by-step installation guide, the deployment architecture defines the structural layout and supervisor relationships that allow the Agent to exist as a reliable, self-healing system service on the host VM.

This chapter answers a key architectural question:
> **How is the Agent packaged, supervised, provisioned, and lifecycle-managed on target host environments?**

---

### 2. Deployment Topology

The physical layout of the Watchdog system places the supervising daemon in close proximity to the trading platform and database store to ensure low latency and high diagnostic availability:

##### Physical Deployment Topology
```
           Cloud Gateway
                 │
                 ▼ (HTTPS / WSS WAN)
     ──────────────────────────────────
     Edge VM (Deployment Boundary)
     ──────────────────────────────────
     systemd (Init System)
         │
         ▼ (Process Supervision)
     Watchdog (Node.js Daemon)
         │
         ├────► Trading Platform (Loopback Trust Zone)
         │
         └────► Local Persistence Service (PostgreSQL DB)
```

*   **Edge VM (Deployment Boundary):** The virtual machine or bare-metal host running the trading engine. It acts as the local containment boundary for the Agent.
*   **systemd:** The native operating system init system responsible for starting, monitoring, and restarting the Watchdog process.
*   **Watchdog Daemon:** The compiled Node.js runtime executing the scheduler, watchdogs, and outbox workers.
*   **Trading Platform:** The local trading engine (e.g., Freqtrade) communicating via isolated local loopback interfaces.
*   **Local Persistence Service:** The database engine (implemented via PostgreSQL) storing persistent state, outbox logs, and audit trails.

---

### 3. Execution Model & Process Supervision

The Watchdog runs as a background daemon process. Instead of managing its own execution boundaries, it integrates with the operating system's native service supervisor (**systemd**):

*   **Process Mapping (`Type=simple`):** The service manager executes the Watchdog directly as a child process. Standard output and error streams are captured by the system journal (`journald`), ensuring centralized edge logging.
*   **Automatic Restarts (`Restart=always`):** If the Watchdog process terminates due to unhandled exceptions, memory exhaustion, or signals, systemd automatically restarts the process.
*   **Crash Rate Limiting (`RestartSec=10`):** The supervisor enforces a 10-second delay between recovery attempts. This prevents CPU exhaustion and log flooding if a persistent startup failure occurs (e.g., a local database connection timeout).
*   **Configuration Decoupling (`EnvironmentFile`):** Environment parameters and credential keys are stored in an external variables file (`.env`), separating the service manager's lifecycle definitions from specific execution configurations.

---

### 4. Build & Provisioning Pipeline

To maintain environment stability, the system separates compilation concerns from environment deployment procedures:

```
    [ BUILD-TIME ]                          [ DEPLOYMENT-TIME ]
 ┌──────────────────┐                    ┌────────────────────────┐
 │  tsc Compiler    │                    │  Environment Variables │
 │  (Builds dist/)  │                    │  (Reads .env File)     │
 └────────┬─────────┘                    └───────────┬────────────┘
          │                                          │
          ▼                                          ▼
 ┌──────────────────┐                    ┌────────────────────────┐
 │ Prisma Generate  │                    │ Database Migration     │
 │ (Generates ORM)  │                    │ (prisma migrate deploy)│
 └──────────────────┘                    └───────────┬────────────┘
                                                     │
                                                     ▼
                                         ┌────────────────────────┐
                                         │ systemd Registration   │
                                         │ (Starts service)       │
                                         └────────────────────────┘
```

#### 4.A. Build-Time Activities
Executed in development or integration environments before software delivery:
*   **TypeScript Compilation:** The source code is compiled using the TypeScript compiler (`tsc`) to output vanilla JavaScript files inside the distribution directory (`dist/`).
*   **Prisma Client Generation:** The database schema contract (`schema.prisma`) is evaluated to generate a type-safe client library matching the specific database configuration.

#### 4.B. Deployment-Time Activities
Executed on the target host VM during system installation or updates:
*   **Environment Configuration:** Sourcing runtime parameters and secrets from the local configuration file.
*   **Database Migration Deployment:** Bootstrapping and updating local database table schemas (`prisma migrate deploy` or `prisma db push`) to synchronize the physical database structure with the application software.
*   **systemd Service Registration:** Linking the service definition file, enabling the daemon to start on system boot, and initiating the process.

---

### 5. Operational Lifecycle States

The physical existence of the Watchdog progresses through structured deployment states:

```
Provision ──► Compile ──► Configure ──► Bootstrap ──► Execute ──► Shutdown
```

1.  **Provision:** Setting up the codebase folder, installing package dependencies, and initializing filesystem permissions.
2.  **Compile:** Executing build-time compilation and database schema generation.
3.  **Configure:** Mapping host-specific settings (database paths, tokens) and registering the service manager files.
4.  **Bootstrap:** Initializing the system daemon. The database connections are opened, cached credentials are validated, and the scheduler queue is populated.
5.  **Execute:** Running the active background schedulers and incident processing loops under process supervision.
6.  **Shutdown:** Intercepting termination signals (`SIGTERM`, `SIGINT`), completing active database writes, allowing critical persistence and communication operations to reach a safe termination point before process exit, and exiting cleanly.

---

### 6. Resource Isolation & Containment

*   **User Privilege Isolation:** The Watchdog does not run under root administrator privileges. It executes under a dedicated, unprivileged system user account. This prevents a compromise of the Watchdog process from granting administrative access to the parent OS.
*   **Filesystem Sandboxing:** Write permissions for the Watchdog user are restricted to specific directories:
    *   *Workspace Directory:* Allowed to read the compiled files and write local identity files.
    *   *System Temp Directory:* Allowed for temporary execution buffers.
    *   *Database Engine:* Writes are restricted to tables defined by the ORM schema.
    All other system filesystem zones are read-only or completely inaccessible to the Watchdog daemon.

---

### 7. Design Principles

*   **Supervisor Autonomy:** Process lifecycle monitoring, logging, and crash restarts are delegated entirely to the operating system's native init manager (systemd), avoiding custom JS-level management wrappers.
*   **Self-Contained Portability:** The Agent depends only on a standard Node.js runtime and a local database driver. It does not require global system libraries, keeping dependencies light and predictable.
*   **Immutable Distributions:** The compiled deployment artifacts (located in the `dist/` directory) remain read-only during runtime execution. Any code updates must go through a clean rebuild and deployment sequence.

---

### 8. Design Rationale

#### 8.A. Why Use systemd instead of Container Runtimes (e.g., Docker)?
Running the Agent inside a Docker container introduces container engine resource overhead and networking complexities. To monitor hardware metrics (such as host CPU, memory, and disk usage), a containerized agent would require privileged access permissions and host directory bindings, bypassing container isolation anyway. Running as a native systemd daemon allows the Agent to inspect host statistics directly and efficiently, avoiding virtualization overhead on low-spec edge VMs.

#### 8.B. Why Compile to Standard JavaScript (via tsc) rather than Packaging into a Single Binary (e.g., pkg)?
Single-file binary compilers (like `pkg`) pack the Node.js runtime and source code into a single executable. While convenient, this introduces platform-specific compilation constraints, increases binary footprint, and complicates remote debugging and CPU profiling. Compiling to standard JS files preserves native Node.js profiling compatibility, maintains platform independence, and simplifies patching.

#### 8.C. Why Enforce a 10-Second Crash Delay (RestartSec=10) in Process Supervision?
If the Watchdog experiences a persistent failure (e.g., the database service fails to start or database credentials change), restarting the process immediately would lead to a rapid boot-loop. This crash loop wastes CPU cycles, fills logs, and can cause kernel scheduler starvation. A 10-second delay gives the host system time to stabilize and prevents resource exhaustion during outages.

#### 8.D. Why Run Database Migrations as a Pre-Execution Task instead of inside Bootstrapping Hooks?
If database migrations are run automatically inside the Agent's startup code, multiple Agent instances starting at the same time could try to modify the schema concurrently. This leads to transaction lock failures and database corruption. Separating migrations into a pre-execution provisioning step ensures they run sequentially and allows deployers to rollback software updates if a database schema migration fails.

---

### 9. Related Chapters

*   **Chapter I — Agent Lifecycle:** Explains the logical start and stop sequences of the orchestrator.
*   **Chapter VIII — Scheduler Architecture:** Details how the scheduled execution loops operate once systemd starts the process.
*   **Chapter XII — Persistence Architecture:** Documents the database tables and schemas that must be provisioned during the build phase.
