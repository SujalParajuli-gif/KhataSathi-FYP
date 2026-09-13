import { createHash } from "node:crypto";

export type ProductAvailabilityValue = "CATALOG_LISTED" | "COMING_SOON";

export type ImportComparisonValue =
  | "READY_NEW"
  | "EXACT_DUPLICATE"
  | "MATCHED_WITH_CHANGES"
  | "IDENTIFIER_CONFLICT"
  | "IN_FILE_DUPLICATE"
  | "NEEDS_REVIEW"
  | "FAILED";

export type ImportFieldChange = {
  field: "name" | "category" | "productCodeVariant" | "sizeValue" | "sizeUnit" | "packageQuantity" | "ratePerPiece" | "retailPrice" | "wholesalePrice" | "availabilityStatus";
  currentValue: string | number | null;
  incomingValue: string | number | null;
};

export type ComparableCatalogProduct = {
  id: string;
  name: string;
  brandName: string;
  sku?: string | null;
  barcode?: string | null;
  barcodeOrigin?: string | null;
  productCodeVariant?: string | null;
  category?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  packageQuantity?: number | null;
  ratePerPiece?: number | null;
  retailPrice?: number | null;
  wholesalePrice?: number | null;
  availabilityStatus?: ProductAvailabilityValue | null;
};

export type ComparableImportRow = {
  rowKey: string;
  name: string;
  brand: string;
  sku?: string | null;
  skuWasGenerated?: boolean;
  barcode?: string | null;
  productCodeVariant?: string | null;
  category?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  packageQuantity?: number | null;
  ratePerPiece?: number | null;
  retailPrice?: number | null;
  wholesalePrice?: number | null;
  availabilityStatus?: ProductAvailabilityValue | null;
};

export type ComparedImportRow = {
  comparisonStatus: ImportComparisonValue;
  availabilityStatus: ProductAvailabilityValue;
  matchedProductId: string | null;
  changes: ImportFieldChange[];
  message: string | null;
};

export function fingerprintImportFile(input: Buffer | Uint8Array) {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeImportIdentity(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s\-_./\\]+/g, " ")
    .replace(/[^\p{L}\p{N} +]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveProductAvailability(...prices: unknown[]): ProductAvailabilityValue {
  const hasAnnouncedPrice = prices.some((price) => {
    if (price === null || price === undefined || price === "") return false;
    const value = Number(price);
    return Number.isFinite(value) && value > 0;
  });
  return hasAnnouncedPrice ? "CATALOG_LISTED" : "COMING_SOON";
}

function comparableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10000) / 10000 : null;
}

function valuesEqual(left: unknown, right: unknown) {
  if (typeof left === "number" || typeof right === "number") {
    return comparableNumber(left) === comparableNumber(right);
  }
  return normalizeImportIdentity(left) === normalizeImportIdentity(right);
}

type CatalogComparisonIndex = {
  byBrandName: Map<string, ComparableCatalogProduct[]>;
  byBarcode: Map<string, ComparableCatalogProduct[]>;
  bySku: Map<string, ComparableCatalogProduct[]>;
  byBrandCode: Map<string, ComparableCatalogProduct[]>;
};

function appendIndex(
  index: Map<string, ComparableCatalogProduct[]>,
  key: string,
  product: ComparableCatalogProduct,
) {
  if (!key) return;
  const existing = index.get(key);
  if (existing) existing.push(product);
  else index.set(key, [product]);
}

function buildCatalogComparisonIndex(products: ComparableCatalogProduct[]): CatalogComparisonIndex {
  const index: CatalogComparisonIndex = {
    byBrandName: new Map(),
    byBarcode: new Map(),
    bySku: new Map(),
    byBrandCode: new Map(),
  };
  for (const product of products) {
    const brand = normalizeImportIdentity(product.brandName);
    appendIndex(index.byBrandName, `${brand}:${normalizeImportIdentity(product.name)}`, product);
    if (product.barcodeOrigin !== "INTERNAL") {
      appendIndex(index.byBarcode, normalizeImportIdentity(product.barcode), product);
    }
    appendIndex(index.bySku, normalizeImportIdentity(product.sku), product);
    appendIndex(index.byBrandCode, `${brand}:${normalizeImportIdentity(product.productCodeVariant)}`, product);
  }
  return index;
}

function meaningfulSizeUnit(value: unknown) {
  const normalized = normalizeImportIdentity(value);
  return normalized && normalized !== "standard" ? normalized : "";
}

function conflictingSize(row: ComparableImportRow, product: ComparableCatalogProduct) {
  const rowSize = comparableNumber(row.sizeValue);
  const productSize = comparableNumber(product.sizeValue);
  if (rowSize !== null && productSize !== null && rowSize !== productSize) return true;
  const rowUnit = meaningfulSizeUnit(row.sizeUnit);
  const productUnit = meaningfulSizeUnit(product.sizeUnit);
  return Boolean(rowUnit && productUnit && rowUnit !== productUnit);
}

