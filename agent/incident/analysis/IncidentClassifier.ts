export class IncidentClassifier {
    private static readonly INFRA_SOURCES = new Set([
        'CPU', 'MEMORY', 'DISK', 'DOCKER_CONTAINER', 
        'DNS', 'NETWORK', 'FREQTRADE_API', 'EXCHANGE_REACHABILITY',
        'VM', 'DOCKER', 'FREQTRADE'
    ]);

    public static isInfrastructure(source: string): boolean {
        for (const prefix of this.INFRA_SOURCES) {
            if (source.startsWith(prefix)) return true;
        }
        return source === 'INFRASTRUCTURE';
    }
}
