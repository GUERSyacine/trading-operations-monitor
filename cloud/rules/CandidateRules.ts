import { CandidateRule, CandidateMatch, TimelineQuery, EvaluationHint } from './CandidateGenerator';
import { MVP_CONFIG } from '../../shared/mvpConfig';

export interface RcaRuleConfig {
    dockerCascadeWindowMs: number;
    telemetryWindowMs: number;
    vmExhaustionWindowMs: number;
    networkOutageWindowMs: number;
}

// 1. Docker Rule
export class DockerRule implements CandidateRule {
    public readonly name = 'DockerRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const de = query.findFirstUnhealthy(['DOCKER', 'DOCKER_HEALTH']);
        if (!de) return [];

        const apiEvents = query.findUnhealthyEvents(['FREQTRADE', 'FREQTRADE_API']);
        const hbEvents = query.findUnhealthyEvents(['HEARTBEAT']);
        
        const evidence = [de.id, ...apiEvents.map(e => e.id), ...hbEvents.map(e => e.id)];
        const conditions = ['Docker failure incident detected'];
        const hints: EvaluationHint[] = [
            {
                id: 'DOCKER_FAILED_FIRST',
                polarity: 'POSITIVE',
                description: 'Docker container failure recorded',
                evidenceIds: [de.id]
            }
        ];
        const missing: string[] = [];
        const matchedSignals = ['DOCKER:DETECTED'];

        if (apiEvents.length > 0) {
            matchedSignals.push('FREQTRADE_API:DETECTED');
            const firstAPI = apiEvents[0];
            const hasApiCascade = query.isBefore(de, firstAPI) && query.areWithinWindow(de, firstAPI, this.config.dockerCascadeWindowMs);
            if (hasApiCascade) {
                conditions.push('Docker to Freqtrade API cascade sequence matched');
                hints.push({
                    id: 'API_TIMEOUT_CASCADE',
                    polarity: 'POSITIVE',
                    description: 'API timed out within cascade window',
                    evidenceIds: [de.id, firstAPI.id]
                });

                if (hbEvents.length > 0) {
                    matchedSignals.push('HEARTBEAT:DETECTED');
                    const firstHB = hbEvents[0];
                    const hasFullCascade = query.isBefore(firstAPI, firstHB) && query.areWithinWindow(firstAPI, firstHB, this.config.dockerCascadeWindowMs);
                    if (hasFullCascade) {
                        conditions.push('Heartbeat silence cascaded after Freqtrade API timeout');
                        hints.push({
                            id: 'HEARTBEAT_CASCADE',
                            polarity: 'POSITIVE',
                            description: 'Heartbeat stopped following API timeout',
                            evidenceIds: [firstAPI.id, firstHB.id]
                        });
                    }
                } else {
                    missing.push('HEARTBEAT');
                    hints.push({
                        id: 'HEARTBEAT_HEALTHY',
                        polarity: 'NEGATIVE',
                        description: 'No heartbeat failure observed (no active incident)',
                        evidenceIds: []
                    });
                }
            }
        } else {
            missing.push('FREQTRADE_API', 'HEARTBEAT');
            hints.push({
                id: 'HEARTBEAT_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'No Freqtrade API failure observed (no active incident)',
                evidenceIds: []
            });
            hints.push({
                id: 'HEARTBEAT_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'No heartbeat failure observed (no active incident)',
                evidenceIds: []
            });
        }

        return [{
            candidateId: 'DOCKER_CONTAINER_EXITED',
            ruleName: this.name,
            title: 'Docker Container Exited',
            description: 'The Freqtrade docker container crashed or stopped communicating, cascading to API timeouts.',
            triggerSignal: 'DOCKER',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            supportingEvidence: evidence,
            contradictingEvidence: [],
            missingEvidence: missing,
            matchedConditions: conditions,
            evaluationHints: hints,
            matchedSignals
        }];
    }
}

// 2. Telemetry Rule
export class TelemetryRule implements CandidateRule {
    public readonly name = 'TelemetryRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const events = query.findUnhealthyEvents(['HEARTBEAT', 'BROKER_CONNECTION', 'BROKER_PING', 'MARKET_DATA', 'MARKET_DATA_STALE']);
        if (events.length === 0) return [];

