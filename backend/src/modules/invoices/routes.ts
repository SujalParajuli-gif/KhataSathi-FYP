import { Router } from "express";
import {
  createDraft,
  list,
  getOne,
  addItem,
  updateItem,
  removeItem,
  finalize,
  cancel,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router = Router();

router.use(authGuard); // all invoice routes require authentication

// viewing invoices is available to all authenticated users
router.get("/", list); // listing invoices with optional filters (status, cashier, date range)
router.get("/:id", getOne); // fetching a single invoice with all its items and customer data

// invoice creation and item management is restricted to cashiers
router.post("/", requireRole("CASHIER"), createDraft); // creating a new draft invoice
router.post("/:id/items", requireRole("CASHIER"), addItem); // adding a product to the draft
router.patch("/:id/items/:itemId", requireRole("CASHIER"), updateItem); // changing the quantity of an item
router.delete("/:id/items/:itemId", requireRole("CASHIER"), removeItem); // removing an item from the draft
router.post("/:id/finalize", requireRole("CASHIER"), finalize); // finalizing the invoice — deducts stock and locks it
router.patch("/:id/cancel", requireRole("CASHIER", "ADMIN"), cancel); // both cashier and admin can cancel an invoice

export default router;
