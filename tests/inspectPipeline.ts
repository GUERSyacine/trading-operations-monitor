import { OperationsWatchdogService } from '../agent/detectors/operations/OperationsWatchdogService';
import { AlertingService } from '../agent/notification/AlertingService';
import { IncidentManager } from '../agent/incident/manager/IncidentManager';

async function main() {
    const mockAlerting = {
        async sendAlert(alert: any) {
            console.log(`[Inspection Mock Alert] [${alert.level}] ${alert.title}: ${alert.message}`);
        }
    };
    const mockIncidentManager = {
        async reportIncident(incident: any) {
            console.log(`[Inspection Mock Incident] [${incident.level}] ${incident.source}: ${incident.reason}`);
        },
        async resolveIncidentBySource(source: string, symbol: string | null = null) {
            console.log(`[Inspection Mock Resolution] Source: ${source}`);
        }
    };

    const service = new OperationsWatchdogService(mockAlerting as any, mockIncidentManager as any);
    const result = await service.checkOrderPipeline(5 * 24 * 60 * 60 * 1000);

    console.log('\n====================================================');
    console.log('📊 LIVE ORDER PIPELINE HEALTH CHECK RESULTS');
    console.log('====================================================');
    console.dir(result, { depth: null });
    console.log('====================================================\n');
}

main().catch(err => {
    console.error('Failed to run inspection:', err);
    process.exit(1);
});
