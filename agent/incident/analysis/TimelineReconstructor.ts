import { Evidence } from './EvidenceCollector';
import { IncidentClassifier } from './IncidentClassifier';
import { MVP_CONFIG } from '../../../mvpConfig';

export interface TimelineEvent {
    id: string;
    groupId: number;
    sequence: number;
    category: 'INCIDENT' | 'AUDIT' | 'GROUP';
    source: string;
    event: 'DETECTED' | 'RESOLVED' | 'CREATED' | 'OBSERVED';
    timestamp: number;
    origin: 'OBSERVATION' | 'ASSESSMENT' | 'SYSTEM';
    entityId?: string;
    severity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
    symbol?: string;
    correlationKey?: string;
    message?: string;
    metadata?: Record<string, unknown>;
    deltaFromStartMs: number;
    deltaFromPreviousMs: number;
    durationMs?: number;
    isConcurrent: boolean;
    isFirstIncident: boolean;
    isLastEvent: boolean;
    previousEventId?: string;
    nextEventId?: string;
    previousSequence?: number;
    nextSequence?: number;
}

export interface IncidentLifecycle {
    incidentId: string;
    source: string;
    detectedAt: number;
    resolvedAt?: number;
    durationMs?: number;
    initialSeverity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
    peakSeverity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
    isResolved: boolean;
}

export interface TimelineStatistics {
    incidentCount: number;
    auditCount: number;
    resolvedCount: number;
    activeCount: number;
    infraCount: number;
    opsCount: number;
    firstIncidentAt?: number;
    lastIncidentAt?: number;
    activeDurationMs: number;
    averageIncidentDurationMs?: number;
    peakSeverity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL';
}

export interface Timeline {
    groupId: number;
    startTime: number;
    endTime: number;
    durationMs: number;
    events: TimelineEvent[];
    statistics: TimelineStatistics;
    firstIncident?: TimelineEvent;
    firstInfrastructureEvent?: TimelineEvent;
    firstOperationsEvent?: TimelineEvent;
    lastEvent: TimelineEvent;
    resolutionChain: TimelineEvent[];
    concurrencyClusters: TimelineEvent[][];
    incidentLifecycles: Record<string, IncidentLifecycle>;
    eventsBySource: Record<string, TimelineEvent[]>;
    eventsByCategory: Record<'INCIDENT' | 'AUDIT' | 'GROUP', TimelineEvent[]>;
}

export class TimelineReconstructor {
    private readonly concurrencyThresholdMs: number;

    constructor(concurrencyThresholdMs = MVP_CONFIG.INCIDENTS.CONCURRENCY_THRESHOLD_MS) {
        this.concurrencyThresholdMs = concurrencyThresholdMs;
    }

