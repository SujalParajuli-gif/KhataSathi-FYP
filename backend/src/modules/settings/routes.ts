import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import {
  getBusinessDefaults,
  updateBusinessDefaults,
} from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all settings routes require authentication

router.get("/business", getBusinessDefaults); // any authenticated user can view the current business settings
router.put("/business", requireRole("ADMIN"), updateBusinessDefaults); // only admin can update business-wide defaults

export default router;
