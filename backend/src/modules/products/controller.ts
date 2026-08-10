import { Request, Response } from "express";
import fs from "fs/promises";
import { PDFParse } from "pdf-parse";
import * as productService from "./service";
import * as documentService from "../documents/service";
import { getCashierPrivilege } from "../settings/service";
import {
  redactInventoryFromProduct,
  redactProductForLookup,
  resolveProductLookupVisibility,
} from "./lookupVisibility";
import { getBusinessCapabilities } from "../settings/capabilities";
import {
  recordProductSearchQuery,
  recordProductSearchSelection,
  type ProductSearchSource,
} from "./searchLogging";
import {
  parseProductSpreadsheet,
  SpreadsheetImportError,
} from "./spreadsheetImport";

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

function readProductListFilters(req: Request) {
  const requestedPage = req.query.page ? Number(req.query.page) : 1;
  const requestedPageSize = req.query.pageSize
    ? Number(req.query.pageSize)
    : 50;

  return {
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
    stockStatus:
      req.query.stockStatus === "in" ||
      req.query.stockStatus === "low" ||
      req.query.stockStatus === "out"
        ? (req.query.stockStatus as "in" | "low" | "out")
        : undefined,
    includeDraftReservations: req.query.draftReservations === "true",
    page:
      Number.isInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1,
    pageSize:
      Number.isInteger(requestedPageSize) && requestedPageSize > 0
        ? Math.min(requestedPageSize, 200)
        : 50,
  };
}

