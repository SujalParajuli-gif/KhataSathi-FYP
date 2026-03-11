// src/modules/products/controller.ts — Product route handlers
import { Request, Response } from "express";
import * as productService from "./service";
import { parse } from "csv-parse";
import { Readable } from "stream";

export async function list(req: Request, res: Response) {
    try {
        const filters = {
            search: req.query.search as string | undefined,
            brand: req.query.brand as string | undefined,
            category: req.query.category as string | undefined,
            isActive: req.query.active === "true" ? true : req.query.active === "false" ? false : undefined,
            lowStockOnly: req.query.lowStock === "true",
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
        };

        const result = await productService.listProducts(filters);
        res.json(result);
    } catch (err) {
        console.error("List products error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function getOne(req: Request, res: Response) {
    try {
        const product = await productService.getProduct(req.params.id);
        if (!product) {
            res.status(404).json({ error: "Product not found" });
            return;
        }
        res.json(product);
    } catch (err) {
        console.error("Get product error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function create(req: Request, res: Response) {
    try {
        const { name, sku, barcode, brandId, category, retailPrice, wholesalePrice, wholesaleQtyThreshold, stock, lowStockThreshold } = req.body;

        if (!name || !sku || !brandId || retailPrice === undefined || wholesalePrice === undefined) {
            res.status(400).json({ error: "name, sku, brandId, retailPrice, and wholesalePrice are required" });
            return;
        }

        const product = await productService.createProduct({
            name, sku, barcode, brandId, category,
            retailPrice: Number(retailPrice),
            wholesalePrice: Number(wholesalePrice),
            wholesaleQtyThreshold: wholesaleQtyThreshold ? Number(wholesaleQtyThreshold) : undefined,
            stock: stock ? Number(stock) : undefined,
            lowStockThreshold: lowStockThreshold ? Number(lowStockThreshold) : undefined,
        });

        res.status(201).json(product);
    } catch (err: any) {
        if (err.code === "P2002") {
            res.status(409).json({ error: "SKU or barcode already exists" });
            return;
        }
        console.error("Create product error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function update(req: Request, res: Response) {
    try {
        const product = await productService.updateProduct(req.params.id, req.body);
        res.json(product);
    } catch (err: any) {
        if (err.code === "P2025") {
            res.status(404).json({ error: "Product not found" });
            return;
        }
        if (err.code === "P2002") {
            res.status(409).json({ error: "SKU or barcode already exists" });
            return;
        }
        console.error("Update product error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function deactivate(req: Request, res: Response) {
    try {
        const product = await productService.deactivateProduct(req.params.id);
        res.json(product);
    } catch (err: any) {
        if (err.code === "P2025") {
            res.status(404).json({ error: "Product not found" });
            return;
        }
        console.error("Deactivate product error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function categories(req: Request, res: Response) {
    try {
        const cats = await productService.getCategories();
        res.json(cats);
    } catch (err) {
        console.error("Categories error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function importCsv(req: Request, res: Response) {
    try {
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "CSV file is required" });
            return;
        }

        const records: any[] = [];
        const stream = Readable.from(file.buffer);

        const parser = stream.pipe(
            parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
            })
        );

        for await (const record of parser) {
            records.push(record);
        }

        let created = 0;
        let errors: string[] = [];

        for (const row of records) {
            try {
                await productService.createProduct({
                    name: row.name,
                    sku: row.sku,
                    barcode: row.barcode || undefined,
                    brandId: row.brandId,
                    category: row.category || undefined,
                    retailPrice: Number(row.retailPrice),
                    wholesalePrice: Number(row.wholesalePrice),
                    wholesaleQtyThreshold: row.wholesaleQtyThreshold ? Number(row.wholesaleQtyThreshold) : undefined,
                    stock: row.stock ? Number(row.stock) : undefined,
                    lowStockThreshold: row.lowStockThreshold ? Number(row.lowStockThreshold) : undefined,
                });
                created++;
            } catch (err: any) {
                errors.push(`Row ${row.sku || "?"}: ${err.message}`);
            }
        }

        res.json({ created, errors, total: records.length });
    } catch (err) {
        console.error("Import CSV error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}
