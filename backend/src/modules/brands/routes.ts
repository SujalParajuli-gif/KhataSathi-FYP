// src/modules/brands/routes.ts — Brand routes
import { Router } from "express";
import { list, getOne, create, update, deactivate } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

// All brand routes require authentication
router.use(authGuard);

// GET /api/brands — list all (optionally ?active=true)
router.get("/", list);

// GET /api/brands/:id — get one
router.get("/:id", getOne);

// POST /api/brands — create (admin only)
router.post("/", requireRole("ADMIN"), create);

// PUT /api/brands/:id — update (admin only)
router.put("/:id", requireRole("ADMIN"), update);

// PATCH /api/brands/:id/deactivate — soft delete (admin only)
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate);

export default router;