export function importRowIdentityKey(row: ComparableImportRow) {
  const brand = normalizeImportIdentity(row.brand);
  // Supplier codes are not assumed unique. Bagmati, for example, reuses codes
  // across legitimate products. The shop's confirmed invariant is one product
  // name per brand.
  return `brand-name:${brand}:${normalizeImportIdentity(row.name)}`;
}

function collectChanges(row: ComparableImportRow, product: ComparableCatalogProduct) {
  const changes: ImportFieldChange[] = [];
  const availabilityStatus = row.availabilityStatus === "COMING_SOON"
    ? "COMING_SOON"
    : "CATALOG_LISTED";
  const currentAvailability = product.availabilityStatus ||
    resolveProductAvailability(product.ratePerPiece, product.retailPrice, product.wholesalePrice);

  const add = (
    field: ImportFieldChange["field"],
    currentValue: string | number | null | undefined,
    incomingValue: string | number | null | undefined,
  ) => {
    if (!valuesEqual(currentValue, incomingValue)) {
      changes.push({
        field,
        currentValue: currentValue ?? null,
        incomingValue: incomingValue ?? null,
      });
    }
  };

  add("name", product.name, row.name);
  if (normalizeImportIdentity(row.category)) {
    add("category", product.category, row.category);
  }
  if (normalizeImportIdentity(row.productCodeVariant)) {
    add("productCodeVariant", product.productCodeVariant, row.productCodeVariant);
  }
  if (row.sizeValue !== null && row.sizeValue !== undefined) {
    add("sizeValue", product.sizeValue, row.sizeValue);
    if (meaningfulSizeUnit(row.sizeUnit)) add("sizeUnit", product.sizeUnit, row.sizeUnit);
  }
  if (row.packageQuantity !== null && row.packageQuantity !== undefined) {
    add("packageQuantity", product.packageQuantity, row.packageQuantity);
  }
  if (row.ratePerPiece !== null && row.ratePerPiece !== undefined) {
    add("ratePerPiece", product.ratePerPiece, row.ratePerPiece);
  }
  if (row.retailPrice !== null && row.retailPrice !== undefined) {
    add("retailPrice", product.retailPrice, row.retailPrice);
  }
  if (row.wholesalePrice !== null && row.wholesalePrice !== undefined) {
    add("wholesalePrice", product.wholesalePrice, row.wholesalePrice);
  }
  if (availabilityStatus !== "COMING_SOON" || currentAvailability === "COMING_SOON") {
    add("availabilityStatus", currentAvailability, availabilityStatus);
  }
  return changes;
}

function compareImportRowWithIndex(
  row: ComparableImportRow,
  index: CatalogComparisonIndex,
): ComparedImportRow {
  if (!normalizeImportIdentity(row.name)) {
    return {
      comparisonStatus: "FAILED",
      availabilityStatus: resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice),
      matchedProductId: null,
      changes: [],
      message: "Product name is required.",
    };
  }
  if (!normalizeImportIdentity(row.brand)) {
    return {
      comparisonStatus: "NEEDS_REVIEW",
      availabilityStatus: resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice),
      matchedProductId: null,
      changes: [],
      message: "Brand must be reviewed before catalog comparison.",
    };
  }
  const availabilityStatus = row.availabilityStatus === "COMING_SOON"
    ? "COMING_SOON"
    : "CATALOG_LISTED";

  const brand = normalizeImportIdentity(row.brand);
  const brandNameKey = `${brand}:${normalizeImportIdentity(row.name)}`;
  const matches = index.byBrandName.get(brandNameKey) || [];
  if (matches.length > 1) {
    return {
      comparisonStatus: "IDENTIFIER_CONFLICT",
      availabilityStatus,
      matchedProductId: null,
      changes: [],
      message: `The import identity matches ${matches.length} catalog products.`,
    };
  }
  const identifierMatches = [
    ...(normalizeImportIdentity(row.barcode)
      ? index.byBarcode.get(normalizeImportIdentity(row.barcode)) || []
      : []),
    ...(!row.skuWasGenerated && normalizeImportIdentity(row.sku)
      ? index.bySku.get(normalizeImportIdentity(row.sku)) || []
      : []),
    ...(normalizeImportIdentity(row.productCodeVariant)
      ? index.byBrandCode.get(`${brand}:${normalizeImportIdentity(row.productCodeVariant)}`) || []
      : []),
  ];
  const identifierProductIds = new Set(identifierMatches.map((product) => product.id));
  if (matches.length === 1 && [...identifierProductIds].some((id) => id !== matches[0].id)) {
    return {
      comparisonStatus: "IDENTIFIER_CONFLICT",
      availabilityStatus,
      matchedProductId: null,
      changes: [],
      message: "Brand and product name match one catalog product, but an incoming identifier belongs to another. Correct the barcode, SKU or product code before importing.",
    };
  }
  if (matches.length === 0 && identifierProductIds.size > 0) {
    return {
      comparisonStatus: "IDENTIFIER_CONFLICT",
      availabilityStatus,
      matchedProductId: identifierProductIds.size === 1 ? identifierMatches[0].id : null,
      changes: [],
      message: "An incoming barcode, SKU or product code belongs to a catalog product with a different brand or name. Verify the identity before importing.",
    };
  }
  if (matches.length === 1 && conflictingSize(row, matches[0])) {
    return {
      comparisonStatus: "IDENTIFIER_CONFLICT",
      availabilityStatus,
      matchedProductId: matches[0].id,
      changes: [],
      message: "Brand and product name match, but the product size differs. Correct the name or size before importing.",
    };
  }
  const incomingRate = comparableNumber(row.ratePerPiece);
  const matchedRate = matches.length === 1
    ? comparableNumber(matches[0].ratePerPiece)
    : null;
  if (
    availabilityStatus !== "COMING_SOON"
    && (incomingRate === null || incomingRate <= 0)
    && (matchedRate === null || matchedRate <= 0)
    && ![row.retailPrice, row.wholesalePrice, ...(matches.length === 1 ? [matches[0].retailPrice, matches[0].wholesalePrice] : [])].some((value) => Number(value) > 0)
  ) {
    return {
      comparisonStatus: "NEEDS_REVIEW",
      availabilityStatus,
      matchedProductId: matches.length === 1 ? matches[0].id : null,
      changes: [],
      message: "Enter an announced price or mark this product as Coming soon.",
    };
  }
  if (matches.length === 0) {
    return {
      comparisonStatus: "READY_NEW",
      availabilityStatus,
      matchedProductId: null,
      changes: [],
      message: availabilityStatus === "COMING_SOON"
        ? "New coming-soon product; supplier price has not been announced."
        : "New catalog product.",
    };
  }
  const matched = matches[0];
  const changes = collectChanges(row, matched);
  return {
    comparisonStatus:
      changes.length === 0
        ? "EXACT_DUPLICATE"
        : "MATCHED_WITH_CHANGES",
    availabilityStatus,
    matchedProductId: matched.id,
    changes,
    message: changes.length === 0
      ? `Already matches ${matched.name}.`
      : `${changes.length} catalog field${changes.length === 1 ? "" : "s"} changed.`,
  };
}

