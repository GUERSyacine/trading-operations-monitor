import { prisma } from '../../../prisma';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Monitoring Script 1: Inactivity Legitimacy Scanner
 * Purpose: Prove that "no trade" always has a reason.
 */
async function monitorInactivity() {
    console.log('--- 🛡️ TG6: Inactivity Legitimacy Audit ---');
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    try {
        const decisions = await prisma.decisionAudit.findMany({
            where: {
                classification: 'REJECTION',
                createdAt: {
                    gte: last24h
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        if (decisions.length === 0) {
            console.log('No rejections in the last 24h. System is either trading or no candidates identified.');
            return;
        }

        const totalRejections = decisions.length;
        console.log(`Total rejections in last 24h: ${totalRejections}`);

        // Group by reason, track risk state and HTF distribution per reason
        const stats: Record<string, { count: number; riskStates: Record<string, number>; htfStates: { tradable: number; notTradable: number } }> = {};
        decisions.forEach((d: any) => {
            const reason = d.rejectionReason || 'UNKNOWN_REASON';
            if (!stats[reason]) stats[reason] = { count: 0, riskStates: {}, htfStates: { tradable: 0, notTradable: 0 } };
            stats[reason].count++;
            // Aggregate risk state distribution
            const riskState = d.systemRiskState || 'UNKNOWN';
            stats[reason].riskStates[riskState] = (stats[reason].riskStates[riskState] || 0) + 1;
            // Aggregate HTF tradability distribution
            if ((d.htf as any)?.isTradable === true) stats[reason].htfStates.tradable++;
            else if ((d.htf as any)?.isTradable === false) stats[reason].htfStates.notTradable++;
        });

        // Sort by count descending so most impactful reasons appear first
        const sortedRows = Object.entries(stats)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([reason, { count, riskStates, htfStates }]) => {
                const percentage = ((count / totalRejections) * 100).toFixed(1) + '%';
                const riskDistribution = Object.entries(riskStates)
                    .map(([state, n]) => `${state}: ${n}`)
                    .join(', ');
                const htfDistribution = `tradable: ${htfStates.tradable}, notTradable: ${htfStates.notTradable}`;
                return {
                    Reason: reason,
                    Count: count,
                    Percentage: percentage,
                    Risk_State_Distribution: riskDistribution,
                    HTF_Tradable_Distribution: htfDistribution
                };
            });

        console.table(sortedRows);

        // 🚨 Alert for vague reasons
        const vagueDecisions = decisions.filter((d: any) => !d.rejectionReason || d.rejectionReason === 'UNKNOWN_REASON');
        if (vagueDecisions.length > 0) {
            console.warn(`🚨 WARNING: Detected ${vagueDecisions.length} decisions with missing/vague reasons.`);
        }

        console.log(`Scan Complete. Institutional Integrity: ${vagueDecisions.length === 0 ? '✅ SOLID' : '⚠️ AT RISK'}`);
    } catch (error: any) {
        console.error('Failed to fetch audit logs from Neon/Prisma:', error?.message || error);
    }
}

monitorInactivity();
