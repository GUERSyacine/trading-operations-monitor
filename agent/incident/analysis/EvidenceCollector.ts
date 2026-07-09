import { prisma } from '../../../shared/prisma';
import { Incident, IncidentGroup, DecisionAudit } from '@prisma/client';

export interface Evidence {
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
}

export class EvidenceCollector {
    public async collectEvidence(groupId: number): Promise<Evidence[]> {
        const group = await prisma.incidentGroup.findUnique({
            where: { id: groupId },
            include: { incidents: true }
        });

        if (!group) {
            throw new Error(`IncidentGroup #${groupId} not found`);
        }

        const evidenceList: Evidence[] = [];

        // 1. Map Group Events
        evidenceList.push(this.normalizeGroupCreation(group));
        if (group.resolvedAt !== null) {
            evidenceList.push(this.normalizeGroupResolution(group));
        }

        // 2. Map Incident Events
        for (const incident of group.incidents) {
            evidenceList.push(this.normalizeIncidentDetection(group.id, incident));
            if (incident.resolvedAt !== null) {
                evidenceList.push(this.normalizeIncidentResolution(group.id, incident));
            }
        }

        // 3. Map Decision Audits
        const openedAtMs = Number(group.openedAt);
        const startTime = new Date(openedAtMs);
        const endTime = group.resolvedAt ? new Date(Number(group.resolvedAt)) : new Date();

        const audits = await prisma.decisionAudit.findMany({
            where: {
                createdAt: {
                    gte: startTime,
                    lte: endTime
                }
            },
            orderBy: {
                createdAt: 'asc'
            }
        });

        for (const audit of audits) {
            evidenceList.push(this.normalizeAudit(group.id, audit));
        }

        // 4. Sort chronologically (ascending by timestamp)
        const sorted = evidenceList.sort((a, b) => a.timestamp - b.timestamp);

        // 5. Populate sequential index (1-based)
        sorted.forEach((evidence, index) => {
            evidence.sequence = index + 1;
        });

        return sorted;
    }

    private normalizeGroupCreation(group: IncidentGroup): Evidence {
        const timestamp = Number(group.openedAt);
        return {
            id: `EVD:GROUP:${group.id}:${timestamp}`,
            groupId: group.id,
            sequence: 0, // Assigned post-sorting
            category: 'GROUP',
            source: group.groupType,
            event: 'CREATED',
            timestamp,
            origin: 'ASSESSMENT',
            entityId: String(group.id),
            severity: group.highestSeverity,
            symbol: group.symbol || undefined,
            correlationKey: group.correlationKey,
            message: `Incident Group #${group.id} opened with key ${group.correlationKey}`
        };
    }

    private normalizeGroupResolution(group: IncidentGroup): Evidence {
        const timestamp = Number(group.resolvedAt);
        return {
            id: `EVD:GROUP_RESOLVED:${group.id}:${timestamp}`,
            groupId: group.id,
            sequence: 0,
            category: 'GROUP',
            source: group.groupType,
            event: 'RESOLVED',
            timestamp,
            origin: 'ASSESSMENT',
            entityId: String(group.id),
            symbol: group.symbol || undefined,
            correlationKey: group.correlationKey,
            message: `Incident Group #${group.id} resolved`
        };
    }

    private normalizeIncidentDetection(groupId: number, incident: Incident): Evidence {
        const timestamp = Number(incident.detectedAt);
        return {
            id: `EVD:INCIDENT_DETECTED:${incident.id}:${timestamp}`,
            groupId,
            sequence: 0,
            category: 'INCIDENT',
            source: incident.source,
            event: 'DETECTED',
            timestamp,
            origin: 'ASSESSMENT',
            entityId: String(incident.id),
            severity: incident.level,
            symbol: incident.symbol || undefined,
            message: incident.reason
        };
    }

    private normalizeIncidentResolution(groupId: number, incident: Incident): Evidence {
        const timestamp = Number(incident.resolvedAt);
        return {
            id: `EVD:INCIDENT_RESOLVED:${incident.id}:${timestamp}`,
            groupId,
            sequence: 0,
            category: 'INCIDENT',
            source: incident.source,
            event: 'RESOLVED',
            timestamp,
            origin: 'ASSESSMENT',
            entityId: String(incident.id),
            severity: incident.level,
            symbol: incident.symbol || undefined,
            message: `Resolved: ${incident.reason}`
        };
    }

    private normalizeAudit(groupId: number, audit: DecisionAudit): Evidence {
        const timestamp = audit.createdAt.getTime();
        const meta = audit.metadata ? (audit.metadata as Record<string, unknown>) : undefined;
        return {
            id: `EVD:AUDIT:${audit.id}:${timestamp}`,
            groupId,
            sequence: 0,
            category: 'AUDIT',
            source: audit.classification,
            event: 'OBSERVED',
            timestamp,
            origin: 'OBSERVATION',
            entityId: String(audit.id),
            message: audit.rejectionReason || `Audit: ${audit.classification}`,
            metadata: meta
        };
    }
}
