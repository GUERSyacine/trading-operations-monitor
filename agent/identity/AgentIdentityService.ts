import * as os from 'os';
import { IdentityStore, AgentIdentity } from './IdentityStore';
import { AgentApiClient } from './CloudAgentClient';
import { AgentRegisterRequest } from '../../shared/types/registration';

export class AgentIdentityService {
    private identity: AgentIdentity | null = null;
    private isRegistering = false;
    private retryTimeoutId?: NodeJS.Timeout;
    private registrationCallbacks: ((identity: AgentIdentity) => void)[] = [];
    private activeMachineId?: string;

    constructor(
        private readonly store: IdentityStore,
        private readonly client: AgentApiClient,
        private readonly licenseToken: string
    ) {}

    /**
     * Start the identity service. Resolves immediately if credentials are cached.
     * Otherwise, triggers non-blocking registration in the background.
     */
    public async initialize(): Promise<boolean> {
        const loadResult = await this.store.load();
        if (loadResult.status === 'SUCCESS' && loadResult.identity) {
            this.identity = loadResult.identity;
            console.log(`[AgentIdentityService] Identity loaded successfully. Agent ID: ${this.identity.agentId}`);
            return true;
        }

        console.log(`[AgentIdentityService] Identity cache status: ${loadResult.status}. Triggering registration flow...`);

        if (loadResult.status === 'CORRUPTED' || loadResult.status === 'INVALID_SCHEMA') {
            console.warn('[AgentIdentityService] Local identity file is invalid/corrupted. Backing up file and resetting credentials.');
            await this.store.backupCorruptedFile();
            this.activeMachineId = this.store.generatePersistentMachineId();
        } else {
            // Preserve loaded machineId if present, otherwise generate a fresh one
            if (loadResult.identity?.machineId) {
                this.activeMachineId = loadResult.identity.machineId;
            } else {
                this.activeMachineId = this.store.generatePersistentMachineId();
            }
        }

        // Kick off registration in the background without blocking orchestrator boot
        this.triggerRegistrationLoop(0);
        return false;
    }

    /**
     * Register a callback to execute when registration succeeds.
     */
    public onRegistered(callback: (identity: AgentIdentity) => void): void {
        this.registrationCallbacks.push(callback);
        // If already registered, invoke immediately
        if (this.identity) {
            try {
                callback(this.identity);
            } catch (err) {
                console.error('[AgentIdentityService] Error in registration callback:', err);
            }
        }
    }

    /**
     * Retrieve the active resolved identity.
     */
    public getIdentity(): AgentIdentity | null {
        return this.identity;
    }

    /**
     * Check registration status.
     */
    public isRegistered(): boolean {
        return this.identity !== null;
    }

    /**
     * Stop any active background loops (clean shutdown).
     */
    public stop(): void {
        if (this.retryTimeoutId) {
            clearTimeout(this.retryTimeoutId);
            this.retryTimeoutId = undefined;
        }
        this.isRegistering = false;
        console.log('[AgentIdentityService] Background registration loop stopped.');
    }

    /**
     * Coordinates registration attempts.
     */
    private triggerRegistrationLoop(attempt: number): void {
        if (this.identity || this.isRegistering) {
            return;
        }

        this.isRegistering = true;
        // Exponential backoff: base 2s, capped at 60s
        const delay = Math.min(2000 * Math.pow(2, attempt), 60000);

        const attemptRegistration = async () => {
            // Guard: ensure we haven't already registered since the timer was scheduled
            if (this.identity) {
                this.isRegistering = false;
                return;
            }

            try {
                const machineId = this.activeMachineId || this.store.generatePersistentMachineId();
                this.activeMachineId = machineId;

                const req: AgentRegisterRequest = {
                    licenseToken: this.licenseToken,
                    machineId: machineId,
                    hostname: os.hostname(),
                    version: '1.0.0',
                    capabilities: ['MONITORING', 'INCIDENTS', 'TELEMETRY']
                };

                console.log(`[AgentIdentityService] Register attempt ${attempt + 1} with machineId ${machineId}...`);
                const response = await this.client.register(req);

                // Cancel the active retry timer if one was scheduled concurrently
                if (this.retryTimeoutId) {
                    clearTimeout(this.retryTimeoutId);
                    this.retryTimeoutId = undefined;
                }

                this.isRegistering = false;

                if (response.success && response.agentId && response.agentSecret) {
                    const newIdentity: AgentIdentity = {
                        version: 1,
                        machineId,
                        agentId: response.agentId,
                        agentSecret: response.agentSecret
                    };

                    // Save local persistence before triggering subscribers
                    await this.store.save(newIdentity);
                    this.identity = newIdentity;
                    console.log(`[AgentIdentityService] Registration successful! Agent ID: ${newIdentity.agentId}`);

                    // Trigger listeners
                    for (const cb of this.registrationCallbacks) {
                        try {
                            cb(newIdentity);
                        } catch (err) {
                            console.error('[AgentIdentityService] Error in registration callback:', err);
                        }
                    }
                } else {
                    console.warn(`[AgentIdentityService] Registration rejected. Status: ${response.status}. Msg: ${response.message}`);
                    
                    if (response.status === 'INVALID_TOKEN') {
                        console.error('[AgentIdentityService] License token is invalid. Manual intervention required. Halting retry loop.');
                        return; // Stop retrying
                    }

                    // Schedule retry
                    this.scheduleRetry(attempt + 1);
                }
            } catch (error: any) {
                this.isRegistering = false;
                console.error(`[AgentIdentityService] Registration error during attempt: ${error?.message || error}`);
                this.scheduleRetry(attempt + 1);
            }
        };

        this.retryTimeoutId = setTimeout(attemptRegistration, delay);
    }

    private scheduleRetry(nextAttempt: number): void {
        this.triggerRegistrationLoop(nextAttempt);
    }
}
