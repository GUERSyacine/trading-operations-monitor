import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AgentIdentity {
    version: number;
    machineId: string;
    agentId: string;
    agentSecret: string;
}

export type IdentityLoadStatus = 'NOT_FOUND' | 'CORRUPTED' | 'INVALID_SCHEMA' | 'SUCCESS';

export interface IdentityLoadResult {
    status: IdentityLoadStatus;
    identity: AgentIdentity | null;
    error?: string;
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
     * Load the identity from local storage with detailed status output.
     */
    public async load(): Promise<IdentityLoadResult> {
        try {
            if (!(await this.exists())) {
                return {
                    status: 'NOT_FOUND',
                    identity: null
                };
            }
            const content = await fs.readFile(this.filePath, 'utf-8');
            let data: any;
            try {
                data = JSON.parse(content);
            } catch (err: any) {
                return {
                    status: 'CORRUPTED',
                    identity: null,
                    error: `JSON parse error: ${err?.message || err}`
                };
            }

            if (data && typeof data === 'object' && 'machineId' in data && 'agentId' in data && 'agentSecret' in data) {
                return {
                    status: 'SUCCESS',
                    identity: {
                        version: typeof data.version === 'number' ? data.version : 1,
                        machineId: data.machineId,
                        agentId: data.agentId,
                        agentSecret: data.agentSecret
                    }
                };
            }

            return {
                status: 'INVALID_SCHEMA',
                identity: null,
                error: 'Identity file exists but is missing required fields (machineId, agentId, agentSecret).'
            };
        } catch (error: any) {
            console.error('[IdentityStore] Error loading identity file:', error?.message || error);
            return {
                status: 'CORRUPTED',
                identity: null,
                error: error?.message || String(error)
            };
        }
    }

    /**
     * Save the identity to local storage.
     */
    public async save(identity: AgentIdentity): Promise<void> {
        try {
            const data = {
                version: identity.version || 1,
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
     * Rename a corrupted/invalid identity file to a .bak file to allow recovery and debugging.
     */
    public async backupCorruptedFile(): Promise<void> {
        try {
            if (await this.exists()) {
                const bakPath = `${this.filePath}.bak`;
                await fs.rename(this.filePath, bakPath);
                console.warn(`[IdentityStore] Corrupted identity file backed up to ${bakPath}`);
            }
        } catch (error: any) {
            console.error('[IdentityStore] Error backing up corrupted file:', error?.message || error);
        }
    }

    /**
     * Generates a unique, persistent machine ID.
     */
    public generatePersistentMachineId(): string {
        return `inst-${randomUUID()}`;
    }
}
