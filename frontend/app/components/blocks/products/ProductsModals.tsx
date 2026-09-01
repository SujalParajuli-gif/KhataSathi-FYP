import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import Icon from "~/components/ui/Icon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import SwipeableTabRail, { type SwipeableTabRailController } from "~/components/ui/SwipeableTabRail";
import { DialogButton, ModalFrame } from "~/components/ui/Modal";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";
import { focusInvalidField } from "~/lib/forms/focusInvalidField";
import type {
  DocumentRecord,
  ImportedProductSummary,
  ProductDeleteSafety,
  ProductImportBatch,
  ReviewedPdfImportRowPayload,
} from "~/lib/api/endpoints";
import type {
  Product,
  ProductStatus,
} from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

type ProductFormErrors = Partial<
  Record<
    | "name"
    | "brand"
    | "category"
    | "sku"
    | "ratePerPiece"
    | "retailPrice"
    | "wholesalePrice"
    | "thresholdQty"
    | "stock"
    | "lowStockThreshold"
    | "packageQuantity"
    | "quantityStep"
    | "image",
    string
  >
>;

type ProductEditorStep = "basic" | "units" | "pricing" | "stock" | "review";
const PRODUCT_EDITOR_STEPS: Array<{ value: ProductEditorStep; label: string }> = [
  { value: "basic", label: "Basic" },
  { value: "units", label: "Units" },
  { value: "pricing", label: "Pricing" },
  { value: "stock", label: "Stock" },
  { value: "review", label: "Review" },
];

type CsvImportError = {
  rowNumber: number;
  sku?: string;
  name?: string;
  message: string;
};

type CsvImportResult = {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  createdProducts?: ImportedProductSummary[];
  errors: CsvImportError[];
  batchId?: string;
  sourceType?: string;
  message?: string;
};

type ProductImportTemplate = {
  id: string;
  name: string;
  supplier: string;
  sourceType: string;
  fieldMap: Record<string, string | string[]>;
};

type PdfReviewDraft = ReviewedPdfImportRowPayload & {
  selected: boolean;
  ignored: boolean;
  rawText: string;
  rowNumber: number;
  status: string;
  error?: string | null;
  comparisonStatus?: ProductImportBatch["rows"][number]["comparisonStatus"];
  changeSet?: NonNullable<ProductImportBatch["rows"][number]["changeSet"]>;
};

function toReviewedImportRowPayload(
  row: PdfReviewDraft,
): ReviewedPdfImportRowPayload {
  return {
    rowId: row.rowId,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    brand: row.brand,
    category: row.category,
    categoryGroup: row.categoryGroup,
    vendorSource: row.vendorSource,
    productCodeVariant: row.productCodeVariant,
    sizeValue: row.sizeValue,
    sizeUnit: row.sizeUnit,
    ratePerPiece: row.ratePerPiece,
    packageQuantity: row.packageQuantity,
    packageUnit: row.packageUnit,
    saleUnit: row.saleUnit,
    allowFractionalQty: row.allowFractionalQty,
    quantityStep: row.quantityStep,
    wholesaleEligible: row.wholesaleEligible,
    sourceCitation: row.sourceCitation,
    searchAliases: row.searchAliases || [],
    retailPrice: row.retailPrice,
    wholesalePrice: row.wholesalePrice,
    stock: row.stock,
    resolution: row.resolution,
  };
}

function reviewedImportRowFingerprint(row: PdfReviewDraft) {
  return JSON.stringify(toReviewedImportRowPayload(row));
}

function isFinishedImportReviewStatus(status: string) {
  return ["IMPORTED", "UPDATED", "KEPT_EXISTING", "IGNORED"].includes(status);
}

function defaultImportResolution(row: ProductImportBatch["rows"][number]) {
  if (row.resolution) return row.resolution;
  if (row.status === "IGNORED") return "IGNORE" as const;
  if (row.comparisonStatus === "READY_NEW") return "CREATE_NEW" as const;
  if (row.comparisonStatus === "EXACT_DUPLICATE") return "KEEP_EXISTING" as const;
  return null;
}

function restoredDraftResolution(row: PdfReviewDraft) {
  if (row.comparisonStatus === "READY_NEW") return "CREATE_NEW" as const;
  if (row.comparisonStatus === "EXACT_DUPLICATE") return "KEEP_EXISTING" as const;
  return null;
}

