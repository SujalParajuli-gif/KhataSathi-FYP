import { Request, Response } from "express";
import * as custService from "./service";

// validating and trimming the customer name — we require it to be a non-empty string
function parseCustomerName(value: unknown) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("Customer name is required");
  }
  return normalized;
}

// converting any input to a trimmed string, returning undefined if it is empty
// we use this for optional fields like phone and email
function parseOptionalText(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

// converting various input types to a boolean value
// the frontend can send "true" as a string or as an actual boolean, so we handle both
function parseBooleanValue(value: unknown) {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
}

// validating that a discount percent is a number between 0 and 100
// we use this for both loyaltyPercent and wholesalePercent fields
// if the value is empty or not provided, it defaults to 0
function parsePercent(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (normalized < 0 || normalized > 100) {
    throw new Error(`${label} must be between 0 and 100`);
  }

  return normalized;
}

// listing all customers, with optional filtering for active-only customers
export async function list(req: Request, res: Response) {
  try {
    const activeOnly = req.query.active === "true"; // checking the query parameter to decide whether to filter
    const customers = await custService.listCustomers(activeOnly);
    res.json(customers);
  } catch (err) {
    console.error("List customers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// fetching a single customer by their ID
export async function getOne(req: Request, res: Response) {
  try {
    const customer = await custService.getCustomer(String(req.params.id));
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json(customer);
  } catch (err) {
    console.error("Get customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// creating a new customer — all input values are validated through the parse helper functions above
export async function create(req: Request, res: Response) {
  try {
    const newCust = await custService.createCustomer({
      name: parseCustomerName(req.body.name),
      phone: parseOptionalText(req.body.phone),
      email: parseOptionalText(req.body.email),
      loyaltyPercent: parsePercent(req.body.loyaltyPercent, "Loyalty percent"),
      wholesalePercent: parsePercent(
        req.body.wholesalePercent,
        "Wholesale percent",
      ),
    });
    res.status(201).json(newCust);
  } catch (err: any) {
    // checking if the error is a known validation error from our parse functions
    if (
      err.message.includes("Customer name") ||
      err.message.includes("percent")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    // P2002 is Prisma's unique constraint violation — means the phone number is already taken
    if (err.code === "P2002") {
      res.status(409).json({ error: "Phone number already exists" });
      return;
    }
    console.error("Create customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// updating an existing customer — only the fields that are provided in the request body get changed
export async function update(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const data: any = {};

    // building the update object with only the fields that were actually sent
    // each field is validated through its respective parse function
    if (body.name !== undefined) {
      data.name = parseCustomerName(body.name);
    }
    if (body.phone !== undefined) {
      data.phone = parseOptionalText(body.phone) || null; // setting to null if empty so the field gets cleared in the database
    }
    if (body.email !== undefined) {
      data.email = parseOptionalText(body.email) || null;
    }
    if (body.loyaltyPercent !== undefined) {
      data.loyaltyPercent = parsePercent(
        body.loyaltyPercent,
        "Loyalty percent",
      );
    }
    if (body.wholesalePercent !== undefined) {
      data.wholesalePercent = parsePercent(
        body.wholesalePercent,
        "Wholesale percent",
      );
    }
    if (body.isActive !== undefined) {
      data.isActive = parseBooleanValue(body.isActive);
    }

    const customer = await custService.updateCustomer(String(req.params.id), data);
    res.json(customer);
  } catch (err: any) {
    if (
      err.message.includes("Customer name") ||
      err.message.includes("percent")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ error: "Phone number already exists" });
      return;
    }
    console.error("Update customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// deactivating a customer — we soft-delete by setting isActive to false instead of removing the record
// this way the customer's data is still available for existing invoices and history
export async function deactivate(req: Request, res: Response) {
  try {
    const customer = await custService.deactivateCustomer(String(req.params.id));
    res.json(customer);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    console.error("Deactivate customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
