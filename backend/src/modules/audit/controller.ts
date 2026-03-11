// src/modules/audit/controller.ts — Audit log route handler
import { Request, Response } from "express";
import * as auditService from "./service";

export async function list(req: Request, res: Response) {
    try {
        const filters = {
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
            action: req.query.action as string | undefined,
            actorId: req.query.actorId as string | undefined,
            entityType: req.query.entityType as string | undefined,
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
