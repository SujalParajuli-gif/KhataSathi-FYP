import { Router } from "express";
import { salesSummary, bestSellers, cashierSales } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.use(requireRole("ADMIN"));

router.get("/sales", salesSummary);
router.get("/best-sellers", bestSellers);
router.get("/cashier-sales", cashierSales);

export default router;