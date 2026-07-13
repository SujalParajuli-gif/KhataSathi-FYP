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
    from?: string;
    to?: string;
    email?: string;
    success?: boolean; // true = successful logins, false = failed attempts
    page?: number;
    pageSize?: number;
}

interface CategorizedHistoryFilters {
    category?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: number;
    pageSize?: number;
}

const HISTORY_CATEGORY_FILTERS: Record<string, { actions?: string[]; entityTypes?: string[] }> = {
    sales: {
        actions: [
            "INVOICE_FINALIZED",
            "INVOICE_PAYMENT_UPDATED",
            "INVOICE_MODIFIED_WITH_CREDIT_NOTE",
            "INVOICE_CANCELLED",
            "INVOICE_SOFT_DELETED",
            "INVOICE_DRAFT_PARKED",
            "INVOICE_DRAFT_RESUMED",
            "INVOICE_DRAFT_DISCARDED",
            "INVOICE_DRAFT_TRANSFERRED",
            "CASHIER_MANUAL_DISCOUNT_APPLIED",
            "CASHIER_PRICE_OVERRIDE_APPLIED",
            "CUSTOMER_CREATED",
            "CUSTOMER_DISCOUNT_CREATED_BY_CASHIER",
            "CUSTOMER_DISCOUNT_REQUEST_CREATED",
            "CUSTOMER_DISCOUNT_REQUEST_APPROVED",
            "CUSTOMER_DISCOUNT_REQUEST_REJECTED",
        ],
    },
    product: {
        actions: ["PRODUCT_PRICE_UPDATED", "PRODUCT_PRICE_UPDATE_DIGEST", "PRODUCT_BULK_PRICE_UPDATE", "MANAGER_PRODUCT_BULK_PRICE_UPDATE", "PRODUCT_DEACTIVATED"],
        entityTypes: ["Product", "Brand"],
    },
    stock: {
        actions: ["PRODUCT_RESTOCKED", "STOCK_RECEIVE_BATCH_CREATED", "STOCK_RECEIVE_BILL_UPLOAD_FAILED", "STOCK_ADJUSTED"],
        entityTypes: ["StockTransaction", "StockReceiveBatch"],
    },
    import: {
        actions: [
            "PRODUCT_IMPORT_COMPLETED",
            "PRODUCT_IMPORT_BATCH_DELETED",
            "PRODUCT_IMPORT_BATCH_RESTORED",
            "PRODUCT_IMPORT_BATCH_PURGED",
        ],
        entityTypes: ["ProductImportBatch", "ProductImportRow"],
    },
    document: {
        actions: ["DOCUMENT_UPLOADED", "DOCUMENT_DELETED", "DOCUMENT_RESTORED", "DOCUMENT_PURGED"],
        entityTypes: ["Document"],
    },
    return: {
        actions: [
            "RETURN_REQUEST_CREATED",
            "RETURN_REQUEST_APPROVED",
            "RETURN_REQUEST_REJECTED",
            "RETURN_REQUEST_REVERSED",
        ],
        entityTypes: ["ReturnRequest"],
    },
    payment: {
        actions: ["INVOICE_PAYMENT_UPDATED", "INVOICE_PAYMENT_FAILED", "ESEWA_PAYMENT_EXPIRED", "PAYMENT_VOIDED"],
        entityTypes: ["Payment", "Invoice"],
    },
    system: {
        actions: [
            "DATABASE_BACKUP",
            "DATABASE_BACKUP_SCHEDULED",
            "DATABASE_RESTORE",
            "SCHEDULED_BACKUP_FAILED",
            "BACKUP_SCHEDULE_UPDATED",
            "CASHIER_PRIVILEGE_UPDATED",
            "OVERRIDE_PIN_UPDATED",
            "OVERRIDE_PIN_LOCKED",
            "CASH_DRAWER_CLOSED",
            "BIN_AUTO_PURGE",
        ],
        entityTypes: ["BackupJob", "BackupSettings", "LoginAttempt", "CashierPrivilege", "BusinessSettings", "OverridePinAttempt"],
    },
};

function formatCurrency(value: unknown) {
    const amount = Number(value ?? 0);
    const normalized = Math.round(amount * 100) / 100;
    return `NPR ${normalized.toLocaleString(undefined, {
        minimumFractionDigits: normalized % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
    })}`;
}

