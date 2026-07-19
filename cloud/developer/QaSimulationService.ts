export interface QaSimulationState {
    cloudOffline: boolean;
    heartbeatReject: boolean;
    authenticationReject: boolean;
    artificialLatencyMs: number;
}

export class QaSimulationService {
    private static instance?: QaSimulationService;

    private state: QaSimulationState = {
        cloudOffline: false,
        heartbeatReject: false,
        authenticationReject: false,
        artificialLatencyMs: 0
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
}
