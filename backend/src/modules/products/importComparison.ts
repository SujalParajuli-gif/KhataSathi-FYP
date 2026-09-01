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
  field: "name" | "category" | "productCodeVariant" | "packageQuantity" | "ratePerPiece" | "retailPrice" | "wholesalePrice" | "availabilityStatus";
  currentValue: string | number | null;
  incomingValue: string | number | null;
};

export type ComparableCatalogProduct = {
  id: string;
  name: string;
  brandName: string;
  barcode?: string | null;
  barcodeOrigin?: string | null;
  productCodeVariant?: string | null;
  category?: string | null;
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
  barcode?: string | null;
  productCodeVariant?: string | null;
  category?: string | null;
  packageQuantity?: number | null;
  ratePerPiece?: number | null;
  retailPrice?: number | null;
  wholesalePrice?: number | null;
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

function barcodeMatches(row: ComparableImportRow, product: ComparableCatalogProduct) {
  const rowBarcode = normalizeImportIdentity(row.barcode);
  return !!rowBarcode && product.barcodeOrigin !== "INTERNAL" &&
    rowBarcode === normalizeImportIdentity(product.barcode);
}

function sameBrand(row: ComparableImportRow, product: ComparableCatalogProduct) {
  return normalizeImportIdentity(row.brand) === normalizeImportIdentity(product.brandName);
}

function brandNameMatches(row: ComparableImportRow, product: ComparableCatalogProduct) {
  return sameBrand(row, product) &&
    normalizeImportIdentity(row.name) === normalizeImportIdentity(product.name);
}

function brandCodeMatches(row: ComparableImportRow, product: ComparableCatalogProduct) {
  const rowCode = normalizeImportIdentity(row.productCodeVariant);
  return !!rowCode && sameBrand(row, product) &&
    rowCode === normalizeImportIdentity(product.productCodeVariant);
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
  const availabilityStatus = resolveProductAvailability(
    row.ratePerPiece,
    row.retailPrice,
    row.wholesalePrice,
  );
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

export function compareImportRowToCatalog(
  row: ComparableImportRow,
  products: ComparableCatalogProduct[],
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

  const barcode = normalizeImportIdentity(row.barcode);
  let matches = barcode
    ? products.filter((product) => barcodeMatches(row, product))
    : [];
  if (matches.length === 0) {
    matches = products.filter((product) => brandNameMatches(row, product));
  }
  let matchedByCodeOnly = false;
  if (matches.length === 0 && normalizeImportIdentity(row.productCodeVariant)) {
    matches = products.filter((product) => brandCodeMatches(row, product));
    matchedByCodeOnly = matches.length > 0;
  }
  const availabilityStatus = resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice);
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
  if (matches.length > 1) {
    return {
      comparisonStatus: "IDENTIFIER_CONFLICT",
      availabilityStatus,
      matchedProductId: null,
      changes: [],
      message: `The import identity matches ${matches.length} catalog products.`,
    };
  }

  const matched = matches[0];
  const changes = collectChanges(row, matched);
  return {
    comparisonStatus:
      !matchedByCodeOnly && changes.length === 0
        ? "EXACT_DUPLICATE"
        : "MATCHED_WITH_CHANGES",
    availabilityStatus,
    matchedProductId: matched.id,
    changes,
    message: matchedByCodeOnly
      ? `Supplier code suggests ${matched.name}, but codes are not unique; verify the renamed match.`
      : changes.length === 0
      ? `Already matches ${matched.name}.`
      : `${changes.length} catalog field${changes.length === 1 ? "" : "s"} changed.`,
  };
}

export function compareImportRowsToCatalog(
  rows: ComparableImportRow[],
  products: ComparableCatalogProduct[],
) {
  const seen = new Map<string, string>();
  const seenBarcodes = new Map<string, string>();
  return rows.map((row) => {
    const identity = importRowIdentityKey(row);
    const barcode = normalizeImportIdentity(row.barcode);
    const earlierRowKey = seen.get(identity) || (barcode ? seenBarcodes.get(barcode) : undefined);
    if (earlierRowKey) {
      return {
        comparisonStatus: "IN_FILE_DUPLICATE" as const,
        availabilityStatus: resolveProductAvailability(row.ratePerPiece, row.retailPrice, row.wholesalePrice),
        matchedProductId: null,
        changes: [] as ImportFieldChange[],
        message: `Duplicates import row ${earlierRowKey}.`,
      };
    }
    seen.set(identity, row.rowKey);
    if (barcode) seenBarcodes.set(barcode, row.rowKey);
    return compareImportRowToCatalog(row, products);
  });
}
