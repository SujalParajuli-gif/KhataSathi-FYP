import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import {
  changeBusinessMode,
  getCapabilities,
  getBusinessDefaults,
  getModePreflight,
  getMyCashierPrivileges,
  getOverridePinPolicy,
  listCashierPrivilegeSettings,
  updateCashierPrivilegeSettings,
  updateBusinessDefaults,
  updateOverridePinPolicy,
} from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all settings routes require authentication

router.get("/capabilities", getCapabilities);
router.get("/cashier-privileges/me", getMyCashierPrivileges); // current user's privilege snapshot

router.use(denyStaff);
router.get("/business", getBusinessDefaults); // any authenticated user can view the current business settings
router.put("/business", requireRole("ADMIN"), updateBusinessDefaults); // only admin can update business-wide defaults
router.get("/business-mode/preflight", requireRole("ADMIN"), getModePreflight);
router.put("/business-mode", requireRole("ADMIN"), changeBusinessMode);
router.get("/override-policy", requireRole("ADMIN"), getOverridePinPolicy);
router.put("/override-pin", requireRole("ADMIN"), updateOverridePinPolicy);
router.get("/cashier-privileges", requireRole("ADMIN"), listCashierPrivilegeSettings);
router.put("/cashier-privileges/:userId", requireRole("ADMIN"), updateCashierPrivilegeSettings);

export default router;