    public reconstruct(groupId: number, evidence: Evidence[]): Timeline {
        if (!evidence || evidence.length === 0) {
            throw new Error(`Cannot reconstruct timeline for group #${groupId}: No evidence provided`);
        }

        const startTime = evidence[0].timestamp;
        const endTime = evidence[evidence.length - 1].timestamp;
        const durationMs = endTime - startTime;

        // 1. Build Incident Lifecycles
        const incidentLifecycles = this.buildIncidentLifecycles(evidence);

        // 2. Identify first incident flags
        let firstIncidentId: string | null = null;
        let firstInfraIncidentId: string | null = null;
        let firstOpsIncidentId: string | null = null;

        for (const ev of evidence) {
            if (ev.category === 'INCIDENT' && ev.event === 'DETECTED') {
                if (!firstIncidentId) {
                    firstIncidentId = ev.id;
                }
                if (IncidentClassifier.isInfrastructure(ev.source)) {
                    if (!firstInfraIncidentId) {
                        firstInfraIncidentId = ev.id;
                    }
                } else {
                    if (!firstOpsIncidentId) {
                        firstOpsIncidentId = ev.id;
                    }
                }
            }
        }

        // 3. Build TimelineEvents (Flattened)
        const timelineEvents: TimelineEvent[] = [];
        for (let i = 0; i < evidence.length; i++) {
            const ev = evidence[i];
            const prev = i > 0 ? evidence[i - 1] : null;

            const deltaFromStartMs = ev.timestamp - startTime;
            const deltaFromPreviousMs = prev ? ev.timestamp - prev.timestamp : 0;

            let durationMs: number | undefined = undefined;
            if (ev.category === 'INCIDENT' && ev.entityId) {
                durationMs = incidentLifecycles[ev.entityId]?.durationMs;
            }

            const isFirstIncident = ev.id === firstIncidentId;
            const isLastEvent = i === evidence.length - 1;

            timelineEvents.push({
                ...ev,
                deltaFromStartMs,
                deltaFromPreviousMs,
                durationMs,
                isConcurrent: false,
                isFirstIncident,
                isLastEvent,
                previousEventId: prev ? prev.id : undefined,
                nextEventId: i + 1 < evidence.length ? evidence[i + 1].id : undefined,
                previousSequence: prev ? prev.sequence : undefined,
                nextSequence: i + 1 < evidence.length ? evidence[i + 1].sequence : undefined
            });
        }

        // 4. Concurrency Clustering (Compare to cluster start to prevent chaining)
        const concurrencyClusters = this.buildConcurrencyClusters(timelineEvents);

        // 5. Build lookup maps and statistics
        const eventsBySource: Record<string, TimelineEvent[]> = {};
        const eventsByCategory: Record<'INCIDENT' | 'AUDIT' | 'GROUP', TimelineEvent[]> = {
            INCIDENT: [],
            AUDIT: [],
            GROUP: []
        };
        
        let incidentCount = 0;
        let auditCount = 0;
        let resolvedCount = 0;
        let activeCount = 0;
        let infraCount = 0;
        let opsCount = 0;
        let firstIncidentAt: number | undefined = undefined;
        let lastIncidentAt: number | undefined = undefined;
        let peakSeverityValue = -1;
        let peakSeverity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'WARNING' | 'CRITICAL' | undefined = undefined;

        const severityScale: Record<string, number> = {
            INFO: 0,
            LOW: 1,
            MEDIUM: 2,
            HIGH: 3,
            WARNING: 4,
            CRITICAL: 5
        };

        for (const te of timelineEvents) {
            // Source Index Map
            if (!eventsBySource[te.source]) {
                eventsBySource[te.source] = [];
            }
            eventsBySource[te.source].push(te);

            // Category Index Map
            eventsByCategory[te.category].push(te);

            // Severity Tracking
            if (te.severity) {
                const val = severityScale[te.severity] ?? 0;
                if (val > peakSeverityValue) {
                    peakSeverityValue = val;
                    peakSeverity = te.severity;
                }
            }

            // Counts & Stats
            if (te.category === 'INCIDENT') {
                incidentCount++;
                if (te.event === 'DETECTED') {
                    if (firstIncidentAt === undefined) firstIncidentAt = te.timestamp;
                    lastIncidentAt = te.timestamp;
                }
                const isInfra = IncidentClassifier.isInfrastructure(te.source);
                if (isInfra) {
                    infraCount++;
                } else {
                    opsCount++;
                }
            } else if (te.category === 'AUDIT') {
                auditCount++;
            }
        }

        let totalDuration = 0;
        for (const id in incidentLifecycles) {
            const lifecycle = incidentLifecycles[id];
            if (lifecycle.isResolved) {
                resolvedCount++;
                totalDuration += lifecycle.durationMs || 0;
            } else {
                activeCount++;
            }
        }

        const averageIncidentDurationMs = resolvedCount > 0 ? (totalDuration / resolvedCount) : undefined;

        const statistics: TimelineStatistics = {
            incidentCount,
            auditCount,
            resolvedCount,
            activeCount,
            infraCount,
            opsCount,
            firstIncidentAt,
            lastIncidentAt,
            activeDurationMs: durationMs,
            averageIncidentDurationMs,
            peakSeverity
        };

        const firstIncident = timelineEvents.find(te => te.isFirstIncident);
        const firstInfrastructureEvent = timelineEvents.find(te => te.id === firstInfraIncidentId);
        const firstOperationsEvent = timelineEvents.find(te => te.id === firstOpsIncidentId);
        const lastEvent = timelineEvents[timelineEvents.length - 1];
        const resolutionChain = timelineEvents.filter(te => te.event === 'RESOLVED');

        return {
            groupId,
            startTime,
            endTime,
            durationMs,
            events: timelineEvents,
            statistics,
            firstIncident,
            firstInfrastructureEvent,
            firstOperationsEvent,
            lastEvent,
            resolutionChain,
            concurrencyClusters,
            incidentLifecycles,
            eventsBySource,
            eventsByCategory
        };
    }

    private buildIncidentLifecycles(evidence: Evidence[]): Record<string, IncidentLifecycle> {
        const lifecycles: Record<string, IncidentLifecycle> = {};

        for (const ev of evidence) {
            if (ev.category === 'INCIDENT' && ev.entityId) {
                const sev = ev.severity || 'INFO';
                if (ev.event === 'DETECTED') {
                    lifecycles[ev.entityId] = {
                        incidentId: ev.entityId,
                        source: ev.source,
                        detectedAt: ev.timestamp,
                        initialSeverity: sev,
                        peakSeverity: sev,
                        isResolved: false
                    };
                } else if (ev.event === 'RESOLVED') {
                    const existing = lifecycles[ev.entityId];
                    if (existing) {
                        existing.resolvedAt = ev.timestamp;
                        existing.durationMs = ev.timestamp - existing.detectedAt;
                        existing.isResolved = true;
                    }
                }
            }
        }

        // Compute peak severity based on events if there are future escalations mapped
        const severityScale: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, WARNING: 4, CRITICAL: 5 };
        for (const ev of evidence) {
            if (ev.category === 'INCIDENT' && ev.entityId && ev.severity) {
                const existing = lifecycles[ev.entityId];
                if (existing) {
                    const existingVal = severityScale[existing.peakSeverity] ?? 0;
                    const newVal = severityScale[ev.severity] ?? 0;
                    if (newVal > existingVal) {
                        existing.peakSeverity = ev.severity;
                    }
                }
            }
        }

        return lifecycles;
    }

    private buildConcurrencyClusters(events: TimelineEvent[]): TimelineEvent[][] {
        const clusters: TimelineEvent[][] = [];
        if (events.length === 0) return clusters;

        let currentCluster: TimelineEvent[] = [events[0]];

        for (let i = 1; i < events.length; i++) {
            const ev = events[i];
            const clusterStart = currentCluster[0];
            const diff = ev.timestamp - clusterStart.timestamp;

            if (diff <= this.concurrencyThresholdMs) {
                currentCluster.push(ev);
            } else {
                if (currentCluster.length > 1) {
                    clusters.push(currentCluster);
                    currentCluster.forEach(e => e.isConcurrent = true);
                }
                currentCluster = [ev];
            }
        }

        if (currentCluster.length > 1) {
            clusters.push(currentCluster);
            currentCluster.forEach(e => e.isConcurrent = true);
        }

        return clusters;
    }
}
