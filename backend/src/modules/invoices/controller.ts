import { Request, Response } from "express";
import * as invoiceService from "./service";
import { formatZodIssues } from "../../lib/requestValidation";
import {
  checkoutBodySchema,
  finalizeBodySchema,
  priceOverrideAuthorizationBodySchema,
} from "./validation";

// validating that a value is a positive whole number (at least 1)
// we use this for quantities and pagination parameters
function parsePositiveWholeNumber(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a whole number greater than 0`);
  }
  return normalized;
}

// validating an optional non-negative number (can be 0 but not negative)
// we use this for the discount amount field since a discount of 0 is valid but negative is not
function parseOptionalNonNegativeNumber(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (normalized < 0) {
    throw new Error(`${label} cannot be negative`);
  }

  return normalized;
}

function sendStockConflict(res: Response, err: any) {
  if (!(err instanceof invoiceService.StockConflictError)) return false;

  res.status(409).json({
    error: err.message,
    code: err.code,
    conflicts: err.conflicts,
  });
  return true;
}

// creating a new draft invoice for the current cashier
// the cashier can optionally link a customer at creation time
export async function createDraft(req: Request, res: Response) {
  try {
    const cashierId = req.user!.id; // the cashier who is creating this invoice
    const { customerId } = req.body;
    const invoice = await invoiceService.createDraft(cashierId, customerId);
    res.status(201).json(invoice);
  } catch (err: any) {
    // this handles when the auto-generated invoice number collides with an existing one
    if (err.message.includes("unique invoice number")) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Create draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// atomic checkout for POS billing: invoice creation, items, finalization, and initial payment in one backend flow
export async function checkout(req: Request, res: Response) {
  try {
    const parsed = checkoutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid checkout payload",
        details: formatZodIssues(parsed.error),
      });
      return;
    }
    const body = parsed.data;

    const result = await invoiceService.checkoutInvoice(req.user!.id, {
      draftInvoiceId: body.draftInvoiceId,
      customerId: body.customerId,
      items: body.items,
      discountAmount: body.discountAmount,
      overridePin: body.overridePin,
      notes: body.notes,
      payment: body.payment,
      payments: body.payments,
    });

    res.status(201).json(result);
  } catch (err: any) {
    if (sendStockConflict(res, err)) return;

    if (
      err.message.includes("Checkout") ||
      err.message.includes("productId") ||
      err.message.includes("qty") ||
      err.message.includes("Payment") ||
      err.message.includes("payment.method") ||
      err.message.includes("Discount amount") ||
      err.message.includes("Customer") ||
      err.message.includes("Product") ||
      err.message.includes("stock") ||
      err.message.includes("Insufficient") ||
      err.message.includes("empty") ||
      err.message.includes("Overpayment") ||
      err.message.includes("Zero-total") ||
      err.message.includes("Parked bill") ||
      err.message.includes("draft") ||
      err.message.includes("checked out") ||
      err.message.includes("fully paid") ||
      err.message.includes("cancelled") ||
      err.message.includes("remaining due") ||
      err.message.includes("PIN") ||
      err.message.includes("authorized") ||
      err.message.includes("not active")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }

    if (err.message.includes("unique invoice number")) {
      res.status(409).json({ error: err.message });
      return;
    }

    console.error("Checkout error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function authorizePriceOverride(req: Request, res: Response) {
  try {
    const parsed = priceOverrideAuthorizationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid price override payload",
        details: formatZodIssues(parsed.error),
      });
      return;
    }
    const body = parsed.data;

    const authorization = await invoiceService.createPriceOverrideAuthorization(
      req.user!.id,
      {
        productId: body.productId,
        customerId: body.customerId,
        qty: body.qty,
        overrideUnitPrice: body.overrideUnitPrice,
        overrideReason: body.overrideReason,
        pin: body.pin,
      },
    );

    res.status(201).json(authorization);
  } catch (err: any) {
    if (
      err.message.includes("Product") ||
      err.message.includes("Customer") ||
      err.message.includes("qty") ||
      err.message.includes("Quantity") ||
      err.message.includes("Override") ||
      err.message.includes("PIN") ||
      err.message.includes("authorized") ||
      err.message.includes("inactive") ||
      err.message.includes("price")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Authorize price override error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function park(req: Request, res: Response) {
  try {
    const draft = await invoiceService.parkDraft(req.user!.id, {
      replaceDraftInvoiceId: req.body?.replaceDraftInvoiceId,
      customerId: req.body?.customerId,
      label: req.body?.label,
      items: req.body?.items,
    });
    res.status(201).json(draft);
  } catch (err: any) {
    if (sendStockConflict(res, err)) return;

    if (
      err.message.includes("Checkout") ||
      err.message.includes("productId") ||
      err.message.includes("qty") ||
      err.message.includes("Customer") ||
      err.message.includes("Product") ||
      err.message.includes("stock") ||
      err.message.includes("Insufficient") ||
      err.message.includes("hold up to")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Park draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listParked(req: Request, res: Response) {
  try {
    const drafts = await invoiceService.listParkedDrafts(
      req.user!.id,
      req.user!.role,
    );
    res.json({ drafts });
  } catch (err) {
    console.error("List parked drafts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function resumeParked(req: Request, res: Response) {
  try {
    const draft = await invoiceService.resumeParkedDraft(
      String(req.params.id),
      req.user!.id,
    );
    res.json(draft);
  } catch (err: any) {
    if (
      err.message.includes("Parked bill") ||
      err.message.includes("parked draft")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Resume parked draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function discardParked(req: Request, res: Response) {
  try {
    const result = await invoiceService.discardParkedDraft(
      String(req.params.id),
      req.user!.id,
      req.user!.role,
    );
    res.json(result);
  } catch (err: any) {
    if (
      err.message.includes("Parked bill") ||
      err.message.includes("parked draft")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Discard parked draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function transferParked(req: Request, res: Response) {
  try {
    const targetCashierId = String(req.body?.cashierId || "").trim();
    if (!targetCashierId) {
      res.status(400).json({ error: "cashierId is required" });
      return;
    }

    const draft = await invoiceService.transferParkedDraft(
      String(req.params.id),
      req.user!.id,
      targetCashierId,
    );
    res.json(draft);
  } catch (err: any) {
    if (
      err.message.includes("Parked bill") ||
      err.message.includes("parked draft") ||
      err.message.includes("cashier")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Transfer parked draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function modifyFinalized(req: Request, res: Response) {
  try {
    const discountAmount = parseOptionalNonNegativeNumber(
      req.body?.discountAmount,
      "Discount amount",
    );

    const result = await invoiceService.modifyFinalizedInvoice(
      String(req.params.id),
      req.user!.id,
      {
        customerId: req.body?.customerId,
        discountAmount,
        overridePin: req.body?.overridePin,
        reason: req.body?.reason,
        items: req.body?.items,
      },
    );

    res.status(201).json(result);
  } catch (err: any) {
    if (sendStockConflict(res, err)) return;

    if (
      err.message.includes("Invoice") ||
      err.message.includes("Customer") ||
      err.message.includes("Product") ||
      err.message.includes("stock") ||
      err.message.includes("Insufficient") ||
      err.message.includes("return/refund") ||
      err.message.includes("qty") ||
      err.message.includes("productId") ||
      err.message.includes("Discount amount") ||
      err.message.includes("PIN") ||
      err.message.includes("authorized") ||
      err.message.includes("not active")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Modify finalized invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// listing invoices with filters for status, cashier, date range, and pagination
export async function list(req: Request, res: Response) {
  try {
    // parsing pagination parameters — defaulting to page 1 and 20 items per page
    const page =
      req.query.page === undefined
        ? 1
        : parsePositiveWholeNumber(req.query.page, "page");
    const pageSize =
      req.query.pageSize === undefined
        ? 20
        : parsePositiveWholeNumber(req.query.pageSize, "pageSize");

    const filters = {
      status: req.query.status as string | undefined,
      paymentStatus: req.query.paymentStatus as string | undefined,
      cashierId: req.query.cashierId as string | undefined,
      customerType: req.query.customerType as string | undefined,
      paymentMethod: req.query.paymentMethod as string | undefined,
      search: req.query.search as string | undefined,
      from: req.query.from as string | undefined, // start of date range in YYYY-MM-DD format
      to: req.query.to as string | undefined, // end of date range in YYYY-MM-DD format
      page,
      pageSize,
    };
    const result = await invoiceService.listInvoices(filters);
    res.json(result);
  } catch (err: any) {
    // checking for known validation errors (invalid page, date format, etc.)
    if (
      err.message.includes("page") ||
      err.message.includes("format") ||
      err.message.includes("calendar date")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("List invoices error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// fetching a single invoice by ID with all its items and customer data
export async function getOne(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const invoice = await invoiceService.getInvoice(invoiceId);
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    res.json(invoice);
  } catch (err) {
    console.error("Get invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// adding a product item to a draft invoice
// the quantity must be a positive whole number and the product must be active and in stock
export async function addItem(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const { productId, qty } = req.body;
    if (!productId) {
      res.status(400).json({ error: "productId is required" });
      return;
    }

    const item = await invoiceService.addItem(
      invoiceId,
      String(productId),
      parsePositiveWholeNumber(qty, "qty"),
    );
    res.status(201).json(item);
  } catch (err: any) {
    // checking for various business rule violations
    if (
      err.message.includes("qty") ||
      err.message.includes("finalized") ||
      err.message.includes("not found") ||
      err.message.includes("inactive") ||
      err.message.includes("stock")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Add item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// updating the quantity of an existing item in a draft invoice
export async function updateItem(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const itemId = String(req.params.itemId);
    const { qty } = req.body;
    const item = await invoiceService.updateItem(
      invoiceId,
      itemId,
      parsePositiveWholeNumber(qty, "qty"),
    );
    res.json(item);
  } catch (err: any) {
    if (
      err.message.includes("qty") ||
      err.message.includes("finalized") ||
      err.message.includes("not found") ||
      err.message.includes("stock") ||
      err.message.includes("belong")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Update item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// removing an item from a draft invoice
export async function removeItem(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const itemId = String(req.params.itemId);
    await invoiceService.removeItem(invoiceId, itemId);
    res.json({ message: "Item removed" });
  } catch (err: any) {
    if (
      err.message.includes("finalized") ||
      err.message.includes("not found") ||
      err.message.includes("belong")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Remove item error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// finalizing an invoice — this is the main action that locks the invoice, deducts stock, and creates audit logs
// the optional discountAmount overrides the auto-calculated discount
export async function finalize(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const userId = req.user!.id; // the user performing the finalization — logged in the audit trail
    const parsed = finalizeBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid invoice finalization payload",
        details: formatZodIssues(parsed.error),
      });
      return;
    }
    const invoice = await invoiceService.finalizeInvoice(
      invoiceId,
      userId,
      parsed.data.discountAmount,
    );
    res.json(invoice);
  } catch (err: any) {
    if (sendStockConflict(res, err)) return;

    // checking for various finalization errors — insufficient stock, already finalized, empty invoice, etc.
    if (
      err.message.includes("Discount amount") ||
      err.message.includes("finalized") ||
      err.message.includes("not found") ||
      err.message.includes("Insufficient") ||
      err.message.includes("empty")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Finalize error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// cancelling an invoice — available to both cashiers and admins
// a finalized invoice cannot be cancelled (it must be handled differently)
export async function cancel(req: Request, res: Response) {
  try {
    const invoice = await invoiceService.cancelInvoice(
      String(req.params.id),
      req.user!.id,
    );
    res.json(invoice);
  } catch (err: any) {
    if (
      err.message.includes("not found") ||
      err.message.includes("finalized") ||
      err.message.includes("cancelled") ||
      err.message.includes("return/refund")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Cancel invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// soft-deleting a cancelled invoice — admin only
// the invoice record is preserved in the database with a deletedAt timestamp
// but no longer appears in default invoice listings
export async function softDelete(req: Request, res: Response) {
  try {
    const result = await invoiceService.softDeleteInvoice(
      String(req.params.id),
      req.user!.id,
    );
    res.json(result);
  } catch (err: any) {
    if (
      err.message.includes("not found") ||
      err.message.includes("cancelled") ||
      err.message.includes("deleted")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Soft delete invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
