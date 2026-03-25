import { Router } from "express";
import { addPayment, listPayments } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);

router.get("/:id/payments", listPayments);
router.post("/:id/payments", requireRole("CASHIER"), addPayment);

export default router;