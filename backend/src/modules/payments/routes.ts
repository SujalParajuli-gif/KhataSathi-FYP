// src/modules/payments/routes.ts — Payment routes (nested under invoices)
import { Router } from "express";
import { addPayment, listPayments } from "./controller";
import { authGuard } from "../../middleware/auth";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

// POST /api/invoices/:id/payments — add payment
router.post("/:id/payments", addPayment);

// GET /api/invoices/:id/payments — list payments
router.get("/:id/payments", listPayments);

export default router;
