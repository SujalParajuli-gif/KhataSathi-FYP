import { Request, Response } from "express";
import * as custService from "./service";

export async function list(req: Request, res: Response) {
  try {
    const activeOnly = req.query.active === "true";
    const customers = await custService.listCustomers(activeOnly);
    res.json(customers);
  } catch (err) {
    console.error("List customers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getOne(req: Request, res: Response) {
  try {
    const customer = await custService.getCustomer(req.params.id);
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

export async function create(req: Request, res: Response) {
  try {
    const { name, phone, email, loyaltyPercent, wholesalePercent } = req.body;
    if (!name) {
      res.status(400).json({ error: "Customer name is required" });
      return;
    }
    const newCust = await custService.createCustomer({
      name: String(name).trim(),
      phone: phone ? String(phone).trim() : undefined,
      email: email ? String(email).trim() : undefined,
      loyaltyPercent: Number(loyaltyPercent) || 0,
      wholesalePercent: Number(wholesalePercent) || 0,
    });
    res.status(201).json(newCust);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Phone number already exists" });
      return;
    }
    console.error("Create customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const body = { ...req.body };
    if (body.phone !== undefined) body.phone = body.phone ? String(body.phone).trim() : null;
    if (body.email !== undefined) body.email = body.email ? String(body.email).trim() : null;
    const customer = await custService.updateCustomer(req.params.id, body);
    res.json(customer);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    console.error("Update customer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deactivate(req: Request, res: Response) {
  try {
    const customer = await custService.deactivateCustomer(req.params.id);
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
