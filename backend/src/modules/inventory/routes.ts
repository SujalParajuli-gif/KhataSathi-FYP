// src/modules/inventory/routes.ts — Inventory routes
import { Router } from "express";
import { restock, adjust, lowStock, stockTransactions } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

// POST /api/inventory/restock — add stock (admin only)
router.post("/restock", requireRole("ADMIN"), restock);

// POST /api/inventory/adjust — adjust stock (admin only)
router.post("/adjust", requireRole("ADMIN"), adjust);

// GET /api/inventory/low-stock — products below threshold
router.get("/low-stock", lowStock);

// GET /api/inventory/transactions — stock transaction history
router.get("/transactions", stockTransactions);

export default router;
