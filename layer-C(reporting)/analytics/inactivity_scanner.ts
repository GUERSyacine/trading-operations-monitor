import { prisma } from '../../prisma';
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

        // Group by reason
        const stats: Record<string, { count: number; lastRisk: string; lastHTF: any }> = {};
        decisions.forEach((d: any) => {
            const reason = d.rejectionReason || 'UNKNOWN_REASON';
            if (!stats[reason]) stats[reason] = { count: 0, lastRisk: '', lastHTF: null };
            stats[reason].count++;
            stats[reason].lastRisk = d.systemRiskState;
            stats[reason].lastHTF = d.htf;
        });

        console.table(Object.keys(stats).map(reason => ({
            Reason: reason,
            Count: stats[reason].count,
            Last_Risk: stats[reason].lastRisk,
            HTF_Tradable: (stats[reason].lastHTF as any)?.isTradable
        })));

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
