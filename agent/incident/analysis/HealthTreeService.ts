import { IncidentManager } from '../manager/IncidentManager';
import { HealthNode, HealthStatus, HealthCheckResult } from '../../detectors/types';
import { InfrastructureWatchdogService } from '../../detectors/infrastructure/InfrastructureWatchdogService';
import { OperationsWatchdogService } from '../../detectors/operations/OperationsWatchdogService';
import { MVP_CONFIG } from '../../../shared/mvpConfig';

export class HealthTreeService {
    constructor(
        private incidentManager: IncidentManager,
        private infraService: InfrastructureWatchdogService,
        private opsService: OperationsWatchdogService
    ) {}

    async getSystemHealthTree(
        infraResults: HealthCheckResult[],
        opsResults: HealthCheckResult[]
    ): Promise<HealthNode> {
        const checkedAt = new Date();

        // 1. Infrastructure Subtree
        const infraSubtree = this.infraService.getInfrastructureSubtree(infraResults);

        // 2. Operations Subtree
        const opsSubtree = this.opsService.getOperationsSubtree(opsResults);

        // 3. Execution Pipeline Subtree
        const pipelineSubtree = this.opsService.getExecutionPipelineSubtree();

        // 4. Protection Subtree
        const activeIncidents = this.incidentManager.getActiveIncidentsCount();
        const isHalted = this.incidentManager.isHalted();
        const protectionMode = MVP_CONFIG.RISK_PROTECTION.PROTECTION_MODE;

        const modeNode: HealthNode = {
            id: 'protection.mode',
            name: 'Protection Mode',
            status: 'HEALTHY',
            checkedAt,
            message: `Mode: ${protectionMode}`
        };

        const incidentNode: HealthNode = {
            id: 'protection.incident_status',
            name: 'Incident Status',
            status: activeIncidents > 0 ? 'WARNING' : 'HEALTHY',
            checkedAt,
            message: `Active Incidents: ${activeIncidents}`
        };

        const haltNode: HealthNode = {
            id: 'protection.active_halt_state',
            name: 'Active Halt State',
            status: isHalted ? 'CRITICAL' : 'HEALTHY',
            checkedAt,
            message: `Halt: ${isHalted ? 'ACTIVE' : 'INACTIVE'}`
        };

        const protectionChildren = [modeNode, incidentNode, haltNode];
        let protectionStatus: HealthStatus = 'HEALTHY';
        if (protectionChildren.some(c => c.status === 'CRITICAL')) {
            protectionStatus = 'CRITICAL';
        } else if (protectionChildren.some(c => c.status === 'WARNING')) {
            protectionStatus = 'WARNING';
        }

        const protectionSubtree: HealthNode = {
            id: 'protection',
            name: 'Protection',
            status: protectionStatus,
            checkedAt,
            children: protectionChildren
        };

        // 5. Global Health Tree Root
        const children = [infraSubtree, opsSubtree, pipelineSubtree, protectionSubtree];

        let globalStatus: HealthStatus = 'HEALTHY';
        if (children.some(c => c.status === 'CRITICAL')) {
            globalStatus = 'CRITICAL';
        } else if (children.some(c => c.status === 'WARNING')) {
            globalStatus = 'WARNING';
        }

        return {
            id: 'global',
            name: 'Global Health Tree',
            status: globalStatus,
            checkedAt,
            children
        };
    }
}
