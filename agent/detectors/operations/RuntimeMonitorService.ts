import { prisma } from '../../../prisma';
import { AlertingService } from '../../notification/AlertingService';

export interface TradeMetrics {
    pnl: number;
    executedAt: Date;
    fillRate: number; // 0.0 to 1.0 (execution quality)
    latencyMs: number; // order creation to fill latency
}

export class RuntimeMonitorService {
    constructor(
        protected alertingService: AlertingService
    ) {}

    /**
     * Fetch trade metrics logs. Isolated for database-free unit testing and mocking.
     */
    protected async fetchTradeMetrics(strategyId: string, windowMs: number): Promise<TradeMetrics[]> {
        try {
            const cutoff = new Date(Date.now() - windowMs);
            const audits = await prisma.decisionAudit.findMany({
                where: {
                    classification: {
                        in: ['ORDER', 'ORDER_FILLED']
                    },
                    createdAt: { gte: cutoff }
                },
                orderBy: { createdAt: 'desc' }
            });

            // MVP assumption:
            // Freqtrade websocket/polling does not expose strategyId.
            // Since MVP supports only ONE running strategy, events without strategyId belong to this strategy.
            // Remove this fallback when multi-strategy support is introduced.
            const filteredAudits = audits.filter(a => {
                const meta = a.metadata as any;
                const stratId = meta?.strategyId || meta?.lifecycleEvent?.strategyId;
                return stratId === undefined || stratId === null || stratId === strategyId;
            });

            return filteredAudits.map(a => {
                const meta = a.metadata as any;
                return {
                    pnl: meta?.outcome?.pnl ?? 0.0,
                    executedAt: a.createdAt,
                    fillRate: meta?.outcome?.fillRate ?? 1.0,
                    latencyMs: meta?.outcome?.latencyMs ?? 150
                };
            });
        } catch (error: any) {
            console.error(`[RuntimeMonitor] Failed to fetch trade metrics for ${strategyId}:`, error?.message || error);
            return [];
        }
    }

    /**
     * 1. Check Trade Frequency Collapse
     * Trigger alert if the strategy hasn't traded in the given timeframe (e.g. 24 hours).
     */
    async checkTradeFrequency(strategyId: string, maxSilenceMs: number = 24 * 60 * 60 * 1000): Promise<boolean> {
        const trades = await this.fetchTradeMetrics(strategyId, maxSilenceMs);

        if (trades.length === 0) {
            const hours = (maxSilenceMs / (60 * 60 * 1000)).toFixed(0);
            console.warn(`⚠️ [RuntimeMonitor] TRADE FREQUENCY COLLAPSE: Strategy ${strategyId} has 0 trades in the last ${hours} hours.`);
            
            await this.alertingService.sendAlert({
                level: 'WARNING',
                title: `Strategy Silence Detected`,
                message: `WARNING: Strategy ${strategyId} trade count collapsed to 0 over the last ${hours} hours. Bot is active but idle!`,
                entityId: strategyId,
                dedupKey: `${strategyId}:silence_warning`
            });
            return false;
        }
        return true;
    }

    /**
     * 2. Check Win Rate Collapse
     * Trigger alert and demote strategy if rolling win rate is below a safe threshold.
     */
    async checkWinRate(strategyId: string, minWinRate: number = 0.30, rollingCount: number = 10): Promise<boolean> {
        // Look back up to 7 days for rolling trade records
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const trades = await this.fetchTradeMetrics(strategyId, sevenDaysMs);

        if (trades.length < rollingCount) {
            // Not enough trades yet to reliably calculate win rate
            return true;
        }

        const recentTrades = trades.slice(0, rollingCount);
        const wins = recentTrades.filter(t => t.pnl > 0).length;
        const winRate = wins / rollingCount;

        if (winRate < minWinRate) {
            const reason = `Rolling Win Rate collapsed to ${(winRate * 100).toFixed(0)}% (Wins: ${wins}/${rollingCount}), below threshold of ${(minWinRate * 100).toFixed(0)}%`;
            console.error(`🚨 [RuntimeMonitor] WIN RATE COLLAPSED: Strategy ${strategyId} - ${reason}`);

            // 2. Dispatch Live Critical Alert
            await this.alertingService.sendAlert({
                level: 'CRITICAL',
                title: `Strategy Win Rate COLLAPSE`,
                message: `CRITICAL PERFORMANCE FAILURE: Strategy ${strategyId} win rate collapsed to ${(winRate * 100).toFixed(0)}% (Wins: ${wins}/${rollingCount}). Strategy demoted to PROBATION (allocations capped at 25% size).`,
                entityId: strategyId,
                dedupKey: `${strategyId}:winrate_collapse_critical`
            });
            return false;
        }
        return true;
    }

    /**
     * 3. Check Fill Quality / Slippage
     * Trigger warning alert if the executed fill rate falls below safety threshold.
     */
    async checkFillRate(strategyId: string, minFillRateRatio: number = 0.85, rollingCount: number = 5): Promise<boolean> {
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        const trades = await this.fetchTradeMetrics(strategyId, threeDaysMs);

        if (trades.length < rollingCount) return true;

        const recentTrades = trades.slice(0, rollingCount);
        const averageFill = recentTrades.reduce((sum, t) => sum + t.fillRate, 0) / rollingCount;

        if (averageFill < minFillRateRatio) {
            console.warn(`⚠️ [RuntimeMonitor] FILL QUALITY DEGRADATION: Strategy ${strategyId} average fill quality is ${(averageFill * 100).toFixed(0)}%`);

            await this.alertingService.sendAlert({
                level: 'WARNING',
                title: `Fill Quality Degradation`,
                message: `WARNING: Strategy ${strategyId} fill quality has collapsed to ${(averageFill * 100).toFixed(0)}% over the last ${rollingCount} trades. Market slippage is extremely high!`,
                entityId: strategyId,
                dedupKey: `${strategyId}:fill_degradation_warning`
            });
            return false;
        }
        return true;
    }

    /**
     * 4. Check Latency Spikes
     * Trigger warning alert if order execution latency is too high.
     */
    async checkLatency(strategyId: string, maxLatencyMs: number = 1000, rollingCount: number = 5): Promise<boolean> {
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        const trades = await this.fetchTradeMetrics(strategyId, threeDaysMs);

        if (trades.length < rollingCount) return true;

        const recentTrades = trades.slice(0, rollingCount);
        const averageLatency = recentTrades.reduce((sum, t) => sum + t.latencyMs, 0) / rollingCount;

        if (averageLatency > maxLatencyMs) {
            console.warn(`⚠️ [RuntimeMonitor] LATENCY SPIKE: Strategy ${strategyId} average order latency is ${averageLatency.toFixed(0)}ms`);

            await this.alertingService.sendAlert({
                level: 'WARNING',
                title: `Order Latency Spike`,
                message: `WARNING: Strategy ${strategyId} average order latency spiked to ${averageLatency.toFixed(0)}ms (threshold: ${maxLatencyMs}ms). Execution paths are slow!`,
                entityId: strategyId,
                dedupKey: `${strategyId}:latency_spike_warning`
            });
            return false;
        }
        return true;
    }
}
