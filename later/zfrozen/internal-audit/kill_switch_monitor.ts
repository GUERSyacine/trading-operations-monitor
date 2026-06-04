import { prisma } from '../prisma';
import * as dotenv from 'dotenv';

dotenv.config();

export enum SystemRiskState {
    NORMAL = 'NORMAL',
    PROTECTION = 'PROTECTION'
}

/**
 * Monitoring Script 3: Kill-Switch Sanity Monitor
 * Purpose: Validate fail-closed behavior under stress.
 */
async function monitorKillSwitch() {
    console.log('--- 🛡️ TG6: Kill-Switch & System Risk Monitor ---');

    // 1. Fetch recent decision audits (last 10 minutes to verify safety)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    
    try {
        const audit = await prisma.decisionAudit.findMany({
            where: {
                createdAt: {
                    gte: tenMinutesAgo
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        if (audit.length === 0) {
            console.log('No recent decisions logged in the last 10 minutes. System idle.');
            console.log('Scan Complete. Fail-Closed Integrity: ✅ VERIFIED (Idle)');
            return;
        }

        const protectionEvents = audit.filter(a => a.systemRiskState === SystemRiskState.PROTECTION);
        
        // Audit both Buy & Sell sides case-insensitively
        const entriesInProtection = protectionEvents.filter(a => {
            const isOrder = a.classification === 'ORDER';
            const side = (a.metadata as any)?.intent?.side?.toLowerCase();
            return isOrder && (side === 'buy' || side === 'sell');
        });

        if (entriesInProtection.length > 0) {
            console.error(`🚨 CRITICAL FAIL-SAFE BREACH: Detected ${entriesInProtection.length} order execution attempt(s) during PROTECTION risk state!`);
            console.table(entriesInProtection.map(e => ({
                Time: e.createdAt,
                Side: (e.metadata as any)?.intent?.side,
                Reason: e.rejectionReason || 'NO_REASON_SPECIFIED'
            })));
            console.error('\nScan Complete. Fail-Closed Integrity: 🚨 CRITICAL BREACH DETECTED');
            process.exit(1);
        }

        if (protectionEvents.length > 0) {
            console.log(`🛡️  System is correctly enforcing fail-closed PROTECTION. Checked ${protectionEvents.length} rejections.`);
        } else {
            console.log(`System operating in normal risk states. Checked ${audit.length} total events.`);
        }

        console.log('\nScan Complete. Fail-Closed Integrity: ✅ VERIFIED');
    } catch (error: any) {
        console.error('Failed to fetch audit records from Prisma:', error?.message || error);
        process.exit(1);
    }
}

monitorKillSwitch();

