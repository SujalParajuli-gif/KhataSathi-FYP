import { Router } from "express";
import {
  addPayment,
  failEsewaPayment,
  initiateEsewaPayment,
  listPayments,
  verifyEsewaPayment,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

// eSewa callback routes — these are called by eSewa after payment success or failure
// they need to be BEFORE authGuard because eSewa sends the user here directly (no JWT token)
router.get("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.post("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.get("/payments/esewa/failure/:paymentId", failEsewaPayment);
router.post("/payments/esewa/failure/:paymentId", failEsewaPayment);

router.use(authGuard); // everything below requires authentication

// initiating an eSewa payment — creates a pending payment record and returns the form data to redirect to eSewa
router.post(
  "/payments/esewa/initiate",
  requireRole("CASHIER", "ADMIN"),
  initiateEsewaPayment,
);
router.get("/invoices/:id/payments", listPayments); // listing all payments for a specific invoice
router.post(
  "/invoices/:id/payments",
  requireRole("CASHIER", "ADMIN"),
  addPayment, // recording a manual payment (cash, card, etc.)
);

export default router;
