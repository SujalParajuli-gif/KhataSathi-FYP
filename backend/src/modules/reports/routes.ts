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
router.use(requireRole("ADMIN")); // all report routes are restricted to admin only

router.get("/analytics", analytics); // returning the full analytics dashboard data for a date range
router.get("/analytics/export/csv", analyticsCsv); // exporting analytics data as a downloadable CSV file
router.get("/sales", salesSummary); // returning a summary of sales for a date range
router.get("/best-sellers", bestSellers); // returning the top-selling products for a date range
router.get("/cashier-sales", cashierSales); // returning sales breakdown per cashier

export default router;
