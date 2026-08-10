import { Router } from "express";
import {
  addPayment,
  failEsewaPayment,
  initiateEsewaPayment,
  listPayments,
  verifyEsewaPayment,
  voidPayment,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { requireBusinessCapability } from "../settings/capabilities";

const router: ReturnType<typeof Router> = Router();
const requirePos = requireBusinessCapability("POS");

// Payment callbacks do not carry a user token, so the mode guard must run
// before auth and must rely on the server-side business setting.

// eSewa callback routes — these are called by eSewa after payment success or failure
// they need to be BEFORE authGuard because eSewa sends the user here directly without a browser session
router.get("/payments/esewa/verify/:paymentId", requirePos, verifyEsewaPayment);
router.post("/payments/esewa/verify/:paymentId", requirePos, verifyEsewaPayment);
router.get("/payments/esewa/failure/:paymentId", requirePos, failEsewaPayment);
router.post("/payments/esewa/failure/:paymentId", requirePos, failEsewaPayment);

// initiating an eSewa payment — creates a pending payment record and returns the form data to redirect to eSewa
router.post(
  "/payments/esewa/initiate",
  requirePos,
  authGuard,
  denyStaff,
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  initiateEsewaPayment,
);
router.get(
  "/invoices/:id/payments",
  requirePos,
  authGuard,
  denyStaff,
  listPayments,
);
router.post(
  "/invoices/:id/payments",
  requirePos,
  authGuard,
  denyStaff,
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  addPayment, // recording a manual payment (cash, card, etc.)
);
router.patch(
  "/invoices/:id/payments/:paymentId/void",
  requirePos,
  authGuard,
  denyStaff,
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  voidPayment, // admin can void directly; cashier needs privilege + override PIN
);

export default router;
