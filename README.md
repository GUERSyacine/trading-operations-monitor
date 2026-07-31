# Execution Watchdog

**Execution Watchdog** is an edge-native, fail-closed monitoring platform designed to protect algorithmic trading systems from silent failures, API degradations, and operational anomalies. 

Designed specifically for VM/bare-metal environments co-located next to algorithmic trading engines (such as Freqtrade), the system acts as an autonomous edge reasoning engine rather than a passive logger, ensuring immediate diagnostics and failsafe protections.

---

## Key Capabilities

1. **Bot Heartbeat Monitoring:** Actively tracks trading application lifecycles, alerting via Telegram/Notification channels immediately upon inactivity or crash events.
2. **Incident Detection & Forensics:** Captures and classifies operational incidents (e.g., flash crashes, spread explosions, slippage anomalies) locally using deterministic rule sets.
3. **Exchange Health Auditing:** Monitors broker/exchange API health, measuring latency spikes, acknowledgement timeouts, and connection errors to isolate local problems from exchange outages.
4. **Strategy Runtime Verification:** Detects anomalies in execution behavior, alerting on sudden fill-rate drops, trading inactivity, or value drift.
5. **Kill-Switch Execution:** Automatically triggers fail-closed isolation routines when critical thresholds (e.g., loss limits, filesystem failures, or exchange halts) are crossed.
6. **Incident Forensics:** Preserves operational trace data, allowing operators to rebuild the exact timeline and state leading up to an execution halt.

---

## Project Structure

The repository is structured as a mono-repository separating concerns into distinct logical domains:

*   **[`agent/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/agent/):** The core background daemon. This runs on the edge host, executing observation sensors, evaluating incident heuristics, and persisting state.
*   **[`cloud/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/cloud/):** The Central control API, dashboard interfaces, and fleet management gateways.
*   **[`shared/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/shared/):** Immutable system contracts, ORM database definitions, schemas, and helper utilities shared by the Agent and Cloud codebases.
*   **[`docs/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/):** Project documentation, featuring the complete 14-chapter **Architecture Manual** detailing logical designs, trust models, and deployment topologies.

---

## Documentation Navigation

The system design and design choices are documented in a hierarchical structure:

1.  **[`ARCHITECTURE.md`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/ARCHITECTURE.md):** The high-level executive overview of the design. This is the recommended entry point to understand system vision, distributed topology, and security invariants.
2.  **[`docs/architecture/`](file:///home/kaito_y69/Desktop/freelance_mvp/execution-watchdog/docs/architecture/):** The complete reference manual for developer contributions, specifying runtime behaviors, recovery models, persistence, and local sandboxing.

---

## Quick Start (Local Development)

### 1. Prerequisites
Ensure you have the following installed on your edge development environment:
*   Node.js (v20+ recommended)
*   PostgreSQL (Local instance or connection endpoint)

### 2. Installation
Clone the repository and install dependency packages:
```bash
npm install
```

### 3. Database Bootstrap
Set up database credentials in your `.env` configuration file, then generate the Prisma ORM client and deploy migrations:
```bash
# Generate type-safe Prisma client
npx prisma generate

# Deploy schema tables to PostgreSQL database
npx prisma db push
```

### 4. Build & Run
Compile TypeScript sources and start the agent daemon:
```bash
# Build TypeScript artifacts to dist/
npm run build

# Start the Agent
node dist/agent/main.js
```
*(For production VM deployments using systemd process managers, refer to the configuration guidelines in Chapter XIV of the Architecture Manual.)*
