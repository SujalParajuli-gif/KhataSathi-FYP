import { Router } from "express";
import { restock, adjust, lowStock, stockTransactions } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all inventory routes require authentication

router.post("/restock", requireRole("ADMIN"), restock); // only admin can add stock to products
router.post("/adjust", requireRole("ADMIN"), adjust); // only admin can manually adjust stock (up or down)
router.get("/low-stock", lowStock); // any authenticated user can view products with low stock
router.get("/transactions", stockTransactions); // viewing the stock transaction history

export default router;
