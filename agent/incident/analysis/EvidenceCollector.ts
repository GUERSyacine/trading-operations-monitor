import { Evidence } from '../../../shared/types/telemetry';
import {
    IIncidentRepository,
    IDecisionAuditRepository,
    IncidentGroupRecord,
    IncidentRecord,
    DecisionAuditRecord
} from '../../../shared/repositories/interfaces';

export class EvidenceCollector {
    private incidentRepo: IIncidentRepository;
    private decisionAuditRepo: IDecisionAuditRepository;

    constructor(
        incidentRepo?: IIncidentRepository,
        decisionAuditRepo?: IDecisionAuditRepository
    ) {
        if (incidentRepo) {
            this.incidentRepo = incidentRepo;
        } else {
            const { PrismaIncidentRepository } = require('../../../shared/repositories/PrismaRepositories');
            this.incidentRepo = new PrismaIncidentRepository();
        }

        if (decisionAuditRepo) {
            this.decisionAuditRepo = decisionAuditRepo;
        } else {
            const { PrismaDecisionAuditRepository } = require('../../../shared/repositories/PrismaRepositories');
            this.decisionAuditRepo = new PrismaDecisionAuditRepository();
        }
    }

    public async collectEvidence(groupId: number): Promise<Evidence[]> {
        const group = await this.incidentRepo.findGroupById(groupId);

        if (!group) {
            throw new Error(`IncidentGroup #${groupId} not found`);
        }

        const incidents = await this.incidentRepo.findIncidents({ groupId });

        const evidenceList: Evidence[] = [];

        // 1. Map Group Events
        evidenceList.push(this.normalizeGroupCreation(group));
        if (group.resolvedAt !== null) {
            evidenceList.push(this.normalizeGroupResolution(group));
        }

        // 2. Map Incident Events
        for (const incident of incidents) {
            evidenceList.push(this.normalizeIncidentDetection(group.id, incident));
            if (incident.resolvedAt !== null) {
                evidenceList.push(this.normalizeIncidentResolution(group.id, incident));
            }
        }

        // 3. Map Decision Audits
        const openedAtMs = Number(group.openedAt);
        const startTime = new Date(openedAtMs);
        const endTime = group.resolvedAt ? new Date(Number(group.resolvedAt)) : new Date();

        const audits = await this.decisionAuditRepo.findMany({
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

    private normalizeGroupCreation(group: IncidentGroupRecord): Evidence {
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
            severity: group.highestSeverity as any,
            symbol: group.symbol || undefined,
            correlationKey: group.correlationKey,
            message: `Incident Group #${group.id} opened with key ${group.correlationKey}`
        };
    }

    private normalizeGroupResolution(group: IncidentGroupRecord): Evidence {
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

    private normalizeIncidentDetection(groupId: number, incident: IncidentRecord): Evidence {
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
            severity: incident.level as any,
            symbol: incident.symbol || undefined,
            message: incident.reason
        };
    }

    private normalizeIncidentResolution(groupId: number, incident: IncidentRecord): Evidence {
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
            severity: incident.level as any,
            symbol: incident.symbol || undefined,
            message: `Resolved: ${incident.reason}`
        };
    }

    private normalizeAudit(groupId: number, audit: DecisionAuditRecord): Evidence {
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
