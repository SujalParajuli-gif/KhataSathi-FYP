import { Router } from "express";
import { list, listLoginAttempts } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all audit routes require authentication
router.get("/", list); // listing audit log entries with optional filters (date, action, actor, entity type)
router.get("/login-attempts", requireRole("ADMIN"), listLoginAttempts); // only admin can view login attempt history

export default router;
