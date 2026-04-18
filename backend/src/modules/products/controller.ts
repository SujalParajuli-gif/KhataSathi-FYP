import { Request, Response } from "express";
import { parse } from "csv-parse";
import { Readable } from "stream";
import * as productService from "./service";

// validating that a required text field is present and not just whitespace
function parseRequiredText(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

// converting any input to a trimmed string, returning undefined if empty
function parseOptionalText(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

// converting various input types to a boolean
function parseBooleanValue(value: unknown) {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
}

// returning a boolean if provided, or undefined if the field is missing
// this is important because undefined means "do not change this field" in an update
function parseOptionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseBooleanValue(value);
}

// validating an optional numeric field — checks that it is a valid finite number
// and optionally enforces a minimum value (e.g., prices must be >= 0.01)
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

// same as parseOptionalNumber but the value is required — it cannot be empty or missing
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

// listing products with optional filters — supports search, brand, category, active status, low stock, and pagination
export async function list(req: Request, res: Response) {
  try {
    // reading all filter options from the query string
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
      lowStockOnly: req.query.lowStock === "true", // when true, only show products where stock is below the threshold
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

// fetching a single product by its ID
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

// creating a new product — all input values are validated through the parse helper functions
export async function create(req: Request, res: Response) {
  try {
    const product = await productService.createProduct({
      name: parseRequiredText(req.body.name, "name"),
      sku: parseRequiredText(req.body.sku, "sku"),
      barcode: parseOptionalText(req.body.barcode),
      brandId: parseRequiredText(req.body.brandId, "brandId"),
      category: parseOptionalText(req.body.category),
      retailPrice: parseRequiredNumber(req.body.retailPrice, "retailPrice", {
        min: 0.01, // price must be at least 0.01
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
        { min: 1 }, // quantity threshold must be at least 1
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
    // checking for validation errors from our parse functions
    if (
      err.message.includes("required") ||
      err.message.includes("must be")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    // P2002 = unique constraint violation — SKU or barcode already exists
    if (err.code === "P2002") {
      res.status(409).json({ error: "SKU or barcode already exists" });
      return;
    }
    // P2003 = foreign key constraint — the brand ID does not point to an existing brand
    if (err.code === "P2003") {
      res.status(400).json({ error: "Brand not found" });
      return;
    }
    console.error("Create product error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// updating an existing product — only the fields that are provided in the request body get changed
export async function update(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const body = req.body || {};
    const data: any = {};

    // building the update object — each field is only included if it was actually sent in the request
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

// deactivating a product — soft delete by setting isActive to false
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

// returning all unique product categories from the database
// the frontend uses this to populate the category filter dropdown
export async function categories(req: Request, res: Response) {
  try {
    const cats = await productService.getCategories();
    res.json(cats);
  } catch (err) {
    console.error("Categories error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// handling bulk product import from a CSV file
// the file is uploaded in memory (not saved to disk), then parsed and processed row by row
export async function importCsv(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "CSV file is required" });
      return;
    }

    const records: any[] = [];
    const stream = Readable.from(file.buffer); // creating a readable stream from the file buffer

    // parsing the CSV with column headers, skipping empty lines, and trimming whitespace
    const parser = stream.pipe(
      parse({
        columns: true, // first row is treated as column headers
        skip_empty_lines: true,
        trim: true,
        bom: true, // handling byte order mark that some editors add
      }),
    );

    // collecting all parsed rows into an array
    for await (const record of parser) {
      records.push(record);
    }

    const result = await productService.importProductsFromCsv(records); // processing each row and creating products
    res.json(result);
  } catch (err) {
    console.error("Import CSV error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
