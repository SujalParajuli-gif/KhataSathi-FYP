import type {
  ProductImportBatch,
  ProductImportRow,
  ReviewedPdfImportRowPayload,
} from "~/lib/api/endpoints";

export type ImportReviewDraft = ReviewedPdfImportRowPayload & {
  rowNumber: number;
  rawText: string;
  status: string;
  error?: string | null;
  comparisonStatus?: ProductImportRow["comparisonStatus"];
  changeSet?: ProductImportRow["changeSet"];
  sourceLocator?: ProductImportRow["sourceLocator"];
};

export type ImportPriceField = "ratePerPiece" | "retailPrice" | "wholesalePrice";

export type ImportBulkEditConfig = {
  brand?: string;
  category?: string;
  vendorSource?: string;
  packageQuantity?: number | null;
  packageUnit?: string;
  priceMove?: {
    from: ImportPriceField;
    to: ImportPriceField;
    conflictPolicy: "KEEP" | "REPLACE";
    clearSource: boolean;
  } | null;
  percentage?: {
    base: ImportPriceField;
    target: ImportPriceField;
    direction: "INCREASE" | "DECREASE";
    percent: number;
  } | null;
};

export type ImportBulkRowResult = {
  payload: ReviewedPdfImportRowPayload;
  changedFields: string[];
  priceConflict: boolean;
  skippedOperations: number;
};

function object(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function parsedImportRow(
  row: Pick<ProductImportRow, "parsed"> | null | undefined,
) {
  return object(row?.parsed);
}

export function sourceCellHasValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function displayImportSourceRegion(locator?: {
  kind?: string;
  regionAdjusted?: boolean;
  region?: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    scale: number;
  } | null;
} | null) {
  const region = locator?.region;
  if (!region) return undefined;
  const rowHeight = region.bottom - region.top;
  const needsLegacyImageAdjustment =
    locator?.kind === "IMAGE"
    && !locator.regionAdjusted
    && region.right - region.left >= 700
    && rowHeight >= 15
    && rowHeight <= 60;
  return needsLegacyImageAdjustment
    ? {
        ...region,
        top: Math.max(0, Math.round(region.top - rowHeight * 1.25)),
        bottom: Math.max(1, Math.round(region.bottom - rowHeight * 1.25)),
      }
    : region;
}

export function readableSourceHeader(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bsku\b/gi, "SKU")
    .replace(/\bmrp\b/gi, "MRP")
    .replace(/\bnpr\b/gi, "NPR")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

const reviewFieldLabels: Partial<Record<keyof ReviewedPdfImportRowPayload, string>> = {
  name: "Product name",
  sku: "SKU",
  barcode: "Barcode",
  brand: "Brand",
  category: "Category",
  categoryGroup: "Category group",
  vendorSource: "Vendor source",
  productCodeVariant: "Product code",
  sizeValue: "Size",
  sizeUnit: "Size unit",
  ratePerPiece: "Purchase rate",
  packageQuantity: "Package quantity",
  packageUnit: "Package unit",
  saleUnit: "Sale unit",
  allowFractionalQty: "Fractional quantity policy",
  quantityStep: "Quantity step",
  wholesaleEligible: "Wholesale policy",
  sourceCitation: "Source citation",
  searchAliases: "Search aliases",
  retailPrice: "Retail price",
  wholesalePrice: "Wholesale price",
  resolution: "Import decision",
};

function comparable(value: unknown) {
  if (Array.isArray(value)) return JSON.stringify(value);
  return value ?? null;
}

export function describeReviewPayloadChanges(
  before: ReviewedPdfImportRowPayload,
  after: ReviewedPdfImportRowPayload,
) {
  return (Object.keys(reviewFieldLabels) as Array<keyof ReviewedPdfImportRowPayload>)
    .filter((field) => comparable(before[field]) !== comparable(after[field]))
    .map((field) => reviewFieldLabels[field] || String(field));
}

