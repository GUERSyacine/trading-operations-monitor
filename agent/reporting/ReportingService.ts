import { prisma } from '../../prisma';

export class ReportingService {
    constructor() {}

    /**
     * Map raw incident reason to a clean category string.
     */
    /**
     * Map raw incident reason to a clean category string.
     */
    private getIncidentCategory(incident: { reason: string; source: string }): { category: string; type: 'operations' | 'execution' } {
        const source = incident.source.toUpperCase();

        switch (source) {
            // Execution Issues
            case 'FLASH_CRASH':
                return { category: 'Flash Crash Volatility Shock', type: 'execution' };
            case 'SPREAD':
                return { category: 'Spread Anomaly', type: 'execution' };
            case 'SLIPPAGE':
                return { category: 'Slippage Anomaly', type: 'execution' };

            // Operations Issues
            case 'HEARTBEAT':
                return { category: 'Heartbeat Lost', type: 'operations' };
            case 'BROKER_DISCONNECT':
                return { category: 'Broker Disconnect', type: 'operations' };
            case 'BROKER_CONNECTION_STALE':
                return { category: 'Broker Connection Stale', type: 'operations' };
            case 'MARKET_DATA_FEED_STALE':
                return { category: 'Market Data Feed Stale', type: 'operations' };
            case 'ORDER_PIPELINE_BLOCKED':
                return { category: 'Order Pipeline Blocked', type: 'operations' };
            case 'EXCHANGE_ACK_FAILURE':
                return { category: 'Exchange Ack Failure', type: 'operations' };
            case 'ORDER_LATENCY_SPIKE':
                return { category: 'Order Latency Spike', type: 'operations' };

            default:
                // Log unrecognised source so it never silently degrades report quality
                console.warn(`[ReportingService] Unknown incident source: "${incident.source}". Falling back to Generic Anomaly. Add it to getIncidentCategory().`);
                const lower = incident.reason.toLowerCase();
                return {
                    category: 'Generic Anomaly',
                    type: lower.includes('execution') || lower.includes('fill') || lower.includes('price') ? 'execution' : 'operations'
                };
        }
    }

    /**
     * Generate daily summary report for a given date.
     */
    async generateDailyReport(date: Date): Promise<string> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const startMs = startOfDay.getTime();
        const endMs = endOfDay.getTime();

        const incidents = await prisma.incident.findMany({
            where: {
                detectedAt: { lte: BigInt(endMs) },
                OR: [
                    { resolvedAt: null },
                    { resolvedAt: { gte: BigInt(startMs) } }
                ]
            }
        });

        const opsCounts: Record<string, number> = {};
        const execCounts: Record<string, number> = {};
        let systemHealth: 'NORMAL' | 'DEGRADED' | 'HALTED' = 'NORMAL';

        for (const incident of incidents) {
            // Determine active/global health status
            const isUnresolved = incident.resolvedAt === null || Number(incident.resolvedAt) >= endMs;
            if (isUnresolved) {
                const level = incident.level.toUpperCase();
                if (level === 'CRITICAL' || level === 'HIGH') {
                    systemHealth = 'HALTED';
                } else if ((level === 'MEDIUM' || level === 'LOW') && systemHealth !== 'HALTED') {
                    systemHealth = 'DEGRADED';
                }
            }

            const { category, type } = this.getIncidentCategory(incident);
            if (type === 'operations') {
                opsCounts[category] = (opsCounts[category] || 0) + 1;
            } else {
                execCounts[category] = (execCounts[category] || 0) + 1;
            }
        }

        const dateStr = startOfDay.toISOString().split('T')[0];

        let report = `Daily Report\nDate: ${dateStr}\n\n`;

        report += `Operations Incidents:\n`;
        const opsSorted = Object.entries(opsCounts).sort((a, b) => b[1] - a[1]);
        if (opsSorted.length === 0) {
            report += `- None\n`;
        } else {
            for (const [key, count] of opsSorted) {
                report += `- ${key}: ${count}\n`;
            }
        }

        report += `\nExecution Incidents:\n`;
        const execSorted = Object.entries(execCounts).sort((a, b) => b[1] - a[1]);
        if (execSorted.length === 0) {
            report += `- None\n`;
        } else {
            for (const [key, count] of execSorted) {
                report += `- ${key}: ${count}\n`;
            }
        }

        report += `\nCurrent Health:\n${systemHealth}\n`;

        return report;
    }

    /**
     * Calculate numeric health score (0-100) based on unresolved incidents.
     */
    async getSystemHealthScore(lookbackMs: number = 24 * 60 * 60 * 1000): Promise<{
        score: number;
        level: string;
        activeIncidentsCount: number;
    }> {
        const cutoff = Date.now() - lookbackMs;
        const activeIncidents = await prisma.incident.findMany({
            where: {
                detectedAt: { gte: BigInt(cutoff) },
                resolvedAt: null
            }
        });

        let score = 100;
        for (const incident of activeIncidents) {
            const level = incident.level.toUpperCase();
            if (level === 'CRITICAL' || level === 'HIGH') {
                score -= 50;
            } else if (level === 'MEDIUM' || level === 'LOW') {
                score -= 20;
            }
        }

        score = Math.max(0, Math.min(100, score));

        let level: string;
        if (score >= 95) {
            level = 'EXCELLENT';
        } else if (score >= 80) {
            level = 'GOOD';
        } else if (score >= 60) {
            level = 'DEGRADED';
        } else {
            level = 'HALTED';
        }

        return {
            score,
            level,
            activeIncidentsCount: activeIncidents.length
        };
    }
}