export function compareImportRowToCatalog(
  row: ComparableImportRow,
  products: ComparableCatalogProduct[],
) {
  return compareImportRowWithIndex(row, buildCatalogComparisonIndex(products));
}

function inFileConflictFields(first: ComparableImportRow, current: ComparableImportRow) {
  const fields: string[] = [];
  const compareWhenBothPresent = (label: string, left: unknown, right: unknown) => {
    if (left !== null && left !== undefined && left !== ""
      && right !== null && right !== undefined && right !== ""
      && !valuesEqual(left, right)) fields.push(label);
  };
  compareWhenBothPresent("brand", first.brand, current.brand);
  compareWhenBothPresent("product name", first.name, current.name);
  if (!first.skuWasGenerated && !current.skuWasGenerated) {
    compareWhenBothPresent("SKU", first.sku, current.sku);
  }
  compareWhenBothPresent("barcode", first.barcode, current.barcode);
  compareWhenBothPresent("product code", first.productCodeVariant, current.productCodeVariant);
  compareWhenBothPresent("category", first.category, current.category);
  compareWhenBothPresent("size", first.sizeValue, current.sizeValue);
  compareWhenBothPresent("size unit", meaningfulSizeUnit(first.sizeUnit), meaningfulSizeUnit(current.sizeUnit));
  compareWhenBothPresent("package quantity", first.packageQuantity, current.packageQuantity);
  compareWhenBothPresent("Rate", first.ratePerPiece, current.ratePerPiece);
  compareWhenBothPresent("retail price", first.retailPrice, current.retailPrice);
  compareWhenBothPresent("wholesale price", first.wholesalePrice, current.wholesalePrice);
  return fields;
}

export function compareImportRowsToCatalog(
  rows: ComparableImportRow[],
  products: ComparableCatalogProduct[],
) {
  const index = buildCatalogComparisonIndex(products);
  const seen = new Map<string, ComparableImportRow>();
  const seenBarcodes = new Map<string, ComparableImportRow>();
  return rows.map((row) => {
    const identity = importRowIdentityKey(row);
    const barcode = normalizeImportIdentity(row.barcode);
    const earlierRow = seen.get(identity) || (barcode ? seenBarcodes.get(barcode) : undefined);
    if (earlierRow) {
      const conflicts = inFileConflictFields(earlierRow, row);
      if (conflicts.length > 0) {
        return {
          comparisonStatus: "IDENTIFIER_CONFLICT" as const,
          availabilityStatus: resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice),
          matchedProductId: null,
          changes: [] as ImportFieldChange[],
          message: `Conflicts with import row ${earlierRow.rowKey}: ${conflicts.join(", ")} differ.`,
        };
      }
      return {
        comparisonStatus: "IN_FILE_DUPLICATE" as const,
        availabilityStatus: resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice),
        matchedProductId: null,
        changes: [] as ImportFieldChange[],
        message: `Duplicates import row ${earlierRow.rowKey}.`,
      };
    }
    seen.set(identity, row);
    if (barcode) seenBarcodes.set(barcode, row);
    return compareImportRowWithIndex(row, index);
  });
}