        const supportingEvidence = events.map(e => e.id);
        const conditions = [`Telemetry failure detected`];
        const hints: EvaluationHint[] = [
            {
                id: 'TELEMETRY_WARNING',
                polarity: 'POSITIVE',
                description: 'Operational telemetry warning recorded',
                evidenceIds: supportingEvidence
            }
        ];
        const missing: string[] = [];
        const matchedSignals = events.map(e => `${e.source}:DETECTED`);

        const failedSources = events.map(e => e.source);
        for (const source of ['HEARTBEAT', 'BROKER_CONNECTION', 'MARKET_DATA_STALE']) {
            const hasFailure = failedSources.some(fs => 
                (source === 'HEARTBEAT' && fs === 'HEARTBEAT') ||
                (source === 'BROKER_CONNECTION' && (fs === 'BROKER_CONNECTION' || fs === 'BROKER_PING')) ||
                (source === 'MARKET_DATA_STALE' && (fs === 'MARKET_DATA' || fs === 'MARKET_DATA_STALE'))
            );
            if (!hasFailure) {
                missing.push(source);
                hints.push({
                    id: 'TELEMETRY_HEALTHY',
                    polarity: 'NEGATIVE',
                    description: `Telemetry channel healthy: ${source}`,
                    evidenceIds: []
                });
            }
        }

        return [{
            candidateId: 'TELEMETRY_BLACKOUT',
            ruleName: this.name,
            title: 'Telemetry Blackout',
            description: 'Multiple system health feeds or heartbeats are disconnected concurrently.',
            triggerSignal: 'HEARTBEAT',
            hypothesisType: 'OPERATIONS',
            affectedLayer: 'LAYER_B',
            supportingEvidence,
            contradictingEvidence: [],
            missingEvidence: missing,
            matchedConditions: conditions,
            evaluationHints: hints,
            matchedSignals
        }];
    }
}

// 3. VM Rule
export class VMRule implements CandidateRule {
    public readonly name = 'VMRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const events = query.findUnhealthyEvents(['CPU', 'MEMORY', 'DISK', 'VM_HEALTH']);
        if (events.length === 0) return [];

        const supportingEvidence = events.map(e => e.id);
        const conditions = [`Resource constraints matched`];

        // Determine resource overloads by checking event source & metadata values
        const hasCpu = events.some(e => e.source === 'CPU' || (e.metadata && typeof e.metadata.cpuPct === 'number'));
        const cpuOver = events.some(e => e.source === 'CPU' || (e.metadata && typeof e.metadata.cpuPct === 'number' && e.metadata.cpuPct >= MVP_CONFIG.INFRASTRUCTURE.CPU_WARNING_THRESHOLD));

        const hasMem = events.some(e => e.source === 'MEMORY' || (e.metadata && typeof e.metadata.memoryPct === 'number'));
        const memOver = events.some(e => e.source === 'MEMORY' || (e.metadata && typeof e.metadata.memoryPct === 'number' && e.metadata.memoryPct >= MVP_CONFIG.INFRASTRUCTURE.MEMORY_WARNING_THRESHOLD));

        const hasDisk = events.some(e => e.source === 'DISK' || (e.metadata && typeof e.metadata.diskPct === 'number'));
        const diskOver = events.some(e => e.source === 'DISK' || (e.metadata && typeof e.metadata.diskPct === 'number' && e.metadata.diskPct >= MVP_CONFIG.INFRASTRUCTURE.DISK_WARNING_THRESHOLD));

        const overloadedList: string[] = [];
        if (cpuOver) overloadedList.push('CPU');
        if (memOver) overloadedList.push('MEMORY');
        if (diskOver) overloadedList.push('DISK');
        if (overloadedList.length === 0) {
            const uniqueSources = Array.from(new Set(events.map(e => e.source)));
            overloadedList.push(...uniqueSources);
        }

        const hints: EvaluationHint[] = [
            {
                id: 'VM_RESOURCE_OVERLOAD',
                polarity: 'POSITIVE',
                description: `Resource overload: ${overloadedList.join(', ')}`,
                evidenceIds: supportingEvidence
            }
        ];
        const missing: string[] = [];
        const matchedSignals = events.map(e => `${e.source}:DETECTED`);

