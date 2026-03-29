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

router.get("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.post("/payments/esewa/verify/:paymentId", verifyEsewaPayment);
router.get("/payments/esewa/failure/:paymentId", failEsewaPayment);
router.post("/payments/esewa/failure/:paymentId", failEsewaPayment);

router.use(authGuard);

router.post("/payments/esewa/initiate", requireRole("CASHIER"), initiateEsewaPayment);
router.get("/invoices/:id/payments", listPayments);
router.post("/invoices/:id/payments", requireRole("CASHIER"), addPayment);

export default router;
