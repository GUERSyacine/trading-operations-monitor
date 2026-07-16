import { MachineInfo, MachineInfoProvider } from './types';
import * as os from 'os';

export class DefaultMachineInfoProvider implements MachineInfoProvider {
    constructor(private readonly dynamicMachineIdResolver?: () => string | undefined) {}

    getMachineInfo(): MachineInfo {
        const resolvedMachineId = this.dynamicMachineIdResolver?.() || process.env.MACHINE_ID || 'local-vps';

        return {
            machineId: resolvedMachineId,
            botId: process.env.BOT_ID || 'ft-bot-1',
            licenseKey: process.env.LICENSE_KEY || 'watchdog-license-default',
            hostname: os.hostname(),
            os: process.platform,
            // TODO: Replace with real dynamic Docker daemon info retrieval inside production agent
            dockerVersion: '1.0.0',
            // TODO: Replace with real dynamic Freqtrade version query from adapter/runner info
            freqtradeVersion: '1.0.0',
            adapter: 'freqtrade',
            environment: process.env.NODE_ENV || 'production',
            agentVersion: '1.0.0',
            schemaVersion: 1
        };
    }
}
