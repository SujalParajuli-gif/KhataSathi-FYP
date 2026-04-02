import { Request, Response } from "express";
import * as invoiceService from "./service";

function parsePositiveWholeNumber(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a whole number greater than 0`);
  }
  return normalized;
}

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

export async function createDraft(req: Request, res: Response) {
  try {
    const cashierId = req.user!.id;
    const { customerId } = req.body;
    const invoice = await invoiceService.createDraft(cashierId, customerId);
    res.status(201).json(invoice);
  } catch (err: any) {
    if (err.message.includes("unique invoice number")) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Create draft error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function list(req: Request, res: Response) {
  try {
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
      cashierId: req.query.cashierId as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      page,
      pageSize,
    };
    const result = await invoiceService.listInvoices(filters);
    res.json(result);
  } catch (err: any) {
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

export async function finalize(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const userId = req.user!.id;
    const discountAmount = parseOptionalNonNegativeNumber(
      req.body?.discountAmount,
      "Discount amount",
    );
    const invoice = await invoiceService.finalizeInvoice(
      invoiceId,
      userId,
      discountAmount,
    );
    res.json(invoice);
  } catch (err: any) {
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
      err.message.includes("cancelled")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Cancel invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
