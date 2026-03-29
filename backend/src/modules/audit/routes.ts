import { Router } from "express";
import { list, listLoginAttempts } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.get("/", list);
router.get("/login-attempts", requireRole("ADMIN"), listLoginAttempts);

export default router;
