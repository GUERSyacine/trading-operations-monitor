import * as os from 'os';
import { exec, execFile } from 'child_process';
import * as dns from 'dns';
import { prisma } from '../../../shared/prisma';
import { AlertingService } from '../../notification/AlertingService';
import { MVP_CONFIG } from '../../../shared/mvpConfig';

import { HealthCheckResult, HealthNode, HealthStatus } from '../../../shared/types/telemetry';

import { FailureInjectionService } from '../../../shared/services/FailureInjectionService';
import { FeatureFlagService } from '../../../shared/services/FeatureFlagService';
import { FailureType, FeatureFlag } from '../../../shared/types/developer';

export class InfrastructureWatchdogService {
    constructor(
        protected alertingService: AlertingService,
        protected failures?: FailureInjectionService,
        protected flags?: FeatureFlagService
    ) {}

    protected lastUptimeSeconds?: number;
    protected freqtradeFailures = 0;
    protected lastDockerRestartCount?: number;
    protected lastSuccessfulApiCheck?: number;
    protected exchangeFailures = 0;
    protected lastSuccessfulExchangeCheck?: number;

    protected enrichMetadata(source: string, customMeta: Record<string, any> = {}): Record<string, any> {
        return {
            ...customMeta,
            watchdogVersion: '1.0.0',
            serviceName: 'InfrastructureWatchdogService',
            environment: process.env.NODE_ENV || 'production',
            checkId: `${source.toLowerCase()}_check`
        };
    }

    protected getCpuUsage(): Promise<number> {
        return new Promise((resolve) => {
            const start = os.cpus().map(cpu => cpu.times);
            setTimeout(() => {
                const end = os.cpus().map(cpu => cpu.times);
                let idleDifference = 0;
                let totalDifference = 0;
                for (let i = 0; i < start.length; i++) {
                    const s = start[i];
                    const e = end[i];
                    const idle = e.idle - s.idle;
                    const total = (e.user - s.user) + (e.nice - s.nice) + (e.sys - s.sys) + (e.irq - s.irq) + idle;
                    idleDifference += idle;
                    totalDifference += total;
                }
                if (totalDifference === 0) resolve(0);
                else resolve(100 - (100 * idleDifference / totalDifference));
            }, 100);
        });
    }

    protected getDiskUsage(): Promise<{ usedPct: number; freeBytes: number }> {
        return new Promise((resolve) => {
            exec('df -B1 /', (err, stdout) => {
                if (err || !stdout) return resolve({ usedPct: 0, freeBytes: 0 });
                const lines = stdout.trim().split('\n');
                if (lines.length < 2) return resolve({ usedPct: 0, freeBytes: 0 });
                
                // Find line for /
                let rootLine = lines.find(l => l.endsWith(' /'));
                if (!rootLine) {
                    rootLine = lines[1];
                }
                const parts = rootLine.replace(/\s+/g, ' ').split(' ');
                
                const freeBytesStr = parts[3] || '0';
                const usePctStr = parts[4] || '0';

                const freeBytes = parseInt(freeBytesStr, 10);
                const usedPct = parseInt(usePctStr.replace('%', ''), 10);

                resolve({
                    usedPct: isNaN(usedPct) ? 0 : usedPct,
                    freeBytes: isNaN(freeBytes) ? 0 : freeBytes
                });
            });
        });
    }

