import { Request, Response } from "express";
import { parse } from "csv-parse";
import { Readable } from "stream";
import * as productService from "./service";

function parseRequiredText(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function parseOptionalText(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function parseBooleanValue(value: unknown) {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
}

function parseOptionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseBooleanValue(value);
}

function parseOptionalNumber(
  value: unknown,
  label: string,
  options?: { min?: number },
) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a valid number`);
  }
  if (typeof options?.min === "number" && normalized < options.min) {
    throw new Error(`${label} must be at least ${options.min}`);
  }

  return normalized;
}

function parseRequiredNumber(
  value: unknown,
  label: string,
  options?: { min?: number },
) {
  const normalized = parseOptionalNumber(value, label, options);
  if (normalized === undefined) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export async function list(req: Request, res: Response) {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      brand: req.query.brand as string | undefined,
      category: req.query.category as string | undefined,
      isActive:
        req.query.active === "true"
          ? true
          : req.query.active === "false"
            ? false
            : undefined,
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
    const productId = String(req.params.id);
    const product = await productService.getProduct(productId);
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
    const product = await productService.createProduct({
      name: parseRequiredText(req.body.name, "name"),
      sku: parseRequiredText(req.body.sku, "sku"),
      barcode: parseOptionalText(req.body.barcode),
      brandId: parseRequiredText(req.body.brandId, "brandId"),
      category: parseOptionalText(req.body.category),
      retailPrice: parseRequiredNumber(req.body.retailPrice, "retailPrice", {
        min: 0.01,
      }),
      wholesalePrice: parseRequiredNumber(
        req.body.wholesalePrice,
        "wholesalePrice",
        {
          min: 0.01,
        },
      ),
      wholesaleQtyThreshold: parseOptionalNumber(
        req.body.wholesaleQtyThreshold,
        "wholesaleQtyThreshold",
        { min: 1 },
      ),
      usesDefaultWholesaleQtyThreshold: parseOptionalBoolean(
        req.body.usesDefaultWholesaleQtyThreshold,
      ),
      stock: parseOptionalNumber(req.body.stock, "stock", { min: 0 }),
      lowStockThreshold: parseOptionalNumber(
        req.body.lowStockThreshold,
        "lowStockThreshold",
        { min: 0 },
      ),
      usesDefaultLowStockThreshold: parseOptionalBoolean(
        req.body.usesDefaultLowStockThreshold,
      ),
      isActive: parseOptionalBoolean(req.body.isActive),
    });

    res.status(201).json(product);
  } catch (err: any) {
    if (
      err.message.includes("required") ||
      err.message.includes("must be")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ error: "SKU or barcode already exists" });
      return;
    }
    if (err.code === "P2003") {
      res.status(400).json({ error: "Brand not found" });
      return;
    }
    console.error("Create product error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const body = req.body || {};
    const data: any = {};

    if (body.name !== undefined) {
      data.name = parseRequiredText(body.name, "name");
    }
    if (body.sku !== undefined) {
      data.sku = parseRequiredText(body.sku, "sku");
    }
    if (body.barcode !== undefined) {
      data.barcode = parseOptionalText(body.barcode) || null;
    }
    if (body.brandId !== undefined) {
      data.brandId = parseRequiredText(body.brandId, "brandId");
    }
    if (body.category !== undefined) {
      data.category = parseOptionalText(body.category) || null;
    }
    if (body.retailPrice !== undefined) {
      data.retailPrice = parseOptionalNumber(body.retailPrice, "retailPrice", {
        min: 0.01,
      });
    }
    if (body.wholesalePrice !== undefined) {
      data.wholesalePrice = parseOptionalNumber(
        body.wholesalePrice,
        "wholesalePrice",
        { min: 0.01 },
      );
    }
    if (body.wholesaleQtyThreshold !== undefined) {
      data.wholesaleQtyThreshold = parseOptionalNumber(
        body.wholesaleQtyThreshold,
        "wholesaleQtyThreshold",
        { min: 1 },
      );
    }
    if (body.usesDefaultWholesaleQtyThreshold !== undefined) {
      data.usesDefaultWholesaleQtyThreshold = parseOptionalBoolean(
        body.usesDefaultWholesaleQtyThreshold,
      );
    }
    if (body.stock !== undefined) {
      data.stock = parseOptionalNumber(body.stock, "stock", { min: 0 });
    }
    if (body.lowStockThreshold !== undefined) {
      data.lowStockThreshold = parseOptionalNumber(
        body.lowStockThreshold,
        "lowStockThreshold",
        { min: 0 },
      );
    }
    if (body.usesDefaultLowStockThreshold !== undefined) {
      data.usesDefaultLowStockThreshold = parseOptionalBoolean(
        body.usesDefaultLowStockThreshold,
      );
    }
    if (body.imageUrl !== undefined) {
      data.imageUrl = parseOptionalText(body.imageUrl) || null;
    }
    if (body.isActive !== undefined) {
      data.isActive = parseBooleanValue(body.isActive);
    }

    const product = await productService.updateProduct(productId, data);
    res.json(product);
  } catch (err: any) {
    if (
      err.message.includes("required") ||
      err.message.includes("must be")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ error: "SKU or barcode already exists" });
      return;
    }
    if (err.code === "P2003") {
      res.status(400).json({ error: "Brand not found" });
      return;
    }
    console.error("Update product error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deactivate(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const product = await productService.deactivateProduct(productId);
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
        bom: true,
      }),
    );

    for await (const record of parser) {
      records.push(record);
    }

    const result = await productService.importProductsFromCsv(records);
    res.json(result);
  } catch (err) {
    console.error("Import CSV error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
