// src/modules/invoices/controller.ts — Invoice route handlers
import { Request, Response } from "express";
import * as invoiceService from "./service";

export async function createDraft(req: Request, res: Response) {
    try {
        const cashierId = req.user!.id;
        const { customerId } = req.body;
        const invoice = await invoiceService.createDraft(cashierId, customerId);
        res.status(201).json(invoice);
    } catch (err) {
        console.error("Create draft error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function list(req: Request, res: Response) {
    try {
        const filters = {
            status: req.query.status as string | undefined,
            cashierId: req.query.cashierId as string | undefined,
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
        };
        const result = await invoiceService.listInvoices(filters);
        res.json(result);
    } catch (err) {
        console.error("List invoices error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function getOne(req: Request, res: Response) {
    try {
        const invoice = await invoiceService.getInvoice(req.params.id);
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
        const { productId, qty } = req.body;
        if (!productId || !qty || qty < 1) {
            res.status(400).json({ error: "productId and qty (>= 1) are required" });
            return;
        }
        const item = await invoiceService.addItem(req.params.id, productId, Number(qty));
        res.status(201).json(item);
    } catch (err: any) {
        if (err.message.includes("finalized") || err.message.includes("not found") || err.message.includes("inactive")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Add item error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function updateItem(req: Request, res: Response) {
    try {
        const { qty } = req.body;
        if (!qty || qty < 1) {
            res.status(400).json({ error: "qty (>= 1) is required" });
            return;
        }
        const item = await invoiceService.updateItem(req.params.id, req.params.itemId, Number(qty));
        res.json(item);
    } catch (err: any) {
        if (err.message.includes("finalized") || err.message.includes("not found")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Update item error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function removeItem(req: Request, res: Response) {
    try {
        await invoiceService.removeItem(req.params.id, req.params.itemId);
        res.json({ message: "Item removed" });
    } catch (err: any) {
        if (err.message.includes("finalized") || err.message.includes("not found")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Remove item error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function finalize(req: Request, res: Response) {
    try {
        const userId = req.user!.id;
        const invoice = await invoiceService.finalizeInvoice(req.params.id, userId);
        res.json(invoice);
    } catch (err: any) {
        if (err.message.includes("finalized") || err.message.includes("not found") || err.message.includes("Insufficient") || err.message.includes("empty")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Finalize error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