        if (events.length >= 2) {
            const hasConcurrency = events.some((e1, i) => 
                events.some((e2, j) => i !== j && (query.inSameCluster(e1, e2) || query.areWithinWindow(e1, e2, this.config.vmExhaustionWindowMs)))
            );
            if (hasConcurrency) {
                conditions.push('Concurrent resource threshold breach matched');
                hints.push({
                    id: 'VM_RESOURCE_OVERLOAD',
                    polarity: 'POSITIVE',
                    description: 'Concurrent resource threshold breach',
                    evidenceIds: supportingEvidence
                });
            }
        }

        // Add healthy resource hints only when they are actively monitored and below threshold
        if (hasCpu && !cpuOver) {
            hints.push({
                id: 'VM_RESOURCE_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'Resource remains healthy: CPU',
                evidenceIds: []
            });
        }
        if (hasMem && !memOver) {
            hints.push({
                id: 'VM_RESOURCE_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'Resource remains healthy: MEMORY',
                evidenceIds: []
            });
        }
        if (hasDisk && !diskOver) {
            hints.push({
                id: 'VM_RESOURCE_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'Resource remains healthy: DISK',
                evidenceIds: []
            });
        }

        return [{
            candidateId: 'VM_RESOURCE_EXHAUSTION',
            ruleName: this.name,
            title: 'VM Resource Exhaustion',
            description: 'System CPU, memory, or disk constraints reached critical limits.',
            triggerSignal: 'VM',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            supportingEvidence,
            contradictingEvidence: [],
            missingEvidence: missing,
            matchedConditions: conditions,
            evaluationHints: hints,
            matchedSignals
        }];
    }
}

// 4. Network Rule
export class NetworkRule implements CandidateRule {
    public readonly name = 'NetworkRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const netEvents = query.findUnhealthyEvents(['NETWORK', 'NETWORK_HEALTH']);
        const dnsEvents = query.findUnhealthyEvents(['DNS', 'DNS_HEALTH']);

        if (netEvents.length === 0 && dnsEvents.length === 0) return [];

        const evidence = [...netEvents.map(e => e.id), ...dnsEvents.map(e => e.id)];
        const conditions = ['Local connection failure detected'];
        const hints: EvaluationHint[] = [];
        const missing: string[] = [];
        const matchedSignals: string[] = [];

        if (netEvents.length > 0 && dnsEvents.length > 0) {
            const netEv = netEvents[0];
            const dnsEv = dnsEvents[0];
            if (query.inSameCluster(netEv, dnsEv) || query.areWithinWindow(netEv, dnsEv, this.config.networkOutageWindowMs)) {
                conditions.push('Concurrent Network and DNS outage matched');
                hints.push({
                    id: 'NET_DNS_OUTAGE',
                    polarity: 'POSITIVE',
                    description: 'Concurrent Network and DNS outage',
                    evidenceIds: evidence
                });
            }
        }

        if (netEvents.length > 0) {
            hints.push({
                id: 'NETWORK_FAILED',
                polarity: 'POSITIVE',
                description: 'Local network interface failed',
                evidenceIds: netEvents.map(e => e.id)
            });
            matchedSignals.push('NETWORK:DETECTED');
        } else {
            hints.push({
                id: 'NETWORK_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'Network adapter remains healthy',
                evidenceIds: []
            });
        }

        if (dnsEvents.length > 0) {
            hints.push({
                id: 'DNS_FAILED',
                polarity: 'POSITIVE',
                description: 'DNS resolution failed',
                evidenceIds: dnsEvents.map(e => e.id)
            });
            matchedSignals.push('DNS:DETECTED');
        } else {
            hints.push({
                id: 'DNS_HEALTHY',
                polarity: 'NEGATIVE',
                description: 'DNS resolution remains healthy',
                evidenceIds: []
            });
        }

