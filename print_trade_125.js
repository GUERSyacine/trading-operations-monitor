const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { SOURCE_CAPABILITIES } = require('./dist/agent/detectors/types');

const canonicalOrder = [
    'SIGNAL',
    'ORDER_CREATED',
    'ORDER_SUBMITTED',
    'ORDER_ACKNOWLEDGED',
    'ORDER_OPEN',
    'ORDER_PARTIALLY_FILLED',
    'ORDER_FILLED'
];

function getEventStateValue(classification) {
    const upper = classification.toUpperCase();
    if (upper === 'SIGNAL') return 0;
    if (upper === 'ORDER_CREATED') return 1;
    if (upper === 'ORDER_SUBMITTED' || upper === 'ORDER_SENT') return 2;
    if (upper === 'ORDER_ACKNOWLEDGED' || upper === 'ORDER_ACK') return 3;
    if (upper === 'ORDER_OPEN') return 4;
    if (upper === 'ORDER_PARTIALLY_FILLED') return 5;
    if (['ORDER_FILLED', 'ORDER_CANCELLED', 'EXCHANGE_REJECTED', 'ORDER_FAILED', 'ORDER'].includes(upper)) return 6;
    return -1;
}

function validateOrderTimeline(timeline, isStepSupportedBySource) {
    const events = timeline.events;
    let isInvalid = false;
    let hasSkipped = false;
    let reachedTerminal = false;
    let duplicatesCount = 0;
    let lastStateValue = -1;
    let lastClassification = undefined;
    let violationType = undefined;
    const terminalStatesSeen = new Set();

    for (let i = 0; i < events.length; i++) {
        const audit = events[i];
        const classification = audit.classification.toUpperCase();
        const stateVal = getEventStateValue(classification);

        if (stateVal === -1) {
            continue;
        }

        // Duplicate event detection
        if (lastClassification && classification === lastClassification) {
            duplicatesCount++;
            continue;
        }

        if (lastStateValue !== -1) {
            if (lastStateValue === 6 && stateVal < 6) {
                isInvalid = true;
                violationType = 'INVALID_TRANSITION';
            }
            if (stateVal < lastStateValue) {
                isInvalid = true;
                violationType = 'BACKWARD_TRANSITION';
            }
            if (stateVal > lastStateValue + 1) {
                for (let stepIdx = lastStateValue + 1; stepIdx < stateVal; stepIdx++) {
                    const stepName = canonicalOrder[stepIdx];
                    if (isStepSupportedBySource(stepName)) {
                        hasSkipped = true;
                        break;
                    }
                }
            }
        } else {
            if (stateVal > 1) {
                for (let stepIdx = 1; stepIdx < stateVal; stepIdx++) {
                    const stepName = canonicalOrder[stepIdx];
                    if (isStepSupportedBySource(stepName)) {
                        hasSkipped = true;
                        break;
                    }
                }
            }
        }

        if (stateVal === 6) {
            reachedTerminal = true;
            terminalStatesSeen.add(classification);
            if (terminalStatesSeen.size > 1) {
                isInvalid = true;
                violationType = 'TERMINAL_MUTATION';
            }
        }

        lastStateValue = stateVal;
        lastClassification = classification;
    }

    return {
        valid: !isInvalid,
        skippedStages: hasSkipped,
        violation: violationType,
        terminalState: reachedTerminal,
        duplicates: duplicatesCount
    };
}

