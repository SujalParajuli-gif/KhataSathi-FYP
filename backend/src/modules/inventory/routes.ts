import { Router } from "express";
import { restock, adjust, lowStock, stockTransactions } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

router.post("/restock", requireRole("ADMIN"), restock);

router.post("/adjust", requireRole("ADMIN"), adjust);

router.get("/low-stock", lowStock);

router.get("/transactions", stockTransactions);

export default router;
