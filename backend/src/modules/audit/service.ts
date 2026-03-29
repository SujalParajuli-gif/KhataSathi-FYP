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

interface LoginAttemptFilters {
    email?: string;
    success?: boolean;
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

export async function listLoginAttempts(filters: LoginAttemptFilters) {
    const { email, success, page = 1, pageSize = 20 } = filters;

    const where: any = {};
    if (email) {
        where.email = { contains: email };
    }
    if (typeof success === "boolean") {
        where.success = success;
    }

    const skip = (page - 1) * pageSize;

    const [attempts, total] = await Promise.all([
        prisma.loginAttempt.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip,
            take: pageSize,
        }),
        prisma.loginAttempt.count({ where }),
    ]);

    return { attempts, total, page, pageSize };
}