async function safelyRecordProductListSearch(
  req: Request,
  source: ProductSearchSource,
  filters: ReturnType<typeof readProductListFilters>,
  resultCount: number,
  durationMs: number,
) {
  try {
    const log = await recordProductSearchQuery({
      rawQuery: filters.search,
      source,
      filters,
      resultCount,
      durationMs,
      actorId: req.user?.id,
      sessionId: req.header("x-product-search-session"),
      page: filters.page,
    });
    return log?.id || null;
  } catch (error) {
    // Analytics must never make the product catalog unavailable.
    console.error("Product search logging error:", error);
    return null;
  }
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
    const capabilities = await getBusinessCapabilities();
    const filters = readProductListFilters(req);
    if (!capabilities.stockTracked) {
      filters.lowStockOnly = false;
      filters.stockStatus = undefined;
      filters.includeDraftReservations = false;
    }
    const startedAt = Date.now();
    const result = await productService.listProducts(filters);
    const searchLogId = await safelyRecordProductListSearch(
      req,
      "PRODUCTS",
      filters,
      result.total,
      Date.now() - startedAt,
    );
    res.json({
      ...result,
      products: capabilities.stockTracked
        ? result.products
        : result.products.map((product) =>
            redactInventoryFromProduct(product as Record<string, any>),
          ),
      stockTracked: capabilities.stockTracked,
      searchLogId,
    });
  } catch (err) {
    console.error("List products error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Product Lookup has a narrower, role-aware response than product management.
// Purchase cost is admin-only and wholesale values follow the saved per-user
// VIEW WHOLESALE permission, so unauthorized prices never reach the browser.
export async function listForPriceLookup(req: Request, res: Response) {
  try {
    const capabilities = await getBusinessCapabilities();
    const filters = readProductListFilters(req);
    if (!capabilities.stockTracked) {
      filters.lowStockOnly = false;
      filters.stockStatus = undefined;
      filters.includeDraftReservations = false;
    }
    const startedAt = Date.now();
    const result = await productService.listProducts(filters);
    const searchDurationMs = Date.now() - startedAt;
    const [privilege, searchLogId] = await Promise.all([
      req.user!.role === "ADMIN"
        ? Promise.resolve({ canViewWholesalePrice: true })
        : getCashierPrivilege(req.user!.id),
      safelyRecordProductListSearch(
        req,
        "PRODUCT_LOOKUP",
        filters,
        result.total,
        searchDurationMs,
      ),
    ]);
    const visibility = resolveProductLookupVisibility(
      req.user!.role,
      privilege.canViewWholesalePrice === true,
    );

    res.set("Cache-Control", "private, no-store");
    res.json({
      ...result,
      products: result.products.map((product) => {
        const visible = redactProductForLookup(
          product as Record<string, any>,
          visibility,
        );
        return capabilities.stockTracked
          ? visible
          : redactInventoryFromProduct(visible);
      }),
      visibility,
      stockTracked: capabilities.stockTracked,
      searchLogId,
    });
  } catch (err) {
    console.error("Price lookup products error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function recordSearchSelection(req: Request, res: Response) {
  try {
    await recordProductSearchSelection({
      searchLogId: req.body.searchLogId,
      productId: req.body.productId,
      action: req.body.action,
      actorId: req.user!.id,
    });
    res.status(204).send();
  } catch (error: any) {
    const status = Number(error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Product search selection logging error:", error);
    res.status(500).json({ error: "Search selection could not be recorded." });
  }
}

// fetching a single product by its ID
export async function getOne(req: Request, res: Response) {
  try {
    const capabilities = await getBusinessCapabilities();
    const productId = String(req.params.id);
    const product = await productService.getProduct(productId);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(
      capabilities.stockTracked
        ? product
        : redactInventoryFromProduct(product as Record<string, any>),
    );
  } catch (err) {
    console.error("Get product error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getMany(req: Request, res: Response) {
  try {
    const capabilities = await getBusinessCapabilities();
    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      res.json({ products: [] });
      return;
    }
    if (ids.length > 50) {
      res.status(400).json({ error: "A maximum of 50 products can be refreshed at once." });
      return;
    }
    const products = await productService.getProductsByIds(ids);
    res.json({
      products: capabilities.stockTracked
        ? products
        : products.map((product) =>
            redactInventoryFromProduct(product as Record<string, any>),
          ),
      stockTracked: capabilities.stockTracked,
    });
  } catch (err) {
    console.error("Batch product lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getByCode(req: Request, res: Response) {
  try {
    const capabilities = await getBusinessCapabilities();
    const code = String(req.query.code || "").trim();
    if (!code) {
      res.status(400).json({ error: "SKU or barcode is required" });
      return;
    }
    const product = await productService.getProductByCode(code);
    if (!product) {
      res.status(404).json({ error: "Active product not found" });
      return;
    }
    res.json(
      capabilities.stockTracked
        ? product
        : redactInventoryFromProduct(product as Record<string, any>),
    );
  } catch (err) {
    console.error("Product code lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// creating a new product — all input values are validated through the parse helper functions
export async function create(req: Request, res: Response) {
  try {
    const capabilities = await getBusinessCapabilities();
    const product = await productService.createProduct({
      name: parseRequiredText(req.body.name, "name"),
      productName: parseOptionalText(req.body.productName),
      sku: parseOptionalText(req.body.sku),
      barcode: parseOptionalText(req.body.barcode),
      brandId: parseOptionalText(req.body.brandId),
      brandName: parseOptionalText(req.body.brandName),
      category: parseOptionalText(req.body.category),
      categoryGroup: parseOptionalText(req.body.categoryGroup),
      vendorSource: parseOptionalText(req.body.vendorSource),
      productCodeVariant: parseOptionalText(req.body.productCodeVariant),
      sizeValue: parseOptionalNumber(req.body.sizeValue, "sizeValue", { min: 0 }),
      sizeUnit: parseOptionalText(req.body.sizeUnit),
      ratePerPiece: parseOptionalNumber(req.body.ratePerPiece, "ratePerPiece", {
        min: 0,
      }),
      packageQuantity: parseOptionalNumber(
        req.body.packageQuantity,
        "packageQuantity",
        { min: 0 },
      ),
      packageUnit: parseOptionalText(req.body.packageUnit),
      saleUnit: parseOptionalText(req.body.saleUnit),
      allowFractionalQty: parseOptionalBoolean(req.body.allowFractionalQty),
      quantityStep: parseOptionalNumber(req.body.quantityStep, "quantityStep", {
        min: 0.001,
      }),
      wholesaleEligible: parseOptionalBoolean(req.body.wholesaleEligible),
      sourceCitation: parseOptionalText(req.body.sourceCitation),
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
      stock: capabilities.stockTracked
        ? parseOptionalNumber(req.body.stock, "stock", { min: 0 })
        : 0,
      lowStockThreshold: parseOptionalNumber(
        req.body.lowStockThreshold,
        "lowStockThreshold",
        { min: 0 },
      ),
      usesDefaultLowStockThreshold: parseOptionalBoolean(
        req.body.usesDefaultLowStockThreshold,
      ),
      isActive: parseOptionalBoolean(req.body.isActive),
    }, req.user!.id);

    res.status(201).json(
      capabilities.stockTracked
        ? product
        : redactInventoryFromProduct(product as Record<string, any>),
    );
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
    const capabilities = await getBusinessCapabilities();
    const productId = String(req.params.id);
    const body = req.body || {};
    const data: any = {};

    // building the update object — each field is only included if it was actually sent in the request
    if (body.name !== undefined) {
      data.name = parseRequiredText(body.name, "name");
    }
    if (body.productName !== undefined) {
      data.productName = parseOptionalText(body.productName) || null;
    }
    if (body.sku !== undefined) {
      data.sku = parseRequiredText(body.sku, "sku");
    }
    if (body.barcode !== undefined) {
      data.barcode = parseOptionalText(body.barcode) || null;
      data.barcodeOrigin = data.barcode ? "MANUFACTURER" : "INTERNAL";
    }
    if (body.brandId !== undefined) {
      data.brandId = parseRequiredText(body.brandId, "brandId");
    }
    if (body.brandName !== undefined) {
      data.brandName = parseOptionalText(body.brandName);
    }
    if (body.category !== undefined) {
      data.category = parseOptionalText(body.category) || null;
    }
    if (body.categoryGroup !== undefined) {
      data.categoryGroup = parseOptionalText(body.categoryGroup) || null;
    }
    if (body.vendorSource !== undefined) {
      data.vendorSource = parseOptionalText(body.vendorSource) || null;
    }
    if (body.productCodeVariant !== undefined) {
      data.productCodeVariant = parseOptionalText(body.productCodeVariant) || null;
    }
    if (body.sizeValue !== undefined) {
      data.sizeValue = parseOptionalNumber(body.sizeValue, "sizeValue", { min: 0 }) ?? null;
    }
    if (body.sizeUnit !== undefined) {
      data.sizeUnit = parseOptionalText(body.sizeUnit) || "STANDARD";
    }
    if (body.ratePerPiece !== undefined) {
      data.ratePerPiece = parseOptionalNumber(body.ratePerPiece, "ratePerPiece", {
        min: 0,
      });
    }
    if (body.packageQuantity !== undefined) {
      data.packageQuantity = parseOptionalNumber(
        body.packageQuantity,
        "packageQuantity",
        { min: 0 },
      );
    }
    if (body.packageUnit !== undefined) {
      data.packageUnit = parseOptionalText(body.packageUnit) || "PIECE";
    }
    if (body.saleUnit !== undefined) {
      data.saleUnit = parseOptionalText(body.saleUnit) || "PIECE";
    }
    if (body.allowFractionalQty !== undefined) {
      data.allowFractionalQty = parseBooleanValue(body.allowFractionalQty);
    }
    if (body.quantityStep !== undefined) {
      data.quantityStep = parseOptionalNumber(body.quantityStep, "quantityStep", {
        min: 0.001,
      });
    }
    if (body.wholesaleEligible !== undefined) {
      data.wholesaleEligible = parseBooleanValue(body.wholesaleEligible);
    }
    if (body.sourceCitation !== undefined) {
      data.sourceCitation = parseOptionalText(body.sourceCitation) || null;
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

    const product = await productService.updateProduct(productId, data, {
      id: req.user!.id,
      role: req.user!.role,
    });
    res.json(
      capabilities.stockTracked
        ? product
        : redactInventoryFromProduct(product as Record<string, any>),
    );
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
    const result = await productService.deactivateProduct(productId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    console.error("Deactivate product error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteSafety(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const safety = await productService.getProductDeleteSafety(productId);
    res.json(safety);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    console.error("Product delete safety error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function permanentDelete(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const result = await productService.permanentlyDeleteProduct(productId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (err.code === "PRODUCT_DELETE_BLOCKED") {
      res.status(409).json({
        error: err.message,
        safety: err.safety,
      });
      return;
    }
    console.error("Permanent product delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function discardStockAndPermanentDelete(req: Request, res: Response) {
  try {
    const productId = String(req.params.id);
    const result = await productService.discardStockAndPermanentlyDeleteProduct(productId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (err.code === "PRODUCT_STOCK_DISCARD_DELETE_BLOCKED") {
      res.status(409).json({ error: err.message, safety: err.safety });
      return;
    }
    console.error("Discard stock and delete product error:", err);
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

// handling bulk product import from a CSV or modern Excel workbook
// the file is uploaded in memory and converted into a review batch before any products are inserted
export async function importCsv(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "CSV or Excel spreadsheet is required" });
      return;
    }

    const parseJsonField = (value: unknown) => {
      if (!value || typeof value !== "string") return undefined;
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    };
    const fieldMap = parseJsonField(req.body?.fieldMap) as
      | Record<string, string | string[]>
      | undefined;
    const expectedHeaders = Object.values(fieldMap || {}).flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    const spreadsheet = await parseProductSpreadsheet({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      expectedHeaders,
    });

    const result = await productService.createCsvImportPreview({
      fileName: file.originalname,
      rows: spreadsheet.rows,
      rowNumbers: spreadsheet.rowNumbers,
      sourceType: spreadsheet.sourceType,
      createdById: req.user!.id,
      supplier: typeof req.body?.supplier === "string" ? req.body.supplier : undefined,
      templateId: typeof req.body?.templateId === "string" ? req.body.templateId : undefined,
      fieldMap,
      defaults: parseJsonField(req.body?.defaults),
    });
    res.json(result);
  } catch (err: any) {
    if (err instanceof SpreadsheetImportError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Import CSV error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listImportTemplates(req: Request, res: Response) {
  try {
    const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;
    const templates = await productService.listProductImportTemplates(sourceType);
    res.json({ templates });
  } catch (err: any) {
    console.error("List import templates error:", err);
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

export async function saveImportTemplate(req: Request, res: Response) {
  try {
    const template = await productService.upsertProductImportTemplate({
      id: typeof req.body?.id === "string" ? req.body.id : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      supplier: String(req.body?.supplier || ""),
      sourceType: typeof req.body?.sourceType === "string" ? req.body.sourceType : "CSV",
      fieldMap:
        req.body?.fieldMap && typeof req.body.fieldMap === "object"
          ? req.body.fieldMap
          : {},
      defaults:
        req.body?.defaults && typeof req.body.defaults === "object"
          ? req.body.defaults
          : undefined,
      createdById: req.user!.id,
    });
    res.json(template);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to save import template" });
  }
}

export async function deleteImportTemplate(req: Request, res: Response) {
  try {
    const result = await productService.deleteProductImportTemplate(String(req.params.id));
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "Import template not found" });
  }
}

export async function bulkPriceUpdate(req: Request, res: Response) {
  try {
    const result = await productService.bulkUpdateProductPrices({
      updates: Array.isArray(req.body?.updates) ? req.body.updates : [],
      scope: req.body?.scope === "FILTERED" ? "FILTERED" : "IDS",
      filters: req.body?.filters || undefined,
      excludedProductIds: Array.isArray(req.body?.excludedProductIds)
        ? req.body.excludedProductIds
        : [],
      wholesaleMarginPercent: req.body?.wholesaleMarginPercent,
      retailMarginPercent: req.body?.retailMarginPercent,
      reason: String(req.body?.reason || ""),
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to update prices" });
  }
}

// handling image supplier rate-list imports.
// AI parsing is optional; without GEMINI_API_KEY the backend still creates a failed review batch explaining what is missing.
export async function importImage(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Image file is required" });
      return;
    }

    if (
      !file.mimetype.startsWith("image/") &&
      !/\.(png|jpe?g|webp)$/i.test(file.originalname)
    ) {
      res.status(400).json({ error: "Only PNG, JPG, JPEG, or WEBP images can use the image import endpoint" });
      return;
    }

    const result = await productService.createImageImportPreview({
      fileName: file.originalname,
      mimeType: file.mimetype || "image/png",
      buffer: file.buffer,
      createdById: req.user!.id,
    });
    res.json(result);
  } catch (err: any) {
    console.error("Import image error:", err);
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

// handling supplier PDF import previews
// text-based PDFs are extracted into ProductImportBatch/ProductImportRow records for later review/mapping
export async function importPdf(req: Request, res: Response) {
  let parser: PDFParse | null = null;

  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "PDF file is required" });
      return;
    }

    if (
      file.mimetype !== "application/pdf" &&
      !file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      res.status(400).json({ error: "Only PDF files can use the PDF import endpoint" });
      return;
    }

    parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    const result = await productService.createPdfImportPreview({
      fileName: file.originalname,
      text: parsed.text || "",
      createdById: req.user!.id,
    });

    res.json(result);
  } catch (err: any) {
    console.error("Import PDF error:", err);
    res.status(500).json({ error: err?.message || "Internal server error" });
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

export async function importFromDocument(req: Request, res: Response) {
  let parser: PDFParse | null = null;

  try {
    const documentId = String(req.params.documentId || "");
    if (!documentId) {
      res.status(400).json({ error: "Document is required" });
      return;
    }

    await documentService.assertDocumentsCanLinkToEntity({
      documentIds: [documentId],
      documentType: "PRODUCT_IMPORT",
      linkedEntityType: "ProductImportBatch",
      viewerRole: req.user!.role,
    });

    const document = await documentService.getDocumentById(documentId, req.user!.role);
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const filePath = documentService.getDocumentFilePath(document);
    if (!filePath) {
      res.status(404).json({ error: "Document file is missing from storage" });
      return;
    }

    const buffer = await fs.readFile(filePath);
    const lowerName = (document.fileName || "").toLowerCase();
    const isPdf = document.mimeType === "application/pdf" || lowerName.endsWith(".pdf");
    const isImage = document.mimeType.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(lowerName);

    let result: any;
    if (isPdf) {
      parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      result = await productService.createPdfImportPreview({
        fileName: document.fileName,
        text: parsed.text || "",
        createdById: req.user!.id,
      });
    } else if (isImage) {
      result = await productService.createImageImportPreview({
        fileName: document.fileName,
        mimeType: document.mimeType || "image/png",
        buffer,
        createdById: req.user!.id,
      });
    } else {
      res.status(400).json({ error: "Only PDF or image product import documents can open an import review." });
      return;
    }

    if (result?.batchId) {
      await documentService.linkDocumentsToEntity({
        documentIds: [documentId],
        documentType: "PRODUCT_IMPORT",
        linkedEntityType: "ProductImportBatch",
        linkedEntityId: result.batchId,
        userId: req.user!.id,
        viewerRole: req.user!.role,
        metadata: {
          supplierName: document.supplierName || undefined,
          billNumber: document.billNumber || undefined,
          billDate: document.billDate ? new Date(document.billDate).toISOString() : undefined,
          billAmount: document.billAmount ?? undefined,
          remarks: document.remarks || undefined,
        },
      });
    }

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to open import document" });
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

// returning a PDF import batch with all extracted rows so the admin can review/mapping before catalog import
export async function getImportBatch(req: Request, res: Response) {
  try {
    const batchId = String(req.params.batchId);
    const batch = await productService.getProductImportBatch(batchId);
    res.json(batch);
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "Import batch not found" });
  }
}

export async function listImportBatches(req: Request, res: Response) {
  try {
    const batches = await productService.listProductImportBatches({
      sourceType: req.query.sourceType as string | undefined,
      status: req.query.status as string | undefined,
      supplier: req.query.supplier as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    res.json({ batches });
  } catch (err: any) {
    console.error("List import batches error:", err);
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

export async function deleteImportBatch(req: Request, res: Response) {
  try {
    const batchId = String(req.params.batchId);
    const result = await productService.deleteProductImportBatch(batchId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err?.message || "Import batch not found" });
  }
}

export async function saveReviewedBatchRows(req: Request, res: Response) {
  try {
    const batchId = String(req.params.batchId);
    const result = await productService.saveReviewedProductImportRows(
      batchId,
      Array.isArray(req.body?.rows) ? req.body.rows : [],
      req.user!.id,
    );
    res.json(result);
  } catch (err: any) {
    const status = Number(err?.statusCode || 0);
    res.status(status >= 400 && status < 500 ? status : 400).json({
      error: err?.message || "Failed to save reviewed rows",
    });
  }
}

// importing only the PDF rows the admin reviewed and selected
export async function importReviewedBatchRows(req: Request, res: Response) {
  try {
    const batchId = String(req.params.batchId);
    const result = await productService.importReviewedPdfRows(batchId, {
      rows: Array.isArray(req.body?.rows) ? req.body.rows : [],
      ignoredRowIds: Array.isArray(req.body?.ignoredRowIds)
        ? req.body.ignoredRowIds
        : [],
      actorId: req.user!.id,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Failed to import reviewed rows" });
  }
}
