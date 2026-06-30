const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const audits = await prisma.decisionAudit.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50
    });

    console.log('--- RECENT AUDITS ---');
    for (const audit of audits) {
        console.log({
            id: audit.id,
            classification: audit.classification,
            createdAt: audit.createdAt,
            metadata: audit.metadata
        });
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
