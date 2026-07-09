import { exec } from 'child_process';
import { SystemCommand } from '../../shared/types/developer';

export class CommandRunner {
    private commandMap: Record<SystemCommand, string> = {
        [SystemCommand.START_FREQTRADE]: 'docker start freqtrade',
        [SystemCommand.STOP_FREQTRADE]: 'docker stop freqtrade',
        [SystemCommand.RESTART_FREQTRADE]: 'docker restart freqtrade',
        [SystemCommand.RESTART_DOCKER]: 'sudo systemctl restart docker',
        [SystemCommand.GET_FREQTRADE_STATUS]: 'docker inspect -f "{{.State.Status}}" freqtrade'
    };

    public async run(command: SystemCommand, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
        const cmdString = this.commandMap[command];
        if (!cmdString) {
            throw new Error(`Command ${command} is not whitelisted.`);
        }

        return new Promise((resolve, reject) => {
            const child = exec(cmdString, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ stdout, stderr });
                }
            });

            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error(`Command execution timed out after ${timeoutMs}ms: ${cmdString}`));
            }, timeoutMs);

            child.on('exit', () => clearTimeout(timeout));
        });
    }
}
