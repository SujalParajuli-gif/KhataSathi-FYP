// src/modules/products/routes.ts — Product routes
import { Router } from "express";
import multer from "multer";
import { list, getOne, create, update, deactivate, categories, importCsv } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
const upload = multer({ storage: multer.memoryStorage() });

// All product routes require authentication
router.use(authGuard);

// GET /api/products — list with search/filters
router.get("/", list);

// GET /api/products/categories — unique categories
router.get("/categories", categories);

// GET /api/products/:id — get one product
router.get("/:id", getOne);

// POST /api/products — create (admin only)
router.post("/", requireRole("ADMIN"), create);

// POST /api/products/import-csv — CSV import (admin only)
router.post("/import-csv", requireRole("ADMIN"), upload.single("file"), importCsv);

// PUT /api/products/:id — update (admin only)
router.put("/:id", requireRole("ADMIN"), update);

// PATCH /api/products/:id/deactivate — soft delete (admin only)
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate);

export default router;
