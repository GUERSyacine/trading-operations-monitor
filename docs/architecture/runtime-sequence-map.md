# Execution Watchdog Runtime Sequence Map
## Phase 3.5 — Execution Sequencing & Runtime Interaction Paths

This document maps the step-by-step runtime interaction sequences between subsystems. While the Data Flow Map tracks objects, the Runtime Sequence Map tracks execution flow, callbacks, and invocation boundaries during key operational cycles.

---

## 1. Sequence A: Telemetry Evaluation Loop (Standard Tick)

This sequence details how the system evaluates state periodically on scheduler ticks without modifying state if thresholds are healthy.

```mermaid
sequenceDiagram
    autonumber
    participant S as Scheduler
    participant D as Telemetry Detector
    participant R as Resource Feed (System/API)
    participant IM as Incident Manager (Reporter Port)

    S->>D: executeCycle()
    activate D
    D->>R: queryMetrics()
    R-->>D: rawMetrics (CPU, memory, Docker status)
    
    alt Threshold Violation Detected
        D->>IM: reportIncident(Proposal)
        Note over D,IM: Proposal contains severity, source, reason
    else Normal Operation
        Note over D: Proposal is not generated
    end
    
    D-->>S: cycleCompleted
    deactivate D
```

---

## 2. Sequence B: State Transition & Persistence Cascade

This sequence is triggered when an `IncidentProposal` submitted to the `IncidentManager` results in an authoritative state change (escalation, new incident, or recovery).

```mermaid
sequenceDiagram
    autonumber
    participant D as Detector
    participant IM as Incident Manager
    participant DB as Persistence (Local DB)
    participant F as Forensics (Evidence Collector)
    participant A as Alerting Service
    participant OP as Outbox Publisher

    D->>IM: reportIncident(Proposal)
    activate IM
    
    Note over IM: Evaluates state change (Idempotency checked)
    
    critical Database Transaction
        IM->>DB: create/update Incident record
        IM->>DB: write IncidentTransition entry
    end
    
    par Evidence Capture
        IM->>F: captureEvidence(incidentId)
        activate F
        F->>OP: publishEvidence(payload)
        deactivate F
    and Alert Generation
        IM->>A: sendAlert(AlertRequest)
        activate A
        Note over A: Evaluates local cooldown cache
        A->>OP: publishAlert(formattedAlert)
        deactivate A
    and Event Sync Queue
        IM->>OP: publishTransition(TransitionEvent)
    end
    
    deactivate IM
```

---

## 3. Sequence C: Asynchronous Synchronization Loop

This background sequence handles the delivery of queued outbox records to the Cloud Gateway.

```mermaid
sequenceDiagram
    autonumber
    participant S as Sync Scheduler
    participant W as Outbox Sync Worker
    participant DB as Persistence (Local DB)
    participant ID as Identity Service
    participant GW as Cloud Gateway

    S->>W: syncPending()
    activate W
    
    W->>DB: fetchPendingEntries(limit: 50)
    DB-->>W: entriesList (Chronological Order)
    
    loop for each entry
        W->>ID: getAuthHeaders()
        ID-->>W: headers (Agent ID, signed HMAC secret)
        W->>GW: POST /api/v1/agent/incidents (or alerts) with headers
        activate GW
        Note over GW: Validates Agent identity & capabilities
        GW-->>W: HTTP 201 Created (Success Ack)
        deactivate GW
        W->>DB: deleteEntry(id)
    end
    
    W-->>S: syncCompleted
    deactivate W
```
