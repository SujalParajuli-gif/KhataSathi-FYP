import { Request, Response } from "express";
import * as inventoryService from "./service";

// handling product restocking — the admin adds a specific quantity to a product's stock
export async function restock(req: Request, res: Response) {
    try {
        const { productId, qty, reason } = req.body;
        // validating that both the product ID and a valid quantity (at least 1) are provided
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

// handling manual stock adjustment — the admin can increase or decrease stock with a reason
// unlike restock which only adds, this allows negative values for corrections (e.g., damaged goods)
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
        // checking for "not found" and "negative stock" errors which are known business rule violations
        if (err.message.includes("not found") || err.message.includes("negative")) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Adjust error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// returning all active products that have stock at or below their low stock threshold
// the frontend uses this to show alerts about products that need restocking
export async function lowStock(req: Request, res: Response) {
    try {
        const products = await inventoryService.getLowStockProducts();
        res.json(products);
    } catch (err) {
        console.error("Low stock error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// listing recent stock transactions, optionally filtered by product ID
// this shows the full history of stock changes (sales, restocks, adjustments)
export async function stockTransactions(req: Request, res: Response) {
    try {
        const productId = req.query.productId as string | undefined; // optional filter by product
        const limit = req.query.limit ? Number(req.query.limit) : 50; // how many transactions to return, defaults to 50
        const txs = await inventoryService.getStockTransactions(productId, limit);
        res.json(txs);
    } catch (err) {
        console.error("Stock transactions error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