async function main() {
    const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const audits = await prisma.decisionAudit.findMany({
        where: {
            createdAt: { gte: cutoff }
        },
        orderBy: { createdAt: 'asc' }
    });

    // Run correlation logic to build tradeToOrdersMap
    const uniqueTradeIds = new Set();
    const orderToTradeMap = new Map();

    for (const audit of audits) {
        const meta = audit.metadata || {};
        const lifecycle = meta.lifecycleEvent || {};
        const rawTradeId = meta.tradeId ?? lifecycle.tradeId;
        const rawOrderId = meta.orderId ?? lifecycle.orderId;

        const tradeId = rawTradeId !== undefined && rawTradeId !== null ? String(rawTradeId) : undefined;
        const orderId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : undefined;

        if (tradeId) {
            uniqueTradeIds.add(tradeId);
        }
        if (orderId && tradeId) {
            orderToTradeMap.set(orderId, tradeId);
        }
    }

    const tradeToOrdersMap = new Map();
    for (const [orderId, tradeId] of orderToTradeMap.entries()) {
        if (!tradeToOrdersMap.has(tradeId)) {
            tradeToOrdersMap.set(tradeId, new Set());
        }
        tradeToOrdersMap.get(tradeId).add(orderId);
    }

    for (const tradeId of uniqueTradeIds) {
        const associatedOrders = tradeToOrdersMap.get(tradeId) || new Set();
        
        const tradeTimeline = audits.filter(audit => {
            const meta = audit.metadata || {};
            const lifecycle = meta.lifecycleEvent || {};
            const rawTradeId = meta.tradeId ?? lifecycle.tradeId;
            const rawOrderId = meta.orderId ?? lifecycle.orderId;
            const tId = rawTradeId !== undefined && rawTradeId !== null ? String(rawTradeId) : undefined;
            const oId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : undefined;
            
            return tId === tradeId || (oId !== undefined && associatedOrders.has(oId));
        });

        tradeTimeline.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        // Group by orderId using chronological proximity correlation
        const resolvedOrderIds = new Map(); // audit.id -> resolved orderId
        const explicitOrderIds = [];

        for (const audit of tradeTimeline) {
            const classification = audit.classification.toUpperCase();
            const stateVal = getEventStateValue(classification);
            if (stateVal <= 0) continue;

            const meta = audit.metadata || {};
            const lifecycle = meta.lifecycleEvent || {};
            const rawOrderId = meta.orderId ?? lifecycle.orderId;
            if (rawOrderId !== undefined && rawOrderId !== null) {
                const oId = String(rawOrderId);
                explicitOrderIds.push({
                    id: audit.id,
                    orderId: oId,
                    time: audit.createdAt.getTime(),
                    side: meta.side ?? lifecycle.side
                });
                resolvedOrderIds.set(audit.id, oId);
            }
        }

        for (const audit of tradeTimeline) {
            const classification = audit.classification.toUpperCase();
            const stateVal = getEventStateValue(classification);
            if (stateVal <= 0) continue;
            if (resolvedOrderIds.has(audit.id)) continue;

            const meta = audit.metadata || {};
            const lifecycle = meta.lifecycleEvent || {};
            const auditTime = audit.createdAt.getTime();
            const auditSide = meta.side ?? lifecycle.side;

            let bestOrderId = undefined;
            let bestDiff = Infinity;

            for (const exp of explicitOrderIds) {
                if (exp.time >= auditTime) {
                    const diff = exp.time - auditTime;
                    if (diff < bestDiff) {
                        if (!auditSide || !exp.side || auditSide === exp.side) {
                            bestDiff = diff;
                            bestOrderId = exp.orderId;
                        }
                    }
                }
            }

            if (!bestOrderId) {
                bestDiff = Infinity;
                for (const exp of explicitOrderIds) {
                    if (exp.time < auditTime) {
                        const diff = auditTime - exp.time;
                        if (diff < bestDiff) {
                            if (!auditSide || !exp.side || auditSide === exp.side) {
                                bestDiff = diff;
                                bestOrderId = exp.orderId;
                            }
                        }
                    }
                }
            }

            const resolvedId = bestOrderId || 'default_order';
            resolvedOrderIds.set(audit.id, resolvedId);
        }

        const auditsWithOrderId = new Map();
        for (const audit of tradeTimeline) {
            const classification = audit.classification.toUpperCase();
            const stateVal = getEventStateValue(classification);
            if (stateVal <= 0) continue;

            const resolvedId = resolvedOrderIds.get(audit.id) || 'default_order';
            let list = auditsWithOrderId.get(resolvedId);
            if (!list) {
                list = [];
                auditsWithOrderId.set(resolvedId, list);
            }
            list.push(audit);
        }

        let tradeSource = 'FREQTRADE';
        for (const audit of tradeTimeline) {
            const meta = audit.metadata || {};
            const s = meta.lifecycleEvent?.source || meta.source;
            if (s) {
                tradeSource = String(s).toUpperCase();
                break;
            }
        }

        const caps = SOURCE_CAPABILITIES[tradeSource] || SOURCE_CAPABILITIES.FREQTRADE;
        const allSupportedEvents = [...caps.requiredEvents, ...caps.optionalEvents];
        const isStepSupportedBySource = (step) => {
            if (step === 'ORDER_FILLED') {
                return allSupportedEvents.some(e =>
                    ['ORDER_FILLED', 'ORDER_CANCELLED', 'EXCHANGE_REJECTED', 'ORDER_FAILED'].includes(e.toUpperCase())
                );
            }
            return allSupportedEvents.some(e => e.toUpperCase() === step);
        };

        const orderTimelines = [];
        for (const [oId, list] of auditsWithOrderId.entries()) {
            orderTimelines.push({
                orderId: oId,
                tradeId: tradeId,
                source: tradeSource,
                events: list
            });
        }

        console.log(`\n================ TRADE ${tradeId} (Source: ${tradeSource}) ================`);
        console.log(`Order Timelines count: ${orderTimelines.length}`);

        for (const timeline of orderTimelines) {
            const result = validateOrderTimeline(timeline, isStepSupportedBySource);
            console.log(`- Order: ${timeline.orderId}`);
            console.log(`  Events:`, timeline.events.map(e => e.classification));
            console.log(`  Result:`, result);
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