function formatQty(value: number | null) {
  if (value === null) return "Not entered";
  const safe = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
  return Number.isInteger(safe)
    ? safe.toLocaleString()
    : safe.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function roundReviewCurrency(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function applyRetailMargin(basePrice: number, marginPercent = 18) {
  const base = Number(basePrice || 0);
  const margin = Number(marginPercent);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(margin) || margin <= 0) return roundReviewCurrency(base);
  return roundReviewCurrency(base * (1 + margin / 100));
}

function readParsedString(
  parsed: Record<string, unknown>,
  keys: string[],
  fallback = "",
) {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function readParsedNumber(
  parsed: Record<string, unknown>,
  keys: string[],
  fallback: number | null = 0,
) {
  for (const key of keys) {
    const value = parsed[key];
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function readParsedBoolean(
  parsed: Record<string, unknown>,
  keys: string[],
  fallback = false,
) {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return fallback;
}

function formatOptionalPurchaseCost(value: number | null) {
  return value === null ? "Not entered" : formatNpr(value);
}

function formatOptionalSellingPrice(value: number | null) {
  return value === null ? "Not entered" : formatNpr(value);
}

function readParsedAliases(parsed: Record<string, unknown>) {
  const value = parsed.searchAliases ?? parsed.search_aliases ?? parsed.aliases;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n]/g)
      : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function displaySourceType(sourceType?: string | null) {
  return (sourceType || "IMPORT").replace(/_/g, " ").toUpperCase();
}

function formatDocumentDate(value?: string | null) {
  if (!value) return "No date";
  return new Date(value).toLocaleDateString();
}

function formatDocumentSize(bytes?: number | null) {
  const size = Number(bytes || 0);
  if (!size) return "0 Bytes";
  if (size < 1024) return `${size} Bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProductSize(product: Product) {
  if (
    !product.sizeValue ||
    !product.sizeUnit ||
    product.sizeUnit === "STANDARD"
  ) {
    return "Standard";
  }
  return `${formatQty(product.sizeValue)} ${product.sizeUnit}`;
}

function formatPackage(product: Product) {
  if (product.packageQuantity === null) return "Package unknown";
  return `${formatQty(product.packageQuantity)} ${product.packageUnit || "PIECE"}`;
}

function slugPart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase()
    .slice(0, 24);
}

function sourceNameFromBatch(batch: ProductImportBatch) {
  const fileBase = (batch.fileName || "Supplier")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return batch.supplier || fileBase || "Supplier";
}

function parseReviewSize(rawText: string) {
  const patterns: Array<{ unit: string; regex: RegExp }> = [
    {
      unit: "LTR",
      regex: /(\d+(?:\.\d+)?)\s*(?:ltrs?|ltr\.?|liters?|litres?)\b/i,
    },
    { unit: "KG", regex: /(\d+(?:\.\d+)?)\s*(?:kgs?|kilograms?)\b/i },
    { unit: "GRAM", regex: /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|gm|g)\b/i },
    { unit: "INCH", regex: /(\d+(?:\.\d+)?)\s*(?:"|inches|inch|in\b)/i },
    { unit: "METER", regex: /(\d+(?:\.\d+)?)\s*(?:mtrs?|meters?|metres?)\b/i },
    {
      unit: "ML",
      regex: /(\d+(?:\.\d+)?)\s*(?:ml|milliliters?|millilitres?)\b/i,
    },
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern.regex);
    if (!match) continue;
    const sizeValue = Number(match[1]);
    return {
      sizeValue: Number.isFinite(sizeValue) ? sizeValue : null,
      sizeUnit: pattern.unit,
    };
  }

  return { sizeValue: null, sizeUnit: "STANDARD" };
}

function parseReviewRate(rawText: string) {
  const mrpMatch = rawText.match(
    /\bMRP\b\s*(?:Rs\.?|NPR)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i,
  );
  if (mrpMatch) {
    return Number(mrpMatch[1].replace(/,/g, ""));
  }

  const currencyMatch = rawText.match(
    /(?:Rs\.?|NPR|Price|Rate)\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i,
  );
  if (currencyMatch) {
    return Number(currencyMatch[1].replace(/,/g, ""));
  }

  const numberMatches = [...rawText.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)];
  const tailNumbers = numberMatches
    .slice(-3)
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
  const decimalTail = tailNumbers.filter((value) => !Number.isInteger(value));
  const candidate =
    decimalTail[decimalTail.length - 1] ??
    tailNumbers[tailNumbers.length - 1] ??
    0;
  return Number.isFinite(candidate) ? candidate : 0;
}

function escapeReviewRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reviewNumberPattern(value: number) {
  const normalized = String(Number(value || 0));
  if (!normalized || normalized === "0") return "";
  const [whole, decimal] = normalized.split(".");
  const formattedWhole = Number(whole).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  const wholePattern =
    formattedWhole === whole
      ? escapeReviewRegExp(whole)
      : `(?:${escapeReviewRegExp(whole)}|${escapeReviewRegExp(formattedWhole)})`;
  return decimal
    ? `${wholePattern}\\.${escapeReviewRegExp(decimal)}0*`
    : `${wholePattern}(?:\\.0+)?`;
}

function removeParsedRate(rawText: string, rate: number) {
  if (!rate) return rawText;
  const escapedRate = reviewNumberPattern(rate);
  if (!escapedRate) return rawText;
  return rawText
    .replace(
      new RegExp(`\\bMRP\\b\\s*(?:Rs\\.?|NPR)?\\s*${escapedRate}\\b`, "i"),
      " ",
    )
    .replace(
      new RegExp(`(?:Rs\\.?|NPR|Price|Rate)\\s*${escapedRate}\\b`, "i"),
      " ",
    )
    .replace(new RegExp(`\\s+${escapedRate}\\s*$`, "i"), " ");
}

function removeOneTrailingTableNumber(rawText: string) {
  return rawText.replace(/\s+\d+(?:,\d{3})*(?:\.\d+)?\s*$/, " ").trim();
}

function cleanReviewProductName(rawText: string, rate: number) {
  const normalized = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const withoutRate = removeParsedRate(normalized, rate)
    .replace(/\s+/g, " ")
    .trim();
  const rateWasRemoved = withoutRate !== normalized;
  const withoutTableQty = rateWasRemoved
    ? removeOneTrailingTableNumber(withoutRate)
    : withoutRate;

  return (
    withoutTableQty
      .replace(/^\s*(?:s\.?\s*n\.?|sl\.?|sn|#)?\s*\d+\s*[-.)]?\s*/i, "")
      .replace(/\b(?:npr|rs\.?|mrp|rate|price)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim() || normalized.slice(0, 80).trim()
  );
}

function guessPdfReviewDraft(
  batch: ProductImportBatch,
  row: ProductImportBatch["rows"][number],
  brands: string[],
  categories: string[],
): PdfReviewDraft {
  const parsed =
    row.parsed && typeof row.parsed === "object"
      ? (row.parsed as Record<string, unknown>)
      : {};
  const rawText =
    row.rawText || readParsedString(parsed, ["name", "productName"]);
  const sourceName = sourceNameFromBatch(batch);
  const brand = brands.find((item) => item !== "All Brands") || sourceName;
  const category =
    categories.find((item) => item !== "All Categories") || sourceName;

  if (
    readParsedString(parsed, ["name", "productName"]) ||
    readParsedString(parsed, ["sku"]) ||
    readParsedNumber(
      parsed,
      ["retailPrice", "wholesalePrice", "ratePerPiece"],
      null,
    ) !== null
  ) {
    const purchaseCost = readParsedNumber(parsed, ["ratePerPiece"], null);
    const wholesalePrice = readParsedNumber(parsed, ["wholesalePrice"], null);
    const retailPrice = readParsedNumber(parsed, ["retailPrice"], null);
    const parsedName = cleanReviewProductName(
      readParsedString(parsed, ["name", "productName"], rawText),
      Number(purchaseCost || retailPrice || wholesalePrice || 0),
    );
    const sizeUnit = readParsedString(parsed, ["sizeUnit"], "STANDARD");
    const saleUnit = readParsedString(
      parsed,
      ["saleUnit"],
      sizeUnit === "KG" || sizeUnit === "METER" ? sizeUnit : "PIECE",
    );
    const packageQuantity = readParsedNumber(parsed, ["packageQuantity"], null);
    const resolution = defaultImportResolution(row);

    return {
      rowId: row.id,
      selected:
        !isFinishedImportReviewStatus(row.status) &&
        row.status !== "FAILED" &&
        (resolution === "CREATE_NEW" || resolution === "UPDATE_MATCHED"),
      ignored: resolution === "IGNORE",
      rawText,
      rowNumber: row.rowNumber,
      status: row.status,
      error: row.error,
      comparisonStatus: row.comparisonStatus,
      changeSet: row.changeSet || [],
      resolution,
      name: parsedName || rawText,
      sku:
        readParsedString(parsed, ["sku"]) ||
        `${slugPart(sourceName) || "IMPORT"}-${row.rowNumber}`.slice(0, 80),
      barcode: readParsedString(parsed, ["barcode"]),
      brand: readParsedString(parsed, ["brand"], brand),
      category: readParsedString(parsed, ["category"], category),
      categoryGroup: readParsedString(
        parsed,
        ["categoryGroup"],
        readParsedString(parsed, ["category"], sourceName),
      ),
      vendorSource: readParsedString(parsed, ["vendorSource"], sourceName),
      productCodeVariant: readParsedString(parsed, ["productCodeVariant"]),
      sizeValue: readParsedNumber(parsed, ["sizeValue"], null),
      sizeUnit,
      ratePerPiece: purchaseCost,
      packageQuantity: packageQuantity !== null && Number.isFinite(Number(packageQuantity))
        ? Number(packageQuantity)
        : null,
      packageUnit: readParsedString(parsed, ["packageUnit"], "PIECE"),
      saleUnit,
      allowFractionalQty: readParsedBoolean(
        parsed,
        ["allowFractionalQty"],
        saleUnit === "KG" || saleUnit === "GRAM" || saleUnit === "METER",
      ),
      quantityStep:
        readParsedNumber(
          parsed,
          ["quantityStep"],
          saleUnit === "KG" || saleUnit === "GRAM" || saleUnit === "METER"
            ? 0.01
            : 1,
        ) ?? 1,
      wholesaleEligible: readParsedBoolean(parsed, ["wholesaleEligible"], true),
      sourceCitation: readParsedString(
        parsed,
        ["sourceCitation"],
        batch.fileName ||
        `${displaySourceType(batch.sourceType)} supplier import`,
      ),
      searchAliases: readParsedAliases(parsed),
      retailPrice: Number(retailPrice || 0) > 0 ? Number(retailPrice) : null,
      wholesalePrice:
        Number(wholesalePrice || 0) > 0 ? Number(wholesalePrice) : null,
      stock: readParsedNumber(parsed, ["stock"], 0) ?? 0,
    };
  }

  const rate = parseReviewRate(rawText);
  const cleanedName = cleanReviewProductName(rawText, rate);
  const packageMatch = rawText.match(
    /\b(\d+)\s*(?:pcs?|pieces?|dozen|dz|box|bundle)\b/i,
  );
  const packageQuantity = packageMatch ? Number(packageMatch[1]) : null;
  const packageUnit = /dozen|dz/i.test(rawText)
    ? "DOZEN"
    : /box/i.test(rawText)
      ? "BOX"
      : /bundle/i.test(rawText)
        ? "BUNDLE"
        : "PIECE";
  const size = parseReviewSize(rawText);
  const skuBase = slugPart(sourceName) || "PDF";
  const namePart = slugPart(cleanedName) || `ROW-${row.rowNumber}`;
  const sku = `${skuBase}-${row.rowNumber}-${namePart}`.slice(0, 80);
  const stock = 0;
  const resolution = defaultImportResolution(row);

  return {
    rowId: row.id,
    selected:
      !isFinishedImportReviewStatus(row.status) &&
      row.status !== "FAILED" &&
      (resolution === "CREATE_NEW" || resolution === "UPDATE_MATCHED"),
    ignored: resolution === "IGNORE",
    rawText,
    rowNumber: row.rowNumber,
    status: row.status,
    error: row.error,
    comparisonStatus: row.comparisonStatus,
    changeSet: row.changeSet || [],
    resolution,
    name: cleanedName,
    sku,
    barcode: "",
    brand,
    category,
    categoryGroup: sourceName,
    vendorSource: sourceName,
    productCodeVariant: "",
    sizeValue: size.sizeValue,
    sizeUnit: size.sizeUnit,
    ratePerPiece: rate > 0 ? rate : null,
    packageQuantity:
      packageQuantity !== null && Number.isFinite(packageQuantity)
        ? packageQuantity
        : null,
    packageUnit,
    saleUnit:
      size.sizeUnit === "KG" || size.sizeUnit === "METER"
        ? size.sizeUnit
        : "PIECE",
    allowFractionalQty: size.sizeUnit === "KG" || size.sizeUnit === "METER",
    quantityStep:
      size.sizeUnit === "KG" || size.sizeUnit === "METER" ? 0.01 : 1,
    wholesaleEligible: true,
    sourceCitation:
      batch.fileName ||
      `${displaySourceType(batch.sourceType)} supplier import`,
    searchAliases: [],
    retailPrice: null,
    wholesalePrice: null,
    stock,
  };
}

const FieldLabelContext = React.createContext<string | undefined>(undefined);

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  const errorId = React.useId();
  const labelledChildren = React.Children.map(children, (child) => {
    if (!React.isValidElement(child) || child.type !== "input") return child;
    const input = child as React.ReactElement<any>;
    const describedBy = [
      input.props["aria-describedby"],
      error ? errorId : undefined,
    ].filter(Boolean).join(" ") || undefined;
    return React.cloneElement(input, {
      "aria-label": input.props["aria-label"] || label,
      "aria-describedby": describedBy,
    });
  });
  return (
    <div className="space-y-[4px]">
      <div className="text-[11px] font-extrabold text-[#565449]">{label}</div>
      <FieldLabelContext.Provider value={label}>
        {labelledChildren}
      </FieldLabelContext.Provider>
      {error ? (
        <div id={errorId} className="text-[12px] font-semibold text-rose-600" role="alert">{error}</div>
      ) : null}
    </div>
  );
}

function CompactPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-[16px] border border-[#CFCFD3] bg-white p-[12px]",
        className,
      )}
    >
      <div className="mb-[10px] text-[12px] font-extrabold uppercase text-[#565449]">
        {title}
      </div>
      <div className="space-y-[10px]">{children}</div>
    </section>
  );
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
  size = "md",
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[12px] font-semibold border active:scale-[0.98] transition";
  const sizeClass =
    size === "sm"
      ? "px-[10px] py-[7px] text-[12px]"
      : "px-[14px] py-[9px] text-[13px]";
  const styles =
    variant === "primary"
      ? "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27]"
      : variant === "danger"
        ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100"
        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        base,
        sizeClass,
        styles,
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {icon ? <GoogleIcon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
}) {
  const fieldLabel = React.useContext(FieldLabelContext);
  return (
    <ProjectSelect
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={Boolean(error)}
      aria-label={fieldLabel}
      className={cn(
        "h-[38px] w-full rounded-[12px] border bg-white px-[10px] text-[13px] font-semibold text-[#000000] outline-none",
        error ? "border-rose-300" : "border-[#CFCFD3]",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </ProjectSelect>
  );
}

function ThresholdModeSwitch({
  mode,
  onChange,
  defaultLabel,
  customLabel,
}: {
  mode: "default" | "custom";
  onChange: (mode: "default" | "custom") => void;
  defaultLabel: string;
  customLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-[6px]">
      <button
        type="button"
        onClick={() => onChange("default")}
        className={cn(
          "h-[34px] rounded-[10px] border px-[10px] text-left text-[11px] font-extrabold transition",
          mode === "default"
            ? "border-[#11120d] bg-[#11120d] text-white"
            : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
        )}
      >
        {defaultLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange("custom")}
        className={cn(
          "h-[34px] rounded-[10px] border px-[10px] text-left text-[11px] font-extrabold transition",
          mode === "custom"
            ? "border-[#11120d] bg-[#11120d] text-white"
            : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
        )}
      >
        {customLabel}
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {status}
    </span>
  );
}

function StockPill({
  flag,
}: {
  flag: "In Stock" | "Low Stock" | "Out of Stock";
}) {
  const cls =
    flag === "In Stock"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : flag === "Low Stock"
        ? "bg-[#FFF7E8] text-[#B7791F] border-[#F6D28B]"
        : "bg-[#FFF1F2] text-[#BE123C] border-[#FECDD3]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {flag}
    </span>
  );
}

function ModalShell({
  open,
  title,
  children,
  footer,
  onClose,
  landscape = false,
  headerLeft,
  maxWidthClass,
  contentClassName,
  footerClassName,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  landscape?: boolean;
  headerLeft?: React.ReactNode;
  maxWidthClass?: string;
  contentClassName?: string;
  footerClassName?: string;
}) {
  useBodyScrollLock(open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 isolate z-[120]">
      <button
        type="button"
        aria-label="Close modal overlay"
        onClick={onClose}
        className="absolute inset-0 z-0 bg-black/50 backdrop-blur-[2px]"
      />
      <div className="absolute inset-0 z-10 flex items-end justify-center p-0 lg:items-center lg:p-[12px]">
        <div
          className={cn(
            "relative z-10 flex h-auto max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.28)] lg:max-h-[calc(100vh-28px)] lg:rounded-[18px] lg:border lg:border-[#CFCFD3]",
            maxWidthClass || (landscape ? "max-w-[1180px]" : "max-w-[1040px]"),
          )}
        >
          <div className="shrink-0 flex min-h-[58px] items-center justify-between border-b border-[#CFCFD3] px-[16px] py-[10px] lg:min-h-0">
            <div className="flex min-w-0 items-center gap-[10px]">
              {headerLeft}
              <div className="truncate text-[18px] font-extrabold text-[#000000] lg:text-[15px] lg:font-semibold">
                {title}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-[12px] border border-[#CFCFD3] hover:bg-[#F3F4F6]"
              aria-label="Close modal"
            >
              <GoogleIcon name="close" className="text-[#565449]" />
            </button>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1",
              contentClassName ?? "bg-white px-[14px] py-[12px] lg:bg-[#F8FAFC]",
              landscape
                ? "overflow-y-auto xl:overflow-hidden"
                : "overflow-y-auto",
            )}
          >
            {children}
          </div>

          {footer ? (
            <div className={cn("shrink-0 border-t border-[#CFCFD3] bg-white px-[16px] pb-[max(10px,env(safe-area-inset-bottom))] pt-[10px] lg:py-[10px]", footerClassName)}>
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

// this component holds all the modals for the products page (Add, Edit, View, Import, Confirm Delete)
// it keeps the main Products page cleaner by separating all modal jsx and state wiring into this file
export default function ProductsModals({
  stockTracked,
  brands,
  categories,
  supplierOptions,
  businessDefaults,

  openAddEdit,
  setOpenAddEdit,
  openImport,
  setOpenImport,
  openView,
  setOpenView,
  openConfirmDelete,
  setOpenConfirmDelete,

  activeProduct,
  activeProductId,

  form,
  setForm,
  formErrors,
  productImagePreview,
  productImageName,
  productSearchTerms,
  setProductSearchTerms,
  productSearchTermsLoading,
  purchaseCostVisible,
  onProductImageChange,
  onClearProductImage,

  onSave,
  productSaveBusy,
  onValidateProductStep,
  onClearFormError,
  onConfirmDelete,
  isAdmin,
  deleteSafety,
  deleteSafetyLoading,
  deleteBusy,
  onConfirmPermanentDelete,
  onDiscardStockAndDelete,
  bulkAction,
  bulkProducts,
  onCloseBulkAction,
  onRemoveBulkProduct,
  onConfirmBulkAction,
  onEditActiveProduct,
  importFile,
  setImportFile,
  importBusy,
  importError,
  importResult,
  pdfReviewBatch,
  importBatches,
  importDocuments,
  importDocumentsLoading,
  importDocumentBusyId,
  importTemplates,
  importTemplateId,
  setImportTemplateId,
  importSupplier,
  setImportSupplier,
  importFieldMap,
  setImportFieldMap,
  onSaveImportTemplate,
  onDeleteImportTemplate,
  pdfReviewBusy,
  onSaveReviewedPdfRows,
  onImportReviewedPdfRows,
  onBackToImportList,
  onOpenImportBatch,
  onDeleteImportBatch,
  onOpenImportDocument,
  onRefreshImportDocuments,
  lastImportedProducts,
  lastImportSupplier,
  onReceiveImportedProducts,
  onCloseImport,
  onUploadCsvClick,
}: {
  stockTracked: boolean;
  brands: string[];
  categories: string[];
  supplierOptions: string[];
  businessDefaults: {
    defaultInitialStock: number;
    defaultLowStockThreshold: number;
    defaultWholesaleQtyThreshold: number;
  };

  openAddEdit: boolean;
  setOpenAddEdit: (v: boolean) => void;

  openImport: boolean;
  setOpenImport: (v: boolean) => void;

  openView: boolean;
  setOpenView: (v: boolean) => void;

  openConfirmDelete: boolean;
  setOpenConfirmDelete: (v: boolean) => void;

  activeProduct: Product | null;
  activeProductId: string | null;

  form: Product;
  setForm: React.Dispatch<React.SetStateAction<Product>>;
  formErrors: ProductFormErrors;
  productImagePreview: string;
  productImageName: string;
  productSearchTerms: string[];
  setProductSearchTerms: React.Dispatch<React.SetStateAction<string[]>>;
  productSearchTermsLoading: boolean;
  purchaseCostVisible: boolean;
  onProductImageChange: (file: File | null) => void;
  onClearProductImage: () => void;

  onSave: () => void;
  productSaveBusy: boolean;
  onValidateProductStep: (step: "basic" | "units" | "pricing" | "stock") => boolean;
  onClearFormError: (field: keyof ProductFormErrors) => void;
  onConfirmDelete: () => void;
  isAdmin: boolean;
  deleteSafety: ProductDeleteSafety | null;
  deleteSafetyLoading: boolean;
  deleteBusy: boolean;
  onConfirmPermanentDelete: () => void;
  onDiscardStockAndDelete: () => void;
  bulkAction: {
    title: string;
    message: string;
    confirmLabel: string;
  } | null;
  bulkProducts: Product[];
  onCloseBulkAction: () => void;
  onRemoveBulkProduct: (productId: string) => void;
  onConfirmBulkAction: () => void;
  onEditActiveProduct: () => void;
  importFile: File | null;
  setImportFile: (file: File | null) => void;
  importBusy: boolean;
  importError: string;
  importResult: CsvImportResult | null;
  pdfReviewBatch: ProductImportBatch | null;
  importBatches: ProductImportBatch[];
  importDocuments: DocumentRecord[];
  importDocumentsLoading: boolean;
  importDocumentBusyId: string | null;
  importTemplates: ProductImportTemplate[];
  importTemplateId: string;
  setImportTemplateId: (v: string) => void;
  importSupplier: string;
  setImportSupplier: (v: string) => void;
  importFieldMap: Record<string, string>;
  setImportFieldMap: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  onSaveImportTemplate: () => void;
  onDeleteImportTemplate: (templateId: string) => void;
  pdfReviewBusy: boolean;
  onSaveReviewedPdfRows: (
    rows: ReviewedPdfImportRowPayload[],
  ) => Promise<void>;
  onImportReviewedPdfRows: (
    rows: ReviewedPdfImportRowPayload[],
    ignoredRowIds: string[],
  ) => void;
  onBackToImportList: () => void;
  onOpenImportBatch: (batchId: string) => void;
  onDeleteImportBatch: (batchId: string) => void;
  onOpenImportDocument: (document: DocumentRecord) => void;
  onRefreshImportDocuments: () => void;
  lastImportedProducts: ImportedProductSummary[];
  lastImportSupplier: string;
  onReceiveImportedProducts: (
    importedProducts: ImportedProductSummary[],
    supplierName?: string | null,
  ) => void;
  onCloseImport: () => void;
  onUploadCsvClick: () => void;
}) {
  const inputBase =
    "h-[38px] w-full rounded-[12px] border bg-white px-[10px] text-[13px] font-semibold text-[#000000] outline-none";
  const inputClass = (error?: string) =>
    cn(inputBase, error ? "border-rose-300" : "border-[#CFCFD3]");
  const compactInputClass =
    "h-[38px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-[10px] text-[13px] font-semibold text-[#000000] outline-none";
  const [importTab, setImportTab] = React.useState<"csv" | "pdf" | "image">("csv");
  const [mobileEditorTab, setMobileEditorTab] = React.useState<ProductEditorStep>("basic");
  const productEditorTabRailRef = React.useRef<SwipeableTabRailController | null>(null);
  const [pricingDraft, setPricingDraft] = React.useState({ cost: "", wholesale: "", retail: "" });
  const [pricingMarkupDraft, setPricingMarkupDraft] = React.useState({ wholesale: "", retail: "" });
  const [productSearchTermDraft, setProductSearchTermDraft] = React.useState("");
  const [pdfReviewRows, setPdfReviewRows] = React.useState<PdfReviewDraft[]>(
    [],
  );
  const [localImportPreviewUrl, setLocalImportPreviewUrl] = React.useState("");
  const [activeReviewRowId, setActiveReviewRowId] = React.useState<
    string | null
  >(null);
  const reviewMarginPercent = 18;
  const [reviewPanelTab, setReviewPanelTab] = React.useState<"row" | "bulk">(
    "row",
  );
  const [reviewSearch, setReviewSearch] = React.useState("");
  const [mobileReviewView, setMobileReviewView] = React.useState<"list" | "editor">("list");
  const [confirmImportSelected, setConfirmImportSelected] = React.useState(false);
  const [reviewStatusFilter, setReviewStatusFilter] = React.useState<
    "ALL" | "READY" | "ISSUES" | "DUPLICATE" | "IGNORED"
  >("ALL");
  const [bulkBrand, setBulkBrand] = React.useState("");
  const [bulkCategory, setBulkCategory] = React.useState("");
  const [bulkSupplier, setBulkSupplier] = React.useState("");
  const [bulkPackageUnit, setBulkPackageUnit] = React.useState("PIECE");
  const [bulkSaleUnit, setBulkSaleUnit] = React.useState("PIECE");
  const [bulkWholesaleEligible, setBulkWholesaleEligible] = React.useState<
    "keep" | "on" | "off"
  >("keep");
  const [bulkStock, setBulkStock] = React.useState(0);

  React.useEffect(() => {
    if (!importFile ||
      !(importFile.type === "application/pdf" ||
        importFile.type.startsWith("image/") ||
        /\.(pdf|png|jpe?g|webp)$/i.test(importFile.name))) {
      setLocalImportPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(importFile);
    setLocalImportPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [importFile]);
  const [bulkWholesaleMargin, setBulkWholesaleMargin] = React.useState(18);
  const [bulkRetailMargin, setBulkRetailMargin] = React.useState(30);
  const [savedReviewFingerprints, setSavedReviewFingerprints] = React.useState<
    Record<string, string>
  >({});
  const [verifiedReviewRowIds, setVerifiedReviewRowIds] = React.useState<
    Set<string>
  >(new Set());
  const [reviewSaveBusy, setReviewSaveBusy] = React.useState(false);
  const [reviewSaveError, setReviewSaveError] = React.useState("");
  const [deleteImportBatchId, setDeleteImportBatchId] = React.useState<
    string | null
  >(null);
  const [importSupplierError, setImportSupplierError] = React.useState("");
  const importSupplierRef = React.useRef<HTMLInputElement>(null);
  const activeReviewRow =
    pdfReviewRows.find((row) => row.rowId === activeReviewRowId) ||
    pdfReviewRows.find((row) => !row.ignored) ||
    null;
  const reviewBrandOptions = React.useMemo(
    () => [
      ...brands.filter((brand) => brand !== "All Brands"),
      ...pdfReviewRows.map((row) => row.brand),
    ],
    [brands, pdfReviewRows],
  );
  const reviewCategoryOptions = React.useMemo(
    () => [
      ...categories.filter((category) => category !== "All Categories"),
      ...pdfReviewRows.map((row) => row.category),
    ],
    [categories, pdfReviewRows],
  );
  const reviewSupplierOptions = React.useMemo(
    () => [
      ...supplierOptions,
      ...pdfReviewRows.map((row) => row.vendorSource || ""),
    ],
    [supplierOptions, pdfReviewRows],
  );
  const deleteImportBatch =
    importBatches.find((batch) => batch.id === deleteImportBatchId) || null;

  React.useEffect(() => {
    if (openAddEdit) {
      setMobileEditorTab("basic");
      const cost = Number(form.ratePerPiece || 0);
      const wholesale = Number(form.wholesalePrice || 0);
      const retail = Number(form.retailPrice || 0);
      setPricingDraft({
        cost: cost > 0 ? String(cost) : "",
        wholesale: wholesale > 0 ? String(wholesale) : "",
        retail: retail > 0 ? String(retail) : "",
      });
      setPricingMarkupDraft({
        wholesale: cost > 0 && wholesale > 0 ? String(Math.round(((wholesale - cost) / cost) * 10000) / 100) : "",
        retail: cost > 0 && retail > 0 ? String(Math.round(((retail - cost) / cost) * 10000) / 100) : "",
      });
      setProductSearchTermDraft("");
    }
  }, [openAddEdit, activeProductId]);

  function addProductSearchTerm() {
    const term = productSearchTermDraft.trim().replace(/\s+/g, " ");
    if (!term || term.length > 120 || productSearchTerms.length >= 20) return;
    setProductSearchTerms((current) => {
      if (current.some((item) => item.localeCompare(term, undefined, { sensitivity: "accent" }) === 0)) {
        return current;
      }
      return [...current, term];
    });
    setProductSearchTermDraft("");
  }

  function downloadImportReviewSheet() {
    if (!pdfReviewBatch || pdfReviewRows.length === 0) return;
    const headers = [
      "Row",
      "Selected",
      "Ignored",
      "Status",
      "Product name",
      "SKU",
      "Barcode",
      "Brand",
      "Category",
      "Supplier",
      "Variant / code",
      "Search terms",
      "Purchase cost",
      "Wholesale price",
      "Retail price",
      "Package quantity",
      "Package unit",
      "Sale unit",
      "Stock",
      "Issue",
    ];
    const rows = pdfReviewRows.map((row) => [
      row.rowNumber,
      row.selected ? "Yes" : "No",
      row.ignored ? "Yes" : "No",
      row.status,
      row.name,
      row.sku,
      row.barcode || "",
      row.brand,
      row.category,
      row.vendorSource || "",
      row.productCodeVariant || "",
      (row.searchAliases || []).join(" | "),
      row.ratePerPiece,
      row.wholesalePrice,
      row.retailPrice,
      row.packageQuantity,
      row.packageUnit,
      row.saleUnit,
      stockTracked ? row.stock : "Not tracked",
      row.error || "",
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = (pdfReviewBatch.fileName || "supplier-catalog")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "supplier-catalog";
    link.href = objectUrl;
    link.download = `${baseName}-review.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  React.useEffect(() => {
    if (!openImport) setImportSupplierError("");
  }, [openImport]);

  function saveImportTemplateWithValidation() {
    if (!importSupplier.trim()) {
      setImportSupplierError("Enter a supplier or brand name before saving this mapping.");
      focusInvalidField(importSupplierRef);
      return;
    }
    setImportSupplierError("");
    onSaveImportTemplate();
  }

  const productEditorSteps = stockTracked
    ? PRODUCT_EDITOR_STEPS
    : PRODUCT_EDITOR_STEPS.filter((step) => step.value !== "stock");
  const editorStepIndex = productEditorSteps.findIndex((step) => step.value === mobileEditorTab);
  function goToPreviousProductStep() {
    if (editorStepIndex <= 0) return;
    setMobileEditorTab(productEditorSteps[editorStepIndex - 1].value);
  }
  function goToNextProductStep() {
    if (editorStepIndex >= productEditorSteps.length - 1) return;
    if (mobileEditorTab !== "review" && !onValidateProductStep(mobileEditorTab)) return;
    setMobileEditorTab(productEditorSteps[editorStepIndex + 1].value);
  }

  const productEditorSwipeGesture = useHorizontalGesture<HTMLDivElement>({
    enabled: openAddEdit && !productSaveBusy,
    threshold: 64,
    edgeGuard: 24,
    allowMouse: true,
    maxViewportWidth: 1023,
    onMove: (offsetX) => {
      const direction: -1 | 1 = offsetX < 0 ? 1 : -1;
      if (!productEditorSteps[editorStepIndex + direction]) {
        productEditorTabRailRef.current?.settle();
        return;
      }
      productEditorTabRailRef.current?.setGestureProgress(
        direction,
        Math.min(1, Math.abs(offsetX) / 140),
      );
    },
    onSwipeLeft: goToNextProductStep,
    onSwipeRight: goToPreviousProductStep,
    onEnd: () => window.requestAnimationFrame(() => productEditorTabRailRef.current?.settle()),
  });

  React.useEffect(() => {
    if (!openAddEdit || Object.keys(formErrors).length === 0) return;
    if (formErrors.name || formErrors.brand || formErrors.category || formErrors.sku || formErrors.image) setMobileEditorTab("basic");
    else if (formErrors.packageQuantity || formErrors.quantityStep) setMobileEditorTab("units");
    else if (formErrors.ratePerPiece || formErrors.retailPrice || formErrors.wholesalePrice || formErrors.thresholdQty) setMobileEditorTab("pricing");
    else if (stockTracked && (formErrors.stock || formErrors.lowStockThreshold)) setMobileEditorTab("stock");
    const timer = window.setTimeout(() => {
      focusInvalidField(document.querySelector<HTMLElement>("[data-product-editor] [aria-invalid='true']"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [formErrors, openAddEdit]);
  const selectedReviewRows = pdfReviewRows.filter(
    (row) =>
      row.selected &&
      !row.ignored &&
      !isFinishedImportReviewStatus(row.status) &&
      (row.resolution === "CREATE_NEW" || row.resolution === "UPDATE_MATCHED"),
  );
  const keptReviewRows = pdfReviewRows.filter(
    (row) =>
      !row.ignored &&
      !isFinishedImportReviewStatus(row.status) &&
      row.resolution === "KEEP_EXISTING",
  );
  const commitReviewRows = [...selectedReviewRows, ...keptReviewRows];
  const dirtyReviewRows = pdfReviewRows.filter(
    (row) =>
      row.status !== "IMPORTED" &&
      reviewedImportRowFingerprint(row) !== savedReviewFingerprints[row.rowId],
  );
  const dirtyReviewRowIds = new Set(dirtyReviewRows.map((row) => row.rowId));
  const dirtySelectedReviewRows = selectedReviewRows.filter((row) =>
    dirtyReviewRowIds.has(row.rowId),
  );
  const dirtyCommitReviewRows = commitReviewRows.filter((row) =>
    dirtyReviewRowIds.has(row.rowId),
  );
  const unconfirmedSelectedReviewRows = selectedReviewRows.filter(
    (row) =>
      dirtyReviewRowIds.has(row.rowId) ||
      row.error ||
      !verifiedReviewRowIds.has(row.rowId),
  );
  const activeReviewRowDirty = activeReviewRow
    ? dirtyReviewRowIds.has(activeReviewRow.rowId)
    : false;
  const activeReviewRowNeedsConfirmation = Boolean(
    activeReviewRow &&
    (activeReviewRowDirty ||
      activeReviewRow.error ||
      !verifiedReviewRowIds.has(activeReviewRow.rowId)),
  );
  const selectedReviewIssueCount = commitReviewRows.filter(
    (row) =>
      row.error ||
      row.status === "FAILED" ||
      row.comparisonStatus === "IDENTIFIER_CONFLICT" ||
      row.comparisonStatus === "IN_FILE_DUPLICATE",
  ).length;
  const ignoredReviewRows = pdfReviewRows.filter((row) => row.ignored);
  const filteredReviewRows = pdfReviewRows.filter((row) => {
    const q = reviewSearch.trim().toLowerCase();
    const matchesSearch =
      !q ||
      [
        row.rawText,
        row.name,
        row.sku,
        row.category,
        row.brand,
        row.vendorSource,
        row.sourceCitation,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    const matchesStatus =
      reviewStatusFilter === "ALL" ||
      (reviewStatusFilter === "IGNORED" && row.ignored) ||
      (reviewStatusFilter === "DUPLICATE" && row.status === "DUPLICATE") ||
      (reviewStatusFilter === "ISSUES" &&
        !row.ignored &&
        (row.status === "FAILED" || !!row.error)) ||
      (reviewStatusFilter === "READY" &&
        !row.ignored &&
        row.status === "READY" &&
        !row.error);
    return matchesSearch && matchesStatus;
  });
  const selectableFilteredRows = filteredReviewRows.filter(
    (row) =>
      !row.ignored &&
      !isFinishedImportReviewStatus(row.status) &&
      row.status !== "FAILED" &&
      row.comparisonStatus !== "MATCHED_WITH_CHANGES" &&
      row.comparisonStatus !== "EXACT_DUPLICATE" &&
      row.comparisonStatus !== "IDENTIFIER_CONFLICT" &&
      row.comparisonStatus !== "IN_FILE_DUPLICATE",
  );
  const allVisibleSelected =
    selectableFilteredRows.length > 0 &&
    selectableFilteredRows.every((row) => row.selected);

  React.useEffect(() => {
    if (!pdfReviewBatch) {
      setPdfReviewRows([]);
      setActiveReviewRowId(null);
      return;
    }

    const nextRows = pdfReviewBatch.rows.map((row) =>
      guessPdfReviewDraft(pdfReviewBatch, row, brands, categories),
    );
    setPdfReviewRows(nextRows);
    setSavedReviewFingerprints(
      Object.fromEntries(
        nextRows.map((row) => [row.rowId, reviewedImportRowFingerprint(row)]),
      ),
    );
    setVerifiedReviewRowIds(new Set());
    setReviewSaveError("");
    setActiveReviewRowId(nextRows.find((row) => !row.ignored)?.rowId || null);
    setReviewPanelTab("row");
    setMobileReviewView("list");
    setConfirmImportSelected(false);
    setReviewSearch("");
    setReviewStatusFilter("ALL");
    setBulkBrand("");
    setBulkCategory("");
    setBulkSupplier("");
    setBulkPackageUnit("PIECE");
    setBulkSaleUnit("PIECE");
    setBulkWholesaleEligible("keep");
    setBulkStock(0);
  }, [pdfReviewBatch?.id, brands, categories]);

  function updateReviewRow(rowId: string, patch: Partial<PdfReviewDraft>) {
    setReviewSaveError("");
    setPdfReviewRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );
  }

  function updateSelectedReviewRows(patch: Partial<PdfReviewDraft>) {
    setReviewSaveError("");
    setPdfReviewRows((rows) =>
      rows.map((row) =>
        row.selected && !row.ignored && row.status !== "IMPORTED"
          ? { ...row, ...patch }
          : row,
      ),
    );
  }

  function applyBulkClassificationToSelectedRows() {
    updateSelectedReviewRows({
      ...(bulkBrand.trim() ? { brand: bulkBrand.trim() } : {}),
      ...(bulkCategory.trim()
        ? { category: bulkCategory.trim(), categoryGroup: bulkCategory.trim() }
        : {}),
      ...(bulkSupplier.trim() ? { vendorSource: bulkSupplier.trim() } : {}),
    });
  }

  function applyBulkPricingToSelectedRows() {
    setPdfReviewRows((rows) =>
      rows.map((row) => {
        if (!row.selected || row.ignored || row.status === "IMPORTED")
          return row;
        if (row.ratePerPiece === null) return row;
        const rate = Number(row.ratePerPiece);
        return {
          ...row,
          wholesalePrice: applyRetailMargin(rate, bulkWholesaleMargin),
          retailPrice: applyRetailMargin(rate, bulkRetailMargin),
        };
      }),
    );
  }

  function applyBulkStockToSelectedRows() {
    updateSelectedReviewRows({ stock: Math.max(0, Number(bulkStock || 0)) });
  }

  function applyBulkRulesToSelectedRows() {
    updateSelectedReviewRows({
      packageUnit: bulkPackageUnit,
      saleUnit: bulkSaleUnit,
      ...(bulkWholesaleEligible === "keep"
        ? {}
        : { wholesaleEligible: bulkWholesaleEligible === "on" }),
    });
  }

  function toggleVisibleReviewSelection(checked: boolean) {
    const ids = new Set(selectableFilteredRows.map((row) => row.rowId));
    setPdfReviewRows((rows) =>
      rows.map((row) =>
        ids.has(row.rowId) ? { ...row, selected: checked } : row,
      ),
    );
  }

  function moveActiveReviewRow(direction: -1 | 1) {
    if (!activeReviewRow) return;
    const index = filteredReviewRows.findIndex((row) => row.rowId === activeReviewRow.rowId);
    const next = filteredReviewRows[index + direction];
    if (next) setActiveReviewRowId(next.rowId);
  }

  async function saveReviewDraftRows(rows: PdfReviewDraft[]) {
    if (rows.length === 0 || reviewSaveBusy) return;
    setReviewSaveBusy(true);
    setReviewSaveError("");
    try {
      await onSaveReviewedPdfRows(rows.map(toReviewedImportRowPayload));
      const savedIds = new Set(rows.map((row) => row.rowId));
      setSavedReviewFingerprints((current) => ({
        ...current,
        ...Object.fromEntries(
          rows.map((row) => [row.rowId, reviewedImportRowFingerprint(row)]),
        ),
      }));
      setVerifiedReviewRowIds((current) => {
        const next = new Set(current);
        savedIds.forEach((id) => next.add(id));
        return next;
      });
      setPdfReviewRows((current) =>
        current.map((row) =>
          savedIds.has(row.rowId)
            ? { ...row, status: "READY", error: null }
            : row,
        ),
      );
    } catch (error: any) {
      setReviewSaveError(
        error?.response?.data?.error ||
        error?.message ||
        "Review changes could not be saved.",
      );
    } finally {
      setReviewSaveBusy(false);
    }
  }

  function regenerateReviewSku(row: PdfReviewDraft) {
    const sourcePart =
      slugPart(
        row.vendorSource || row.brand || sourceNameFromBatch(pdfReviewBatch!),
      ) || "IMPORT";
    const namePart =
      slugPart(row.name || row.rawText || `ROW-${row.rowNumber}`) ||
      `ROW-${row.rowNumber}`;
    updateReviewRow(row.rowId, {
      sku: `${sourcePart}-${row.rowNumber}-${namePart}`.slice(0, 80),
      status: "READY",
      error: null,
      selected: !row.ignored,
    });
  }

  function confirmSelectedPdfRowsImport() {
    const rows = commitReviewRows.map(toReviewedImportRowPayload);
    onImportReviewedPdfRows(
      rows,
      ignoredReviewRows.map((row) => row.rowId),
    );
    setConfirmImportSelected(false);
  }

  return (
    <>
      <ModalShell
        open={openAddEdit}
        title={activeProductId ? "Edit Product" : "Add Product"}
        onClose={() => { if (!productSaveBusy) setOpenAddEdit(false); }}
        maxWidthClass="max-w-[760px]"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <div>
              {editorStepIndex > 0 ? <Button onClick={goToPreviousProductStep} disabled={productSaveBusy}>Back</Button> : <Button onClick={() => setOpenAddEdit(false)} disabled={productSaveBusy}>Cancel</Button>}
            </div>
            {activeProductId ? (
              <Button variant="primary" icon="save" onClick={onSave} disabled={productSaveBusy}>
                {productSaveBusy ? "Saving..." : "Save Changes"}
              </Button>
            ) : mobileEditorTab === "review" ? (
              <Button variant="primary" icon="save" onClick={onSave} disabled={productSaveBusy}>
                {productSaveBusy ? "Saving..." : "Create Product"}
              </Button>
            ) : (
              <Button variant="primary" icon="arrow_forward" onClick={goToNextProductStep}>Continue</Button>
            )}
          </div>
        }
      >
        <div className="border-b border-[#E5E7EB] bg-white px-3 pt-2.5 md:px-6">
          <div className="mb-1 text-[12px] font-bold text-[#64748B]">
            {activeProductId ? "Edit section" : "Step"} {editorStepIndex + 1} of {productEditorSteps.length}
            {activeProductId ? " · Save from any section" : ""}
          </div>
          <SwipeableTabRail
            items={productEditorSteps}
            value={mobileEditorTab}
            onChange={setMobileEditorTab}
            ariaLabel="Product form steps"
            controllerRef={productEditorTabRailRef}
            railClassName="w-full min-w-full"
            buttonClassName="h-[48px] min-w-0 flex-1 px-1 text-[14px] font-extrabold"
            activeClassName="text-[#11120D]"
            inactiveClassName="text-[#8C8889] hover:text-[#565449]"
          />
        </div>
        <div {...productEditorSwipeGesture} data-product-editor className="min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-col gap-4 sm:gap-5">

            {/* Basic Info Tab */}
            <div className={cn("flex flex-col gap-4", mobileEditorTab !== "basic" && "hidden")}>

              {/* Image uploader stacks on narrow screens so the form does not leave a dead column below it. */}
              <div className="grid grid-cols-1 items-start gap-3.5 sm:grid-cols-[136px_minmax(0,1fr)] sm:gap-4">
                {/* Product Image Uploader */}
                <div className="flex w-full flex-col items-center sm:w-[136px]">
                  <div className="w-full text-[11px] font-bold uppercase tracking-wider text-[#475569] mb-1.5 self-start">
                    Product Image
                  </div>
                  <div className="relative flex h-[78px] w-full flex-col items-center justify-center overflow-hidden rounded-[14px] border-2 border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-1.5 transition hover:border-[#1E293B] hover:bg-[#F1F5F9] sm:h-[136px] sm:w-[136px]">
                    <input
                      id="product-image-dropzone"
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        onProductImageChange(event.target.files?.[0] || null);
                        event.currentTarget.value = "";
                      }}
                      className="sr-only"
                    />
                    {productImagePreview || form.imageUrl ? (
                      <div className="group relative flex h-full w-full items-center justify-center">
                        <PreviewableImage
                          src={productImagePreview || form.imageUrl}
                          alt={form.name || "Product preview"}
                          title={form.name || "Product preview"}
                          subtitle={form.sku ? `SKU: ${form.sku}` : undefined}
                          enablePreview="desktop"
                          imgClassName="h-full w-full object-contain p-1"
                          className="flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] bg-white"
                          fallback={<GoogleIcon name="inventory_2" sizePx={36} className="text-[#8C8889]" />}
                        />
                        <div className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-[10px] bg-black/55 opacity-0 backdrop-blur-[1px] transition group-hover:opacity-100">
                          <label
                            htmlFor="product-image-dropzone"
                            className="inline-flex cursor-pointer items-center justify-center rounded-[7px] bg-white/95 px-2 py-1 text-[11px] font-bold text-[#0F172A] shadow-xs hover:bg-white"
                            title="Change image"
                          >
                            <GoogleIcon name="photo_camera" className="text-[14px]" />
                          </label>
                          <button
                            type="button"
                            onClick={onClearProductImage}
                            className="inline-flex items-center justify-center rounded-[7px] bg-rose-600 px-2 py-1 text-[11px] font-bold text-white shadow-xs hover:bg-rose-700"
                            title="Remove image"
                          >
                            <GoogleIcon name="delete" className="text-[14px]" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <label
                        htmlFor="product-image-dropzone"
                        className="flex h-full w-full cursor-pointer flex-row items-center justify-center gap-2.5 p-2 text-center sm:flex-col sm:gap-1"
                      >
                        <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-[#E2E8F0] text-[#475569]">
                          <GoogleIcon name="add_a_photo" className="text-[16px] sm:text-[18px]" />
                        </div>
                        <div className="text-[11px] sm:text-[11.5px] font-extrabold text-[#0F172A] leading-tight sm:mt-0.5">
                          Upload Image
                        </div>
                        <div className="text-[9px] sm:text-[9.5px] font-semibold text-[#94A3B8]">
                          JPG, PNG &lt; 5MB
                        </div>
                      </label>
                    )}
                  </div>
                  {formErrors.image ? (
                    <div className="mt-1 text-center text-[10.5px] font-bold text-rose-600">
                      {formErrors.image}
                    </div>
                  ) : null}
                  {productImagePreview || form.imageUrl ? (
                    <div className="mt-1.5 flex w-full justify-center gap-2">
                      <label
                        htmlFor="product-image-dropzone"
                        className="cursor-pointer text-[11px] font-bold text-[#2563EB] hover:underline"
                      >
                        Change
                      </label>
                      <span className="text-[#CBD5E1]">·</span>
                      <button
                        type="button"
                        onClick={onClearProductImage}
                        className="text-[11px] font-bold text-rose-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Main: Product Name, Brand & Category */}
                <div className="flex-1 min-w-0 space-y-3">
                  <Field label="Product Name" error={formErrors.name}>
                    <input
                      data-modal-initial-focus
                      value={form.name}
                      aria-invalid={Boolean(formErrors.name)}
                      onChange={(event) => {
                        setForm((product) => ({ ...product, name: event.target.value }));
                        onClearFormError("name");
                      }}
                      className={inputClass(formErrors.name)}
                      placeholder="e.g. Laundry Basket (Big)"
                    />
                  </Field>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Field label="Brand" error={formErrors.brand}>
                      <CreatableCombobox
                        value={form.brand}
                        onChange={(value) => { setForm((product) => ({ ...product, brand: value })); onClearFormError("brand"); }}
                        options={brands.filter((brand) => brand !== "All Brands")}
                        placeholder="Search or create brand"
                        ariaLabel="Brand"
                        invalid={Boolean(formErrors.brand)}
                        required
                      />
                    </Field>
                    <Field label="Category" error={formErrors.category}>
                      <CreatableCombobox
                        value={form.category}
                        onChange={(value) => { setForm((product) => ({ ...product, category: value })); onClearFormError("category"); }}
                        options={categories.filter((category) => category !== "All Categories")}
                        placeholder="Search or create category"
                        ariaLabel="Category"
                        invalid={Boolean(formErrors.category)}
                        required
                      />
                    </Field>
                  </div>
                </div>
              </div>

              {/* Remaining Fields below top row */}
              <div className="space-y-3 pt-1">
                {isAdmin ? (
                  <Field label="Search terms (optional)">
                    <div className="rounded-[12px] border border-[#CFCFD3] bg-white p-2.5">
                      <div className="flex gap-2">
                        <input
                          value={productSearchTermDraft}
                          maxLength={120}
                          disabled={productSearchTermsLoading || productSearchTerms.length >= 20}
                          onChange={(event) => setProductSearchTermDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === ",") {
                              event.preventDefault();
                              addProductSearchTerm();
                            }
                          }}
                          className="h-10 min-w-0 flex-1 rounded-[10px] border border-[#DADDE3] px-3 text-[13px] font-semibold outline-none focus:border-[#2563EB]"
                          placeholder="e.g. balti, local nickname, Nepali term"
                          aria-label="Product-specific search term"
                        />
                        <button
                          type="button"
                          onClick={addProductSearchTerm}
                          disabled={productSearchTermsLoading || !productSearchTermDraft.trim() || productSearchTerms.length >= 20}
                          className="inline-flex h-10 shrink-0 items-center justify-center rounded-[10px] bg-[#11120d] px-3 text-[12px] font-extrabold text-white disabled:opacity-40"
                        >
                          Add
                        </button>
                      </div>
                      <div className="mt-2 flex min-h-7 flex-wrap gap-1.5">
                        {productSearchTermsLoading ? (
                          <span className="text-[11px] font-semibold text-[#6B7280]">Loading saved terms...</span>
                        ) : productSearchTerms.length > 0 ? (
                          productSearchTerms.map((term) => (
                            <span key={term} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] pl-3 pr-1.5 text-[11px] font-bold text-[#1D4ED8]">
                              {term}
                              <button
                                type="button"
                                onClick={() => setProductSearchTerms((current) => current.filter((item) => item !== term))}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-blue-100"
                                aria-label={`Remove search term ${term}`}
                              >
                                <GoogleIcon name="close" className="text-[15px]" />
                              </button>
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] font-medium text-[#6B7280]">Add only real names customers or staff use for this exact product. Normal spelling mistakes are handled automatically.</span>
                        )}
                      </div>
                    </div>
                  </Field>
                ) : null}

                <Field label="Supplier / Source (optional)">
                  <CreatableCombobox
                    value={form.vendorSource || ""}
                    onChange={(value) => setForm((product) => ({ ...product, vendorSource: value }))}
                    options={supplierOptions}
                    placeholder="Search or type supplier"
                    ariaLabel="Supplier or source"
                  />
                </Field>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Field label="Barcode (optional)">
                    <input value={form.barcode || ""} onChange={(event) => setForm((product) => ({ ...product, barcode: event.target.value }))} className={compactInputClass} placeholder="Scan or type manufacturer barcode" />
                  </Field>
                  <Field label="SKU (optional)">
                    <input value={form.sku} onChange={(event) => setForm((product) => ({ ...product, sku: event.target.value }))} className={compactInputClass} placeholder="Generated automatically if blank" />
                  </Field>
                </div>
              </div>
            </div>

            {/* Bottom Row: Rest of the details */}
            <div className="grid grid-cols-1 gap-[18px]">

              {/* SIZE & PACKAGING */}
              <div className={cn("space-y-[12px]", mobileEditorTab !== "units" && "hidden")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  SIZE & PACKAGING
                </h3>

                <Field label="Sale Unit / बिक्री एकाइ">
                  <Select
                    value={form.saleUnit || "PIECE"}
                    onChange={(value) => {
                      const supportsFractions = ["KG", "GRAM", "METER", "LTR", "ML"].includes(value);
                      setForm((product) => ({
                        ...product,
                        saleUnit: value,
                        allowFractionalQty: supportsFractions ? product.allowFractionalQty : false,
                        quantityStep: supportsFractions ? product.quantityStep : 1,
                      }));
                    }}
                    options={[
                      { value: "PIECE", label: "Piece (वटा)" },
                      { value: "KG", label: "Kilogram (किलो)" },
                      { value: "GRAM", label: "Gram (ग्राम)" },
                      { value: "LTR", label: "Liter (लिटर)" },
                      { value: "ML", label: "Milliliter (मिलिलिटर)" },
                      { value: "METER", label: "Meter (मिटर)" },
                    ]}
                  />
                </Field>
                <p className="rounded-[10px] bg-[#F8FAFC] px-3 py-2 text-[11px] font-medium leading-5 text-[#6B7280]">
                  One unit is what price and stock mean—for example one bottle, one kilogram, or one meter.
                </p>

                <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-[10px]">
                  <Field label="Item size / capacity (optional)">
                    <input
                      type="number"
                      min={0.01}
                      step="0.001"
                      value={form.sizeValue ?? ""}
                      onChange={(event) =>
                        setForm((product) => ({
                          ...product,
                          sizeValue: event.target.value === "" ? null : Number(event.target.value),
                        }))
                      }
                      className={compactInputClass}
                      placeholder="2.5"
                    />
                  </Field>
                  <Field label="Size Unit">
                    <Select
                      value={form.sizeUnit || "STANDARD"}
                      onChange={(value) =>
                        setForm((product) => ({
                          ...product,
                          sizeUnit: value,
                          sizeValue: value === "STANDARD" ? null : product.sizeValue,
                        }))
                      }
                      options={[
                        { value: "STANDARD", label: "Std" },
                        { value: "LTR", label: "Ltr" },
                        { value: "ML", label: "ML" },
                        { value: "KG", label: "KG" },
                        { value: "GRAM", label: "Gram" },
                        { value: "INCH", label: "Inch" },
                        { value: "METER", label: "Meter" },
                        { value: "CM", label: "CM" },
                      ]}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-[10px]">
                  <Field label={`Pack contains (${(form.saleUnit || "PIECE").toLowerCase()})`} error={formErrors.packageQuantity}>
                    <input
                      type="number"
                      min={0.001}
                      step="0.001"
                      value={form.packageQuantity ?? ""}
                      aria-invalid={Boolean(formErrors.packageQuantity)}
                      onChange={(event) => {
                        setForm((product) => ({
                          ...product,
                          packageQuantity: event.target.value === "" ? null : Number(event.target.value),
                        }));
                        onClearFormError("packageQuantity");
                      }}
                      className={inputClass(formErrors.packageQuantity)}
                      placeholder="Unknown"
                    />
                  </Field>
                  <Field label="Pack type">
                    <Select
                      value={form.packageUnit || "PIECE"}
                      onChange={(value) =>
                        setForm((product) => ({
                          ...product,
                          packageUnit: value,
                          packageQuantity:
                            value === "DOZEN" && product.packageQuantity === 1
                              ? 12
                              : value === "PIECE" && product.packageQuantity === 12
                                ? 1
                                : product.packageQuantity,
                        }))
                      }
                      options={[
                        { value: "PIECE", label: "Piece" },
                        { value: "DOZEN", label: "Dozen" },
                        { value: "KG", label: "KG" },
                        { value: "BUNDLE", label: "Bundle" },
                        { value: "BOX", label: "Box" },
                      ]}
                    />
                  </Field>
                </div>

                {["KG", "GRAM", "METER", "LTR", "ML"].includes(form.saleUnit || "PIECE") ? (
                  <div className="rounded-[12px] border border-[#DADDE3] bg-[#F8FAFC] p-3">
                    <label className="flex min-h-[44px] items-center gap-[10px] text-[12px] font-bold text-[#11120d]">
                      <input
                        type="checkbox"
                        checked={form.allowFractionalQty}
                        onChange={(event) => setForm((product) => ({ ...product, allowFractionalQty: event.target.checked, quantityStep: event.target.checked ? (product.quantityStep === 1 ? 0.1 : product.quantityStep) : 1 }))}
                        className="h-5 w-5 rounded border-[#CFCFD3] accent-[#3B82F6]"
                      />
                      Allow partial quantity (for example 0.5 kg)
                    </label>
                    {form.allowFractionalQty ? (
                      <Field label="Quantity step" error={formErrors.quantityStep}>
                        <Select
                          value={String(form.quantityStep)}
                          onChange={(value) => {
                            setForm((product) => ({ ...product, quantityStep: Number(value) }));
                            onClearFormError("quantityStep");
                          }}
                          error={formErrors.quantityStep}
                          options={[{ value: "0.05", label: "0.05" }, { value: "0.1", label: "0.1" }, { value: "0.25", label: "0.25" }, { value: "0.5", label: "0.5" }, { value: "1", label: "1" }]}
                        />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* PRICING */}
              <div className={cn("space-y-[12px]", mobileEditorTab !== "pricing" && "hidden")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  PRICING
                </h3>

                <Field label="Catalog availability">
                  <Select
                    value={form.availabilityStatus}
                    onChange={(value) => setForm((product) => ({
                      ...product,
                      availabilityStatus: value === "COMING_SOON" ? "COMING_SOON" : "CATALOG_LISTED",
                    }))}
                    options={[
                      { value: "CATALOG_LISTED", label: "Catalog listed" },
                      { value: "COMING_SOON", label: "Price coming soon" },
                    ]}
                  />
                  <div className="mt-1 text-[10px] font-semibold leading-4 text-slate-500">
                    Coming-soon products stay searchable but are blocked from billing until prices are entered and this is changed to Catalog listed.
                  </div>
                </Field>

                <Field label={`Purchase cost per ${(form.saleUnit || "unit").toLowerCase()} (optional)`} error={formErrors.ratePerPiece}>
                  <input
                    type="number"
                    min={0.01}
                    step="0.01"
                    inputMode="decimal"
                    aria-invalid={Boolean(formErrors.ratePerPiece)}
                    value={pricingDraft.cost}
                    placeholder="Leave blank if unknown"
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => {
                      const value = event.target.value;
                      const nextCost = Number(value || 0);
                      setPricingDraft((current) => ({ ...current, cost: value }));
                      setForm((product) => ({
                        ...product,
                        ratePerPiece: value === "" ? null : nextCost,
                      }));
                      setPricingMarkupDraft({
                        wholesale: nextCost > 0 && Number(pricingDraft.wholesale) > 0 ? String(Math.round(((Number(pricingDraft.wholesale) - nextCost) / nextCost) * 10000) / 100) : "",
                        retail: nextCost > 0 && Number(pricingDraft.retail) > 0 ? String(Math.round(((Number(pricingDraft.retail) - nextCost) / nextCost) * 10000) / 100) : "",
                      });
                      onClearFormError("ratePerPiece");
                    }}
                    className={inputClass(formErrors.ratePerPiece)}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
                  <Field label="Store wholesale price (optional)" error={formErrors.wholesalePrice}>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      inputMode="decimal"
                      aria-invalid={Boolean(formErrors.wholesalePrice)}
                      value={pricingDraft.wholesale}
                      placeholder="Leave blank if unknown"
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const value = event.target.value;
                        const price = value === "" ? null : Number(value);
                        setPricingDraft((current) => ({ ...current, wholesale: value }));
                        setForm((product) => ({ ...product, wholesalePrice: price }));
                        onClearFormError("wholesalePrice");
                        const cost = Number(pricingDraft.cost || 0);
                        setPricingMarkupDraft((current) => ({ ...current, wholesale: cost > 0 && Number(price) > 0 ? String(Math.round(((Number(price) - cost) / cost) * 10000) / 100) : "" }));
                      }}
                      className={inputClass(formErrors.wholesalePrice)}
                    />
                  </Field>
                  <Field label="Retail price (optional)" error={formErrors.retailPrice}>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      inputMode="decimal"
                      aria-invalid={Boolean(formErrors.retailPrice)}
                      value={pricingDraft.retail}
                      placeholder="Leave blank if unknown"
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const value = event.target.value;
                        const price = value === "" ? null : Number(value);
                        setPricingDraft((current) => ({ ...current, retail: value }));
                        setForm((product) => ({ ...product, retailPrice: price }));
                        onClearFormError("retailPrice");
                        const cost = Number(pricingDraft.cost || 0);
                        setPricingMarkupDraft((current) => ({ ...current, retail: cost > 0 && Number(price) > 0 ? String(Math.round(((Number(price) - cost) / cost) * 10000) / 100) : "" }));
                      }}
                      className={inputClass(formErrors.retailPrice)}
                    />
                  </Field>
                </div>

                {!Number(pricingDraft.retail) || !Number(pricingDraft.wholesale) ? (
                  <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-4 text-amber-800">
                    Selling price pending. The product remains available in catalog and lookup, but cannot be billed until both prices are set.
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-3 rounded-[12px] border border-[#BFDBFE] bg-[#EFF6FF] p-3 md:grid-cols-2">
                  {(["wholesale", "retail"] as const).map((kind) => {
                    const sellingPrice = Number(pricingDraft[kind] || 0);
                    const cost = Number(pricingDraft.cost || 0);
                    const profit = sellingPrice - cost;
                    const grossMargin = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0;
                    return (
                      <Field key={kind} label={`${kind === "wholesale" ? "Wholesale" : "Retail"} markup on cost %`}>
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={pricingMarkupDraft[kind]}
                          disabled={!Number(pricingDraft.cost)}
                          placeholder="e.g. 20"
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const value = event.target.value;
                            const markup = Number(value || 0);
                            const nextPrice = cost > 0 && Number.isFinite(markup) ? Math.round(cost * (1 + markup / 100) * 100) / 100 : 0;
                            setPricingMarkupDraft((current) => ({ ...current, [kind]: value }));
                            setPricingDraft((current) => ({ ...current, [kind]: nextPrice > 0 ? String(nextPrice) : "" }));
                            setForm((product) => ({ ...product, [kind === "wholesale" ? "wholesalePrice" : "retailPrice"]: nextPrice }));
                          }}
                          className={`${compactInputClass} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
                        />
                        <div className="mt-1 text-[11px] font-semibold text-[#1D4ED8]">
                          {cost > 0
                            ? `Profit ${formatNpr(profit)} · Gross margin ${Number.isFinite(grossMargin) ? grossMargin.toFixed(1) : "0.0"}%`
                            : "Enter purchase cost to calculate markup and profit."}
                        </div>
                      </Field>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 gap-[10px]">
                  <label className="flex h-[38px] items-center gap-[8px] rounded-[10px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[12px] font-bold text-[#11120d]">
                    <input
                      type="checkbox"
                      checked={form.wholesaleEligible}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, wholesaleEligible: event.target.checked }))
                      }
                      className="h-[16px] w-[16px] rounded border-[#CFCFD3] accent-[#3B82F6]"
                    />
                    Wholesale Eligible
                  </label>

                  {form.wholesaleEligible && (
                    <Field label="Wholesale Threshold" error={formErrors.thresholdQty}>
                      <input
                        type="number"
                        min={1}
                        value={form.thresholdQtyMode === 'default' ? businessDefaults.defaultWholesaleQtyThreshold : form.thresholdQty}
                        aria-invalid={Boolean(formErrors.thresholdQty)}
                        onChange={(event) => {
                          setForm((product) => ({
                            ...product,
                            thresholdQtyMode: 'custom',
                            thresholdQty: Number(event.target.value),
                          }));
                          onClearFormError("thresholdQty");
                        }}
                        className={inputClass(formErrors.thresholdQty)}
                      />
                    </Field>
                  )}
                </div>
              </div>

              {/* STOCK & STATUS */}
              {stockTracked ? <div className={cn("space-y-[12px]", mobileEditorTab !== "stock" && "hidden")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  STOCK & STATUS
                </h3>

                <Field label="Initial Stock" error={formErrors.stock}>
                  <input
                    type="number"
                    value={form.stock}
                    readOnly={Boolean(activeProductId)}
                    aria-invalid={Boolean(formErrors.stock)}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => {
                      setForm((product) => ({ ...product, stock: Number(event.target.value) }));
                      onClearFormError("stock");
                    }}
                    className={cn(inputClass(formErrors.stock), activeProductId && "cursor-not-allowed bg-[#F3F4F6] text-[#6B7280]")}
                  />
                  <div className="mt-1 text-[11px] font-medium text-[#6B7280]">
                    {activeProductId
                      ? "Current stock is read-only here. Use Stock Movement for audited corrections or receiving."
                      : form.stock === businessDefaults.defaultInitialStock
                        ? `Using shop default: ${businessDefaults.defaultInitialStock}`
                        : "Custom initial stock"}
                  </div>
                </Field>

                <Field label="Low Stock Threshold" error={formErrors.lowStockThreshold}>
                  <input
                    type="number"
                    min={0}
                    value={form.lowStockThresholdMode === 'default' ? businessDefaults.defaultLowStockThreshold : form.lowStockThreshold}
                    aria-invalid={Boolean(formErrors.lowStockThreshold)}
                    onChange={(event) => {
                      setForm((product) => ({
                        ...product,
                        lowStockThresholdMode: 'custom',
                        lowStockThreshold: Number(event.target.value),
                      }));
                      onClearFormError("lowStockThreshold");
                    }}
                    className={inputClass(formErrors.lowStockThreshold)}
                  />
                </Field>

                <Field label="Status">
                  <Select
                    value={form.status}
                    onChange={(value) =>
                      setForm((product) => ({ ...product, status: value as any }))
                    }
                    options={[
                      { value: "Active", label: "Active" },
                      { value: "Inactive", label: "Inactive" },
                    ]}
                  />
                </Field>
              </div> : null}

            </div>

            {mobileEditorTab === "review" ? (
              <div className="space-y-4">
                {/* 1. Hero Product Summary Header Card */}
                <div className="flex flex-col gap-3.5 rounded-[16px] border border-[#E2E8F0] bg-white p-4 shadow-2xs sm:flex-row sm:items-start sm:justify-between sm:p-5">
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    {/* Thumbnail Frame */}
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC]">
                      {productImagePreview || form.imageUrl ? (
                        <img
                          src={productImagePreview || form.imageUrl}
                          alt={form.name || "Product"}
                          className="h-full w-full object-contain p-1"
                        />
                      ) : (
                        <GoogleIcon name="inventory_2" sizePx={34} className="text-[#94A3B8]" />
                      )}
                    </div>

                    {/* Basic Meta Info */}
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="text-[18px] sm:text-[20px] font-black leading-snug text-[#0F172A] break-words">
                        {form.name || "Untitled Product"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold">
                        <span className="rounded-md bg-[#F1F5F9] px-2.5 py-1 text-[#334155]">
                          {form.brand || "No Brand"}
                        </span>
                        <span className="text-[#CBD5E1]">·</span>
                        <span className="rounded-md bg-[#F1F5F9] px-2.5 py-1 text-[#334155]">
                          {form.category || "Uncategorized"}
                        </span>
                        {form.vendorSource ? (
                          <>
                            <span className="text-[#CBD5E1]">·</span>
                            <span className="text-[#64748B]">
                              Supplier: <span className="text-[#0F172A] font-extrabold">{form.vendorSource}</span>
                            </span>
                          </>
                        ) : null}
                      </div>

                      {/* SKU & Barcode pills */}
                      <div className="mt-1 flex flex-wrap items-center gap-2 pt-0.5 text-[12px] font-semibold text-[#64748B]">
                        <span className="inline-flex items-center gap-1 rounded-[6px] bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1 font-mono text-[#475569]">
                          <span className="text-[#94A3B8] font-sans">SKU:</span> {form.sku.trim() || "Auto-generated"}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-[6px] bg-[#F8FAFC] border border-[#E2E8F0] px-2.5 py-1 font-mono text-[#475569]">
                          <span className="text-[#94A3B8] font-sans">Barcode:</span> {form.barcode?.trim() || "Auto-generated"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setMobileEditorTab("basic")}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[9px] border border-[#CBD5E1] bg-white px-3 text-[12.5px] font-bold text-[#2563EB] shadow-2xs hover:bg-[#F8FAFC]"
                  >
                    <GoogleIcon name="edit" className="text-[14px]" />
                    <span>Edit Basic</span>
                  </button>
                </div>

                {/* 2. Structured Two-Column Summary Grid */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* Pricing Card */}
                  <section className="rounded-[16px] border border-[#E2E8F0] bg-white p-4 shadow-2xs flex flex-col justify-between sm:p-5">
                    <div>
                      <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                        <div className="flex items-center gap-2 text-[15px] font-black text-[#0F172A]">
                          <GoogleIcon name="payments" className="text-[18px] text-emerald-600" />
                          <span>Pricing & Margins</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setMobileEditorTab("pricing")}
                          className="text-[13px] font-bold text-[#2563EB] hover:underline"
                        >
                          Edit
                        </button>
                      </div>

                      <div className="mt-3.5 space-y-2 text-[13px]">
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Purchase Cost (खरिद):</span>
                          <span className="font-mono font-black text-[#0F172A] text-[14px]">
                            {form.ratePerPiece !== null && Number(form.ratePerPiece) > 0
                              ? formatNpr(Number(form.ratePerPiece))
                              : "Not entered"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Retail Price (खुद्रा):</span>
                          <span className="font-mono font-black text-[#0F172A] text-[15px]">
                            {formatNpr(Number(form.retailPrice || 0))}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Wholesale Price (थोक):</span>
                          <span className="font-mono font-black text-[#0F172A] text-[14px]">
                            {form.wholesaleEligible && form.wholesalePrice
                              ? formatNpr(Number(form.wholesalePrice))
                              : "Disabled"}
                          </span>
                        </div>
                        {form.wholesaleEligible && form.thresholdQty ? (
                          <div className="flex items-center justify-between py-0.5">
                            <span className="font-semibold text-[#64748B]">Wholesale Threshold:</span>
                            <span className="font-bold text-[#334155] text-[13.5px]">
                              {form.thresholdQty} {form.saleUnit || "PIECE"}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Calculated Profit Margin Badge */}
                    {form.ratePerPiece !== null && Number(form.ratePerPiece) > 0 && Number(form.retailPrice) > Number(form.ratePerPiece) ? (
                      <div className="mt-3.5 rounded-[10px] bg-emerald-50 border border-emerald-200 p-2.5 text-[12px] text-emerald-900 font-bold flex items-center justify-between">
                        <span>Gross Markup:</span>
                        <span>
                          {(((Number(form.retailPrice) - Number(form.ratePerPiece)) / Number(form.ratePerPiece)) * 100).toFixed(1)}% ({formatNpr(Number(form.retailPrice) - Number(form.ratePerPiece))} / {form.saleUnit || "piece"})
                        </span>
                      </div>
                    ) : null}
                  </section>

                  {/* Units, Packaging & Stock Card */}
                  <section className="rounded-[16px] border border-[#E2E8F0] bg-white p-4 shadow-2xs flex flex-col justify-between sm:p-5">
                    <div>
                      <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                        <div className="flex items-center gap-2 text-[15px] font-black text-[#0F172A]">
                          <GoogleIcon name="inventory" className="text-[18px] text-blue-600" />
                          <span>Units & Packaging</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setMobileEditorTab("units")}
                          className="text-[13px] font-bold text-[#2563EB] hover:underline"
                        >
                          Edit
                        </button>
                      </div>

                      <div className="mt-3.5 space-y-2 text-[13px]">
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Base Sale Unit:</span>
                          <span className="font-black uppercase text-[#0F172A]">
                            {form.saleUnit || "PIECE"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Physical Size:</span>
                          <span className="font-bold text-[#334155]">
                            {form.sizeValue ? `${form.sizeValue} ${form.sizeUnit || ""}` : "Standard / Unspecified"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Package Quantity:</span>
                          <span className="font-bold text-[#334155]">
                            {form.packageQuantity ? `${form.packageQuantity} ${form.saleUnit || "PIECE"}` : "1 PIECE"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="font-semibold text-[#64748B]">Order Step:</span>
                          <span className="font-bold text-[#334155]">
                            {form.quantityStep || 1} {form.saleUnit || "PIECE"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Stock & Status summary row */}
                    <div className="mt-3.5 rounded-[10px] bg-[#F8FAFC] border border-[#E2E8F0] p-2.5 flex items-center justify-between text-[12px]">
                      {stockTracked ? (
                        <div>
                          <span className="font-semibold text-[#64748B]">Stock: </span>
                          <span className="font-extrabold text-[#0F172A]">{form.stock} {form.saleUnit || "PIECE"}</span>
                        </div>
                      ) : (
                        <span className="text-[#64748B] font-medium">Standard tracking</span>
                      )}
                      <span className={cn(
                        "inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-extrabold",
                        form.status === "Active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
                      )}>
                        {form.status || "Active"}
                      </span>
                    </div>
                  </section>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={openImport}
        title={
          pdfReviewBatch
            ? `Review ${displaySourceType(pdfReviewBatch.sourceType)} Import`
            : "Import Products from Spreadsheet, PDF, or Image"
        }
        onClose={onCloseImport}
        landscape={!!pdfReviewBatch}
        contentClassName={
          pdfReviewBatch
            ? "min-h-0 flex-1 overflow-hidden bg-white p-0 lg:bg-[#F8FAFC] lg:p-3"
            : undefined
        }
        footerClassName={pdfReviewBatch && mobileReviewView === "editor" ? "hidden xl:block" : undefined}
        headerLeft={
          pdfReviewBatch ? (
            <button
              type="button"
              onClick={onBackToImportList}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
              aria-label="Back to import options"
            >
              <GoogleIcon name="arrow_back" className="text-[18px]" />
            </button>
          ) : null
        }
        footer={
          pdfReviewBatch ? (
            <div className="flex w-full items-center justify-between gap-3">
              <div className="min-w-0 text-[12px] font-semibold text-[#6B7280]">
                <span className="font-extrabold text-[#11120d]">
                  {selectedReviewRows.length} create/update
                </span>
                <span> · {keptReviewRows.length} keep · {ignoredReviewRows.length} ignored</span>
                {dirtyCommitReviewRows.length > 0 ? (
                  <span className="block text-amber-700">
                    {dirtyCommitReviewRows.length} decided row{dirtyCommitReviewRows.length === 1 ? " has" : "s have"} unsaved changes
                  </span>
                ) : null}
              </div>
              <Button
                variant="primary"
                icon="check_circle"
                onClick={() => setConfirmImportSelected(true)}
                disabled={
                  pdfReviewBusy ||
                  reviewSaveBusy ||
                  commitReviewRows.length === 0 ||
                  dirtyCommitReviewRows.length > 0
                }
              >
                {pdfReviewBusy
                  ? "Importing..."
                  : dirtyCommitReviewRows.length > 0
                    ? "Save changes first"
                    : `Apply ${commitReviewRows.length} decisions`}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-[10px]">
              <Button
                variant="primary"
                icon="upload_file"
                onClick={onUploadCsvClick}
                disabled={importBusy}
              >
                {importBusy ? "Importing..." : "Import File"}
              </Button>
            </div>
          )
        }
      >
        {pdfReviewBatch ? (
          <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden lg:gap-3 xl:h-[min(76vh,760px)] xl:grid-cols-[minmax(390px,0.95fr)_minmax(0,1.25fr)]">
            <section className={cn("min-h-0 flex-col overflow-hidden bg-white xl:rounded-[16px] xl:border xl:border-[#CFCFD3]", mobileReviewView === "list" ? "flex" : "hidden", "xl:flex")}>
              <div className="shrink-0 border-b border-[#CFCFD3] px-[12px] py-[10px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-[8px]">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-extrabold text-[#000000]">
                        {pdfReviewBatch.fileName || "Supplier rate list"}
                      </div>
                      <div className="mt-[2px] text-[11px] font-semibold text-[#8C8889]">
                        {pdfReviewBatch.rows.length} stored rows from{" "}
                        {pdfReviewBatch.totalRows} extracted
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={downloadImportReviewSheet}
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#CFCFD3] bg-white px-2.5 text-[11px] font-extrabold text-[#11120d] transition hover:bg-[#F3F4F6]"
                      aria-label="Download supplier review sheet"
                      title="Download the current review as CSV"
                    >
                      <GoogleIcon name="download" className="text-[17px]" />
                      <span className="hidden sm:inline">Review sheet</span>
                    </button>
                    <span className="rounded-full border border-sky-200 bg-sky-50 px-[10px] py-[5px] text-[11px] font-extrabold text-sky-800">
                      {pdfReviewBatch.status}
                    </span>
                  </div>
                </div>
                {!stockTracked ? (
                  <div className="mt-2 rounded-[10px] border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] font-bold leading-4 text-blue-900">
                    Catalog Only: stock columns are not applied. Imported products remain uncounted until inventory is enabled and an opening count is completed.
                  </div>
                ) : null}
                <div className="relative mt-[10px]">
                  <GoogleIcon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-[#6B7280]" />
                  <input
                    value={reviewSearch}
                    onChange={(event) => setReviewSearch(event.target.value)}
                    placeholder="Search extracted rows..."
                    className="h-11 w-full rounded-[12px] border border-[#CFCFD3] bg-white pl-10 pr-3 text-[12px] font-semibold text-[#000000] outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/15"
                  />
                </div>
                <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <ProjectSelect
                    aria-label="Filter import rows by status"
                    value={reviewStatusFilter}
                    onChange={(event) => setReviewStatusFilter(event.target.value as any)}
                    className="h-11 rounded-[12px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#11120d] outline-none"
                  >
                    <option value="ALL">All rows</option>
                    <option value="READY">Ready</option>
                    <option value="ISSUES">Needs attention</option>
                    <option value="DUPLICATE">Duplicates</option>
                    <option value="IGNORED">Ignored</option>
                  </ProjectSelect>
                  <button
                    type="button"
                    onClick={() => toggleVisibleReviewSelection(!allVisibleSelected)}
                    disabled={filteredReviewRows.length === 0}
                    className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-[12px] border px-3 text-[11px] font-extrabold disabled:pointer-events-none disabled:opacity-45", allVisibleSelected ? "border-[#179B4D] bg-[#EAF8EF] text-[#11763A]" : "border-[#CFCFD3] bg-white text-[#11120d]")}
                  >
                    <GoogleIcon name={allVisibleSelected ? "deselect" : "select_all"} className="text-[18px]" />
                    {allVisibleSelected ? "Clear visible" : "Select visible"}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => { setReviewPanelTab("bulk"); setMobileReviewView("editor"); }}
                  disabled={selectedReviewRows.length === 0}
                  className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-3 text-[12px] font-extrabold text-white disabled:pointer-events-none disabled:opacity-45"
                >
                  <GoogleIcon name="tune" className="text-[18px]" />Bulk edit {selectedReviewRows.length} selected
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-white">
                {filteredReviewRows.map((row) => {
                  const active = activeReviewRow?.rowId === row.rowId;
                  const imported = row.status === "IMPORTED";
                  return (
                    <React.Fragment key={row.rowId}>
                      <div className={cn("border-b border-[#E5E7EB] px-3 py-3 xl:hidden", active ? "bg-[#EEF4FF] shadow-[inset_3px_0_0_#11120d]" : "bg-white", row.ignored && "bg-[#F8FAFC]")}>
                        <button type="button" onClick={() => { setActiveReviewRowId(row.rowId); setReviewPanelTab("row"); setMobileReviewView("editor"); }} className={cn("w-full min-w-0 text-left", row.ignored && "opacity-60")}>
                          <div className="flex items-center gap-2"><span className="text-[10px] font-extrabold text-[#6B7280]">Row {row.rowNumber}</span><span className={cn("rounded-full px-2 py-0.5 text-[9px] font-extrabold", imported ? "bg-emerald-50 text-emerald-700" : row.ignored ? "bg-slate-200 text-slate-700" : dirtyReviewRowIds.has(row.rowId) ? "bg-amber-50 text-amber-800" : verifiedReviewRowIds.has(row.rowId) ? "bg-emerald-50 text-emerald-700" : row.status === "DUPLICATE" ? "bg-amber-50 text-amber-700" : row.error ? "bg-rose-50 text-rose-700" : "bg-sky-50 text-sky-700")}>{row.ignored ? "Ignored" : dirtyReviewRowIds.has(row.rowId) ? "Unsaved" : verifiedReviewRowIds.has(row.rowId) ? "Saved" : row.status}</span></div>
                          <div className="mt-1 line-clamp-2 text-[13px] font-extrabold leading-[18px] text-[#11120d]">{row.name || row.rawText || "No text captured"}</div>
                          <div className={cn("mt-1 truncate text-[10px] font-semibold", row.error ? "text-rose-700" : "text-[#4B5563]")}>{row.error || `Purchase cost ${row.ratePerPiece === null ? "not entered" : `रु. ${formatQty(row.ratePerPiece)}`}${stockTracked ? ` · Stock ${formatQty(row.stock)}` : ""}`}</div>
                        </button>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button type="button" disabled={imported || row.ignored || row.comparisonStatus === "MATCHED_WITH_CHANGES" || row.comparisonStatus === "EXACT_DUPLICATE"} onClick={() => updateReviewRow(row.rowId, { selected: !row.selected, ignored: false, resolution: "CREATE_NEW" })} className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-[11px] border px-3 text-[11px] font-extrabold", row.selected ? "border-[#179B4D] bg-[#EAF8EF] text-[#11763A]" : "border-[#CFCFD3] bg-white text-[#11120d]", (imported || row.ignored || row.comparisonStatus === "MATCHED_WITH_CHANGES" || row.comparisonStatus === "EXACT_DUPLICATE") && "pointer-events-none opacity-45")}><GoogleIcon name={row.selected ? "check_box" : "check_box_outline_blank"} className="text-[19px]" />{row.selected ? "Selected" : "Select row"}</button>
                          <button type="button" disabled={imported} onClick={() => updateReviewRow(row.rowId, row.ignored ? { ignored: false, selected: restoredDraftResolution(row) === "CREATE_NEW", resolution: restoredDraftResolution(row) } : { ignored: true, selected: false, resolution: "IGNORE" })} className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-[11px] border px-3 text-[11px] font-extrabold disabled:opacity-45", row.ignored ? "border-[#2563EB] bg-[#EEF4FF] text-[#1D4ED8]" : "border-[#CFCFD3] bg-white text-[#8A2C2C]")}><GoogleIcon name={row.ignored ? "undo" : "block"} className="text-[18px]" />{row.ignored ? "Restore row" : "Ignore row"}</button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveReviewRowId(row.rowId);
                          setReviewPanelTab("row");
                        }}
                        className={cn(
                          "hidden min-h-[42px] w-full grid-cols-[26px_72px_minmax(0,1fr)_64px] items-center gap-[8px] border-b border-[#E5E7EB] px-[10px] py-[7px] text-left transition last:border-b-0 xl:grid",
                          active
                            ? "bg-[#EEF4FF] shadow-[inset_3px_0_0_#11120d]"
                            : "bg-white hover:bg-[#ECEFF3]",
                          row.ignored ? "opacity-60" : "",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={row.selected}
                          disabled={imported || row.ignored || row.comparisonStatus === "MATCHED_WITH_CHANGES" || row.comparisonStatus === "EXACT_DUPLICATE"}
                          onChange={(event) => {
                            event.stopPropagation();
                            updateReviewRow(row.rowId, {
                              selected: event.target.checked,
                              ignored: event.target.checked ? false : row.ignored,
                              resolution: "CREATE_NEW",
                            });
                          }}
                          onClick={(event) => event.stopPropagation()}
                        />
                        <div className="space-y-[3px]">
                          <div className="text-[10px] font-extrabold text-[#8C8889]">
                            Row {row.rowNumber}
                          </div>
                          <span
                            className={cn(
                              "inline-flex rounded-full px-[7px] py-[2px] text-[9px] font-extrabold",
                              imported
                                ? "bg-emerald-50 text-emerald-700"
                                : row.ignored
                                  ? "bg-slate-100 text-slate-500"
                                  : row.status === "DUPLICATE"
                                    ? "bg-amber-50 text-amber-700"
                                    : row.error
                                      ? "bg-rose-50 text-rose-700"
                                      : "bg-sky-50 text-sky-700",
                            )}
                          >
                            {row.ignored ? "Ignored" : row.status}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="max-h-[34px] overflow-hidden break-words text-[12px] font-extrabold leading-[17px] text-[#000000]">
                            {row.rawText || "No text captured"}
                          </div>
                          {row.error ? (
                            <div className="mt-[2px] max-h-[28px] overflow-hidden break-words text-[10px] font-semibold leading-[14px] text-rose-700">
                              {row.error}
                            </div>
                          ) : (
                            <div className="truncate text-[10px] font-semibold text-[#8C8889]">
                              {row.ratePerPiece === null
                                ? "Purchase cost not entered"
                                : `NPR ${formatQty(row.ratePerPiece)}`}
                              {stockTracked ? ` | Stock ${formatQty(row.stock)}` : ""}
                            </div>
                          )}
                        </div>
                        <span
                          role="button"
                          tabIndex={-1}
                          onClick={(event) => {
                            event.stopPropagation();
                            updateReviewRow(row.rowId, row.ignored
                              ? { ignored: false, selected: restoredDraftResolution(row) === "CREATE_NEW", resolution: restoredDraftResolution(row) }
                              : { ignored: true, selected: false, resolution: "IGNORE" });
                          }}
                          className={cn(
                            "inline-flex h-[28px] items-center justify-center rounded-[9px] border border-[#CFCFD3] bg-white px-[8px] text-[11px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]",
                            imported && "pointer-events-none opacity-50",
                          )}
                        >
                          <GoogleIcon name={row.ignored ? "undo" : "block"} className="mr-1 text-[15px]" />
                          {row.ignored ? "Restore" : "Ignore"}
                        </span>
                      </button>
                    </React.Fragment>
                  );
                })}
                {filteredReviewRows.length === 0 ? (
                  <div className="px-[12px] py-[20px] text-[12px] font-semibold text-[#8C8889]">
                    No rows match the current search or status filter.
                  </div>
                ) : null}
              </div>
            </section>

            <section className={cn("min-h-0 overflow-y-auto bg-white px-3 py-3 xl:rounded-[16px] xl:border xl:border-[#CFCFD3] xl:p-[12px]", mobileReviewView === "editor" ? "block" : "hidden", "xl:block")}>
              {activeReviewRow ? (
                <div className="space-y-[12px]">
                  <div className="flex items-center justify-between gap-2 xl:hidden">
                    <button type="button" onClick={() => setMobileReviewView("list")} className="inline-flex min-h-11 items-center gap-2 rounded-[11px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#11120d]"><GoogleIcon name="arrow_back" className="text-[18px]" />Rows</button>
                    <div className="min-w-0 text-center text-[11px] font-bold text-[#4B5563]">
                      {reviewPanelTab === "bulk"
                        ? `${selectedReviewRows.length} selected`
                        : `Row ${activeReviewRow.rowNumber} of ${pdfReviewRows.length}`}
                    </div>
                    {reviewPanelTab === "row" ? (
                      <div className="flex gap-1"><button type="button" onClick={() => moveActiveReviewRow(-1)} className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white" aria-label="Previous import row"><GoogleIcon name="chevron_left" /></button><button type="button" onClick={() => moveActiveReviewRow(1)} className="inline-flex h-11 w-11 items-center justify-center rounded-[11px] border border-[#CFCFD3] bg-white" aria-label="Next import row"><GoogleIcon name="chevron_right" /></button></div>
                    ) : (
                      <GoogleIcon name="tune" className="text-[22px] text-[#565449]" />
                    )}
                  </div>

                  <div className="flex items-start justify-between gap-3 rounded-[14px] bg-[#F8FAFC] px-3 py-3">
                    <div>
                      <div className="text-[13px] font-extrabold text-[#11120d]">
                        {reviewPanelTab === "bulk" ? "Bulk changes" : `Review row ${activeReviewRow.rowNumber}`}
                      </div>
                      <div className="mt-1 text-[11px] font-semibold leading-4 text-[#6B7280]">
                        {reviewPanelTab === "bulk"
                          ? `Only filled settings will be applied to ${selectedReviewRows.length} selected draft rows.`
                          : activeReviewRowDirty
                            ? "Unsaved changes — save this row before importing."
                            : verifiedReviewRowIds.has(activeReviewRow.rowId)
                              ? "Saved to the import review."
                              : "Check the extracted values before importing."}
                      </div>
                    </div>
                    {reviewPanelTab === "bulk" ? (
                      <button type="button" onClick={() => setReviewPanelTab("row")} className="hidden shrink-0 rounded-[10px] border border-[#CFCFD3] bg-white px-3 py-2 text-[11px] font-extrabold text-[#11120d] xl:inline-flex">Review row</button>
                    ) : (
                      <span className={cn("shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold", activeReviewRowDirty ? "bg-amber-100 text-amber-800" : verifiedReviewRowIds.has(activeReviewRow.rowId) ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700")}>{activeReviewRowDirty ? "Unsaved" : verifiedReviewRowIds.has(activeReviewRow.rowId) ? "Saved" : "Review"}</span>
                    )}
                  </div>

                  {reviewPanelTab === "bulk" ? (
                    <div className="space-y-[12px]">
                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Classification
                        </div>
                        <div className="grid grid-cols-1 gap-[10px] lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                          <Field label="Brand">
                            <CreatableCombobox
                              value={bulkBrand}
                              onChange={setBulkBrand}
                              options={reviewBrandOptions}
                              placeholder="Search or type brand"
                              ariaLabel="Brand to apply to selected import rows"
                              selectOnFocus
                              createHelpText="New value — applied only when you choose Apply to draft."
                            />
                          </Field>
                          <Field label="Category">
                            <CreatableCombobox
                              value={bulkCategory}
                              onChange={setBulkCategory}
                              options={reviewCategoryOptions}
                              placeholder="Search or type category"
                              ariaLabel="Category to apply to selected import rows"
                              selectOnFocus
                              createHelpText="New value — applied only when you choose Apply to draft."
                            />
                          </Field>
                          <Field label="Supplier / Source">
                            <CreatableCombobox
                              value={bulkSupplier}
                              onChange={setBulkSupplier}
                              options={reviewSupplierOptions}
                              placeholder="Search or type supplier"
                              ariaLabel="Supplier or source to apply to selected import rows"
                              selectOnFocus
                              createHelpText="New value — applied only when you choose Apply to draft."
                            />
                          </Field>
                          <Button
                            size="sm"
                            onClick={applyBulkClassificationToSelectedRows}
                            disabled={selectedReviewRows.length === 0}
                          >
                            Apply to draft
                          </Button>
                        </div>
                      </div>

                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Pricing
                        </div>
                        <div className="grid grid-cols-1 gap-[8px] lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                          <Field label="Wholesale margin / थोक मार्जिन %">
                            <input
                              type="number"
                              value={bulkWholesaleMargin}
                              onChange={(event) =>
                                setBulkWholesaleMargin(
                                  Number(event.target.value) || 0,
                                )
                              }
                              className={compactInputClass}
                            />
                          </Field>
                          <Field label="Retail margin / खुद्रा मार्जिन %">
                            <input
                              type="number"
                              value={bulkRetailMargin}
                              onChange={(event) =>
                                setBulkRetailMargin(
                                  Number(event.target.value) || 0,
                                )
                              }
                              className={compactInputClass}
                            />
                          </Field>
                          <Button
                            size="sm"
                            onClick={applyBulkPricingToSelectedRows}
                            disabled={selectedReviewRows.length === 0}
                          >
                            Apply margins to draft
                          </Button>
                        </div>
                      </div>

                      {stockTracked ? <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Stock
                        </div>
                        <div className="grid grid-cols-1 gap-[8px] lg:grid-cols-[1fr_auto] lg:items-end">
                          <Field label="Opening stock">
                            <input
                              type="number"
                              min={0}
                              value={bulkStock}
                              onChange={(event) =>
                                setBulkStock(Number(event.target.value) || 0)
                              }
                              className={compactInputClass}
                            />
                          </Field>
                          <Button
                            size="sm"
                            onClick={applyBulkStockToSelectedRows}
                            disabled={selectedReviewRows.length === 0}
                          >
                            Apply stock to draft
                          </Button>
                        </div>
                      </div> : null}

                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Rules
                        </div>
                        <div className="grid grid-cols-1 gap-[8px] lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                          <Field label="Package unit">
                            <Select
                              value={bulkPackageUnit}
                              onChange={setBulkPackageUnit}
                              options={[
                                { value: "PIECE", label: "Piece" },
                                { value: "DOZEN", label: "Dozen" },
                                { value: "KG", label: "KG" },
                                { value: "BUNDLE", label: "Bundle" },
                                { value: "BOX", label: "Box" },
                              ]}
                            />
                          </Field>
                          <Field label="Sale unit">
                            <Select
                              value={bulkSaleUnit}
                              onChange={setBulkSaleUnit}
                              options={[
                                { value: "PIECE", label: "Piece" },
                                { value: "KG", label: "KG" },
                                { value: "GRAM", label: "Gram" },
                                { value: "METER", label: "Meter" },
                              ]}
                            />
                          </Field>
                          <Field label="Qty Wholesale Pricing">
                            <Select
                              value={bulkWholesaleEligible}
                              onChange={(value) =>
                                setBulkWholesaleEligible(
                                  value as "keep" | "on" | "off",
                                )
                              }
                              options={[
                                { value: "keep", label: "Keep current" },
                                { value: "on", label: "On" },
                                { value: "off", label: "Off" },
                              ]}
                            />
                          </Field>
                          <Button
                            size="sm"
                            onClick={applyBulkRulesToSelectedRows}
                            disabled={selectedReviewRows.length === 0}
                          >
                            Apply rules to draft
                          </Button>
                        </div>
                      </div>
                      <div className="sticky bottom-0 rounded-[14px] border border-[#D9DCE1] bg-white p-3 shadow-[0_-8px_20px_rgba(17,18,13,0.08)]">
                        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-bold">
                          <span className="text-[#4B5563]">Review changes before import</span>
                          <span className={unconfirmedSelectedReviewRows.length > 0 ? "text-amber-700" : "text-emerald-700"}>
                            {unconfirmedSelectedReviewRows.length > 0 ? `${unconfirmedSelectedReviewRows.length} need confirmation` : "All selected rows confirmed"}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => saveReviewDraftRows(unconfirmedSelectedReviewRows)}
                          disabled={unconfirmedSelectedReviewRows.length === 0 || reviewSaveBusy}
                          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-4 text-[12px] font-extrabold text-white disabled:pointer-events-none disabled:opacity-45"
                        >
                          <GoogleIcon name="fact_check" className="text-[18px]" />
                          {reviewSaveBusy ? "Saving review..." : `Confirm ${unconfirmedSelectedReviewRows.length} checked ${unconfirmedSelectedReviewRows.length === 1 ? "row" : "rows"}`}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {localImportPreviewUrl ? (
                        <div className="overflow-hidden rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6]">
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#CFCFD3] bg-white px-3 py-2">
                            <span className="text-[11px] font-extrabold text-[#11120d]">
                              Original source
                            </span>
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="max-w-[min(52vw,280px)] truncate text-[10px] font-bold text-[#6B7280]">
                                {activeReviewRow.sourceCitation || importFile?.name}
                              </span>
                              <a
                                href={`${localImportPreviewUrl}#page=${activeReviewRow.sourceCitation?.match(/p\.(\d+)/i)?.[1] || 1}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-[9px] border border-[#CFCFD3] bg-white px-2.5 text-[10px] font-extrabold text-[#11120d] hover:bg-[#F3F4F6]"
                              >
                                <GoogleIcon name="open_in_new" className="text-[15px]" />
                                Open source
                              </a>
                            </div>
                          </div>
                          {importFile?.type.startsWith("image/") ? (
                            <img
                              src={localImportPreviewUrl}
                              alt="Uploaded supplier catalog"
                              className="max-h-[min(52vh,560px)] min-h-[240px] w-full object-contain sm:min-h-[300px]"
                            />
                          ) : (
                            <iframe
                              key={`${activeReviewRow.rowId}-${activeReviewRow.sourceCitation || "source"}`}
                              title="Original supplier PDF"
                              src={`${localImportPreviewUrl}#page=${activeReviewRow.sourceCitation?.match(/p\.(\d+)/i)?.[1] || 1}&zoom=page-width`}
                              className="h-[min(48vh,520px)] min-h-[300px] w-full bg-white sm:min-h-[360px]"
                            />
                          )}
                        </div>
                      ) : null}
                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] py-[10px]">
                        <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                          Extracted line
                        </div>
                        <div className="mt-[4px] text-[12px] font-semibold leading-5 text-[#000000]">
                          {activeReviewRow.rawText}
                        </div>
                      </div>

                      {activeReviewRow.comparisonStatus ? (
                        <div className={cn(
                          "rounded-[14px] border px-3 py-2.5",
                          activeReviewRow.comparisonStatus === "READY_NEW"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : activeReviewRow.comparisonStatus === "MATCHED_WITH_CHANGES"
                              ? "border-amber-200 bg-amber-50 text-amber-900"
                              : "border-slate-300 bg-slate-50 text-slate-700",
                        )}>
                          <div className="text-[11px] font-extrabold uppercase tracking-wide">
                            {activeReviewRow.comparisonStatus === "READY_NEW"
                              ? "New catalog product"
                              : activeReviewRow.comparisonStatus === "MATCHED_WITH_CHANGES"
                                ? "Existing product has changes"
                                : activeReviewRow.comparisonStatus.replaceAll("_", " ")}
                          </div>
                          {activeReviewRow.changeSet && activeReviewRow.changeSet.length > 0 ? (
                            <div className="mt-2 grid gap-1.5 text-[11px] font-semibold">
                              {activeReviewRow.changeSet.map((change) => (
                                <div key={change.field} className="grid grid-cols-[minmax(90px,0.7fr)_1fr_auto_1fr] items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5">
                                  <span className="font-extrabold">{change.field.replaceAll(/([A-Z])/g, " $1")}</span>
                                  <span className="truncate text-slate-600">{change.currentValue ?? "Not entered"}</span>
                                  <GoogleIcon name="arrow_forward" className="text-[14px]" />
                                  <span className="truncate font-extrabold">{change.incomingValue ?? "Not entered"}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          {activeReviewRow.comparisonStatus === "MATCHED_WITH_CHANGES" ? (
                            <div className="mt-3">
                              <div className="mb-2 text-[11px] font-bold leading-4">
                                Choose what this catalog row should do. Nothing is updated until you save the decision and confirm the import.
                              </div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <button
                                  type="button"
                                  onClick={() => updateReviewRow(activeReviewRow.rowId, { resolution: "KEEP_EXISTING", selected: false, ignored: false })}
                                  className={cn("min-h-11 rounded-[11px] border px-3 text-[11px] font-extrabold", activeReviewRow.resolution === "KEEP_EXISTING" ? "border-slate-700 bg-slate-800 text-white" : "border-slate-300 bg-white text-slate-800")}
                                >
                                  Keep existing
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateReviewRow(activeReviewRow.rowId, { resolution: "UPDATE_MATCHED", selected: true, ignored: false })}
                                  className={cn("min-h-11 rounded-[11px] border px-3 text-[11px] font-extrabold", activeReviewRow.resolution === "UPDATE_MATCHED" ? "border-blue-700 bg-blue-700 text-white" : "border-blue-300 bg-white text-blue-800")}
                                >
                                  Apply displayed changes
                                </button>
                              </div>
                            </div>
                          ) : activeReviewRow.comparisonStatus === "EXACT_DUPLICATE" ? (
                            <div className="mt-2 rounded-[10px] border border-slate-200 bg-white/80 px-3 py-2 text-[11px] font-bold leading-4">
                              No supplier fields changed. Decision: keep the existing product unchanged.
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {activeReviewRow.ratePerPiece === null ? (
                        <div className="rounded-[12px] border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] font-bold leading-4 text-sky-900">
                          Price coming soon. This product can be kept in catalog and search with zero stock, but it cannot be billed until purchase and selling prices are entered and approved.
                        </div>
                      ) : null}

                      <div className="grid grid-cols-1 gap-[10px] lg:grid-cols-2">
                        <Field label="Product Name">
                          <input
                            value={activeReviewRow.name}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                name: event.target.value,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="SKU">
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-[8px]">
                            <input
                              value={activeReviewRow.sku}
                              onChange={(event) =>
                                updateReviewRow(activeReviewRow.rowId, {
                                  sku: event.target.value,
                                  status:
                                    activeReviewRow.status === "DUPLICATE"
                                      ? "READY"
                                      : activeReviewRow.status,
                                  error:
                                    activeReviewRow.status === "DUPLICATE"
                                      ? null
                                      : activeReviewRow.error,
                                })
                              }
                              className={compactInputClass}
                            />
                            <Button
                              size="sm"
                              onClick={() =>
                                regenerateReviewSku(activeReviewRow)
                              }
                              disabled={activeReviewRow.status === "IMPORTED"}
                            >
                              Regenerate
                            </Button>
                          </div>
                        </Field>
                        <Field label="Brand">
                          <CreatableCombobox
                            value={activeReviewRow.brand}
                            onChange={(value) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                brand: value,
                              })
                            }
                            options={reviewBrandOptions}
                            placeholder="Search or type brand"
                            ariaLabel={`Brand for import row ${activeReviewRow.rowNumber}`}
                            selectOnFocus
                            createHelpText="New value — stored when this review row is saved."
                          />
                        </Field>
                        <Field label="Category">
                          <CreatableCombobox
                            value={activeReviewRow.category}
                            onChange={(value) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                category: value,
                                categoryGroup: value,
                              })
                            }
                            options={reviewCategoryOptions}
                            placeholder="Search or type category"
                            ariaLabel={`Category for import row ${activeReviewRow.rowNumber}`}
                            selectOnFocus
                            createHelpText="New value — stored when this review row is saved."
                          />
                        </Field>
                        <Field label="Supplier / Source">
                          <CreatableCombobox
                            value={activeReviewRow.vendorSource || ""}
                            onChange={(value) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                vendorSource: value,
                              })
                            }
                            options={reviewSupplierOptions}
                            placeholder="Search or type supplier"
                            ariaLabel={`Supplier or source for import row ${activeReviewRow.rowNumber}`}
                            selectOnFocus
                            createHelpText="New value — stored when this review row is saved."
                          />
                        </Field>
                        <Field label="Variant / Code">
                          <input
                            value={activeReviewRow.productCodeVariant || ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                productCodeVariant: event.target.value,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        {isAdmin ? (
                          <Field label="Product search terms (optional)">
                            <input
                              value={(activeReviewRow.searchAliases || []).join(", ")}
                              maxLength={1200}
                              onChange={(event) =>
                                updateReviewRow(activeReviewRow.rowId, {
                                  searchAliases: event.target.value
                                    .split(/[,;\n]/g)
                                    .map((term) => term.trim())
                                    .filter(Boolean),
                                })
                              }
                              className={compactInputClass}
                              placeholder="balti, local nickname, Nepali term"
                            />
                            <div className="mt-1 text-[10px] font-semibold leading-4 text-[#6B7280]">
                              Separate terms with commas. Use only real names for this exact product; ordinary typos are handled automatically.
                            </div>
                          </Field>
                        ) : null}
                      </div>

                      <div className="grid grid-cols-2 gap-[10px] lg:grid-cols-4">
                        <Field label="Size Value">
                          <input
                            type="number"
                            value={activeReviewRow.sizeValue ?? ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                sizeValue:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Size Unit">
                          <Select
                            value={activeReviewRow.sizeUnit || "STANDARD"}
                            onChange={(value) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                sizeUnit: value,
                              })
                            }
                            options={[
                              { value: "STANDARD", label: "Standard" },
                              { value: "ML", label: "ML" },
                              { value: "LTR", label: "Ltr" },
                              { value: "KG", label: "KG" },
                              { value: "GRAM", label: "Gram" },
                              { value: "INCH", label: "Inch" },
                              { value: "METER", label: "Meter" },
                            ]}
                          />
                        </Field>
                        <Field label="Package Qty">
                          <input
                            type="number"
                            value={activeReviewRow.packageQuantity ?? ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                packageQuantity:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                              })
                            }
                            placeholder="Unknown"
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Package Unit">
                          <Select
                            value={activeReviewRow.packageUnit || "PIECE"}
                            onChange={(value) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                packageUnit: value,
                              })
                            }
                            options={[
                              { value: "PIECE", label: "Piece" },
                              { value: "DOZEN", label: "Dozen" },
                              { value: "KG", label: "KG" },
                              { value: "BUNDLE", label: "Bundle" },
                              { value: "BOX", label: "Box" },
                            ]}
                          />
                        </Field>
                      </div>

                      <div className="grid grid-cols-2 gap-[10px] lg:grid-cols-4">
                        <Field label="Purchase cost (optional)">
                          <input
                            type="number"
                            value={activeReviewRow.ratePerPiece ?? ""}
                            onChange={(event) => {
                              const next = event.target.value
                                ? Number(event.target.value)
                                : null;
                              updateReviewRow(activeReviewRow.rowId, {
                                ratePerPiece: next,
                              });
                            }}
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Retail Price (optional)">
                          <input
                            type="number"
                            value={activeReviewRow.retailPrice ?? ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                retailPrice: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Store Wholesale (optional)">
                          <input
                            type="number"
                            value={activeReviewRow.wholesalePrice ?? ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                wholesalePrice: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        {stockTracked ? <Field label="Stock">
                          <input
                            type="number"
                            value={activeReviewRow.stock}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                stock: Number(event.target.value),
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field> : null}
                      </div>

                      {activeReviewRow.retailPrice === null ||
                        activeReviewRow.wholesalePrice === null ? (
                        <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-4 text-amber-800">
                          Selling prices needed before billing. This product will remain visible in the catalog, but billing is blocked until both retail and store-wholesale prices are entered.
                        </div>
                      ) : null}

                      <div className="grid grid-cols-1 gap-[10px]">
                        <label className="flex h-[40px] items-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] px-[10px] text-[12px] font-extrabold text-[#565449]">
                          <input
                            type="checkbox"
                            checked={activeReviewRow.wholesaleEligible}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                wholesaleEligible: event.target.checked,
                              })
                            }
                          />
                          Qty Wholesale Pricing
                        </label>
                      </div>
                    </>
                  )}

                  {reviewSaveError ? (
                    <div role="alert" className="rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-bold leading-4 text-rose-700">
                      {reviewSaveError}
                    </div>
                  ) : null}

                  {reviewPanelTab === "row" ? (
                    <div className="sticky bottom-0 rounded-[14px] border border-[#D9DCE1] bg-white p-3 shadow-[0_-8px_20px_rgba(17,18,13,0.08)]">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="text-[11px] font-bold text-[#4B5563]">
                          {activeReviewRowDirty
                            ? "Changes have not been saved yet."
                            : verifiedReviewRowIds.has(activeReviewRow.rowId)
                              ? "Changes saved to this review."
                              : "No changes to save."}
                        </div>
                        <span className={cn("shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold", activeReviewRowDirty ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700")}>
                          {activeReviewRowDirty ? "Unsaved" : "Saved"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => saveReviewDraftRows([activeReviewRow])}
                        disabled={!activeReviewRowNeedsConfirmation || reviewSaveBusy || activeReviewRow.status === "IMPORTED"}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[11px] bg-[#11120d] px-4 text-[12px] font-extrabold text-white disabled:pointer-events-none disabled:opacity-45"
                      >
                        <GoogleIcon name="save" className="text-[18px]" />
                        {reviewSaveBusy ? "Saving row..." : activeReviewRowDirty ? "Save row changes" : activeReviewRowNeedsConfirmation ? "Confirm checked row" : "Row confirmed"}
                      </button>
                    </div>
                  ) : null}

                  {importError ? (
                    <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-[12px] py-[10px] text-[12px] font-semibold text-rose-700">
                      {importError}
                    </div>
                  ) : null}

                  {importResult?.message ? (
                    <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] py-[10px] text-[12px] font-semibold text-[#565449]">
                      {importResult.message}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full min-h-[260px] items-center justify-center text-center">
                  <div>
                    <GoogleIcon
                      name="rule"
                      className="text-[40px] text-[#CFCFD3]"
                    />
                    <div className="mt-[8px] text-[14px] font-extrabold text-[#565449]">
                      Select an import row
                    </div>
                    <div className="mt-[4px] text-[12px] font-semibold text-[#8C8889]">
                      Choose an extracted line to map it into a product.
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>) : (
          <div className="flex flex-col h-full bg-[#F8FAFC]">
            {/* Tabs */}
            <div className="flex border-b border-[#E5E7EB] bg-white px-[24px]">
              <button
                type="button"
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "csv" ? "border-[#11120d] text-[#11120d]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
                onClick={() => setImportTab("csv")}
              >
                <Icon name="table_chart" className="text-[18px]" />
                Spreadsheet
              </button>
              <button
                type="button"
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "pdf" ? "border-[#11120d] text-[#11120d]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
                onClick={() => setImportTab("pdf")}
              >
                <Icon name="picture_as_pdf" className="text-[18px]" />
                PDF Rate List
              </button>
              <button
                type="button"
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "image" ? "border-[#11120d] text-[#11120d]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
                onClick={() => setImportTab("image")}
              >
                <Icon name="image" className="text-[18px]" />
                Image Rate List
              </button>
            </div>

            {importError && (
              <div className="mx-[24px] mt-[18px] flex items-start justify-between gap-[12px] rounded-[14px] border border-[#FCA5A5] bg-[#FEF2F2] px-[14px] py-[12px] text-[12px] font-bold leading-5 text-[#DC2626]">
                <div className="flex items-start gap-[8px]">
                  <Icon name="error" className="mt-[1px] text-[17px]" />
                  <span>{importError}</span>
                </div>
              </div>
            )}

            {/* Tab Content */}
            <div className="space-y-[20px] p-[20px] sm:p-[24px]">
              {importTab === "csv" && (
                <div className="space-y-[20px]">
                  {/* Spreadsheet Upload */}
                  <div className="group relative rounded-[16px] border-2 border-dashed border-[#CFCFD3] bg-white p-[28px] text-center transition hover:border-[#11120d] hover:bg-[#F8F9FA] sm:p-[32px]">
                    <div className="mx-auto mb-[14px] flex h-[48px] w-[48px] items-center justify-center rounded-[12px] border border-[#E2E8F0] bg-[#F1F5F9] transition-transform group-hover:scale-110">
                      <Icon name="table_chart" className="text-[24px] text-[#64748B] group-hover:text-[#11120d]" />
                    </div>
                    <h4 className="mb-[4px] text-[14px] font-bold text-[#1E293B]">Upload spreadsheet rate list</h4>
                    <p className="mb-[14px] text-[12px] text-[#64748B]">Supports .csv and modern Excel .xlsx workbooks</p>
                    <label htmlFor="csv-upload" className="inline-flex cursor-pointer rounded-[8px] bg-[#11120d] px-[20px] py-[8px] text-[12px] font-bold text-white shadow-xs transition hover:bg-[#2a2c27]">
                      {importFile ? "Change spreadsheet" : "Choose spreadsheet"}
                    </label>
                    <input
                      type="file"
                      accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                      className="hidden"
                      id="csv-upload"
                    />
                    {importFile && (
                      <div className="mt-[12px] flex items-center justify-center gap-[6px] text-[12px] font-bold text-emerald-800">
                        <Icon name="check_circle" className="text-[14px]" /> {importFile.name}
                      </div>
                    )}
                  </div>

                  {/* Spreadsheet Field Mapping & Template Settings */}
                  <div className="rounded-[16px] border border-[#E5E7EB] bg-white p-[18px] shadow-xs sm:p-[20px]">
                    <div className="mb-[14px] flex flex-wrap items-center justify-between gap-[12px]">
                      <div>
                        <h4 className="text-[14px] font-bold text-[#11120d]">Spreadsheet Column Mapping</h4>
                        <p className="mt-[2px] text-[12px] text-[#8C8889]">Map supplier columns to KhataSathi fields</p>
                      </div>
                      <div className="flex gap-[8px]">
                        <button type="button" onClick={saveImportTemplateWithValidation} className="rounded-[8px] bg-[#F3F4F6] px-[12px] py-[6px] text-[12px] font-bold text-[#565449] transition hover:bg-[#E5E7EB]">Save Template</button>
                        {importTemplateId && (
                          <button onClick={() => onDeleteImportTemplate(importTemplateId)} className="rounded-[8px] bg-[#FEF2F2] px-[12px] py-[6px] text-[12px] font-bold text-[#DC2626] transition hover:bg-[#FEE2E2]">Delete</button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-[14px]">
                      <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2">
                        <ProjectSelect
                          value={importTemplateId}
                          onChange={(event) => setImportTemplateId(event.target.value)}
                          className="h-[40px] w-full rounded-[10px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[13px] font-bold outline-none focus:border-[#11120d]"
                        >
                          <option value="">No template</option>
                          {importTemplates.map((t) => <option key={t.id} value={t.id}>{t.supplier} - {t.name}</option>)}
                        </ProjectSelect>
                        <label className="block">
                          <input
                            ref={importSupplierRef}
                            value={importSupplier}
                            aria-invalid={Boolean(importSupplierError)}
                            aria-describedby={importSupplierError ? "import-supplier-error" : undefined}
                            onChange={(event) => {
                              setImportSupplier(event.target.value);
                              setImportSupplierError("");
                            }}
                            placeholder="Supplier / Brand Name"
                            className={cn("h-[40px] w-full rounded-[10px] bg-white px-[12px] text-[13px] font-semibold outline-none focus:ring-2", importSupplierError ? "border-2 border-[#DC2626] bg-[#FFF1F2] focus:ring-red-100" : "border border-[#CFCFD3] focus:border-[#11120d] focus:ring-slate-100")}
                          />
                          {importSupplierError ? <span id="import-supplier-error" role="alert" className="mt-1 block text-[11px] font-semibold text-[#BE123C]">{importSupplierError}</span> : null}
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-[10px] rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-[14px] sm:grid-cols-3 md:grid-cols-4">
                        {[
                          ["productName", "Name Col"], ["serial", "SKU/Serial"], ["variant", "Variant"],
                          ["packageQuantity", "Pack Qty"], ["retailPrice", "MRP Col"], ["wholesalePrice", "Rate Col"], ["stock", "Stock"]
                        ].filter(([key]) => stockTracked || key !== "stock").map(([key, label]) => (
                          <div key={key} className="space-y-[4px]">
                            <label className="text-[10px] font-extrabold uppercase tracking-wider text-[#8C8889]">{label}</label>
                            <input
                              value={importFieldMap[key] || ""}
                              onChange={(event) => setImportFieldMap((current) => ({ ...current, [key]: event.target.value }))}
                              className="h-[36px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-semibold outline-none transition focus:border-[#11120d] focus:ring-1 focus:ring-[#11120d]"
                              placeholder="Header name"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Import History */}
                  <div className="overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-white shadow-xs">
                    <div className="border-b border-[#E5E7EB] bg-[#F8FAFC] px-[20px] py-[14px]">
                      <h4 className="text-[14px] font-bold text-[#11120d]">Recent Import History</h4>
                    </div>
                    {importBatches.length > 0 ? (
                      <div className="divide-y divide-[#E5E7EB]">
                        {importBatches.map((batch) => (
                          <div key={batch.id} className="flex min-w-0 items-center justify-between gap-3 p-[14px] transition-colors hover:bg-[#ECEFF3] sm:p-[16px]">
                            <div className="flex min-w-0 flex-1 items-center gap-[12px] sm:gap-[16px]">
                              <div className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-[#F1F5F9]">
                                <Icon name={["CSV", "XLSX"].includes(String(batch.sourceType || "").toUpperCase()) ? "table_chart" : String(batch.sourceType || "").toUpperCase() === "PDF" ? "picture_as_pdf" : "image"} className="text-[20px] text-[#64748B]" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 break-all text-[13px] font-bold leading-5 text-[#1E293B] sm:truncate sm:break-normal">{batch.fileName || "Supplier import"}</div>
                                <div className="mt-[2px] text-[11px] font-medium text-[#64748B]">{batch.createdAt ? new Date(batch.createdAt).toLocaleDateString() : ""} • {displaySourceType(batch.sourceType)}</div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 sm:gap-[20px]">
                              <div className="hidden text-right sm:block">
                                <div className="text-[12px] font-bold text-[#334155]">{batch.totalRows} Rows</div>
                                <div className="mt-[2px] text-[11px] font-semibold text-[#64748B]">{batch.importedRows} Processed</div>
                              </div>
                              <div className="flex shrink-0 items-center gap-[8px]">
                                <button type="button" onClick={() => setDeleteImportBatchId(batch.id)} className="flex h-[32px] w-[32px] items-center justify-center rounded-[8px] text-[#64748B] transition hover:bg-[#FEE2E2] hover:text-[#EF4444]" title="Delete import review" aria-label={`Delete import ${batch.fileName || "file"}`}>
                                  <Icon name="delete" className="text-[18px]" />
                                </button>
                                <button type="button" onClick={() => onOpenImportBatch(batch.id)} className="flex h-[32px] items-center justify-center rounded-[8px] bg-[#11120d] px-[14px] text-[12px] font-bold text-white transition hover:bg-[#2a2c27]">
                                  Open
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-[36px] text-center">
                        <Icon name="history" className="mx-auto mb-[10px] text-[36px] text-[#CBD5E1]" />
                        <div className="text-[14px] font-bold text-[#475569]">No Recent Imports</div>
                        <div className="mt-[4px] text-[12px] text-[#64748B]">Your imported rate lists and history will appear here.</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {importTab === "pdf" && (
                <div className="group relative rounded-[16px] border-2 border-dashed border-[#CFCFD3] bg-white p-[40px] text-center transition hover:border-[#11120d] hover:bg-[#F8F9FA] sm:p-[48px]">
                  <div className="mx-auto mb-[18px] flex h-[60px] w-[60px] items-center justify-center rounded-[16px] border border-[#E2E8F0] bg-[#F1F5F9] shadow-xs transition-transform group-hover:scale-110">
                    <Icon name="picture_as_pdf" className="text-[30px] text-[#94A3B8] group-hover:text-[#11120d]" />
                  </div>
                  <h4 className="mb-[6px] text-[16px] font-bold text-[#1E293B]">Upload PDF supplier rate list</h4>
                  <p className="mb-[20px] text-[13px] text-[#64748B]">Text or scanned PDF files up to 50 MB. Extracted rows always open in review before import.</p>
                  <label htmlFor="pdf-upload" className="inline-flex cursor-pointer rounded-[10px] bg-[#11120d] px-[24px] py-[10px] text-[13px] font-bold text-white shadow-xs transition hover:bg-[#2a2c27]">
                    {importFile ? "Change PDF File" : "Choose PDF File"}
                  </label>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                    className="hidden"
                    id="pdf-upload"
                  />
                  {importFile && (
                    <div className="mt-[14px] flex items-center justify-center gap-[6px] text-[13px] font-bold text-emerald-800">
                      <Icon name="check_circle" className="text-[16px]" /> {importFile.name}
                    </div>
                  )}
                </div>
              )}

              {importTab === "image" && (
                <div className="group relative rounded-[16px] border-2 border-dashed border-[#CFCFD3] bg-white p-[40px] text-center transition hover:border-[#11120d] hover:bg-[#F8F9FA] sm:p-[48px]">
                  <div className="mx-auto mb-[18px] flex h-[60px] w-[60px] items-center justify-center rounded-[16px] border border-[#E2E8F0] bg-[#F1F5F9] shadow-xs transition-transform group-hover:scale-110">
                    <Icon name="image" className="text-[30px] text-[#94A3B8] group-hover:text-[#11120d]" />
                  </div>
                  <h4 className="mb-[6px] text-[16px] font-bold text-[#1E293B]">Upload image of printed rate list</h4>
                  <p className="mb-[20px] text-[13px] text-[#64748B]">PNG, JPG, WebP up to 10MB — AI will parse from image</p>
                  <label htmlFor="img-upload" className="inline-flex cursor-pointer rounded-[10px] bg-[#11120d] px-[24px] py-[10px] text-[13px] font-bold text-white shadow-xs transition hover:bg-[#2a2c27]">
                    {importFile ? "Change Image" : "Choose Image"}
                  </label>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                    className="hidden"
                    id="img-upload"
                  />
                  {importFile && (
                    <div className="mt-[14px] flex items-center justify-center gap-[6px] text-[13px] font-bold text-emerald-800">
                      <Icon name="check_circle" className="text-[16px]" /> {importFile.name}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}
      </ModalShell>

      <ModalFrame
        open={confirmImportSelected}
        title="Import reviewed products?"
        description="This is the final check before catalog creates, matched updates, and keep-existing decisions are applied."
        onClose={() => setConfirmImportSelected(false)}
        layer="critical"
        maxWidthClass="max-w-[540px]"
        mobileBottomSheet
        footer={(
          <div className="grid w-full grid-cols-2 gap-3">
            <DialogButton onClick={() => setConfirmImportSelected(false)} disabled={pdfReviewBusy}>Review again</DialogButton>
            <DialogButton variant="primary" icon="check_circle" onClick={confirmSelectedPdfRowsImport} disabled={pdfReviewBusy || commitReviewRows.length === 0 || selectedReviewIssueCount > 0}>{pdfReviewBusy ? "Applying..." : selectedReviewIssueCount > 0 ? "Resolve selected issues" : `Apply ${commitReviewRows.length}`}</DialogButton>
          </div>
        )}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-[12px] border border-emerald-200 bg-emerald-50 p-3 text-center"><div className="text-[20px] font-black text-emerald-800">{selectedReviewRows.filter((row) => row.resolution === "CREATE_NEW").length}</div><div className="text-[10px] font-extrabold uppercase text-emerald-700">Create</div></div>
            <div className="rounded-[12px] border border-blue-200 bg-blue-50 p-3 text-center"><div className="text-[20px] font-black text-blue-800">{selectedReviewRows.filter((row) => row.resolution === "UPDATE_MATCHED").length}</div><div className="text-[10px] font-extrabold uppercase text-blue-700">Update</div></div>
            <div className="rounded-[12px] border border-slate-200 bg-slate-50 p-3 text-center"><div className="text-[20px] font-black text-slate-800">{keptReviewRows.length}</div><div className="text-[10px] font-extrabold uppercase text-slate-600">Keep</div></div>
            <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-3 text-center"><div className="text-[20px] font-black text-amber-800">{selectedReviewIssueCount}</div><div className="text-[10px] font-extrabold uppercase text-amber-700">Issues</div></div>
          </div>
          <p className="rounded-[14px] border border-[#BFDBFE] bg-[#EFF6FF] p-4 text-[12px] font-semibold leading-5 text-[#1D4ED8]">Creates add catalog products. Updates apply only the displayed supplier-field differences to the matched product. Keep leaves the existing product unchanged. Ignored rows are recorded but not applied.</p>
        </div>
      </ModalFrame>

      <ModalFrame
        open={!!deleteImportBatchId}
        title="Delete Import Review"
        description="Products that were already imported from this review will not be removed from your catalog."
        onClose={() => setDeleteImportBatchId(null)}
        layer="critical"
        maxWidthClass="max-w-[460px]"
        footer={
          <div className="grid w-full grid-cols-2 gap-2.5">
            <DialogButton onClick={() => setDeleteImportBatchId(null)} disabled={importBusy}>
              Cancel
            </DialogButton>
            <DialogButton
              variant="danger"
              icon="delete"
              disabled={importBusy || !deleteImportBatchId}
              onClick={() => {
                if (!deleteImportBatchId) return;
                onDeleteImportBatch(deleteImportBatchId);
                setDeleteImportBatchId(null);
              }}
            >
              {importBusy ? "Deleting..." : "Delete Review"}
            </DialogButton>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="rounded-[12px] border border-rose-200 bg-rose-50 p-3 text-[12px] font-semibold leading-5 text-rose-800">
            Delete this import review history? Products that were already imported from this review will not be removed.
          </div>
          <div className="rounded-[12px] border border-[#D8DBE0] bg-[#F8FAFC] p-3.5">
            <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#7A7F89]">
              Review
            </div>
            <div className="mt-1 truncate text-[14px] font-extrabold text-[#11120d]">
              {deleteImportBatch?.fileName || "Supplier import"}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-bold">
              <span className="rounded-full border border-[#D8DBE0] bg-white px-2.5 py-0.5 text-[#4B5563]">
                {displaySourceType(deleteImportBatch?.sourceType)}
              </span>
              <span className="rounded-full border border-[#D8DBE0] bg-white px-2.5 py-0.5 text-[#4B5563]">
                {deleteImportBatch?.totalRows || 0} rows
              </span>
              <span className="rounded-full border border-[#D8DBE0] bg-white px-2.5 py-0.5 text-[#4B5563]">
                {deleteImportBatch?.status || "DRAFT"}
              </span>
            </div>
          </div>
        </div>
      </ModalFrame>

      <ModalShell
        open={openView}
        title="Product Details"
        onClose={() => setOpenView(false)}
        maxWidthClass="max-w-[700px]"
        contentClassName="bg-white p-5"
        footer={
          <>
            <div className="w-full md:hidden [&>button]:w-full">
              {activeProduct ? <Button variant="primary" icon="edit" onClick={onEditActiveProduct}>Edit Product</Button> : null}
            </div>
            <div className="hidden items-center justify-end gap-[10px] md:flex">
              <Button onClick={() => setOpenView(false)}>Close</Button>
              {activeProduct ? <Button variant="primary" icon="edit" onClick={onEditActiveProduct}>Edit Product</Button> : null}
            </div>
          </>
        }
      >
        {activeProduct ? (
          <>
            <div className="space-y-4 md:hidden">
              <PreviewableImage
                src={activeProduct.imageUrl}
                alt={activeProduct.name}
                title={activeProduct.name}
                subtitle={`SKU: ${activeProduct.sku || "NO-SKU"}`}
                enablePreview="desktop"
                imgClassName="h-full w-full object-contain p-3"
                className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-[16px] border border-[#E5E7EB] bg-[#F8FAFC]"
                fallback={<GoogleIcon name="inventory_2" sizePx={70} className="text-[#8C8889]" />}
              />
              <div>
                <h2 className="text-[25px] font-black leading-8 text-[#11120d]">{activeProduct.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-[8px] bg-[#F3F4F6] px-2.5 py-1.5 font-mono text-[12px] font-bold text-[#6B7280]">{activeProduct.sku || "NO-SKU"}</span>
                  <StatusPill status={activeProduct.status} />
                </div>
              </div>

              {([
                {
                  icon: "category",
                  title: "Classification",
                  rows: [
                    ["Brand", activeProduct.brand || "-"],
                    ["Category", activeProduct.category || "-"],
                    ["Variant", activeProduct.productCodeVariant || "-"],
                    ["Barcode", activeProduct.barcode || "-"],
                    ["Supplier", activeProduct.vendorSource || "-"],
                  ],
                },
                {
                  icon: "sell",
                  title: "Pricing",
                  rows: [
                    ...(purchaseCostVisible
                      ? [["Purchase cost", formatOptionalPurchaseCost(activeProduct.ratePerPiece)] as const]
                      : []),
                    ["Retail Price", formatOptionalSellingPrice(activeProduct.retailPrice)],
                    ["Wholesale Price", formatOptionalSellingPrice(activeProduct.wholesalePrice)],
                    ["Wholesale Threshold", `${formatQty(activeProduct.thresholdQty)} ${activeProduct.saleUnit || "PIECE"}${activeProduct.thresholdQtyMode === "default" ? " (Default)" : ""}`],
                  ],
                },
                {
                  icon: "deployed_code",
                  title: "Units & Packaging",
                  rows: [
                    ["Size", formatProductSize(activeProduct)],
                    ["Pack", formatPackage(activeProduct)],
                    ["Sale Unit", activeProduct.saleUnit || "-"],
                    ["Quantity Step", formatQty(activeProduct.quantityStep)],
                    ["Fractional quantities", activeProduct.allowFractionalQty ? "Allowed" : "Not allowed"],
                  ],
                },
                {
                  icon: "inventory_2",
                  title: "Stock",
                  rows: [
                    ["Current Stock", `${formatQty(activeProduct.stock)} ${activeProduct.saleUnit || "PIECE"}`],
                    ["Low-stock Threshold", `${formatQty(activeProduct.lowStockThreshold)}${activeProduct.lowStockThresholdMode === "default" ? " (Default)" : " (Custom)"}`],
                    ["Availability", getStockFlag(activeProduct)],
                  ],
                },
              ] as const)
                .filter((section) => stockTracked || section.title !== "Stock")
                .map((section) => (
                  <section key={section.title} className="rounded-[16px] border border-[#E5E7EB] bg-white p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[#F3F4F6] text-[#11120d]"><GoogleIcon name={section.icon} className="text-[22px]" /></span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] font-extrabold text-[#11120d]">{section.title}</h3>
                        <dl className="mt-2 space-y-2">
                          {section.rows.map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3 text-[13px]">
                              <dt className="font-semibold text-[#6B7280]">{label}</dt>
                              <dd className="break-words text-right font-bold text-[#11120d]">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                  </section>
                ))}
            </div>

            <div className="hidden bg-white md:block md:max-h-[85vh] md:overflow-y-auto">
              <div className="flex flex-col gap-4 md:flex-row">

                {/* Left - Image & Status */}
                <div className="flex w-full flex-shrink-0 flex-col items-center gap-2.5 md:w-[124px]">
                  <PreviewableImage
                    src={activeProduct.imageUrl}
                    alt={activeProduct.name}
                    title={activeProduct.name}
                    subtitle={`SKU: ${activeProduct.sku || "NO-SKU"}`}
                    enablePreview="desktop"
                    imgClassName="h-full w-full object-contain p-2"
                    className="flex aspect-square w-[124px] h-[124px] items-center justify-center overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] shadow-2xs"
                    fallback={
                      <GoogleIcon
                        name="inventory_2"
                        sizePx={54}
                        className="text-[#8C8889]"
                      />
                    }
                  />
                  <StatusPill status={activeProduct.status} />
                </div>

                {/* Right - Details */}
                <div className="flex-1 min-w-0 space-y-3.5">

                  {/* Header Info */}
                  <div>
                    <h3 className="text-[18px] font-black leading-snug text-[#0F172A]">{activeProduct.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="rounded-[6px] border border-[#E2E8F0] bg-[#F1F5F9] px-2 py-0.5 font-mono text-[11.5px] font-bold text-[#334155]">
                        {activeProduct.sku || "NO-SKU"}
                      </span>
                      {activeProduct.barcode ? (
                        <span className="text-[#64748B]">
                          Barcode: <span className="font-mono font-semibold text-[#334155]">{activeProduct.barcode}</span>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Details Grid */}
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-[12px] border border-[#F1F5F9] bg-[#F8FAFC]/80 p-3 text-[12.5px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Brand</span>
                      <span className="truncate font-bold text-[#0F172A]">
                        {activeProduct.brand || "—"}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Category</span>
                      <span className="truncate font-bold text-[#0F172A]">
                        {activeProduct.category || "—"}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Variant</span>
                      <span className="truncate font-bold text-[#0F172A]">{activeProduct.productCodeVariant || "—"}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Vendor</span>
                      <span className="truncate font-bold text-[#0F172A]">{activeProduct.vendorSource || "—"}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Size</span>
                      <span className="font-bold text-[#0F172A]">{formatProductSize(activeProduct)}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Package</span>
                      <span className="font-bold text-[#0F172A]">{formatPackage(activeProduct)}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Sale Unit</span>
                      <span className="font-bold text-[#0F172A]">{activeProduct.saleUnit || "PIECE"}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[#64748B]">Fractional Qty</span>
                      <span className="font-bold text-[#0F172A]">
                        {activeProduct.allowFractionalQty ? (
                          <span className="text-[#16A34A]">Yes (step {activeProduct.quantityStep})</span>
                        ) : "No"}
                      </span>
                    </div>
                  </div>

                  {/* Bottom Pricing & Stock Cards */}
                  <div className={cn("grid gap-3", stockTracked ? "grid-cols-2" : "grid-cols-1")}>
                    {/* Pricing Card */}
                    <div className="rounded-[14px] border border-[#E2E8F0] bg-white p-3 shadow-2xs">
                      <div className="flex items-center gap-1.5 border-b border-[#F1F5F9] pb-2 text-[11px] font-black uppercase tracking-wider text-[#475569]">
                        <GoogleIcon name="sell" className="text-[14px] text-[#64748B]" />
                        <span>Pricing</span>
                      </div>
                      <div className="mt-2.5 space-y-1.5 text-[12.5px]">
                        {purchaseCostVisible ? (
                          <div className="flex items-center justify-between">
                            <span className="text-[#64748B]">Purchase Cost</span>
                            <span className="font-bold text-[#0F172A]">{formatOptionalPurchaseCost(activeProduct.ratePerPiece)}</span>
                          </div>
                        ) : null}
                        <div className="flex items-center justify-between">
                          <span className="text-[#64748B]">Retail Price</span>
                          <span className="font-black text-[#16A34A] text-[14.5px]">{formatOptionalSellingPrice(activeProduct.retailPrice)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[#64748B]">Wholesale Price</span>
                          <span className="font-bold text-[#0F172A]">{formatOptionalSellingPrice(activeProduct.wholesalePrice)}</span>
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-[#F8FAFC] text-[11.5px] text-[#64748B]">
                          <span>Wholesale Threshold</span>
                          <span className="font-medium text-[#475569]">
                            {activeProduct.wholesaleEligible
                              ? `${formatQty(activeProduct.thresholdQty)} ${activeProduct.saleUnit || "PIECE"}`
                              : "Disabled"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Stock Card */}
                    {stockTracked ? (
                      <div className="flex flex-col justify-between rounded-[14px] border border-[#E2E8F0] bg-white p-3 shadow-2xs">
                        <div>
                          <div className="flex items-center gap-1.5 border-b border-[#F1F5F9] pb-2 text-[11px] font-black uppercase tracking-wider text-[#475569]">
                            <GoogleIcon name="inventory_2" className="text-[14px] text-[#64748B]" />
                            <span>Stock Inventory</span>
                          </div>
                          <div className="mt-2.5 flex items-center justify-between">
                            <div className="text-[24px] font-black leading-none text-[#0F172A]">
                              {formatQty(activeProduct.stock)}
                              <span className="ml-1 text-[12px] font-bold text-[#64748B]">
                                {activeProduct.saleUnit || "PIECE"}
                              </span>
                            </div>
                            <StockPill flag={getStockFlag(activeProduct)} />
                          </div>
                        </div>
                        <div className="mt-2.5 border-t border-[#F1F5F9] pt-2 text-[11.5px] text-[#64748B]">
                          Low Stock Alert: <span className="font-bold text-[#475569]">{formatQty(activeProduct.lowStockThreshold)} {activeProduct.saleUnit || "PIECE"}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[14px] font-semibold text-[#8C8889]">
            No product selected.
          </div>
        )}
      </ModalShell>

      {openConfirmDelete && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center p-0 sm:items-center sm:p-[16px]">
          <div className="absolute inset-0 bg-[#0F172A]/45 backdrop-blur-[2px]" onClick={() => setOpenConfirmDelete(false)} />
          <div role="dialog" aria-modal="true" aria-labelledby="single-product-delete-title" className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[26px] bg-white px-[20px] pb-[max(20px,env(safe-area-inset-bottom))] pt-[20px] text-center shadow-2xl sm:max-w-[560px] sm:rounded-[24px] sm:p-[32px]">
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-[#CFCFD3] sm:hidden" />
            <div className="w-[56px] h-[56px] rounded-full bg-red-50 flex items-center justify-center mx-auto mb-[20px]">
              <GoogleIcon name="warning" className="text-[28px] text-red-600" />
            </div>

            <h3 id="single-product-delete-title" className="text-[20px] font-extrabold text-slate-900 mb-[12px]">
              {isAdmin && deleteSafety?.canPermanentDelete
                ? "Permanently delete product?"
                : isAdmin && stockTracked && deleteSafety?.canDiscardStockAndDelete
                  ? "Remove this product?"
                  : "Set product inactive?"}
            </h3>

            <div className="text-[14px] text-slate-500 mb-[28px] leading-relaxed">
              <div className="mb-[16px] flex items-center gap-3 rounded-[14px] border border-[#E5E7EB] bg-white p-3 text-left">
                <PreviewableImage src={activeProduct?.thumbnailUrl || activeProduct?.imageUrl || ""} previewSrc={activeProduct?.imageUrl} alt={activeProduct?.name || "Selected product"} title={activeProduct?.name || "Selected product"} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[11px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
                <div className="min-w-0"><div className="truncate text-[15px] font-extrabold text-[#11120d]">{activeProduct?.name || "Selected product"}</div><div className="mt-1 truncate font-mono text-[11px] text-[#8C8889]">SKU: {activeProduct?.sku || "-"}</div></div>
              </div>

              {deleteSafetyLoading ? (
                <div className="rounded-[12px] border border-[#CFCFD3] bg-[#F8FAFC] px-[16px] py-[12px] text-[13px] font-semibold text-[#565449] mb-[16px] text-left">
                  Checking whether this product is safe to permanently delete...
                </div>
              ) : isAdmin && deleteSafety?.canPermanentDelete ? (
                <div className="rounded-[12px] border border-emerald-200 bg-emerald-50 px-[16px] py-[12px] text-[13px] font-semibold text-emerald-700 mb-[16px] text-left">
                  {deleteSafety.safeReason}
                </div>
              ) : isAdmin && stockTracked && deleteSafety?.canDiscardStockAndDelete ? (
                <div className="mb-[16px] rounded-[12px] border border-amber-200 bg-amber-50 px-[16px] py-[12px] text-left">
                  <div className="text-[13px] font-extrabold text-amber-900">Stock can be cleared as part of deletion</div>
                  <p className="mt-1 text-[13px] font-semibold leading-5 text-amber-900">This product has no reservations or business-history references. Its current stock can be set to zero and the product deleted in one audited action.</p>
                </div>
              ) : isAdmin && deleteSafety && !deleteSafety.canPermanentDelete ? (
                <div className="mb-[16px] space-y-[8px] rounded-[12px] border border-[#FCA5A5] bg-[#FEF2F2] px-[16px] py-[12px] text-left">
                  <div className="text-[13px] font-extrabold text-[#DC2626]">Permanent deletion blocked</div>
                  {deleteSafety.stockBlocker ? <div className="text-[13px] font-semibold text-[#565449]">
                    {stockTracked
                      ? deleteSafety.stockBlocker
                      : "Inventory or reservation data prevents permanent deletion. Inventory values remain hidden while Catalog Only is active."}
                  </div> : null}
                  {deleteSafety.references.length > 0 ? (
                    <ul className="space-y-[4px] text-[13px] font-semibold text-[#565449] ml-[16px] list-disc">
                      {deleteSafety.references.map((r) => <li key={r.label}>{r.count} {r.label}</li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <p>
                {isAdmin && deleteSafety?.canPermanentDelete
                  ? "This action cannot be undone. The product will be permanently removed from the catalog."
                  : isAdmin && stockTracked && deleteSafety?.canDiscardStockAndDelete
                    ? "Discarding stock and permanently deleting the product cannot be undone. Setting it inactive is the reversible option."
                    : "Setting the product inactive is reversible and preserves its history. Permanent deletion remains unavailable while the blockers above exist."}
              </p>
            </div>

            <div className={cn("grid grid-cols-1 gap-3", isAdmin && stockTracked && deleteSafety?.canDiscardStockAndDelete ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
              <button onClick={() => setOpenConfirmDelete(false)} disabled={deleteBusy} className="inline-flex min-h-11 w-full items-center justify-center rounded-[12px] border border-slate-300 bg-white px-4 text-[14px] font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50">
                Cancel
              </button>
              {isAdmin && deleteSafetyLoading ? (
                <button disabled className="inline-flex min-h-11 w-full items-center justify-center rounded-[12px] bg-[#D1D5DB] px-4 text-[14px] font-bold text-white">
                  Checking...
                </button>
              ) : isAdmin && deleteSafety?.canPermanentDelete ? (
                <button onClick={onConfirmPermanentDelete} disabled={deleteBusy} className="inline-flex min-h-11 w-full items-center justify-center rounded-[12px] bg-red-600 px-4 text-[14px] font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-50">
                  {deleteBusy ? "Deleting..." : "Delete Forever"}
                </button>
              ) : (
                <button onClick={onConfirmDelete} disabled={deleteBusy} className="inline-flex min-h-11 w-full items-center justify-center rounded-[12px] bg-[#11120d] px-4 text-[14px] font-bold text-white transition-colors hover:bg-[#2a2c27] disabled:opacity-50">
                  {deleteBusy ? "Updating..." : "Set inactive"}
                </button>
              )}
              {isAdmin && stockTracked && deleteSafety?.canDiscardStockAndDelete && !deleteSafetyLoading ? (
                <button type="button" onClick={onDiscardStockAndDelete} disabled={deleteBusy} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-red-600 px-3 text-[13px] font-bold text-white transition hover:bg-red-700 disabled:opacity-50"><GoogleIcon name="delete_forever" className="text-[19px]" />{deleteBusy ? "Deleting..." : "Zero stock & delete"}</button>
              ) : null}
            </div>
            {isAdmin && deleteSafety && !deleteSafety.canPermanentDelete && !deleteSafety.canDiscardStockAndDelete && !deleteSafetyLoading ? (
              <button type="button" disabled className="mt-3 inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-[12px] bg-[#F3F4F6] text-[13px] font-bold text-[#A3A3A3]"><GoogleIcon name="delete_forever" className="text-[19px]" />Delete Forever</button>
            ) : null}
          </div>
        </div>
      )}

      {!!bulkAction && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center p-0 sm:items-center sm:p-[20px]">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
            onClick={onCloseBulkAction}
          ></div>
          <div role="dialog" aria-modal="true" aria-labelledby="bulk-inactive-title" className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[26px] border border-slate-100 bg-white text-left shadow-2xl transition-all sm:max-w-[520px] sm:rounded-[24px]">
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-[#CFCFD3] sm:hidden" />
            <header className="flex items-start gap-3 border-b border-[#E5E7EB] px-5 pb-4 sm:px-6 sm:pt-6">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-[#FFF7E8] text-[#B7791F]"><Icon name="do_not_disturb_on" className="text-[23px]" /></span>
              <div className="min-w-0 flex-1"><h3 id="bulk-inactive-title" className="text-[20px] font-extrabold leading-tight text-[#11120d]">{bulkAction?.title || "Confirm action"}</h3><p className="mt-1.5 text-[13px] font-medium leading-5 text-[#565449]">{bulkAction?.message}</p></div>
              <button type="button" onClick={onCloseBulkAction} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] text-[#6B7280]" aria-label="Close selected products confirmation"><Icon name="close" /></button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
              <div className="mb-2 flex items-center justify-between gap-3"><h4 className="text-[12px] font-extrabold uppercase tracking-wide text-[#565449]">Review selected ({bulkProducts.length})</h4><span className="text-[11px] font-semibold text-[#8C8889]">Remove mistakes before confirming</span></div>
              {bulkProducts.length > 0 ? (
                <div className="max-h-[min(48dvh,360px)] divide-y divide-[#E5E7EB] overflow-y-auto overscroll-contain rounded-[14px] border border-[#E5E7EB] bg-white">
                  {bulkProducts.map((product) => (
                    <div key={product.id} className="flex min-h-[64px] items-center gap-3 px-3 py-2.5">
                      <PreviewableImage src={product.thumbnailUrl || product.imageUrl} fallbackSrc={product.thumbnailUrl ? product.imageUrl : undefined} previewSrc={product.imageUrl} alt={product.name} title={product.name} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
                      <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</div><div className="mt-0.5 truncate font-mono text-[10px] text-[#8C8889]">SKU: {product.sku || "-"}</div></div>
                      <button type="button" onClick={() => onRemoveBulkProduct(product.id)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-[#BE123C] transition hover:bg-[#FFF1F2]" aria-label={`Remove ${product.name} from selection`}><Icon name="close" className="text-[20px]" /></button>
                    </div>
                  ))}
                </div>
              ) : <div className="rounded-[14px] border-2 border-dashed border-[#E5E7EB] px-4 py-8 text-center text-[13px] font-semibold text-[#8C8889]">No products remain selected.</div>}
              <p className="mt-3 rounded-[12px] bg-[#F8FAFC] p-3 text-[12px] font-medium leading-5 text-[#6B7280]">Products become unavailable to selling flows, while invoice history and audit records remain intact.</p>
            </div>

            <footer className="grid shrink-0 grid-cols-2 gap-3 border-t border-[#E5E7EB] bg-white px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 sm:px-6">
              <button onClick={onCloseBulkAction} className="inline-flex min-h-11 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[14px] font-bold text-[#565449] transition hover:bg-[#F3F4F6]">
                Cancel
              </button>
              <button onClick={onConfirmBulkAction} disabled={bulkProducts.length === 0} className="inline-flex min-h-11 items-center justify-center rounded-[12px] bg-[#11120d] px-4 text-[14px] font-bold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-45">
                {bulkAction?.confirmLabel || "Confirm"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
