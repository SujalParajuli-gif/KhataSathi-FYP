// src/modules/audit/service.ts — Audit log business logic
import prisma from "../../db/prisma";

interface AuditFilters {
    from?: string;
    to?: string;
    action?: string;
    actorId?: string;
    entityType?: string;
    page?: number;
    pageSize?: number;
}

export async function listAuditLogs(filters: AuditFilters) {
    const { from, to, action, actorId, entityType, page = 1, pageSize = 50 } = filters;

    const where: any = {};
    if (action) where.action = { contains: action };
    if (actorId) where.actorId = actorId;
    if (entityType) where.entityType = entityType;
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z");
    }

    const skip = (page - 1) * pageSize;

    const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            include: { actor: { select: { id: true, name: true, email: true } } },
            orderBy: { createdAt: "desc" },
            skip,
            take: pageSize,
        }),
        prisma.auditLog.count({ where }),
    ]);

    return { logs, total, page, pageSize };
}
