// src/modules/audit/routes.ts — Audit routes (admin only)
import { Router } from "express";
import { list } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);
router.use(requireRole("ADMIN"));

// GET /api/audit?from=&to=&action=&actorId=&entityType=
router.get("/", list);

export default router;
