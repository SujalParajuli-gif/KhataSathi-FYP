// src/modules/reports/routes.ts — Report routes
import { Router } from "express";
import { salesSummary, bestSellers, cashierSales } from "./controller";
import { authGuard } from "../../middleware/auth";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

// GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/sales", salesSummary);

// GET /api/reports/best-sellers?from=&to=&limit=10
router.get("/best-sellers", bestSellers);

// GET /api/reports/cashier-sales?from=&to=
router.get("/cashier-sales", cashierSales);

export default router;
