import { Router } from "express";
import {
  createDraft,
  checkout,
  authorizePriceOverride,
  park,
  listParked,
  resumeParked,
  discardParked,
  transferParked,
  modifyFinalized,
  list,
  getOne,
  addItem,
  updateItem,
  removeItem,
  finalize,
  cancel,
  softDelete,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";

const router = Router();

router.use(authGuard); // all invoice routes require authentication
router.use(denyStaff);

// viewing invoices is available to all authenticated users
router.get("/", list); // listing invoices with optional filters (status, cashier, date range)

// invoice creation and item management is restricted to cashiers
router.post("/", requireRole("CASHIER", "MANAGER"), createDraft); // creating a new draft invoice
router.post("/checkout", requireRole("CASHIER", "MANAGER"), checkout); // atomic POS checkout
router.post("/price-overrides/authorize", requireRole("CASHIER", "MANAGER"), authorizePriceOverride); // verify PIN before a cart price override becomes active
router.get("/parked", requireRole("CASHIER", "MANAGER", "ADMIN"), listParked); // list parked bills; supervisors can see all cashiers
router.post("/parked", requireRole("CASHIER", "MANAGER"), park); // park the current bill for later
router.post("/parked/:id/resume", requireRole("CASHIER", "MANAGER"), resumeParked); // resume a parked bill into the billing cart
router.patch("/parked/:id/transfer", requireRole("ADMIN", "MANAGER"), transferParked); // supervisors transfer a held bill to another cashier
router.delete("/parked/:id", requireRole("CASHIER", "MANAGER", "ADMIN"), discardParked); // discard a parked bill
router.get("/:id", getOne); // fetching a single invoice with all its items and customer data
router.post("/:id/modify", requireRole("CASHIER", "MANAGER", "ADMIN"), modifyFinalized); // modify finalized invoice through credit note + replacement
router.post("/:id/items", requireRole("CASHIER", "MANAGER"), addItem); // adding a product to the draft
router.patch("/:id/items/:itemId", requireRole("CASHIER", "MANAGER"), updateItem); // changing the quantity of an item
router.delete("/:id/items/:itemId", requireRole("CASHIER", "MANAGER"), removeItem); // removing an item from the draft
router.post("/:id/finalize", requireRole("CASHIER", "MANAGER"), finalize); // finalizing the invoice — deducts stock and locks it
router.patch("/:id/cancel", requireRole("CASHIER", "MANAGER", "ADMIN"), cancel); // counter staff, managers, and admin can cancel an invoice
router.delete("/:id", requireRole("ADMIN"), softDelete); // admin-only soft-delete for cancelled invoices

export default router;
