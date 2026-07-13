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

const router: ReturnType<typeof Router> = Router();

// eSewa callback routes — these are called by eSewa after payment success or failure
// they need to be BEFORE authGuard because eSewa sends the user here directly (no JWT token)
router.get("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.post("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.get("/payments/esewa/failure/:paymentId", failEsewaPayment);
router.post("/payments/esewa/failure/:paymentId", failEsewaPayment);

router.use(authGuard); // everything below requires authentication
router.use(denyStaff);

// initiating an eSewa payment — creates a pending payment record and returns the form data to redirect to eSewa
router.post(
  "/payments/esewa/initiate",
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  initiateEsewaPayment,
);
router.get("/invoices/:id/payments", listPayments); // listing all payments for a specific invoice
router.post(
  "/invoices/:id/payments",
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  addPayment, // recording a manual payment (cash, card, etc.)
);
router.patch(
  "/invoices/:id/payments/:paymentId/void",
  requireRole("CASHIER", "MANAGER", "ADMIN"),
  voidPayment, // admin can void directly; cashier needs privilege + override PIN
);

export default router;
