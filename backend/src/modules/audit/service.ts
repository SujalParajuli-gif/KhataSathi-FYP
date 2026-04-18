import prisma from "../../db/prisma";

// defining the shape of filters for listing audit logs
interface AuditFilters {
    from?: string;
    to?: string;
    action?: string; // e.g., INVOICE_FINALIZED, PRODUCT_RESTOCKED
    actorId?: string; // filter by who performed the action
    entityType?: string; // e.g., Invoice, Product, Brand
    page?: number;
    pageSize?: number;
}

// defining the shape of filters for listing login attempts
interface LoginAttemptFilters {
    email?: string;
    success?: boolean; // true = successful logins, false = failed attempts
    page?: number;
    pageSize?: number;
}

// listing audit log entries with optional filters for date range, action, actor, and entity type
// we use this so the admin can review all actions performed in the system
export async function listAuditLogs(filters: AuditFilters) {
    const { from, to, action, actorId, entityType, page = 1, pageSize = 50 } = filters;

    // building the where clause dynamically based on which filters are provided
    const where: any = {};
    if (action) where.action = { contains: action }; // partial match on action name
    if (actorId) where.actorId = actorId;
    if (entityType) where.entityType = entityType;
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from); // start of the date range
        if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z"); // end of day for the to date
    }

    const skip = (page - 1) * pageSize; // calculating pagination offset

    // running the query and count in parallel for better performance
    const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            include: { actor: { select: { id: true, name: true, email: true } } }, // including who performed the action
            orderBy: { createdAt: "desc" }, // newest entries first
            skip,
            take: pageSize,
        }),
        prisma.auditLog.count({ where }), // getting total count for pagination
    ]);

    return { logs, total, page, pageSize };
}

// listing login attempt records with optional filters for email and success/failure
// the admin uses this to monitor who is trying to access the system and identify suspicious activity
export async function listLoginAttempts(filters: LoginAttemptFilters) {
    const { email, success, page = 1, pageSize = 20 } = filters;

    const where: any = {};
    if (email) {
        where.email = { contains: email }; // partial match so the admin can search by part of the email
    }
    if (typeof success === "boolean") {
        where.success = success; // filtering by whether the login attempt succeeded or failed
    }

    const skip = (page - 1) * pageSize;

    const [attempts, total] = await Promise.all([
        prisma.loginAttempt.findMany({
            where,
            orderBy: { createdAt: "desc" }, // newest attempts first
            skip,
            take: pageSize,
        }),
        prisma.loginAttempt.count({ where }),
    ]);

    return { attempts, total, page, pageSize };
}
