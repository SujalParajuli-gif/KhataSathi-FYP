import { Router } from "express";
import { categorizedHistory, list, listLoginAttempts } from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all audit routes require authentication
router.use(denyStaff);
router.get("/history", categorizedHistory); // category-wise business history for admin/cashier views
router.get("/", list); // listing audit log entries with optional filters (date, action, actor, entity type)
router.get("/login-attempts", requireRole("ADMIN", "MANAGER"), listLoginAttempts); // admin and manager can view login attempt history

export default router;
