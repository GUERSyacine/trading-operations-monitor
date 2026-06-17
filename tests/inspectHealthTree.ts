import { InfrastructureWatchdogService } from '../layer-A(observation)/layer1(infrastructure_monitoring)/InfrastructureWatchdogService';
import { OperationsWatchdogService } from '../layer-A(observation)/layer2(trading_operations_monitoring)/OperationsWatchdogService';
import { IncidentManager } from '../layer-B(Assessement)/IncidentManager';
import { HealthTreeService } from '../layer-B(Assessement)/HealthTreeService';
import { AlertingService } from '../layer-D(notification)/alerting/AlertingService';

async function main() {
    console.log('🔄 Initializing Live VM Health Tree Compilation...\n');

    const alertingService = new AlertingService();
    const incidentManager = new IncidentManager(alertingService);
    await incidentManager.init();

    const infraService = new InfrastructureWatchdogService(alertingService);
    const opsService = new OperationsWatchdogService(alertingService, incidentManager);
    const healthTreeService = new HealthTreeService(incidentManager, infraService, opsService);

    console.log('🩺 Executing VM Infrastructure Health Checks...');
    const infraResults = await infraService.runAllInfrastructureChecks();

    console.log('🩺 Executing Operations Monitoring Checks...');
    const opsResults = await opsService.runAllOperationsChecks();

    console.log('🌳 Compiling System Health Tree...');
    const healthTree = await healthTreeService.getSystemHealthTree(infraResults, opsResults);

    console.log('\n====================================================');
    console.log('📊 SERIALIZED HIERARCHICAL SYSTEM HEALTH TREE');
    console.log('====================================================');
    console.log(JSON.stringify(healthTree, null, 2));
    console.log('====================================================\n');
}

main().catch(err => {
    console.error('❌ Failed to inspect health tree:', err);
    process.exit(1);
});
