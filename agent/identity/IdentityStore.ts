import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AgentIdentity {
    machineId: string;
    agentId: string;
    agentSecret: string;
}

export class IdentityStore {
    private readonly filePath: string;

    constructor(customPath?: string) {
        // Default path is workspace root folder
        this.filePath = customPath || path.resolve(process.cwd(), '.agent-identity.json');
    }

    /**
     * Check if the identity file exists.
     */
    public async exists(): Promise<boolean> {
        try {
            await fs.access(this.filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Load the identity from local storage.
     */
    public async load(): Promise<AgentIdentity | null> {
        try {
            if (!(await this.exists())) {
                return null;
            }
            const content = await fs.readFile(this.filePath, 'utf-8');
            const data = JSON.parse(content);
            if (data && data.machineId && data.agentId && data.agentSecret) {
                return {
                    machineId: data.machineId,
                    agentId: data.agentId,
                    agentSecret: data.agentSecret
                };
            }
            return null;
        } catch (error: any) {
            console.error('[IdentityStore] Error loading identity file:', error?.message || error);
            return null;
        }
    }

    /**
     * Save the identity to local storage.
     */
    public async save(identity: AgentIdentity): Promise<void> {
        try {
            const data = {
                machineId: identity.machineId,
                agentId: identity.agentId,
                agentSecret: identity.agentSecret
            };
            await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[IdentityStore] Identity successfully saved to ${this.filePath}`);
        } catch (error: any) {
            console.error('[IdentityStore] Error saving identity file:', error?.message || error);
            throw error;
        }
    }

    /**
     * Clear/delete the identity file.
     */
    public async clear(): Promise<void> {
        try {
            if (await this.exists()) {
                await fs.unlink(this.filePath);
                console.log('[IdentityStore] Local identity file deleted.');
            }
        } catch (error: any) {
            console.error('[IdentityStore] Error clearing identity file:', error?.message || error);
            throw error;
        }
    }

    /**
     * Generates a unique, persistent machine ID.
     */
    public generateMachineId(): string {
        return `mac-${randomUUID()}`;
    }
}
