export interface QaSimulationState {
    cloudOffline: boolean;
    heartbeatReject: boolean;
    authenticationReject: boolean;
    artificialLatencyMs: number;
    minimumVersion: string;
    deprecatedVersion: string;
}

export interface VersionCheckResult {
    status: 'OK' | 'DEPRECATED' | 'REJECTED';
    message?: string;
    currentVersion: string;
    minimumVersion: string;
    deprecatedVersion: string;
}

export class QaSimulationService {
    private static instance?: QaSimulationService;

    private state: QaSimulationState = {
        cloudOffline: false,
        heartbeatReject: false,
        authenticationReject: false,
        artificialLatencyMs: 0,
        minimumVersion: '1.0.0',
        deprecatedVersion: '1.0.0'
    };

    public static getInstance(): QaSimulationService {
        if (!QaSimulationService.instance) {
            QaSimulationService.instance = new QaSimulationService();
        }
        return QaSimulationService.instance;
    }

    public getState(): QaSimulationState {
        return { ...this.state };
    }

    public updateState(update: Partial<QaSimulationState>): QaSimulationState {
        this.state = { ...this.state, ...update };
        return this.getState();
    }

    public isCloudOffline(): boolean {
        return this.state.cloudOffline;
    }

    public shouldRejectHeartbeat(): boolean {
        return this.state.heartbeatReject;
    }

    public shouldRejectAuthentication(): boolean {
        return this.state.authenticationReject;
    }

    public getArtificialLatency(): number {
        return this.state.artificialLatencyMs;
    }

    /**
     * Compare two semantic versions (x.y.z).
     * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2.
     */
    public compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    /**
     * Validate incoming version against policy constraints.
     */
    public checkVersion(version?: string): VersionCheckResult {
        const currentVersion = version || '';
        const minV = this.state.minimumVersion;
        const depV = this.state.deprecatedVersion;

        if (!version) {
            return {
                status: 'REJECTED',
                message: 'Protocol violation: X-Agent-Version header or version field is required.',
                currentVersion,
                minimumVersion: minV,
                deprecatedVersion: depV
            };
        }

        if (this.compareVersions(currentVersion, minV) < 0) {
            return {
                status: 'REJECTED',
                message: `Upgrade Required: Agent version ${currentVersion} is unsupported. Minimum required is ${minV}.`,
                currentVersion,
                minimumVersion: minV,
                deprecatedVersion: depV
            };
        }

        if (this.compareVersions(currentVersion, depV) < 0) {
            return {
                status: 'DEPRECATED',
                message: `Deprecated Protocol Warning: Agent version ${currentVersion} is deprecated. Deprecated threshold is ${depV}. Please upgrade.`,
                currentVersion,
                minimumVersion: minV,
                deprecatedVersion: depV
            };
        }

        return {
            status: 'OK',
            currentVersion,
            minimumVersion: minV,
            deprecatedVersion: depV
        };
    }
}