function positivePrice(payload: ReviewedPdfImportRowPayload, field: ImportPriceField) {
  const value = Number(payload[field]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function applyImportBulkEdit(
  original: ReviewedPdfImportRowPayload,
  config: ImportBulkEditConfig,
): ImportBulkRowResult {
  const next = { ...original };
  let priceConflict = false;
  let skippedOperations = 0;

  if (config.brand?.trim()) next.brand = config.brand.trim();
  if (config.category?.trim()) {
    next.category = config.category.trim();
    next.categoryGroup = config.category.trim();
  }
  if (config.vendorSource?.trim()) next.vendorSource = config.vendorSource.trim();
  if (typeof config.packageQuantity === "number") next.packageQuantity = config.packageQuantity;
  if (config.packageUnit?.trim()) next.packageUnit = config.packageUnit.trim().toUpperCase();

  if (config.priceMove) {
    const sourceValue = positivePrice(next, config.priceMove.from);
    const destinationValue = positivePrice(next, config.priceMove.to);
    if (sourceValue === null) {
      skippedOperations += 1;
    } else if (destinationValue !== null && config.priceMove.conflictPolicy === "KEEP") {
      priceConflict = true;
      skippedOperations += 1;
    } else {
      if (destinationValue !== null) priceConflict = true;
      next[config.priceMove.to] = sourceValue;
      if (config.priceMove.clearSource) next[config.priceMove.from] = null;
    }
  }

  if (config.percentage) {
    const baseValue = positivePrice(next, config.percentage.base);
    if (baseValue === null) {
      skippedOperations += 1;
    } else {
      const factor = config.percentage.direction === "INCREASE"
        ? 1 + config.percentage.percent / 100
        : 1 - config.percentage.percent / 100;
      const calculated = Math.round(baseValue * factor * 100) / 100;
      if (calculated > 0) next[config.percentage.target] = calculated;
      else skippedOperations += 1;
    }
  }

  return {
    payload: next,
    changedFields: describeReviewPayloadChanges(original, next),
    priceConflict,
    skippedOperations,
  };
}

function text(source: Record<string, unknown>, key: string, fallback = "") {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOrNull(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolean(source: Record<string, unknown>, key: string, fallback: boolean) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function defaultResolution(row: ProductImportRow) {
  if (row.resolution) return row.resolution;
  if (row.comparisonStatus === "READY_NEW") return "CREATE_NEW" as const;
  if (row.comparisonStatus === "EXACT_DUPLICATE") return "KEEP_EXISTING" as const;
  if (row.status === "IGNORED") return "IGNORE" as const;
  return null;
}

export function importRowToDraft(
  batch: Pick<ProductImportBatch, "fileName" | "supplier" | "sourceType">,
  row: ProductImportRow,
): ImportReviewDraft {
  const parsed = parsedImportRow(row);
  const fallbackSource = batch.supplier || batch.fileName?.replace(/\.[^.]+$/, "") || "Supplier";
  const fallbackName = row.rawText?.trim() || `Import row ${row.rowNumber}`;
  const name = text(parsed, "name", text(parsed, "productName", fallbackName));
  const sizeUnit = text(parsed, "sizeUnit", "STANDARD");
  const saleUnit = text(
    parsed,
    "saleUnit",
    sizeUnit === "KG" || sizeUnit === "METER" ? sizeUnit : "PIECE",
  );
  const aliases = Array.isArray(parsed.searchAliases)
    ? parsed.searchAliases.map(String).map((value) => value.trim()).filter(Boolean)
    : [];

  return {
    rowId: row.id,
    rowNumber: row.rowNumber,
    rawText: row.rawText || "",
    status: row.status,
    error: row.error,
    comparisonStatus: row.comparisonStatus,
    changeSet: row.changeSet || [],
    sourceLocator: row.sourceLocator,
    resolution: defaultResolution(row),
    name,
    sku: text(parsed, "sku", `IMPORT-${row.rowNumber}`),
    barcode: text(parsed, "barcode"),
    brand: text(parsed, "brand", fallbackSource),
    category: text(parsed, "category", "Uncategorized"),
    categoryGroup: text(parsed, "categoryGroup", text(parsed, "category", "Uncategorized")),
    vendorSource: text(parsed, "vendorSource", fallbackSource),
    productCodeVariant: text(parsed, "productCodeVariant"),
    sizeValue: numberOrNull(parsed, "sizeValue"),
    sizeUnit,
    ratePerPiece: numberOrNull(parsed, "ratePerPiece"),
    packageQuantity: numberOrNull(parsed, "packageQuantity"),
    packageUnit: text(parsed, "packageUnit", "PIECE"),
    saleUnit,
    allowFractionalQty: boolean(parsed, "allowFractionalQty", false),
    quantityStep: numberOrNull(parsed, "quantityStep") ?? 1,
    wholesaleEligible: boolean(parsed, "wholesaleEligible", true),
    sourceCitation: text(parsed, "sourceCitation", batch.fileName || batch.sourceType),
    searchAliases: aliases,
    retailPrice: numberOrNull(parsed, "retailPrice"),
    wholesalePrice: numberOrNull(parsed, "wholesalePrice"),
    stock: 0,
  };
}

export function draftPayload(draft: ImportReviewDraft): ReviewedPdfImportRowPayload {
  const {
    rowNumber: _rowNumber,
    rawText: _rawText,
    status: _status,
    error: _error,
    comparisonStatus: _comparisonStatus,
    changeSet: _changeSet,
    sourceLocator: _sourceLocator,
    ...payload
  } = draft;
  return { ...payload, stock: 0 };
}

export function comparisonLabel(status?: ProductImportRow["comparisonStatus"]) {
  const labels: Record<string, string> = {
    READY_NEW: "New product",
    EXACT_DUPLICATE: "Exact existing product",
    MATCHED_WITH_CHANGES: "Existing product changed",
    IDENTIFIER_CONFLICT: "Identifier conflict",
    IN_FILE_DUPLICATE: "Duplicate in this file",
    NEEDS_REVIEW: "Needs review",
    FAILED: "Extraction failed",
  };
  return labels[status || ""] || "Needs review";
}
