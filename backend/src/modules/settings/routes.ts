import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import {
  getBusinessDefaults,
  getMyCashierPrivileges,
  getOverridePinPolicy,
  listCashierPrivilegeSettings,
  updateCashierPrivilegeSettings,
  updateBusinessDefaults,
  updateOverridePinPolicy,
} from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all settings routes require authentication

router.get("/cashier-privileges/me", getMyCashierPrivileges); // current user's privilege snapshot

router.use(denyStaff);
router.get("/business", getBusinessDefaults); // any authenticated user can view the current business settings
router.put("/business", requireRole("ADMIN"), updateBusinessDefaults); // only admin can update business-wide defaults
router.get("/override-policy", requireRole("ADMIN"), getOverridePinPolicy);
router.put("/override-pin", requireRole("ADMIN"), updateOverridePinPolicy);
router.get("/cashier-privileges", requireRole("ADMIN"), listCashierPrivilegeSettings);
router.put("/cashier-privileges/:userId", requireRole("ADMIN"), updateCashierPrivilegeSettings);

export default router;