        return [{
            candidateId: 'NETWORK_OUTAGE',
            ruleName: this.name,
            title: 'Network Outage',
            description: 'General network DNS resolution or internet routing outage.',
            triggerSignal: 'NETWORK',
            hypothesisType: 'INFRASTRUCTURE',
            affectedLayer: 'LAYER_A',
            supportingEvidence: evidence,
            contradictingEvidence: [],
            missingEvidence: missing,
            matchedConditions: conditions,
            evaluationHints: hints,
            matchedSignals
        }];
    }
}

// 5. Exchange Rule
export class ExchangeRule implements CandidateRule {
    public readonly name = 'ExchangeRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const exEvents = query.findUnhealthyEvents(['EXCHANGE_REACHABILITY', 'EXCHANGE_HEALTH']);
        if (exEvents.length === 0) return [];

        const netEvents = query.findUnhealthyEvents(['NETWORK', 'NETWORK_HEALTH']);
        const dnsEvents = query.findUnhealthyEvents(['DNS', 'DNS_HEALTH']);
        const localNetworkIssues = [...netEvents, ...dnsEvents];

        const contradictingEvidence: string[] = [];
        const conditions = ['Exchange reachability failed'];
        const hints: EvaluationHint[] = [
            {
                id: 'EXCHANGE_UNREACHABLE',
                polarity: 'POSITIVE',
                description: 'Exchange API unreachable',
                evidenceIds: exEvents.map(e => e.id)
            }
        ];
        const matchedSignals = ['EXCHANGE_REACHABILITY:DETECTED'];

        if (localNetworkIssues.length > 0) {
            contradictingEvidence.push(...localNetworkIssues.map(e => e.id));
            conditions.push('Local Network/DNS outages detected (weakens external exchange outage hypothesis)');
            hints.push({
                id: 'LOCAL_NETWORK_DOWN_CONCURRENCY',
                polarity: 'NEGATIVE',
                description: 'Local network down concurrently',
                evidenceIds: localNetworkIssues.map(e => e.id)
            });
            matchedSignals.push(...localNetworkIssues.map(e => `${e.source}:DETECTED`));
        } else {
            conditions.push('Local server network and DNS are healthy');
            hints.push({
                id: 'LOCAL_NETWORK_DNS_HEALTHY',
                polarity: 'POSITIVE',
                description: 'Local network and DNS are operational',
                evidenceIds: []
            });
        }

        const supportingEvidence = exEvents.map(e => e.id);

        return [{
            candidateId: 'EXCHANGE_OUTAGE',
            ruleName: this.name,
            title: 'Exchange API Outage',
            description: 'External Exchange API endpoints are unreachable while server local network remains healthy.',
            triggerSignal: 'EXCHANGE_REACHABILITY',
            hypothesisType: 'EXTERNAL',
            affectedLayer: 'EXTERNAL',
            supportingEvidence,
            contradictingEvidence,
            missingEvidence: [],
            matchedConditions: conditions,
            evaluationHints: hints,
            matchedSignals
        }];
    }
}

// 6. Lifecycle Rule
export class LifecycleRule implements CandidateRule {
    public readonly name = 'LifecycleRule';

    constructor(private readonly config: RcaRuleConfig) {}

    public evaluate(query: TimelineQuery): CandidateMatch[] {
        const events = query.findUnhealthyEvents(['LIFECYCLE_ANOMALY']);
        if (events.length === 0) return [];

        const supportingEvidence = events.map(e => e.id);

        return [{
            candidateId: 'LIFECYCLE_MUTATION',
            ruleName: this.name,
            title: 'Lifecycle Mutation Anomaly',
            description: 'State machine detected an unauthorized or backward state mutation.',
            triggerSignal: 'LIFECYCLE_ANOMALY',
            hypothesisType: 'SYSTEM',
            affectedLayer: 'LAYER_B',
            supportingEvidence,
            contradictingEvidence: [],
            missingEvidence: [],
            matchedConditions: ['Lifecycle anomaly detected'],
            evaluationHints: [
                {
                    id: 'STATE_MACHINE_MUTATION',
                    polarity: 'POSITIVE',
                    description: 'State machine transition breach',
                    evidenceIds: supportingEvidence
                }
            ],
            matchedSignals: ['LIFECYCLE_ANOMALY:DETECTED']
        }];
    }
}