function humanizeAction(action: string) {
    return action
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function importBatchIdFromLog(log: any) {
    if (log.entityType === "ProductImportBatch") return log.entityId;
    return log.meta?.batchId || log.meta?.productImportBatchId || null;
}

export function buildHistoryDisplay(log: any, category: string) {
    const actorName = log.actor?.name || log.meta?.actorName || "System";
    const meta = log.meta || {};
    const fallbackTitle = humanizeAction(log.action);
    const fallbackDescription = `${actorName} performed ${humanizeAction(log.action)}.`;
    let title = fallbackTitle;
    let description = fallbackDescription;
    let detailType: string | null = null;
    let detailId: string | null = null;
    let actionLabel: string | null = null;

    switch (log.action) {
        case "INVOICE_FINALIZED":
            title = `Invoice generated: ${meta.invoiceNo || log.entityId}`;
            description = `${actorName} finalized invoice ${meta.invoiceNo || log.entityId} for ${formatCurrency(meta.netTotal)}.`;
            break;
        case "INVOICE_PAYMENT_UPDATED":
            title = `Payment updated: ${meta.invoiceNo || log.entityId}`;
            description = `${actorName} added ${formatCurrency(meta.amountAdded)}. Remaining due ${formatCurrency(meta.remainingDue)}.`;
            break;
        case "INVOICE_CANCELLED":
            title = `Invoice cancelled: ${meta.invoiceNo || log.entityId}`;
            description = `${actorName} cancelled invoice ${meta.invoiceNo || log.entityId}; stock and payment history were preserved.`;
            break;
        case "STOCK_RECEIVE_BATCH_CREATED":
            title = `Stock received from ${meta.supplierName || "supplier"}`;
            description = `${actorName} received ${meta.totalQty || 0} item(s) across ${meta.lineCount || 0} product(s).`;
            detailType = "stockReceiveBatch";
            detailId = log.entityId;
            actionLabel = "View details";
            break;
        case "PRODUCT_RESTOCKED":
            title = `Stock added: ${meta.productName || log.entityId}`;
            description = `${actorName} added ${meta.qty || 0} unit(s). Reason: ${meta.reason || "Manual restock"}.`;
            break;
        case "STOCK_ADJUSTED":
            title = `Stock adjusted: ${meta.productName || log.entityId}`;
            description = `${actorName} changed stock by ${meta.qtyDelta || 0}; ${meta.previousStock ?? "?"} -> ${meta.nextStock ?? "?"}.`;
            break;
        case "STOCK_RECEIVE_BILL_UPLOAD_FAILED":
            title = "Stock bill upload failed";
            description = `${actorName} received stock from ${meta.supplierName || "supplier"}, but the bill upload failed.`;
            break;
        case "PRODUCT_PRICE_UPDATED":
            title = `Product price changed: ${meta.productName || meta.sku || log.entityId}`;
            description = `${actorName} changed retail price from ${formatCurrency(meta.before?.retailPrice)} to ${formatCurrency(meta.after?.retailPrice)}.`;
            break;
        case "PRODUCT_PRICE_UPDATE_DIGEST":
        case "MANAGER_PRODUCT_BULK_PRICE_UPDATE":
            title = "Bulk product prices updated";
            description = `${actorName} updated prices for ${meta.updatedCount || 0} product(s). Reason: ${meta.reason || "No reason provided"}.`;
            break;
        case "PRODUCT_DEACTIVATED":
            title = `Product removed from sale: ${meta.productName || meta.sku || log.entityId}`;
            description = `${actorName} deactivated this product. Invoice history remains preserved.`;
            break;
        case "PRODUCT_IMPORT_COMPLETED":
            title = `Import completed: ${meta.fileName || meta.sourceType || "Product import"}`;
            description = `${actorName} imported ${meta.createdCount || 0} product(s) with ${meta.errorCount || 0} issue(s).`;
            detailType = "importBatch";
            detailId = importBatchIdFromLog(log);
            actionLabel = "Reopen review";
            break;
        case "PRODUCT_IMPORT_BATCH_DELETED":
            title = `Import review deleted: ${meta.fileName || log.entityId}`;
            description = `${actorName} moved an import review to the bin. Imported products were not removed.`;
            detailType = "importBatch";
            detailId = importBatchIdFromLog(log);
            actionLabel = "Reopen review";
            break;
        case "PRODUCT_IMPORT_BATCH_RESTORED":
            title = `Import review restored: ${meta.fileName || log.entityId}`;
            description = `${actorName} restored an import review from the bin.`;
            detailType = "importBatch";
            detailId = importBatchIdFromLog(log);
            actionLabel = "Reopen review";
            break;
        case "DOCUMENT_UPLOADED":
            title = `${meta.count || 1} document(s) uploaded`;
            description = `${actorName} uploaded ${String(meta.documentType || "document").toLowerCase()} file(s).`;
            break;
        case "DOCUMENT_DELETED":
            title = `Document moved to bin: ${meta.fileName || log.entityId}`;
            description = `${actorName} moved this document to the bin.`;
            break;
        case "RETURN_REQUEST_CREATED":
            title = "Return request created";
            description = `${actorName} created a return request.`;
            break;
        case "RETURN_REQUEST_APPROVED":
            title = "Return approved";
            description = `${actorName} approved a return for ${formatCurrency(meta.refundAmount)}.`;
            break;
        case "RETURN_REQUEST_REJECTED":
            title = "Return rejected";
            description = `${actorName} rejected a return request.`;
            break;
        case "PAYMENT_VOIDED":
            title = `Payment voided: ${formatCurrency(meta.voidedAmount)}`;
            description = `${actorName} voided payment on invoice ${meta.invoiceNo || log.entityId}.`;
            break;
        case "CASH_DRAWER_CLOSED":
            title = "Cash drawer discrepancy";
            description = `${meta.cashierName || "Cashier"} closed with expected ${formatCurrency(meta.expectedTotal)} and actual ${formatCurrency(meta.actualTotal)}.`;
            break;
        case "SCHEDULED_BACKUP_FAILED":
            title = "Scheduled backup failed";
            description = meta.error || meta.message || "Scheduled database backup failed.";
            break;
        case "DATABASE_BACKUP":
        case "DATABASE_BACKUP_SCHEDULED":
            title = "Database backup completed";
            description = `${actorName} created ${meta.filename || "a database backup"}.`;
            break;
        case "DATABASE_RESTORE":
            title = "Database restore completed";
            description = `${actorName} restored from ${meta.filename || "a backup file"}.`;
            break;
        case "BIN_AUTO_PURGE":
            title = "Bin auto purge completed";
            description = `Purged ${meta.purgedDocuments || 0} document(s), ${meta.purgedProductImportBatches || 0} import review(s), and ${meta.purgedAlerts || 0} dismissed alert(s). Failed: ${meta.failedCount || 0}.`;
            break;
    }

    return { title, description, detailType, detailId, actionLabel };
}

function buildCategoryWhere(category?: string) {
    if (!category || category === "all") return {};

    const config = HISTORY_CATEGORY_FILTERS[category];
    if (!config) return {};

    const or: any[] = [];
    if (config.actions?.length) or.push({ action: { in: config.actions } });
    if (config.entityTypes?.length) or.push({ entityType: { in: config.entityTypes } });

    return or.length ? { OR: or } : {};
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
    const { from, to, email, success, page = 1, pageSize = 20 } = filters;

    const where: any = {};
    if (email) {
        where.email = { contains: email }; // partial match so the admin can search by part of the email
    }
    if (typeof success === "boolean") {
        where.success = success; // filtering by whether the login attempt succeeded or failed
    }
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from); // start of the chosen date range
        if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z"); // end of day for the chosen to date
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

export async function listCategorizedHistory(filters: CategorizedHistoryFilters) {
    const { category = "all", from, to, q, page = 1, pageSize = 30 } = filters;

    const where: any = {};
    const andFilters: any[] = [];
    const categoryWhere = buildCategoryWhere(category);
    if (Object.keys(categoryWhere).length) {
        andFilters.push(categoryWhere);
    }
    if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z");
    }
    if (q) {
        andFilters.push({ OR: [
            { action: { contains: q } },
            { entityType: { contains: q } },
            { entityId: { contains: q } },
            { actor: { name: { contains: q } } },
        ] });
    }
    if (andFilters.length) {
        where.AND = andFilters;
    }

    const safePageSize = Math.max(1, Math.min(100, pageSize));
    const skip = (page - 1) * safePageSize;

    const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            include: { actor: { select: { id: true, name: true, email: true, role: true } } },
            orderBy: { createdAt: "desc" },
            skip,
            take: safePageSize,
        }),
        prisma.auditLog.count({ where }),
    ]);

    return {
        category,
        events: logs.map((log) => {
            const display = buildHistoryDisplay(log, category);
            return {
                id: log.id,
                category,
                action: log.action,
                entityType: log.entityType,
                entityId: log.entityId,
                actor: log.actor,
                meta: log.meta,
                createdAt: log.createdAt,
                ...display,
            };
        }),
        total,
        page,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
    };
}
