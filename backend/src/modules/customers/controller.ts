// src/modules/customers/controller.ts — Customer route handlers
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
        const { name, phone, loyaltyPercent } = req.body;
        if (!name || !name.trim()) {
            res.status(400).json({ error: "Customer name is required" });
            return;
        }
        if (loyaltyPercent !== undefined && (loyaltyPercent < 0 || loyaltyPercent > 100)) {
            res.status(400).json({ error: "loyaltyPercent must be 0–100" });
            return;
        }
        const customer = await custService.createCustomer({ name: name.trim(), phone, loyaltyPercent });
        res.status(201).json(customer);
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
        const customer = await custService.updateCustomer(req.params.id, req.body);
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