    async checkVMHealth(): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        try {
            const cpuPct = await this.getCpuUsage();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const memoryPct = ((totalMem - freeMem) / totalMem) * 100;
            const diskInfo = await this.getDiskUsage();
            
            const loadavg = os.loadavg();
            const load1m = loadavg[0];
            const load5m = loadavg[1];
            const load15m = loadavg[2];
            
            const uptimeSeconds = os.uptime();

            let isAlarm = false;
            let isWarning = false;
            const alerts: string[] = [];
            const warnings: string[] = [];

            // CPU
            if (cpuPct > MVP_CONFIG.INFRASTRUCTURE.CPU_CRITICAL_THRESHOLD) {
                isAlarm = true;
                alerts.push(`CPU usage ${cpuPct.toFixed(1)}% > ${MVP_CONFIG.INFRASTRUCTURE.CPU_CRITICAL_THRESHOLD}%`);
            } else if (cpuPct > MVP_CONFIG.INFRASTRUCTURE.CPU_WARNING_THRESHOLD) {
                isWarning = true;
                warnings.push(`CPU usage ${cpuPct.toFixed(1)}% > ${MVP_CONFIG.INFRASTRUCTURE.CPU_WARNING_THRESHOLD}%`);
            }

            // Memory
            if (memoryPct > MVP_CONFIG.INFRASTRUCTURE.MEMORY_CRITICAL_THRESHOLD) {
                isAlarm = true;
                alerts.push(`Memory usage ${memoryPct.toFixed(1)}% > ${MVP_CONFIG.INFRASTRUCTURE.MEMORY_CRITICAL_THRESHOLD}%`);
            } else if (memoryPct > MVP_CONFIG.INFRASTRUCTURE.MEMORY_WARNING_THRESHOLD) {
                isWarning = true;
                warnings.push(`Memory usage ${memoryPct.toFixed(1)}% > ${MVP_CONFIG.INFRASTRUCTURE.MEMORY_WARNING_THRESHOLD}%`);
            }

            // Disk
            if (diskInfo.usedPct > MVP_CONFIG.INFRASTRUCTURE.DISK_CRITICAL_THRESHOLD) {
                isAlarm = true;
                alerts.push(`Disk usage ${diskInfo.usedPct}% > ${MVP_CONFIG.INFRASTRUCTURE.DISK_CRITICAL_THRESHOLD}%`);
            } else if (diskInfo.usedPct > MVP_CONFIG.INFRASTRUCTURE.DISK_WARNING_THRESHOLD) {
                isWarning = true;
                warnings.push(`Disk usage ${diskInfo.usedPct}% > ${MVP_CONFIG.INFRASTRUCTURE.DISK_WARNING_THRESHOLD}%`);
            }

            // Reboot
            if (this.lastUptimeSeconds !== undefined && uptimeSeconds + 30 < this.lastUptimeSeconds) {
                isAlarm = true;
                alerts.push(`VM reboot detected. Previous uptime: ${this.lastUptimeSeconds}s, current uptime: ${uptimeSeconds}s`);
            }
            this.lastUptimeSeconds = uptimeSeconds;

            const alarmMessage = alerts.join(', ');
            const warningMessage = warnings.join(', ');
            const systemRiskState = isAlarm ? 'PROTECTION' : 'NORMAL';

            const metadata = {
                source: 'VM',
                hostname: os.hostname(),
                cpuPct,
                memoryPct,
                diskPct: diskInfo.usedPct,
                diskFreeBytes: diskInfo.freeBytes,
                load1m,
                load5m,
                load15m,
                uptimeSeconds
            };

            await prisma.decisionAudit.create({
                data: {
                    classification: 'VM_HEALTH',
                    systemRiskState,
                    rejectionReason: alarmMessage || warningMessage || null,
                    metadata
                }
            });

            if (isAlarm) {
                console.error(`🚨 [InfrastructureWatchdog] VM HEALTH CRITICAL: ${alarmMessage}`);
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'VM Health Critical',
                    message: `CRITICAL RESOURCE BREACH: ${alarmMessage}`,
                    dedupKey: 'vm_health_critical'
                });
                return {
                    source: 'VM',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: alarmMessage,
                    metadata: this.enrichMetadata('VM', metadata)
                };
            }

            if (isWarning) {
                console.warn(`⚠️ [InfrastructureWatchdog] VM HEALTH WARNING: ${warningMessage}`);
                await this.alertingService.sendAlert({
                    level: 'WARNING',
                    title: 'VM Health Warning',
                    message: `RESOURCE WARNING: ${warningMessage}`,
                    dedupKey: 'vm_health_warning'
                });
                return {
                    source: 'VM',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'WARNING',
                    message: warningMessage,
                    metadata: this.enrichMetadata('VM', metadata)
                };
            }

            console.log('[InfrastructureWatchdog] VM resources are healthy.');
            return {
                source: 'VM',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('VM', metadata)
            };
        } catch (error: any) {
            console.error('[InfrastructureWatchdog] Failed VM health check:', error?.message || error);
            return {
                source: 'VM',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('VM')
            };
        }
    }

    protected getDockerInspect(containerName: string): Promise<any> {
        return new Promise((resolve) => {
            execFile('docker', ['inspect', containerName], (err, stdout) => {
                if (err || !stdout) return resolve(null);
                try {
                    const data = JSON.parse(stdout);
                    if (!Array.isArray(data) || data.length === 0) return resolve(null);
                    resolve(data[0]);
                } catch {
                    resolve(null);
                }
            });
        });
    }

    async checkDockerContainerHealth(): Promise<HealthCheckResult> {
        const checkStart = Date.now();
        try {
            const containerName = MVP_CONFIG.INFRASTRUCTURE.DOCKER_CONTAINER_NAME;
            const inspectData = await this.getDockerInspect(containerName);

            if (!inspectData) {
                const errMsg = `Docker container '${containerName}' not found or Docker daemon unreachable`;
                console.error(`🚨 [InfrastructureWatchdog] DOCKER HEALTH CRITICAL: ${errMsg}`);
                const metadata = { source: 'DOCKER', container: containerName, status: 'missing', restartCount: 0, uptimeSeconds: 0, healthy: false };
                await prisma.decisionAudit.create({
                    data: {
                        classification: 'DOCKER_HEALTH',
                        systemRiskState: 'PROTECTION',
                        rejectionReason: errMsg,
                        metadata
                    }
                });
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Docker Container Missing',
                    message: `CRITICAL: ${errMsg}`,
                    dedupKey: 'docker_container_missing'
                });
                return {
                    source: 'DOCKER',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: errMsg,
                    metadata: this.enrichMetadata('DOCKER', metadata)
                };
            }

            const state = inspectData.State || {};
            const status = state.Status || 'unknown';
            const restartCount = inspectData.RestartCount || 0;
            const healthy = state.Health ? state.Health.Status === 'healthy' : true;
            const exitCode = state.ExitCode ?? 0;

            const startedAt = state.StartedAt ? new Date(state.StartedAt).getTime() : 0;
            const uptimeSeconds = startedAt > 0 ? Math.floor((Date.now() - startedAt) / 1000) : 0;

            let isAlarm = false;
            const alerts: string[] = [];

            if (status !== 'running') {
                isAlarm = true;
                alerts.push(`Container status is '${status}' (expected 'running')`);
            }
            if (restartCount > MVP_CONFIG.INFRASTRUCTURE.DOCKER_RESTART_THRESHOLD) {
                isAlarm = true;
                alerts.push(`Restart count ${restartCount} > threshold of ${MVP_CONFIG.INFRASTRUCTURE.DOCKER_RESTART_THRESHOLD}`);
            }
            if (!healthy) {
                isAlarm = true;
                alerts.push(`Container health status is unhealthy`);
            }
            if (exitCode !== 0 && status !== 'running') {
                isAlarm = true;
                alerts.push(`Container exited with non-zero exit code ${exitCode}`);
            }
            
            const restartCountIncreased = this.lastDockerRestartCount !== undefined && restartCount > this.lastDockerRestartCount;
            if (status === 'running' && uptimeSeconds < 60 && restartCountIncreased) {
                isAlarm = true;
                alerts.push(`Container has low uptime (${uptimeSeconds}s) and restart count increased from ${this.lastDockerRestartCount} to ${restartCount}`);
            }
            this.lastDockerRestartCount = restartCount;

            const alarmMessage = alerts.join(', ');
            const systemRiskState = isAlarm ? 'PROTECTION' : 'NORMAL';

            const metadata = {
                source: 'DOCKER',
                container: containerName,
                status,
                restartCount,
                uptimeSeconds,
                healthy,
                exitCode
            };

            await prisma.decisionAudit.create({
                data: {
                    classification: 'DOCKER_HEALTH',
                    systemRiskState,
                    rejectionReason: alarmMessage || null,
                    metadata
                }
            });

            if (isAlarm) {
                console.error(`🚨 [InfrastructureWatchdog] DOCKER CONTAINER CRITICAL: ${alarmMessage}`);
                await this.alertingService.sendAlert({
                    level: 'CRITICAL',
                    title: 'Docker Container Unhealthy',
                    message: `CRITICAL CONTAINER BREACH: ${alarmMessage}`,
                    dedupKey: 'docker_container_unhealthy'
                });
                return {
                    source: 'DOCKER',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: alarmMessage,
                    metadata: this.enrichMetadata('DOCKER', metadata)
                };
            }

            console.log(`[InfrastructureWatchdog] Docker container '${containerName}' is healthy.`);
            return {
                source: 'DOCKER',
                healthy: true,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                metadata: this.enrichMetadata('DOCKER', metadata)
            };
        } catch (error: any) {
            console.error('[InfrastructureWatchdog] Failed Docker health check:', error?.message || error);
            return {
                source: 'DOCKER',
                healthy: false,
                checkedAt: new Date(),
                checkDurationMs: Date.now() - checkStart,
                severity: 'CRITICAL',
                message: error?.message || String(error),
                metadata: this.enrichMetadata('DOCKER')
            };
        }
    }

    protected getHttpResponse(urlStr: string): Promise<{ statusCode: number; responseTimeMs: number }> {
        return new Promise((resolve) => {
            const url = require('url');
            const http = require('http');
            const https = require('https');
            const parsed = url.parse(urlStr);
            const client = parsed.protocol === 'https:' ? https : http;
            const start = Date.now();
            const req = client.get(urlStr, { timeout: 5000 }, (res: any) => {
                res.on('data', () => {}); // Consume response data stream
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode || 0, responseTimeMs: Date.now() - start });
                });
            });
            req.on('error', () => resolve({ statusCode: 0, responseTimeMs: Date.now() - start }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ statusCode: 0, responseTimeMs: Date.now() - start });
            });
        });
    }

    async checkFreqtradeAPI(): Promise<HealthCheckResult> {
        const runCheck = async (): Promise<HealthCheckResult> => {
            const checkStart = Date.now();
            const apiUrl = MVP_CONFIG.INFRASTRUCTURE.FREQTRADE_API_URL;
            let isSuccess = false;
            let statusCode = 0;
            let responseTimeMs = 0;
            let errorMsg: string | null = null;

            try {
                const res = await this.getHttpResponse(apiUrl);
                statusCode = res.statusCode;
                responseTimeMs = res.responseTimeMs;
                isSuccess = res.statusCode === 200;
                if (!isSuccess) {
                    errorMsg = `Status code: ${res.statusCode}`;
                }
            } catch (error: any) {
                isSuccess = false;
                errorMsg = error?.message || String(error);
            }

            try {
                if (!isSuccess) {
                    this.freqtradeFailures++;
                } else {
                    this.freqtradeFailures = 0;
                    this.lastSuccessfulApiCheck = Date.now();
                }

                const maxFailures = 3;
                const isAlarm = this.freqtradeFailures >= maxFailures;
                const systemRiskState = isAlarm ? 'PROTECTION' : 'NORMAL';

                const downtimeSeconds = isAlarm && this.lastSuccessfulApiCheck
                    ? Math.floor((Date.now() - this.lastSuccessfulApiCheck) / 1000)
                    : null;

                const alarmMessage = isAlarm
                    ? (downtimeSeconds !== null
                        ? `Freqtrade API unreachable or non-200 for ${downtimeSeconds}s (consecutive checks failed: ${this.freqtradeFailures}${errorMsg ? `, reason: ${errorMsg}` : ''})`
                        : `Freqtrade API unreachable or non-200 for ${this.freqtradeFailures} consecutive checks${errorMsg ? `, reason: ${errorMsg}` : ''}`)
                    : null;

                const metadata = {
                    source: 'FREQTRADE',
                    url: apiUrl,
                    statusCode,
                    responseTimeMs,
                    consecutiveFailures: this.freqtradeFailures,
                    maxFailures,
                    downtimeSeconds,
                    error: errorMsg
                };

                await prisma.decisionAudit.create({
                    data: {
                        classification: 'FREQTRADE_API',
                        systemRiskState,
                        rejectionReason: alarmMessage,
                        metadata
                    }
                });

                if (!isSuccess) {
                    if (isAlarm) {
                        console.error(`🚨 [InfrastructureWatchdog] FREQTRADE API CRITICAL: ${alarmMessage}`);
                        await this.alertingService.sendAlert({
                            level: 'CRITICAL',
                            title: 'Freqtrade API Unreachable',
                            message: `CRITICAL API FAILURE: ${alarmMessage || 'Freqtrade API down'} (status code: ${statusCode}, response time: ${responseTimeMs}ms).`,
                            dedupKey: 'freqtrade_api_unreachable'
                        });
                    }
                    return {
                        source: 'FREQTRADE',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: isAlarm ? 'CRITICAL' : 'WARNING',
                        message: isAlarm ? (alarmMessage || 'Unreachable') : 'Freqtrade API warning',
                        metadata: this.enrichMetadata('FREQTRADE', metadata)
                    };
                }

                console.log(`[InfrastructureWatchdog] Freqtrade API is healthy (${responseTimeMs}ms).`);
                return {
                    source: 'FREQTRADE',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('FREQTRADE', metadata)
                };
            } catch (innerError: any) {
                console.error('[InfrastructureWatchdog] Failed Freqtrade API check audit logging:', innerError?.message || innerError);
                return {
                    source: 'FREQTRADE',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: innerError?.message || String(innerError),
                    metadata: this.enrichMetadata('FREQTRADE')
                };
            }
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.NETWORK_TIMEOUT,
                component: 'InfrastructureWatchdogService',
                operation: 'checkFreqtradeAPI',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errMsg = 'Simulated Freqtrade API Timeout';
                    await prisma.decisionAudit.create({
                        data: {
                            classification: 'FREQTRADE_API',
                            systemRiskState: 'PROTECTION',
                            rejectionReason: errMsg,
                            metadata: { simulated: true }
                        }
                    });
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'Freqtrade API Unreachable',
                        message: `CRITICAL API FAILURE (SIMULATED): ${errMsg}`,
                        dedupKey: 'freqtrade_api_unreachable'
                    });
                    return {
                        source: 'FREQTRADE',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errMsg,
                        metadata: this.enrichMetadata('FREQTRADE', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
    }

    protected executePing(target: string): Promise<{ loss: number; latency: number }> {
        return new Promise((resolve) => {
            execFile('ping', ['-c', '1', '-W', '1', target], (err, stdout) => {
                if (err || !stdout) return resolve({ loss: 100, latency: 9999 });
                const lines = stdout.split('\n');
                let loss = 100;
                let latency = 9999;
                for (const line of lines) {
                    if (line.includes('packet loss')) {
                        const match = line.match(/(\d+)%\s+packet loss/);
                        if (match) loss = parseInt(match[1], 10);
                    }
                    if (line.includes('rtt min/avg/max/mdev') || line.includes('round-trip min/avg/max')) {
                        const parts = line.split('=')[1];
                        if (parts) {
                            const avg = parseFloat(parts.trim().split('/')[1]);
                            if (!isNaN(avg)) latency = avg;
                        }
                    }
                }
                resolve({ loss, latency });
            });
        });
    }

    async checkHostNetwork(): Promise<HealthCheckResult> {
        const runCheck = async (): Promise<HealthCheckResult> => {
            const checkStart = Date.now();
            try {
                const targets = MVP_CONFIG.INFRASTRUCTURE.NETWORK_TARGETS;
                const results = await Promise.all(
                    targets.map(async (target) => {
                        const r = await this.executePing(target);
                        return { target, ...r };
                    })
                );

                const allFailed = results.every(r => r.loss > 50);
                const someFailed = results.some(r => r.loss > 50);
                const systemRiskState = allFailed ? 'PROTECTION' : 'NORMAL';

                const failedTargets = results.filter(r => r.loss > 50).map(r => r.target);
                const successfulTargets = results.filter(r => r.loss <= 50).map(r => r.target);
                const totalLoss = results.reduce((acc, r) => acc + r.loss, 0);
                const packetLossPct = results.length > 0 ? totalLoss / results.length : 100;

                const alarmMessage = allFailed
                    ? `All network targets (${targets.join(', ')}) failed with packet loss > 50%`
                    : (someFailed ? `Network degraded: some targets failed with packet loss > 50% (${failedTargets.join(', ')})` : null);

                const metadata = {
                    source: 'NETWORK',
                    targets: results,
                    allFailed,
                    someFailed,
                    failedTargets,
                    successfulTargets,
                    packetLossPct
                };

                await prisma.decisionAudit.create({
                    data: {
                        classification: 'NETWORK_HEALTH',
                        systemRiskState,
                        rejectionReason: alarmMessage,
                        metadata
                    }
                });

                if (allFailed) {
                    console.error(`🚨 [InfrastructureWatchdog] HOST NETWORK CRITICAL: ${alarmMessage}`);
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'VPS Network Offline',
                        message: `CRITICAL INFRASTRUCTURE FAILURE: ${alarmMessage}. The host has lost internet connectivity!`,
                        dedupKey: 'host_network_offline'
                    });
                    return {
                        source: 'NETWORK',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: alarmMessage || 'Offline',
                        metadata: this.enrichMetadata('NETWORK', metadata)
                    };
                }

                if (someFailed) {
                    console.warn(`⚠️ [InfrastructureWatchdog] HOST NETWORK WARNING: ${alarmMessage}`);
                    await this.alertingService.sendAlert({
                        level: 'WARNING',
                        title: 'VPS Network Degraded',
                        message: `NETWORK WARNING: ${alarmMessage}`,
                        dedupKey: 'host_network_degraded'
                    });
                    return {
                        source: 'NETWORK',
                        healthy: true,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'WARNING',
                        message: alarmMessage || 'Degraded',
                        metadata: this.enrichMetadata('NETWORK', metadata)
                    };
                }

                console.log('[InfrastructureWatchdog] VPS network connectivity is healthy.');
                return {
                    source: 'NETWORK',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('NETWORK', metadata)
                };
            } catch (error: any) {
                console.error('[InfrastructureWatchdog] Failed host network check:', error?.message || error);
                return {
                    source: 'NETWORK',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: error?.message || String(error),
                    metadata: this.enrichMetadata('NETWORK')
                };
            }
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.NETWORK_TIMEOUT,
                component: 'InfrastructureWatchdogService',
                operation: 'checkHostNetwork',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errMsg = 'Simulated Host Network Outage';
                    await prisma.decisionAudit.create({
                        data: {
                            classification: 'NETWORK_HEALTH',
                            systemRiskState: 'PROTECTION',
                            rejectionReason: errMsg,
                            metadata: { simulated: true }
                        }
                    });
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'VPS Network Offline',
                        message: `CRITICAL INFRASTRUCTURE FAILURE (SIMULATED): ${errMsg}`,
                        dedupKey: 'host_network_offline'
                    });
                    return {
                        source: 'NETWORK',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errMsg,
                        metadata: this.enrichMetadata('NETWORK', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
    }

    async checkExchangeReachability(): Promise<HealthCheckResult> {
        const runCheck = async (): Promise<HealthCheckResult> => {
            const checkStart = Date.now();
            const url = MVP_CONFIG.INFRASTRUCTURE.EXCHANGE_PING_URL;
            let isSuccess = false;
            let statusCode = 0;
            let responseTimeMs = 0;
            let errorMsg: string | null = null;

            try {
                const res = await this.getHttpResponse(url);
                statusCode = res.statusCode;
                responseTimeMs = res.responseTimeMs;
                isSuccess = res.statusCode === 200;
                if (!isSuccess) {
                    errorMsg = `Status code: ${res.statusCode}`;
                }
            } catch (error: any) {
                isSuccess = false;
                errorMsg = error?.message || String(error);
            }

            try {
                if (!isSuccess) {
                    this.exchangeFailures++;
                } else {
                    this.exchangeFailures = 0;
                    this.lastSuccessfulExchangeCheck = Date.now();
                }

                const maxFailures = 3;
                const isAlarm = this.exchangeFailures >= maxFailures;
                const systemRiskState = isAlarm ? 'PROTECTION' : 'NORMAL';

                const downtimeSeconds = isAlarm && this.lastSuccessfulExchangeCheck
                    ? Math.floor((Date.now() - this.lastSuccessfulExchangeCheck) / 1000)
                    : null;

                const alarmMessage = isAlarm
                    ? (downtimeSeconds !== null
                        ? `Exchange API unreachable or non-200 for ${downtimeSeconds}s (consecutive checks failed: ${this.exchangeFailures}, status: ${statusCode}${errorMsg ? `, reason: ${errorMsg}` : ''})`
                        : `Exchange API unreachable or non-200 for ${this.exchangeFailures} consecutive checks (status: ${statusCode}${errorMsg ? `, reason: ${errorMsg}` : ''})`)
                    : null;

                const metadata = {
                    source: 'EXCHANGE_REACHABILITY',
                    url,
                    statusCode,
                    responseTimeMs,
                    consecutiveFailures: this.exchangeFailures,
                    maxFailures,
                    downtimeSeconds,
                    error: errorMsg
                };

                await prisma.decisionAudit.create({
                    data: {
                        classification: 'EXCHANGE_HEALTH',
                        systemRiskState,
                        rejectionReason: alarmMessage,
                        metadata
                    }
                });

                if (!isSuccess) {
                    if (isAlarm) {
                        console.error(`🚨 [InfrastructureWatchdog] EXCHANGE REACHABILITY CRITICAL: ${alarmMessage}`);
                        await this.alertingService.sendAlert({
                            level: 'CRITICAL',
                            title: 'Exchange API Unreachable',
                            message: `CRITICAL CONNECTIVITY FAILURE: Exchange API at ${url} is unreachable: ${alarmMessage || `status ${statusCode}`} (response time: ${responseTimeMs}ms).`,
                            dedupKey: 'exchange_api_unreachable'
                        });
                    }
                    return {
                        source: 'EXCHANGE_REACHABILITY',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: isAlarm ? 'CRITICAL' : 'WARNING',
                        message: isAlarm ? (alarmMessage || 'Unreachable') : 'Exchange reachability warning',
                        metadata: this.enrichMetadata('EXCHANGE_REACHABILITY', metadata)
                    };
                }

                console.log(`[InfrastructureWatchdog] Exchange reachability is healthy (${responseTimeMs}ms).`);
                return {
                    source: 'EXCHANGE_REACHABILITY',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('EXCHANGE_REACHABILITY', metadata)
                };
            } catch (innerError: any) {
                console.error('[InfrastructureWatchdog] Failed exchange reachability check audit logging:', innerError?.message || innerError);
                return {
                    source: 'EXCHANGE_REACHABILITY',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: innerError?.message || String(innerError),
                    metadata: this.enrichMetadata('EXCHANGE_REACHABILITY')
                };
            }
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.NETWORK_TIMEOUT,
                component: 'InfrastructureWatchdogService',
                operation: 'checkExchangeReachability',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errMsg = 'Simulated Exchange Reachability Outage';
                    await prisma.decisionAudit.create({
                        data: {
                            classification: 'EXCHANGE_HEALTH',
                            systemRiskState: 'PROTECTION',
                            rejectionReason: errMsg,
                            metadata: { simulated: true }
                        }
                    });
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'Exchange API Unreachable',
                        message: `CRITICAL CONNECTIVITY FAILURE (SIMULATED): ${errMsg}`,
                        dedupKey: 'exchange_api_unreachable'
                    });
                    return {
                        source: 'EXCHANGE_REACHABILITY',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errMsg,
                        metadata: this.enrichMetadata('EXCHANGE_REACHABILITY', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
    }

    protected resolveDnsPromise(host: string): Promise<string[]> {
        return new Promise((resolve) => {
            dns.resolve(host, (err, addresses) => {
                if (err || !addresses) resolve([]);
                else resolve(addresses);
            });
        });
    }

    async checkDnsResolution(): Promise<HealthCheckResult> {
        const runCheck = async (): Promise<HealthCheckResult> => {
            const checkStart = Date.now();
            try {
                const host = MVP_CONFIG.INFRASTRUCTURE.DNS_RESOLVE_HOST;
                const addresses = await this.resolveDnsPromise(host);

                const isSuccess = addresses.length > 0;
                const systemRiskState = isSuccess ? 'NORMAL' : 'PROTECTION';
                const alarmMessage = isSuccess ? null : `Failed to resolve host ${host}`;

                const metadata = {
                    source: 'DNS',
                    host,
                    resolvedAddresses: addresses,
                    resolvedCount: addresses.length
                };

                await prisma.decisionAudit.create({
                    data: {
                        classification: 'DNS_HEALTH',
                        systemRiskState,
                        rejectionReason: alarmMessage,
                        metadata
                    }
                });

                if (!isSuccess) {
                    console.error(`🚨 [InfrastructureWatchdog] DNS RESOLUTION CRITICAL: ${alarmMessage}`);
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'DNS Resolution Failed',
                        message: `CRITICAL RESOLUTION FAILURE: Host ${host} could not be resolved by the local DNS. DNS configurations are broken!`,
                        dedupKey: 'dns_resolution_failed'
                    });
                    return {
                        source: 'DNS',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: alarmMessage || 'Resolution Failed',
                        metadata: this.enrichMetadata('DNS', metadata)
                    };
                }

                console.log(`[InfrastructureWatchdog] DNS resolution is healthy (resolved ${host} to ${addresses[0]}).`);
                return {
                    source: 'DNS',
                    healthy: true,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    metadata: this.enrichMetadata('DNS', metadata)
                };
            } catch (error: any) {
                console.error('[InfrastructureWatchdog] Failed DNS resolution check:', error?.message || error);
                return {
                    source: 'DNS',
                    healthy: false,
                    checkedAt: new Date(),
                    checkDurationMs: Date.now() - checkStart,
                    severity: 'CRITICAL',
                    message: error?.message || String(error),
                    metadata: this.enrichMetadata('DNS')
                };
            }
        };

        if (this.failures) {
            return this.failures.intercept<HealthCheckResult>({
                type: FailureType.DNS_FAILURE,
                component: 'InfrastructureWatchdogService',
                operation: 'checkDnsResolution',
                real: () => runCheck(),
                simulate: async () => {
                    const checkStart = Date.now();
                    const errMsg = 'Simulated DNS resolution failure';
                    await prisma.decisionAudit.create({
                        data: {
                            classification: 'DNS_HEALTH',
                            systemRiskState: 'PROTECTION',
                            rejectionReason: errMsg,
                            metadata: { simulated: true }
                        }
                    });
                    await this.alertingService.sendAlert({
                        level: 'CRITICAL',
                        title: 'DNS Resolution Failed',
                        message: `CRITICAL RESOLUTION FAILURE (SIMULATED): ${errMsg}`,
                        dedupKey: 'dns_resolution_failed'
                    });
                    return {
                        source: 'DNS',
                        healthy: false,
                        checkedAt: new Date(),
                        checkDurationMs: Date.now() - checkStart,
                        severity: 'CRITICAL',
                        message: errMsg,
                        metadata: this.enrichMetadata('DNS', { simulated: true })
                    };
                }
            });
        }
        return runCheck();
    }

    async runAllInfrastructureChecks(): Promise<HealthCheckResult[]> {
        return await Promise.all([
            this.checkVMHealth(),
            this.checkDockerContainerHealth(),
            this.checkFreqtradeAPI(),
            this.checkHostNetwork(),
            this.checkExchangeReachability(),
            this.checkDnsResolution()
        ]);
    }

    getInfrastructureSubtree(results: HealthCheckResult[]): HealthNode {
        const checkedAt = new Date();
        const sourceMap: Record<string, { id: string, name: string }> = {
            'VM': { id: 'infra.vm_health', name: 'VM Health' },
            'DOCKER': { id: 'infra.docker_health', name: 'Docker Health' },
            'FREQTRADE': { id: 'infra.freqtrade_api', name: 'Freqtrade API' },
            'NETWORK': { id: 'infra.host_network', name: 'Host Network' },
            'EXCHANGE_REACHABILITY': { id: 'infra.exchange_reachability', name: 'Exchange Reachability' },
            'DNS': { id: 'infra.dns_resolution', name: 'DNS Resolution' }
        };

        const children: HealthNode[] = results.map(r => {
            const info = sourceMap[r.source] || { id: `infra.${r.source.toLowerCase()}`, name: r.source };
            const status: HealthStatus = r.healthy 
                ? 'HEALTHY' 
                : (r.severity === 'WARNING' ? 'WARNING' : 'CRITICAL');
            return {
                id: info.id,
                name: info.name,
                status,
                message: r.message,
                checkedAt: r.checkedAt,
                metrics: r.metadata
            };
        });

        // Determine parent status: CRITICAL > WARNING > HEALTHY
        let parentStatus: HealthStatus = 'HEALTHY';
        if (children.some(c => c.status === 'CRITICAL')) {
            parentStatus = 'CRITICAL';
        } else if (children.some(c => c.status === 'WARNING')) {
            parentStatus = 'WARNING';
        }

        return {
            id: 'infrastructure',
            name: 'Infrastructure',
            status: parentStatus,
            checkedAt,
            children
        };
    }
}
