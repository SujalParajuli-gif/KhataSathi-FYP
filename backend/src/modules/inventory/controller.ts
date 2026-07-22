import { Request, Response } from "express";
import fs from "fs/promises";
import * as inventoryService from "./service";
import * as documentService from "../documents/service";
import { formatZodIssues } from "../../lib/requestValidation";
import { adjustStockBodySchema } from "./validation";

function cleanupUploadedFiles(req: Request) {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files) return Promise.resolve();
    return Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {}))).then(() => undefined);
}

function parseReceiveLines(raw: unknown): inventoryService.ReceiveStockLineInput[] {
    if (Array.isArray(raw)) return raw as inventoryService.ReceiveStockLineInput[];
    if (typeof raw !== "string") return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseDocumentIds(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export async function receiveBatch(req: Request, res: Response) {
    try {
        const {
            supplierName,
            billNumber,
            billDate,
            billAmount,
            remarks,
            reason,
        } = req.body;
        const lines = parseReceiveLines(req.body.lines);
        const documentIds = parseDocumentIds(req.body.documentIds);

        if (!supplierName || lines.length === 0) {
            await cleanupUploadedFiles(req);
            res.status(400).json({ error: "supplierName and at least one received line are required" });
            return;
        }

        if (documentIds.length > 0) {
            await documentService.assertDocumentsCanLinkToEntity({
                documentIds,
                documentType: "STOCK_BILL",
                linkedEntityType: "StockReceiveBatch",
                viewerRole: req.user!.role,
            });
        }

        const batch = await inventoryService.receiveStockBatch(
            {
                supplierName,
                billNumber: billNumber || undefined,
                billDate: billDate || undefined,
                billAmount: billAmount ? Number(billAmount) : undefined,
                remarks: remarks || undefined,
                reason: reason || undefined,
                lines,
            },
            req.user!.id,
        );

        if (!batch) {
            throw new Error("Stock receive batch was not saved.");
        }

        let documents: any[] = [];
        let linkedDocuments: any[] = [];
        let documentWarning: string | undefined;
        if (documentIds.length > 0) {
            linkedDocuments = await documentService.linkDocumentsToEntity({
                documentIds,
                documentType: "STOCK_BILL",
                linkedEntityType: "StockReceiveBatch",
                linkedEntityId: batch.id,
                userId: req.user!.id,
                viewerRole: req.user!.role,
                metadata: {
                    supplierName,
                    billNumber: billNumber || undefined,
                    billDate: billDate || undefined,
                    billAmount: billAmount ? Number(billAmount) : undefined,
                    remarks: remarks || undefined,
                },
            });
        }

        const files = req.files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
            try {
                documents = await documentService.createDocuments(
                    files.map((f) => ({
                        originalname: f.originalname,
                        mimetype: f.mimetype,
                        size: f.size,
                        path: f.path,
                    })),
                    {
                        documentType: "STOCK_BILL",
                        supplierName,
                        billNumber: billNumber || undefined,
                        billDate: billDate || undefined,
                        billAmount: billAmount ? Number(billAmount) : undefined,
                        remarks: remarks || undefined,
                        linkedEntityType: "StockReceiveBatch",
                        linkedEntityId: batch?.id,
                    },
                    req.user!.id,
                );
            } catch (docErr) {
                console.error("Receive batch bill document upload failed:", docErr);
                documentWarning = "Stock was received, but bill file upload failed.";
                await inventoryService.recordStockReceiveBillUploadFailure({
                    batchId: batch?.id,
                    actorId: req.user!.id,
                    actorRole: req.user!.role,
                    supplierName,
                    fileCount: files.length,
                    error: docErr,
                });
                await cleanupUploadedFiles(req);
            }
        }

        res.status(201).json({ batch, documents, linkedDocuments, documentWarning });
    } catch (err: any) {
        await cleanupUploadedFiles(req);

        if (
            err.message?.includes("required") ||
            err.message?.includes("not found") ||
            err.message?.includes("greater than zero") ||
            err.message?.includes("negative") ||
            err.message?.includes("quantity") ||
            err.message?.includes("Product is required")
        ) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error("Receive batch error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// handling product restocking — the admin adds a specific quantity to a product's stock
// now also supports optional bill photo/PDF uploads via multipart/form-data
export async function restock(req: Request, res: Response) {
    try {
        const { productId, qty, reason, supplierName, billNumber, billDate, billAmount } = req.body;
        // validating that both the product ID and a valid positive quantity are provided
        if (!productId || qty === undefined || Number(qty) <= 0) {
            // cleaning up any uploaded temp files before returning error
            const files = req.files as Express.Multer.File[] | undefined;
            if (files) {
                await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
            }
            res.status(400).json({ error: "productId and qty (> 0) required" });
            return;
        }

        // performing the stock update
        const product = await inventoryService.restockProduct(productId, Number(qty), reason, req.user!.id);

        // if bill files were uploaded, save them as documents linked to this stock transaction
        let documents: any[] = [];
        const files = req.files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
            try {
                // finding the stock transaction that was just created for this restock
                // it is the most recent RESTOCK transaction for this product by this user
                const recentTx = await inventoryService.getRecentRestockTransaction(productId, req.user!.id);

                documents = await documentService.createDocuments(
                    files.map((f) => ({
                        originalname: f.originalname,
                        mimetype: f.mimetype,
                        size: f.size,
                        path: f.path,
                    })),
                    {
                        documentType: "STOCK_BILL",
                        supplierName: supplierName || undefined,
                        billNumber: billNumber || undefined,
                        billDate: billDate || undefined,
                        billAmount: billAmount ? Number(billAmount) : undefined,
                        linkedEntityType: "StockTransaction",
                        linkedEntityId: recentTx?.id,
                    },
                    req.user!.id,
                );
            } catch (docErr) {
                // stock update succeeded but document upload failed
                // we log the error but don't fail the entire restock operation
                console.error("Bill document upload failed (restock succeeded):", docErr);
                // cleaning up any remaining temp files
                await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
            }
        }

        res.json({ product, documents });
    } catch (err: any) {
        // cleaning up temp files on error
        const files = req.files as Express.Multer.File[] | undefined;
        if (files) {
            await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
        }

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
        const parsed = adjustStockBodySchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: "Invalid stock adjustment payload",
                details: formatZodIssues(parsed.error),
            });
            return;
        }
        const { productId, qtyDelta, reason } = parsed.data;
        const product = await inventoryService.adjustStock(productId, qtyDelta, reason || "", req.user!.id);
        res.json(product);
    } catch (err: any) {
        // checking for "not found" and "negative stock" errors which are known business rule violations
        if (
            err.message.includes("not found") ||
            err.message.includes("negative") ||
            err.message.includes("cannot be zero") ||
            err.message.includes("Product is required")
        ) {
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

export async function receiveBatches(req: Request, res: Response) {
    try {
        const result = await inventoryService.getStockReceiveBatches({
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            page: req.query.page ? Number(req.query.page) : undefined,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
            supplierName: req.query.supplierName as string | undefined,
            billNumber: req.query.billNumber as string | undefined,
            from: req.query.from as string | undefined,
            to: req.query.to as string | undefined,
        });
        res.json(result);
    } catch (err) {
        console.error("Receive batches error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function receiveBatchDetail(req: Request, res: Response) {
    try {
        const batch = await inventoryService.getStockReceiveBatchById(String(req.params.id));
        res.json(batch);
    } catch (err: any) {
        if (err.message?.includes("not found")) {
            res.status(404).json({ error: err.message });
            return;
        }
        console.error("Receive batch detail error:", err);
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
