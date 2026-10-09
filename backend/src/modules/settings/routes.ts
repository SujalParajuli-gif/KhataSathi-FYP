import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { requireBusinessCapability } from "./capabilities";
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
import {
  createPaymentAccountHandler,
  getEnabledPaymentAccountsHandler,
  getQrAssetFileHandler,
  listPaymentAccountAuditHandler,
  listPaymentAccountsHandler,
  patchPaymentAccountHandler,
  reorderPaymentAccountsHandler,
  uploadQrAssetHandler,
  uploadQrMiddleware,
} from "./paymentAccounts/controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all settings routes require authentication

router.get("/capabilities", getCapabilities);
router.get("/cashier-privileges/me", getMyCashierPrivileges); // current user's privilege snapshot

// Payment accounts accessible to cashier/manager/admin for POS receiving QRs
router.get(
  "/payment-accounts/enabled",
  denyStaff,
  requireBusinessCapability("POS"),
  getEnabledPaymentAccountsHandler,
);
router.get(
  "/payment-accounts/:id/qr/:assetId/file",
  denyStaff,
  getQrAssetFileHandler,
);
router.get(
  "/payment-accounts/:id/qr/:assetId/thumbnail",
  denyStaff,
  getQrAssetFileHandler,
);

router.use(denyStaff);

// Admin-only payment receiving accounts management
router.get("/payment-accounts", requireRole("ADMIN"), listPaymentAccountsHandler);
router.post("/payment-accounts", requireRole("ADMIN"), createPaymentAccountHandler);
router.put("/payment-accounts/order", requireRole("ADMIN"), reorderPaymentAccountsHandler);
router.get("/payment-accounts/:id/audit", requireRole("ADMIN"), listPaymentAccountAuditHandler);
router.patch("/payment-accounts/:id", requireRole("ADMIN"), patchPaymentAccountHandler);
router.post("/payment-accounts/:id/qr", requireRole("ADMIN"), uploadQrMiddleware, uploadQrAssetHandler);

router.get("/business", getBusinessDefaults); // any authenticated user can view the current business settings
router.put("/business", requireRole("ADMIN"), updateBusinessDefaults); // only admin can update business-wide defaults
router.get("/business-mode/preflight", requireRole("ADMIN"), getModePreflight);
router.put("/business-mode", requireRole("ADMIN"), changeBusinessMode);
router.get("/override-policy", requireRole("ADMIN"), getOverridePinPolicy);
router.put("/override-pin", requireRole("ADMIN"), updateOverridePinPolicy);
router.get("/cashier-privileges", requireRole("ADMIN"), listCashierPrivilegeSettings);
router.put("/cashier-privileges/:userId", requireRole("ADMIN"), updateCashierPrivilegeSettings);

export default router;
