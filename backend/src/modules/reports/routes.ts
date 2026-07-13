import { Router } from "express";
import {
  analytics,
  analyticsCsv,
  salesSummary,
  bestSellers,
  cashierSales,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);

router.get("/analytics", requireRole("ADMIN", "MANAGER"), analytics); // returning the operational analytics dashboard data for a date range
router.get("/analytics/export/csv", requireRole("ADMIN"), analyticsCsv); // exporting analytics data is admin-only
router.get("/sales", requireRole("ADMIN", "MANAGER"), salesSummary); // returning a summary of sales for a date range
router.get("/best-sellers", requireRole("ADMIN", "MANAGER"), bestSellers); // returning the top-selling products for a date range
router.get("/cashier-sales", requireRole("ADMIN", "MANAGER"), cashierSales); // returning sales breakdown per cashier

export default router;
