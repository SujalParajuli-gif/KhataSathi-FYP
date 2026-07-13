import { Request, Response } from "express";
import * as auditService from "./service";

// listing audit log entries with optional filters for date range, action type, actor, and entity type
// this is used by the admin to review all actions that have been performed in the system
export async function list(req: Request, res: Response) {
    try {
        // reading all filter options from the query string
        const filters = {
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
            action: req.query.action as string | undefined, // e.g., INVOICE_FINALIZED, PRODUCT_RESTOCKED
            actorId: req.query.actorId as string | undefined, // filter by who performed the action
            entityType: req.query.entityType as string | undefined, // e.g., Invoice, Product, Brand
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
        };
        const result = await auditService.listAuditLogs(filters);
        res.json(result);
    } catch (err) {
        console.error("Audit list error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// listing login attempt records — shows who tried to log in, whether they succeeded, and from which IP
// this is admin-only and is used for security monitoring
export async function listLoginAttempts(req: Request, res: Response) {
    try {
        const filters = {
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
            email: req.query.email as string | undefined, // optional filter by email
            success:
                req.query.success === "true"
                    ? true
                    : req.query.success === "false"
                        ? false
                        : undefined, // optional filter by success/failure
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
        };
        const result = await auditService.listLoginAttempts(filters);
        res.json(result);
    } catch (err) {
        console.error("Login attempts list error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// listing business history grouped by category for the History screen tabs
export async function categorizedHistory(req: Request, res: Response) {
    try {
        const filters = {
            category: req.query.category as string | undefined,
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
            q: req.query.q as string | undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 30,
        };
        const result = await auditService.listCategorizedHistory(filters);
        res.json(result);
    } catch (err) {
        console.error("Categorized history error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
