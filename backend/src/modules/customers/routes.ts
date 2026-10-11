import { Router } from "express";
import {
  approveDiscountRequest,
  create,
  createDiscountedByCashier,
  createQuick,
  createDiscountRequest,
  deactivate,
  deleteDiscount,
  getDiscountDeleteSafety,
  getOne,
  getProductPurchaseHistory,
  getCustomerPurchaseHistory,
  lookupCustomers,
  list,
  listDiscountRequests,
  rejectDiscountRequest,
  update,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { requireBusinessCapability } from "../settings/capabilities";

import { listCustomerReceivables } from "./receivables";
import { ZodError } from "zod";
import { applyCustomerCredit, reverseCustomerCredit, CreditApplicationConflict } from "./creditApplications";
import { FinancialTransactionConflictError } from "../../lib/transactionLocks";

import { confirmCustomerCreditPayout, confirmCustomerCreditRecovery, CashPayoutConflict } from "./cashPayouts";

const router: ReturnType<typeof Router> = Router();
const requirePos = requireBusinessCapability("POS");
router.use(authGuard); // all customer routes require authentication

router.get("/receivables", requirePos, requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try { res.json(await listCustomerReceivables(req.query, req.user!.role)); }
  catch (error) {
    if (error instanceof ZodError) { res.status(400).json({ error: "Invalid customer receivables filters" }); return; }
    console.error("Customer receivables failed", error);
    res.status(500).json({ error: "Customer receivables could not be loaded" });
  }
});

const creditFailure = (res: import("express").Response, error: unknown) => {
  if (error instanceof ZodError) { res.status(400).json({ error: "Invalid credit application input" }); return; }
  if (error instanceof CreditApplicationConflict || error instanceof FinancialTransactionConflictError) { res.status(409).json({ error: error.message }); return; }
  console.error("Credit application failed", { code: typeof (error as any)?.code === "string" ? (error as any).code : "UNKNOWN" });
  res.status(500).json({ error: "Credit application outcome is unknown; retry the same operation" });
};
router.post("/credit-applications", requirePos, requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try { res.status(201).json(await applyCustomerCredit(req.user!.id, req.body)); }
  catch (error) { creditFailure(res, error); }
});
router.post("/credit-applications/:id/reverse", requirePos, requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try { res.json(await reverseCustomerCredit(req.user!.id, String(req.params.id), req.body)); }
  catch (error) { creditFailure(res, error); }
});

const payoutFailure = (res: import("express").Response, error: unknown) => {
  if (error instanceof ZodError) { res.status(400).json({ error: "Invalid cash payout confirmation" }); return; }
  if (error instanceof CashPayoutConflict || error instanceof FinancialTransactionConflictError) { res.status(409).json({ error: error.message }); return; }
  console.error("Cash payout failed", { code: typeof (error as any)?.code === "string" ? (error as any).code : "UNKNOWN" });
  res.status(500).json({ error: "Cash outcome is unknown; retry the same operation" });
};
router.post("/credit-payouts", requirePos, requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try { res.status(201).json(await confirmCustomerCreditPayout(req.user!.id, req.body)); }
  catch (error) { payoutFailure(res, error); }
});
router.post("/credit-payouts/:id/recover", requirePos, requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try { res.json(await confirmCustomerCreditRecovery(req.user!.id, String(req.params.id), req.body)); }
  catch (error) { payoutFailure(res, error); }
});

router.get("/lookup", requirePos, requireRole("ADMIN", "MANAGER", "CASHIER"), lookupCustomers);
router.get("/", list); // any authenticated user can view the customer list
router.use(denyStaff);
router.post("/quick", requireRole("ADMIN", "MANAGER", "CASHIER"), createQuick);
router.post("/cashier-discounted", createDiscountedByCashier); // authorized cashiers can create discounted customers
router.get("/discount-requests", listDiscountRequests); // admin sees all requests; cashiers see their own requests
router.post("/discount-requests", createDiscountRequest); // cashiers can request admin approval for discounts
router.patch("/discount-requests/:id/approve", requireRole("ADMIN", "MANAGER"), approveDiscountRequest);
router.patch("/discount-requests/:id/reject", requireRole("ADMIN", "MANAGER"), rejectDiscountRequest);
router.get("/:id/discounts/:discountType/delete-safety", requireRole("ADMIN", "MANAGER"), getDiscountDeleteSafety);
router.delete("/:id/discounts/:discountType", requireRole("ADMIN", "MANAGER"), deleteDiscount);
router.get("/:customerId/purchase-history", requirePos, requireRole("ADMIN", "MANAGER", "CASHIER"), getCustomerPurchaseHistory);
router.get("/:customerId/product-history", requirePos, requireRole("ADMIN", "MANAGER", "CASHIER"), getProductPurchaseHistory);
router.get("/:id", getOne); // fetching a single customer by ID
router.post("/", requireRole("ADMIN", "MANAGER"), create); // admin and managers can create new customers
router.put("/:id", requireRole("ADMIN", "MANAGER"), update); // admin and managers can update customer info
router.patch("/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivate); // admin and managers can deactivate a customer
export default router;
