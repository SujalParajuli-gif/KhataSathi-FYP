import { Request, Response } from "express";
import * as inventoryService from "./service";

export async function restock(req: Request, res: Response) {
    try {
        const { productId, qty, reason } = req.body;
        if (!productId || !qty || qty < 1) {
            res.status(400).json({ error: "productId and qty (>= 1) required" });
            return;
        }
        const product = await inventoryService.restockProduct(productId, Number(qty), reason, req.user!.id);
        res.json(product);
    } catch (err: any) {
        if (err.message.includes("not found")) {
            res.status(404).json({ error: err.message });
            return;
        }
        console.error("Restock error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function adjust(req: Request, res: Response) {
    try {
        const { productId, qtyDelta, reason } = req.body;
        if (!productId || qtyDelta === undefined) {
            res.status(400).json({ error: "productId and qtyDelta required" });
            return;
        }
        const product = await inventoryService.adjustStock(productId, Number(qtyDelta), reason, req.user!.id);
        res.json(product);
    } catch (err: any) {
        if (err.message.includes("not found") || err.message.includes("negative")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Adjust error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function lowStock(req: Request, res: Response) {
    try {
        const products = await inventoryService.getLowStockProducts();
        res.json(products);
    } catch (err) {
        console.error("Low stock error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function stockTransactions(req: Request, res: Response) {
    try {
        const productId = req.query.productId as string | undefined;
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const txs = await inventoryService.getStockTransactions(productId, limit);
        res.json(txs);
    } catch (err) {
        console.error("Stock transactions error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
