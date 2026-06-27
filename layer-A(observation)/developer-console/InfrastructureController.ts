import { CommandRunner } from './CommandRunner';
import { SystemCommand, WatchdogEventType, EventCategory } from './types';
import { EventBus } from './EventBus';

export class InfrastructureController {
    constructor(
        private runner: CommandRunner,
        private eventBus: EventBus = EventBus.getInstance()
    ) {}

    public async restartFreqtrade(correlationId?: string): Promise<void> {
        this.eventBus.emit(EventCategory.COMMAND, WatchdogEventType.COMMAND_EXECUTED, 'InfrastructureController', { command: SystemCommand.RESTART_FREQTRADE }, correlationId);
        await this.runner.run(SystemCommand.RESTART_FREQTRADE);
    }

    public async stopFreqtrade(correlationId?: string): Promise<void> {
        this.eventBus.emit(EventCategory.COMMAND, WatchdogEventType.COMMAND_EXECUTED, 'InfrastructureController', { command: SystemCommand.STOP_FREQTRADE }, correlationId);
        await this.runner.run(SystemCommand.STOP_FREQTRADE);
    }

    public async startFreqtrade(correlationId?: string): Promise<void> {
        this.eventBus.emit(EventCategory.COMMAND, WatchdogEventType.COMMAND_EXECUTED, 'InfrastructureController', { command: SystemCommand.START_FREQTRADE }, correlationId);
        await this.runner.run(SystemCommand.START_FREQTRADE);
    }

    public async getFreqtradeStatus(): Promise<string> {
        try {
            const { stdout } = await this.runner.run(SystemCommand.GET_FREQTRADE_STATUS);
            return stdout.trim();
        } catch (err: any) {
            return 'unknown';
        }
    }
}
