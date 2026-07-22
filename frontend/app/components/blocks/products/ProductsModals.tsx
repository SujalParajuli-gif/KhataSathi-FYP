import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import Icon from "~/components/ui/Icon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
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
    | "sku"
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
};

function formatQty(value: number) {
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
  return `${formatQty(product.packageQuantity || 1)} ${product.packageUnit || "PIECE"}`;
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
    const baseRate =
      readParsedNumber(parsed, ["ratePerPiece"], null) ??
      readParsedNumber(parsed, ["wholesalePrice"], null) ??
      readParsedNumber(parsed, ["retailPrice"], 0) ??
      0;
    const wholesalePrice =
      readParsedNumber(parsed, ["wholesalePrice"], null) ??
      readParsedNumber(parsed, ["ratePerPiece"], baseRate) ??
      baseRate;
    const retailPrice =
      readParsedNumber(parsed, ["retailPrice"], null) ??
      applyRetailMargin(Number(wholesalePrice || baseRate || 0), 18);
    const parsedName = cleanReviewProductName(
      readParsedString(parsed, ["name", "productName"], rawText),
      Number(baseRate || wholesalePrice || retailPrice || 0),
    );
    const sizeUnit = readParsedString(parsed, ["sizeUnit"], "STANDARD");
    const saleUnit = readParsedString(
      parsed,
      ["saleUnit"],
      sizeUnit === "KG" || sizeUnit === "METER" ? sizeUnit : "PIECE",
    );
    const packageQuantity =
      readParsedNumber(parsed, ["packageQuantity"], 1) ?? 1;

    return {
      rowId: row.id,
      selected:
        row.status !== "IMPORTED" &&
        row.status !== "IGNORED" &&
        row.status !== "FAILED" &&
        row.status !== "DUPLICATE",
      ignored: row.status === "IGNORED",
      rawText,
      rowNumber: row.rowNumber,
      status: row.status,
      error: row.error,
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
      ratePerPiece: Number(baseRate || wholesalePrice || retailPrice || 0),
      packageQuantity: Number.isFinite(Number(packageQuantity))
        ? Number(packageQuantity)
        : 1,
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
      retailPrice: Number(retailPrice || 0),
      wholesalePrice: Number(wholesalePrice || baseRate || 0),
      stock: readParsedNumber(parsed, ["stock"], 0) ?? 0,
    };
  }

  const rate = parseReviewRate(rawText);
  const cleanedName = cleanReviewProductName(rawText, rate);
  const packageMatch = rawText.match(
    /\b(\d+)\s*(?:pcs?|pieces?|dozen|dz|box|bundle)\b/i,
  );
  const packageQuantity = packageMatch ? Number(packageMatch[1]) : 1;
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

  return {
    rowId: row.id,
    selected:
      row.status !== "IMPORTED" &&
      row.status !== "IGNORED" &&
      row.status !== "FAILED" &&
      row.status !== "DUPLICATE",
    ignored: row.status === "IGNORED",
    rawText,
    rowNumber: row.rowNumber,
    status: row.status,
    error: row.error,
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
    ratePerPiece: rate,
    packageQuantity: Number.isFinite(packageQuantity) ? packageQuantity : 1,
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
    retailPrice: applyRetailMargin(rate, 18),
    wholesalePrice: rate,
    stock,
  };
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-[4px]">
      <div className="text-[11px] font-extrabold text-[#565449]">{label}</div>
      {children}
      {error ? (
        <div className="text-[12px] font-semibold text-rose-600">{error}</div>
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
  return (
    <ProjectSelect
      value={value}
      onChange={(event) => onChange(event.target.value)}
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
            "relative z-10 flex h-dvh max-h-dvh w-full flex-col overflow-hidden border-0 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.28)] lg:h-auto lg:max-h-[calc(100vh-28px)] lg:rounded-[18px] lg:border lg:border-[#CFCFD3]",
            maxWidthClass || (landscape ? "max-w-[1180px]" : "max-w-[1040px]"),
          )}
        >
          <div className="shrink-0 flex min-h-[62px] items-center justify-between border-b border-[#CFCFD3] px-[16px] py-[10px] lg:min-h-0">
            <div className="flex min-w-0 items-center gap-[10px]">
              {headerLeft}
              <div className="truncate text-[19px] font-extrabold text-[#000000] lg:text-[15px] lg:font-semibold">
                {title}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-[12px] border border-[#CFCFD3] hover:bg-[#F3F4F6]"
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
            <div className="shrink-0 border-t border-[#CFCFD3] bg-white px-[16px] pb-[max(10px,env(safe-area-inset-bottom))] pt-[10px] lg:py-[10px]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// this component holds all the modals for the products page (Add, Edit, View, Import, Confirm Delete)
// it keeps the main Products page cleaner by separating all modal jsx and state wiring into this file
export default function ProductsModals({
  brands,
  categories,
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
  onProductImageChange,
  onClearProductImage,

  onSave,
  onConfirmDelete,
  isAdmin,
  deleteSafety,
  deleteSafetyLoading,
  deleteBusy,
  onConfirmPermanentDelete,
  bulkAction,
  bulkProducts,
  onCloseBulkAction,
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
  brands: string[];
  categories: string[];
  businessDefaults: {
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
  onProductImageChange: (file: File | null) => void;
  onClearProductImage: () => void;

  onSave: () => void;
  onConfirmDelete: () => void;
  isAdmin: boolean;
  deleteSafety: ProductDeleteSafety | null;
  deleteSafetyLoading: boolean;
  deleteBusy: boolean;
  onConfirmPermanentDelete: () => void;
  bulkAction: {
    title: string;
    message: string;
    confirmLabel: string;
  } | null;
  bulkProducts: Product[];
  onCloseBulkAction: () => void;
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
  const [mobileEditorTab, setMobileEditorTab] = React.useState<"basic" | "units" | "pricing" | "stock">("basic");
  const [pdfReviewRows, setPdfReviewRows] = React.useState<PdfReviewDraft[]>(
    [],
  );
  const [activeReviewRowId, setActiveReviewRowId] = React.useState<
    string | null
  >(null);
  const reviewMarginPercent = 18;
  const [reviewPanelTab, setReviewPanelTab] = React.useState<"row" | "bulk">(
    "row",
  );
  const [reviewSearch, setReviewSearch] = React.useState("");
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
  const [bulkWholesaleMargin, setBulkWholesaleMargin] = React.useState(18);
  const [bulkRetailMargin, setBulkRetailMargin] = React.useState(30);
  const [deleteImportBatchId, setDeleteImportBatchId] = React.useState<
    string | null
  >(null);
  const activeReviewRow =
    pdfReviewRows.find((row) => row.rowId === activeReviewRowId) ||
    pdfReviewRows.find((row) => !row.ignored) ||
    null;
  const deleteImportBatch =
    importBatches.find((batch) => batch.id === deleteImportBatchId) || null;

  React.useEffect(() => {
    if (openAddEdit) setMobileEditorTab("basic");
  }, [openAddEdit, activeProductId]);

  React.useEffect(() => {
    if (!openAddEdit || Object.keys(formErrors).length === 0) return;
    if (formErrors.name || formErrors.sku || formErrors.image) setMobileEditorTab("basic");
    else if (formErrors.packageQuantity || formErrors.quantityStep) setMobileEditorTab("units");
    else if (formErrors.retailPrice || formErrors.wholesalePrice || formErrors.thresholdQty) setMobileEditorTab("pricing");
    else if (formErrors.stock || formErrors.lowStockThreshold) setMobileEditorTab("stock");
  }, [formErrors, openAddEdit]);
  const selectedReviewRows = pdfReviewRows.filter(
    (row) => row.selected && !row.ignored && row.status !== "IMPORTED",
  );
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
      row.status !== "IMPORTED" &&
      row.status !== "FAILED" &&
      row.status !== "DUPLICATE",
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
    setActiveReviewRowId(nextRows.find((row) => !row.ignored)?.rowId || null);
    setReviewPanelTab("row");
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
    setPdfReviewRows((rows) =>
      rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );
  }

  function updateSelectedReviewRows(patch: Partial<PdfReviewDraft>) {
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
        const rate = Number(
          row.ratePerPiece || row.wholesalePrice || row.retailPrice || 0,
        );
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

  function importSelectedPdfRows() {
    const rows = selectedReviewRows.map((row) => ({
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
      retailPrice: row.retailPrice,
      wholesalePrice: row.wholesalePrice,
      stock: row.stock,
    }));
    onImportReviewedPdfRows(
      rows,
      ignoredReviewRows.map((row) => row.rowId),
    );
  }

  return (
    <>
      <ModalShell
        open={openAddEdit}
        title={activeProductId ? "Edit Product" : "Add Product"}
        onClose={() => setOpenAddEdit(false)}
        landscape
        footer={
          <>
            <div className="w-full md:hidden [&>button]:w-full">
              <Button variant="primary" icon="save" onClick={onSave}>
                Save Product
              </Button>
            </div>
            <div className="hidden w-full items-center justify-end gap-[10px] md:flex">
              <Button onClick={() => setOpenAddEdit(false)}>Cancel</Button>
              <Button variant="primary" icon="save" onClick={onSave}>
                Save Product
              </Button>
            </div>
          </>
        }
      >
        <div className="grid shrink-0 grid-cols-4 border-b border-[#E5E7EB] bg-white md:hidden">
          {([
            ["basic", "Basic"],
            ["units", "Units"],
            ["pricing", "Pricing"],
            ["stock", "Stock"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMobileEditorTab(value)}
              className={cn(
                "relative h-[52px] text-[13px] font-bold",
                mobileEditorTab === value ? "text-[#11120d]" : "text-[#8C8889]",
              )}
            >
              {label}
              {mobileEditorTab === value ? <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-[#11120d]" /> : null}
            </button>
          ))}
        </div>
        <div className="h-full min-h-0 overflow-y-auto px-[20px] py-[16px]">
          <div className="flex flex-col gap-[24px]">
            
            {/* Top row: Image & Basic Info */}
            <div className={cn("grid grid-cols-1 gap-[18px] md:grid-cols-[200px_minmax(0,1fr)] md:gap-[24px]", mobileEditorTab !== "basic" && "hidden md:grid")}>
              
              {/* Product Image - Smaller, more compact */}
              <div className="space-y-[10px]">
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  PRODUCT IMAGE
                </h3>
                <div className="flex min-h-[96px] flex-col items-center justify-center rounded-[12px] border-2 border-dashed border-[#CFCFD3] bg-[#F8FAFC] p-[12px] transition hover:bg-gray-50 md:p-[16px]">
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
                    <div className="flex flex-col items-center gap-[8px] w-full">
                      <PreviewableImage
                        src={productImagePreview || form.imageUrl}
                        alt={form.name || "Product preview"}
                        title={form.name || "Product preview"}
                        subtitle={form.sku ? `SKU: ${form.sku}` : undefined}
                        enablePreview="desktop"
                        imgClassName="h-full w-full object-contain p-2"
                        className="flex h-[88px] w-full max-w-[180px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[#CFCFD3] bg-white shadow-sm md:h-[132px] md:max-w-full"
                        fallback={
                          <GoogleIcon
                            name="inventory_2"
                            sizePx={36}
                            className="text-[#8C8889]"
                          />
                        }
                      />
                      <div className="flex flex-col gap-[6px] w-full mt-[4px]">
                        <label
                          htmlFor="product-image-dropzone"
                          className="inline-flex w-full cursor-pointer items-center justify-center rounded-[8px] bg-[#3B82F6] px-[12px] py-[6px] text-[12px] font-bold text-white transition hover:bg-[#2563EB]"
                        >
                          Change
                        </label>
                        <button
                          type="button"
                          onClick={onClearProductImage}
                          className="inline-flex w-full items-center justify-center rounded-[8px] border border-[#FECDD3] bg-[#FFF1F2] px-[12px] py-[6px] text-[12px] font-bold text-[#BE123C] transition hover:bg-rose-100"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <label
                      htmlFor="product-image-dropzone"
                      className="flex flex-col items-center gap-[8px] cursor-pointer text-center w-full py-[16px]"
                    >
                      <div className="flex h-[44px] w-[44px] items-center justify-center rounded-full border border-[#CFCFD3] bg-white text-[#565449]">
                        <GoogleIcon name="cloud_upload" className="text-[22px]" />
                      </div>
                      <div className="text-[12px] font-bold text-[#11120d] leading-tight mt-[4px]">
                        Upload Image
                      </div>
                      <div className="text-[10px] font-medium text-[#8C8889] leading-tight">
                        JPG/PNG &lt; 5MB
                      </div>
                    </label>
                  )}
                  {formErrors.image ? (
                    <div className="mt-[6px] text-[11px] font-semibold text-rose-600 text-center">
                      {formErrors.image}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Basic Information */}
              <div className="space-y-[12px]">
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  BASIC INFORMATION
                </h3>
                
                <Field label="Product Name" error={formErrors.name}>
                  <input
                    value={form.name}
                    onChange={(event) =>
                      setForm((product) => ({ ...product, name: event.target.value }))
                    }
                    className={inputClass(formErrors.name)}
                    placeholder="e.g. Sauce Bottle"
                  />
                </Field>

                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
                  <Field label="SKU" error={formErrors.sku}>
                    <input
                      value={form.sku}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, sku: event.target.value }))
                      }
                      className={inputClass(formErrors.sku)}
                      placeholder="BAGMATI-001"
                    />
                  </Field>
                  <Field label="Barcode">
                    <input
                      value={form.barcode || ""}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, barcode: event.target.value }))
                      }
                      className={compactInputClass}
                      placeholder="Optional"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
                  <Field label="Brand">
                    <Select
                      value={form.brand}
                      onChange={(value) =>
                        setForm((product) => ({ ...product, brand: value }))
                      }
                      options={brands
                        .filter((brand) => brand !== "All Brands")
                        .map((brand) => ({ value: brand, label: brand }))}
                    />
                  </Field>
                  <Field label="Category">
                    <Select
                      value={form.category}
                      onChange={(value) =>
                        setForm((product) => ({ ...product, category: value }))
                      }
                      options={categories
                        .filter((category) => category !== "All Categories")
                        .map((category) => ({ value: category, label: category }))}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
                  <Field label="Category Group">
                    <input
                      value={form.categoryGroup || ""}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, categoryGroup: event.target.value }))
                      }
                      className={compactInputClass}
                      placeholder="e.g. White, Green, Silver"
                    />
                  </Field>
                  <Field label="Supplier / Source">
                    <input
                      value={form.vendorSource || ""}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, vendorSource: event.target.value }))
                      }
                      className={compactInputClass}
                      placeholder="e.g. Bagmati Plastic"
                    />
                  </Field>
                </div>

                <Field label="Variant / Code">
                  <input
                    value={form.productCodeVariant || ""}
                    onChange={(event) =>
                      setForm((product) => ({ ...product, productCodeVariant: event.target.value }))
                    }
                    className={compactInputClass}
                    placeholder="e.g. Bucket 105"
                  />
                </Field>
              </div>
            </div>

            {/* Bottom Row: Rest of the details */}
            <div className="grid grid-cols-1 gap-[18px] md:grid-cols-3 md:gap-[24px]">

              {/* SIZE & PACKAGING */}
              <div className={cn("space-y-[12px]", mobileEditorTab !== "units" && "hidden md:block")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  SIZE & PACKAGING
                </h3>

                <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-[10px]">
                  <Field label="Size Value">
                    <input
                      type="number"
                      min={0}
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
                  <Field label="Pack Qty" error={formErrors.packageQuantity}>
                    <input
                      type="number"
                      min={0.001}
                      step="0.001"
                      value={form.packageQuantity}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, packageQuantity: Number(event.target.value) }))
                      }
                      className={inputClass(formErrors.packageQuantity)}
                    />
                  </Field>
                  <Field label="Pack Unit">
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

                <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-[10px]">
                  <Field label="Sale Unit">
                    <Select
                      value={form.saleUnit || "PIECE"}
                      onChange={(value) =>
                        setForm((product) => ({
                          ...product,
                          saleUnit: value,
                          allowFractionalQty:
                            value === "KG" || value === "GRAM" || value === "METER"
                              ? product.allowFractionalQty
                              : false,
                          quantityStep:
                            value === "KG" || value === "GRAM" || value === "METER"
                              ? product.quantityStep
                              : 1,
                        }))
                      }
                      options={[
                        { value: "PIECE", label: "Piece" },
                        { value: "KG", label: "KG" },
                        { value: "GRAM", label: "Gram" },
                        { value: "METER", label: "Meter" },
                        { value: "LTR", label: "Ltr" },
                      ]}
                    />
                  </Field>
                  <Field label="Qty Step" error={formErrors.quantityStep}>
                    <input
                      type="number"
                      min={0.001}
                      step="0.001"
                      value={form.quantityStep}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, quantityStep: Number(event.target.value) }))
                      }
                      className={inputClass(formErrors.quantityStep)}
                    />
                  </Field>
                </div>

                <label className="flex h-[38px] items-center gap-[8px] rounded-[10px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[12px] font-bold text-[#11120d]">
                  <input
                    type="checkbox"
                    checked={form.allowFractionalQty}
                    onChange={(event) =>
                      setForm((product) => ({
                        ...product,
                        allowFractionalQty: event.target.checked,
                        quantityStep: event.target.checked
                          ? product.quantityStep || 0.001
                          : 1,
                      }))
                    }
                    className="h-[16px] w-[16px] rounded border-[#CFCFD3] accent-[#3B82F6]"
                  />
                  Decimal quantity (fractions)
                </label>
              </div>

              {/* PRICING */}
              <div className={cn("space-y-[12px]", mobileEditorTab !== "pricing" && "hidden md:block")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  PRICING
                </h3>
                
                <Field label="Rate Per Piece (NPR)">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.ratePerPiece}
                    onChange={(event) => {
                      const nextRate = Number(event.target.value);
                      setForm((product) => ({
                        ...product,
                        ratePerPiece: nextRate,
                        retailPrice: !product.retailPrice || product.retailPrice === product.ratePerPiece ? nextRate : product.retailPrice,
                        wholesalePrice: !product.wholesalePrice || product.wholesalePrice === product.ratePerPiece ? nextRate : product.wholesalePrice,
                      }));
                    }}
                    className={compactInputClass}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-[10px] md:grid-cols-2">
                  <Field label="Retail Price" error={formErrors.retailPrice}>
                    <input
                      type="number"
                      value={form.retailPrice}
                      onChange={(event) => {
                        const nextRetailPrice = Number(event.target.value);
                        setForm((product) => ({
                          ...product,
                          retailPrice: nextRetailPrice,
                          ratePerPiece: !product.ratePerPiece || product.ratePerPiece === product.retailPrice ? nextRetailPrice : product.ratePerPiece,
                        }));
                      }}
                      className={inputClass(formErrors.retailPrice)}
                    />
                  </Field>
                  <Field label="Wholesale Price" error={formErrors.wholesalePrice}>
                    <input
                      type="number"
                      value={form.wholesalePrice}
                      onChange={(event) =>
                        setForm((product) => ({ ...product, wholesalePrice: Number(event.target.value) }))
                      }
                      className={inputClass(formErrors.wholesalePrice)}
                    />
                  </Field>
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
                        onChange={(event) =>
                          setForm((product) => ({
                            ...product,
                            thresholdQtyMode: 'custom',
                            thresholdQty: Number(event.target.value),
                          }))
                        }
                        className={inputClass(formErrors.thresholdQty)}
                      />
                    </Field>
                  )}
                </div>
              </div>

              {/* STOCK & STATUS */}
              <div className={cn("space-y-[12px]", mobileEditorTab !== "stock" && "hidden md:block")}>
                <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-[8px] border-b border-[#E5E7EB] pb-[8px]">
                  STOCK & STATUS
                </h3>
                
                <Field label="Initial Stock" error={formErrors.stock}>
                  <input
                    type="number"
                    value={form.stock}
                    onChange={(event) =>
                      setForm((product) => ({ ...product, stock: Number(event.target.value) }))
                    }
                    className={inputClass(formErrors.stock)}
                  />
                </Field>

                <Field label="Low Stock Threshold" error={formErrors.lowStockThreshold}>
                  <input
                    type="number"
                    min={0}
                    value={form.lowStockThresholdMode === 'default' ? businessDefaults.defaultLowStockThreshold : form.lowStockThreshold}
                    onChange={(event) =>
                      setForm((product) => ({
                        ...product,
                        lowStockThresholdMode: 'custom',
                        lowStockThreshold: Number(event.target.value),
                      }))
                    }
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
              </div>

            </div>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={openImport}
        title={
          pdfReviewBatch
            ? `Review ${displaySourceType(pdfReviewBatch.sourceType)} Import`
            : "Import Products from CSV, PDF, or Image"
        }
        onClose={onCloseImport}
        landscape={!!pdfReviewBatch}
        headerLeft={
          pdfReviewBatch ? (
            <button
              type="button"
              onClick={onBackToImportList}
              className="inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
              aria-label="Back to import options"
            >
              <GoogleIcon name="arrow_back" className="text-[18px]" />
            </button>
          ) : null
        }
        footer={
          pdfReviewBatch ? (
            <div className="flex flex-wrap items-center justify-between gap-[10px]">
              <div className="text-[12px] font-semibold text-[#8C8889]">
                {selectedReviewRows.length} selected, {ignoredReviewRows.length}{" "}
                ignored
              </div>
              <div className="flex items-center gap-[10px]">
                <Button
                  variant="primary"
                  icon="check_circle"
                  onClick={importSelectedPdfRows}
                  disabled={pdfReviewBusy || selectedReviewRows.length === 0}
                >
                  {pdfReviewBusy ? "Importing..." : "Import Selected"}
                </Button>
              </div>
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
          <div className="grid h-[min(76vh,760px)] min-h-0 grid-cols-1 gap-[12px] overflow-hidden xl:grid-cols-[minmax(390px,0.95fr)_minmax(0,1.25fr)]">
            <section className="flex min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-white">
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
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-[10px] py-[5px] text-[11px] font-extrabold text-sky-800">
                    {pdfReviewBatch.status}
                  </span>
                </div>
                <div className="mt-[10px] grid grid-cols-[auto_minmax(0,1fr)_130px] gap-[8px]">
                  <label className="inline-flex h-[36px] items-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-white px-[10px] text-[11px] font-extrabold text-[#565449]">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={(event) =>
                        toggleVisibleReviewSelection(event.target.checked)
                      }
                    />
                    Select all
                  </label>
                  <input
                    value={reviewSearch}
                    onChange={(event) => setReviewSearch(event.target.value)}
                    placeholder="Search extracted rows..."
                    className="h-[36px] rounded-[12px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-semibold text-[#000000] outline-none"
                  />
                  <ProjectSelect
                    value={reviewStatusFilter}
                    onChange={(event) =>
                      setReviewStatusFilter(event.target.value as any)
                    }
                    className="h-[36px] rounded-[12px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#565449] outline-none"
                  >
                    <option value="ALL">All</option>
                    <option value="READY">Ready</option>
                    <option value="ISSUES">Issues</option>
                    <option value="DUPLICATE">Duplicates</option>
                    <option value="IGNORED">Ignored</option>
                  </ProjectSelect>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-white">
                {filteredReviewRows.map((row) => {
                  const active = activeReviewRow?.rowId === row.rowId;
                  const imported = row.status === "IMPORTED";
                  return (
                    <button
                      key={row.rowId}
                      type="button"
                      onClick={() => setActiveReviewRowId(row.rowId)}
                      className={cn(
                        "grid min-h-[42px] w-full grid-cols-[26px_72px_minmax(0,1fr)_64px] items-center gap-[8px] border-b border-[#E5E7EB] px-[10px] py-[7px] text-left transition last:border-b-0",
                        active
                          ? "bg-[#EEF4FF] shadow-[inset_3px_0_0_#11120d]"
                          : "bg-white hover:bg-[#ECEFF3]",
                        row.ignored ? "opacity-60" : "",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={row.selected}
                        disabled={imported || row.ignored}
                        onChange={(event) => {
                          event.stopPropagation();
                          updateReviewRow(row.rowId, {
                            selected: event.target.checked,
                            ignored: event.target.checked ? false : row.ignored,
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
                            NPR {formatQty(row.ratePerPiece)} | Stock{" "}
                            {formatQty(row.stock)}
                          </div>
                        )}
                      </div>
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateReviewRow(row.rowId, {
                            ignored: !row.ignored,
                            selected: row.ignored,
                          });
                        }}
                        className={cn(
                          "inline-flex h-[28px] items-center justify-center rounded-[9px] border border-[#CFCFD3] bg-white px-[8px] text-[11px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]",
                          imported && "pointer-events-none opacity-50",
                        )}
                      >
                        {row.ignored ? "Use" : "Ignore"}
                      </span>
                    </button>
                  );
                })}
                {filteredReviewRows.length === 0 ? (
                  <div className="px-[12px] py-[20px] text-[12px] font-semibold text-[#8C8889]">
                    No rows match the current search or status filter.
                  </div>
                ) : null}
              </div>
            </section>

            <section className="min-h-0 overflow-y-auto rounded-[16px] border border-[#CFCFD3] bg-white p-[12px]">
              {activeReviewRow ? (
                <div className="space-y-[12px]">
                  <div className="grid grid-cols-2 gap-[6px] rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[5px]">
                    {(["row", "bulk"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setReviewPanelTab(tab)}
                        className={cn(
                          "h-[36px] rounded-[10px] text-[12px] font-extrabold transition",
                          reviewPanelTab === tab
                            ? "bg-[#11120d] text-white"
                            : "bg-white text-[#565449] hover:bg-[#F3F4F6]",
                        )}
                      >
                        {tab === "row"
                          ? "Row"
                          : `Change Selected (${selectedReviewRows.length})`}
                      </button>
                    ))}
                  </div>

                  {reviewPanelTab === "bulk" ? (
                    <div className="space-y-[12px]">
                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Classification
                        </div>
                        <div className="grid grid-cols-1 gap-[10px] lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                          <Field label="Brand">
                            <input
                              value={bulkBrand}
                              onChange={(event) =>
                                setBulkBrand(event.target.value)
                              }
                              className={compactInputClass}
                              placeholder="Apply brand"
                            />
                          </Field>
                          <Field label="Category">
                            <input
                              value={bulkCategory}
                              onChange={(event) =>
                                setBulkCategory(event.target.value)
                              }
                              className={compactInputClass}
                              placeholder="Apply category"
                            />
                          </Field>
                          <Field label="Supplier / Source">
                            <input
                              value={bulkSupplier}
                              onChange={(event) =>
                                setBulkSupplier(event.target.value)
                              }
                              className={compactInputClass}
                              placeholder="Apply supplier"
                            />
                          </Field>
                          <Button
                            size="sm"
                            onClick={applyBulkClassificationToSelectedRows}
                            disabled={selectedReviewRows.length === 0}
                          >
                            Apply classification
                          </Button>
                        </div>
                      </div>

                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
                        <div className="mb-[8px] text-[12px] font-extrabold text-[#000000]">
                          Pricing
                        </div>
                        <div className="grid grid-cols-1 gap-[8px] lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                          <Field label="Wholesale margin %">
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
                          <Field label="Retail margin %">
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
                            Apply pricing
                          </Button>
                        </div>
                      </div>

                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] p-[12px]">
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
                            Apply stock
                          </Button>
                        </div>
                      </div>

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
                            Apply rules
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] py-[10px]">
                        <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                          Extracted line
                        </div>
                        <div className="mt-[4px] text-[12px] font-semibold leading-5 text-[#000000]">
                          {activeReviewRow.rawText}
                        </div>
                      </div>

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
                          <input
                            value={activeReviewRow.brand}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                brand: event.target.value,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Category">
                          <input
                            value={activeReviewRow.category}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                category: event.target.value,
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Supplier / Source">
                          <input
                            value={activeReviewRow.vendorSource || ""}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                vendorSource: event.target.value,
                              })
                            }
                            className={compactInputClass}
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
                            value={activeReviewRow.packageQuantity}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                packageQuantity: Number(event.target.value),
                              })
                            }
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
                        <Field label="Rate / Piece">
                          <input
                            type="number"
                            value={activeReviewRow.ratePerPiece}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              updateReviewRow(activeReviewRow.rowId, {
                                ratePerPiece: next,
                                retailPrice: applyRetailMargin(
                                  next,
                                  reviewMarginPercent,
                                ),
                                wholesalePrice: next,
                              });
                            }}
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Retail Price">
                          <input
                            type="number"
                            value={activeReviewRow.retailPrice}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                retailPrice: Number(event.target.value),
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Wholesale">
                          <input
                            type="number"
                            value={activeReviewRow.wholesalePrice}
                            onChange={(event) =>
                              updateReviewRow(activeReviewRow.rowId, {
                                wholesalePrice: Number(event.target.value),
                              })
                            }
                            className={compactInputClass}
                          />
                        </Field>
                        <Field label="Stock">
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
                        </Field>
                      </div>

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
          </div>        ) : (
          <div className="flex flex-col h-full bg-[#F8FAFC]">
            {/* Tabs */}
            <div className="flex border-b border-[#E5E7EB] bg-white px-[24px]">
              <button
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "csv" ? "border-[#2563EB] text-[#2563EB]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
                onClick={() => setImportTab("csv")}
              >
                <Icon name="table_chart" className="text-[18px]" />
                CSV File
              </button>
              <button
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "pdf" ? "border-[#2563EB] text-[#2563EB]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
                onClick={() => setImportTab("pdf")}
              >
                <Icon name="picture_as_pdf" className="text-[18px]" />
                PDF Rate List
              </button>
              <button
                className={`py-[16px] px-[16px] text-[13px] font-bold border-b-2 flex items-center gap-[8px] transition ${importTab === "image" ? "border-[#2563EB] text-[#2563EB]" : "border-transparent text-[#8C8889] hover:text-[#565449]"}`}
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
            <div className="p-[24px] overflow-y-auto space-y-[24px]">
              {importTab === "csv" && (
                <div className="space-y-[24px]">
                  {/* CSV Upload */}
                  <div className="border-2 border-dashed border-[#CFCFD3] rounded-[16px] p-[32px] text-center hover:border-[#3B82F6] hover:bg-[#EFF6FF] transition group relative bg-white">
                    <div className="w-[48px] h-[48px] rounded-[12px] bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center mx-auto mb-[16px] group-hover:scale-110 transition-transform">
                      <Icon name="table_chart" className="text-[24px] text-[#64748B] group-hover:text-[#3B82F6]" />
                    </div>
                    <h4 className="text-[14px] font-bold text-[#1E293B] mb-[6px]">Upload CSV rate list</h4>
                    <p className="text-[12px] text-[#64748B] mb-[16px]">Standard .csv file mapping to KhataSathi format</p>
                    <label htmlFor="csv-upload" className="inline-flex cursor-pointer bg-[#F1F5F9] text-[#0F172A] font-bold px-[20px] py-[8px] rounded-[8px] text-[12px] border border-[#E2E8F0] shadow-sm hover:bg-[#E2E8F0] transition">
                      {importFile ? "Change CSV File" : "Choose CSV File"}
                    </label>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                      className="hidden"
                      id="csv-upload"
                    />
                    {importFile && (
                      <div className="mt-[12px] text-[12px] font-bold text-[#10B981] flex items-center justify-center gap-[6px]">
                        <Icon name="check_circle" className="text-[14px]" /> {importFile.name}
                      </div>
                    )}
                  </div>

                  {/* CSV Field Mapping & Template Settings */}
                  <div className="bg-white border border-[#E5E7EB] rounded-[16px] p-[20px] shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-[12px] mb-[16px]">
                      <div>
                        <h4 className="text-[14px] font-bold text-[#11120d]">CSV Column Mapping</h4>
                        <p className="text-[12px] text-[#8C8889] mt-[2px]">Map supplier columns to KhataSathi fields</p>
                      </div>
                      <div className="flex gap-[8px]">
                        <button onClick={onSaveImportTemplate} className="text-[12px] font-bold bg-[#F3F4F6] text-[#565449] px-[12px] py-[6px] rounded-[8px] hover:bg-[#E5E7EB] transition">Save Template</button>
                        {importTemplateId && (
                          <button onClick={() => onDeleteImportTemplate(importTemplateId)} className="text-[12px] font-bold bg-[#FEF2F2] text-[#DC2626] px-[12px] py-[6px] rounded-[8px] hover:bg-[#FEE2E2] transition">Delete</button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-[16px]">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
                        <ProjectSelect
                          value={importTemplateId}
                          onChange={(event) => setImportTemplateId(event.target.value)}
                          className="h-[40px] w-full rounded-[10px] border border-[#CFCFD3] bg-[#F8FAFC] px-[12px] text-[13px] font-bold outline-none focus:border-[#3B82F6]"
                        >
                          <option value="">No template</option>
                          {importTemplates.map((t) => <option key={t.id} value={t.id}>{t.supplier} - {t.name}</option>)}
                        </ProjectSelect>
                        <input
                          value={importSupplier}
                          onChange={(event) => setImportSupplier(event.target.value)}
                          placeholder="Supplier / Brand Name"
                          className="h-[40px] w-full rounded-[10px] border border-[#CFCFD3] bg-white px-[12px] text-[13px] font-semibold outline-none focus:border-[#3B82F6]"
                        />
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-[12px] p-[16px] bg-[#F8FAFC] rounded-[12px] border border-[#E5E7EB]">
                        {[
                          ["productName", "Name Col"], ["serial", "SKU/Serial"], ["variant", "Variant"],
                          ["packageQuantity", "Pack Qty"], ["retailPrice", "MRP Col"], ["wholesalePrice", "Rate Col"], ["stock", "Stock"]
                        ].map(([key, label]) => (
                          <div key={key} className="space-y-[6px]">
                            <label className="text-[11px] font-bold text-[#8C8889] uppercase tracking-wider">{label}</label>
                            <input
                              value={importFieldMap[key] || ""}
                              onChange={(event) => setImportFieldMap((current) => ({...current, [key]: event.target.value}))}
                              className="h-[36px] w-full rounded-[8px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-semibold outline-none focus:border-[#3B82F6] focus:ring-1 focus:ring-[#3B82F6]"
                              placeholder="Header name"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Import History */}
                  <div className="bg-white border border-[#E5E7EB] rounded-[16px] overflow-hidden shadow-sm">
                    <div className="px-[20px] py-[16px] border-b border-[#E5E7EB] bg-[#F8FAFC]">
                      <h4 className="text-[14px] font-bold text-[#11120d]">Recent Import History</h4>
                    </div>
                    {importBatches.length > 0 ? (
                      <div className="divide-y divide-[#E5E7EB]">
                        {importBatches.map((batch) => (
                          <div key={batch.id} className="flex min-w-0 items-center justify-between gap-3 p-[16px] transition-colors hover:bg-[#ECEFF3]">
                            <div className="flex min-w-0 flex-1 items-center gap-[12px] sm:gap-[16px]">
                              <div className="h-[40px] w-[40px] shrink-0 rounded-[10px] bg-[#F1F5F9] flex items-center justify-center border border-[#E2E8F0]">
                                <Icon name={batch.sourceType === "csv" ? "table_chart" : batch.sourceType === "pdf" ? "picture_as_pdf" : "image"} className="text-[20px] text-[#64748B]" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 break-all text-[13px] font-bold leading-5 text-[#1E293B] sm:truncate sm:break-normal">{batch.fileName || "Supplier import"}</div>
                                <div className="text-[11px] font-medium text-[#64748B] mt-[2px]">{batch.createdAt ? new Date(batch.createdAt).toLocaleDateString() : ""} • {displaySourceType(batch.sourceType)}</div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 sm:gap-[24px]">
                              <div className="text-right hidden sm:block">
                                <div className="text-[12px] font-bold text-[#334155]">{batch.totalRows} Rows</div>
                                <div className="text-[11px] font-medium text-[#10B981] mt-[2px]">{batch.importedRows} Processed</div>
                              </div>
                              <div className="flex shrink-0 items-center gap-[8px]">
                                <button onClick={() => setDeleteImportBatchId(batch.id)} className="w-[32px] h-[32px] flex items-center justify-center rounded-[8px] text-[#64748B] hover:text-[#EF4444] hover:bg-[#FEE2E2] transition">
                                  <Icon name="delete" className="text-[18px]" />
                                </button>
                                <button onClick={() => onOpenImportBatch(batch.id)} className="px-[16px] h-[32px] flex items-center justify-center rounded-[8px] text-[12px] font-bold bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E2E8F0] transition">
                                  Open
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-[40px] text-center">
                        <Icon name="history" className="text-[40px] text-[#CBD5E1] mx-auto mb-[12px]" />
                        <div className="text-[14px] font-bold text-[#475569]">No Recent Imports</div>
                        <div className="text-[13px] text-[#64748B] mt-[4px]">Your imported rate lists and history will appear here.</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {importTab === "pdf" && (
                <div className="border-2 border-dashed border-[#CFCFD3] bg-white rounded-[16px] p-[48px] text-center hover:border-[#3B82F6] hover:bg-[#EFF6FF] transition group relative">
                  <div className="w-[64px] h-[64px] rounded-[16px] bg-[#F1F5F9] border border-[#E2E8F0] shadow-sm flex items-center justify-center mx-auto mb-[20px] group-hover:scale-110 transition-transform">
                    <Icon name="picture_as_pdf" className="text-[32px] text-[#94A3B8] group-hover:text-[#3B82F6]" />
                  </div>
                  <h4 className="text-[16px] font-bold text-[#1E293B] mb-[8px]">Upload PDF supplier rate list</h4>
                  <p className="text-[13px] text-[#64748B] mb-[24px]">PDF files up to 10MB — AI will parse and extract product data</p>
                  <label htmlFor="pdf-upload" className="inline-flex cursor-pointer bg-[#2563EB] text-white font-bold px-[24px] py-[10px] rounded-[10px] text-[13px] shadow-sm hover:bg-[#1D4ED8] transition">
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
                    <div className="mt-[16px] text-[13px] font-bold text-[#10B981] flex items-center justify-center gap-[6px]">
                      <Icon name="check_circle" className="text-[16px]" /> {importFile.name}
                    </div>
                  )}
                </div>
              )}

              {importTab === "image" && (
                <div className="border-2 border-dashed border-[#CFCFD3] bg-white rounded-[16px] p-[48px] text-center hover:border-[#3B82F6] hover:bg-[#EFF6FF] transition group relative">
                  <div className="w-[64px] h-[64px] rounded-[16px] bg-[#F1F5F9] border border-[#E2E8F0] shadow-sm flex items-center justify-center mx-auto mb-[20px] group-hover:scale-110 transition-transform">
                    <Icon name="image" className="text-[32px] text-[#94A3B8] group-hover:text-[#3B82F6]" />
                  </div>
                  <h4 className="text-[16px] font-bold text-[#1E293B] mb-[8px]">Upload image of printed rate list</h4>
                  <p className="text-[13px] text-[#64748B] mb-[24px]">PNG, JPG, WebP up to 10MB — AI will parse from image</p>
                  <label htmlFor="img-upload" className="inline-flex cursor-pointer bg-[#2563EB] text-white font-bold px-[24px] py-[10px] rounded-[10px] text-[13px] shadow-sm hover:bg-[#1D4ED8] transition">
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
                    <div className="mt-[16px] text-[13px] font-bold text-[#10B981] flex items-center justify-center gap-[6px]">
                      <Icon name="check_circle" className="text-[16px]" /> {importFile.name}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}
      </ModalShell>

      <ModalShell
        open={!!deleteImportBatchId}
        title="Delete Import Review"
        onClose={() => setDeleteImportBatchId(null)}
        footer={
          <div className="flex w-full items-center justify-end gap-[10px] [&>button]:flex-1 md:[&>button]:flex-none">
            <Button onClick={() => setDeleteImportBatchId(null)}>Cancel</Button>
            <Button
              variant="danger"
              icon="delete"
              disabled={importBusy || !deleteImportBatchId}
              onClick={() => {
                if (!deleteImportBatchId) return;
                onDeleteImportBatch(deleteImportBatchId);
                setDeleteImportBatchId(null);
              }}
            >
              Delete Review
            </Button>
          </div>
        }
      >
        <div className="space-y-[12px]">
          <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-[12px] py-[10px] text-[13px] font-semibold leading-5 text-rose-800">
            Delete this import review history? Products that were already
            imported from this review will not be removed.
          </div>
          <div className="rounded-[14px] border border-[#CFCFD3] bg-white px-[12px] py-[10px]">
            <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
              Review
            </div>
            <div className="mt-[4px] text-[14px] font-extrabold text-[#000000]">
              {deleteImportBatch?.fileName || "Supplier import"}
            </div>
            <div className="mt-[5px] flex flex-wrap gap-[6px] text-[11px] font-extrabold">
              <span className="rounded-full bg-[#F3F4F6] px-[8px] py-[4px] text-[#565449]">
                {displaySourceType(deleteImportBatch?.sourceType)}
              </span>
              <span className="rounded-full bg-[#F3F4F6] px-[8px] py-[4px] text-[#565449]">
                {deleteImportBatch?.totalRows || 0} rows
              </span>
              <span className="rounded-full bg-[#F3F4F6] px-[8px] py-[4px] text-[#565449]">
                {deleteImportBatch?.status || "DRAFT"}
              </span>
            </div>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={openView}
        title="Product Details"
        onClose={() => setOpenView(false)}
        contentClassName="bg-white p-[20px]"
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
                icon: "badge",
                title: "Identity",
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
                  ["Rate per Piece", formatNpr(activeProduct.ratePerPiece)],
                  ["Retail Price", formatNpr(activeProduct.retailPrice)],
                  ["Wholesale Price", formatNpr(activeProduct.wholesalePrice)],
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
            ] as const).map((section) => (
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
            <div className="flex flex-col gap-[20px] md:flex-row">

              {/* Left - Image & Quick Actions */}
              <div className="w-full flex-shrink-0 md:w-[152px] flex flex-col items-center">
                <PreviewableImage
                  src={activeProduct.imageUrl}
                  alt={activeProduct.name}
                  title={activeProduct.name}
                  subtitle={`SKU: ${activeProduct.sku || "NO-SKU"}`}
                  enablePreview="desktop"
                  imgClassName="h-full w-full object-contain p-2"
                  className="flex w-full aspect-square items-center justify-center overflow-hidden rounded-[14px] border border-[#CFCFD3] bg-white shadow-sm"
                  fallback={
                    <GoogleIcon
                      name="inventory_2"
                      sizePx={64}
                      className="text-[#8C8889]"
                    />
                  }
                />
                <div className="mt-[12px]">
                  <StatusPill status={activeProduct.status} />
                </div>
              </div>

              {/* Right - Details */}
              <div className="flex-1 space-y-[16px]">
                
                {/* Header Info */}
                <div>
                  <h3 className="text-[20px] font-extrabold leading-6 text-[#11120d]">{activeProduct.name}</h3>
                  <div className="flex items-center gap-[8px] mt-[4px]">
                    <span className="rounded-[6px] border border-[#CFCFD3] bg-white px-[7px] py-[3px] font-mono text-[13px] font-bold text-[#565449]">
                      {activeProduct.sku || "NO-SKU"}
                    </span>
                    {activeProduct.barcode && (
                      <span className="text-[12px] text-[#565449]">Barcode: {activeProduct.barcode}</span>
                    )}
                  </div>
                </div>

                {/* Details Grid */}
                <div className="grid grid-cols-1 gap-x-[28px] gap-y-[8px] text-[14px] sm:grid-cols-2">
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Brand</span>
                    <span className="text-right font-extrabold text-[#11120d]">
                      {activeProduct.brand ? (
                        <span className="rounded-[6px] border border-[#CFCFD3] bg-white px-[8px] py-[2px] text-[12px] uppercase tracking-wider text-[#11120d]">{activeProduct.brand}</span>
                      ) : "-"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Category</span>
                    <span className="text-right font-extrabold text-[#11120d]">
                      {activeProduct.category ? (
                        <span className="rounded-[6px] border border-[#CFCFD3] bg-white px-[8px] py-[2px] text-[12px] uppercase tracking-wider text-[#11120d]">{activeProduct.category}</span>
                      ) : "-"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Variant</span>
                    <span className="text-right font-extrabold text-[#11120d]">{activeProduct.productCodeVariant || "-"}</span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Vendor</span>
                    <span className="text-right font-extrabold text-[#11120d]">{activeProduct.vendorSource || "-"}</span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Size</span>
                    <span className="text-right font-extrabold text-[#11120d]">{formatProductSize(activeProduct)}</span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Package</span>
                    <span className="text-right font-extrabold text-[#11120d]">{formatPackage(activeProduct)}</span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Sale Unit</span>
                    <span className="text-right font-extrabold text-[#11120d]">{activeProduct.saleUnit}</span>
                  </div>
                  <div className="flex justify-between gap-[16px] border-b border-[#E5E7EB] py-[6px]">
                    <span className="text-[#565449]">Fractional Qty</span>
                    <span className="text-right font-extrabold text-[#11120d]">
                      {activeProduct.allowFractionalQty ? (
                        <span className="text-[#16A34A]">Yes (step {activeProduct.quantityStep})</span>
                      ) : "No"}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-[14px] pt-[4px] sm:grid-cols-2">
                  {/* Pricing Card */}
                  <div className="rounded-[14px] border border-[#CFCFD3] bg-white p-[16px]">
                    <h4 className="text-[11px] font-extrabold text-[#565449] uppercase tracking-wider mb-[12px] flex items-center gap-[6px]">
                      <GoogleIcon name="sell" className="text-[15px] text-[#565449]" />
                      Pricing
                    </h4>
                    <div className="space-y-[8px] text-[14px]">
                      <div className="flex justify-between">
                        <span className="text-[#565449]">Rate per Piece</span>
                        <span className="font-extrabold text-[15px] text-[#11120d]">{formatNpr(activeProduct.ratePerPiece)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#565449]">Retail Price</span>
                        <span className="font-extrabold text-[15px] text-[#16A34A]">{formatNpr(activeProduct.retailPrice)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#565449]">Wholesale Price</span>
                        <span className="font-extrabold text-[15px] text-[#11120d]">{formatNpr(activeProduct.wholesalePrice)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#565449]">Wholesale Eligible</span>
                        <span className="font-bold text-[#11120d]">
                          {activeProduct.wholesaleEligible ? (
                            <span className="text-[#16A34A] flex items-center gap-[4px]"><GoogleIcon name="check" className="text-[14px]" /> Yes</span>
                          ) : "No"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#565449]">Threshold</span>
                        <span className="font-medium text-[#8C8889]">
                          {activeProduct.thresholdQtyMode === "default" ? "Default " : ""}
                          ({activeProduct.thresholdQty} qty)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Stock Card */}
                  <div className="flex flex-col justify-between rounded-[14px] border border-[#CFCFD3] bg-white p-[16px]">
                    <div>
                      <h4 className="text-[11px] font-extrabold text-[#565449] uppercase tracking-wider mb-[12px] flex items-center gap-[6px]">
                        <GoogleIcon name="inventory_2" className="text-[15px] text-[#565449]" />
                        Stock
                      </h4>
                      <div className="flex items-center gap-[12px] mb-[12px]">
                        <div className="flex items-center gap-[8px]">
                          <span className="text-[38px] font-black leading-none text-[#11120d]">{formatQty(activeProduct.stock)}</span>
                          <StockPill flag={getStockFlag(activeProduct)} />
                        </div>
                      </div>
                    </div>
                    <div className="text-[12px] text-[#8C8889] font-medium border-t border-[#E5E7EB] pt-[12px]">
                      Low Stock Threshold: {activeProduct.lowStockThresholdMode === 'default' ? 'Default ' : ''} ({formatQty(activeProduct.lowStockThreshold)})
                    </div>
                  </div>
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
          <div className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[26px] bg-white px-[20px] pb-[env(safe-area-inset-bottom)] pt-[20px] text-center shadow-2xl sm:max-w-[440px] sm:rounded-[24px] sm:p-[32px]">
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-[#CFCFD3] sm:hidden" />
            <div className="w-[56px] h-[56px] rounded-full bg-red-50 flex items-center justify-center mx-auto mb-[20px]">
              <GoogleIcon name="warning" className="text-[28px] text-red-600" />
            </div>

            <h3 className="text-[20px] font-extrabold text-slate-900 mb-[12px]">
              {isAdmin && deleteSafety?.canPermanentDelete ? "Delete product?" : "Deactivate product?"}
            </h3>

            <div className="text-[14px] text-slate-500 mb-[28px] leading-relaxed">
              <div className="mb-[16px] flex items-center gap-3 rounded-[14px] border border-[#E5E7EB] bg-white p-3 text-left">
                <PreviewableImage src={activeProduct?.imageUrl || ""} alt={activeProduct?.name || "Selected product"} title={activeProduct?.name || "Selected product"} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[11px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
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
              ) : isAdmin && deleteSafety && !deleteSafety.canPermanentDelete ? (
                <div className="mb-[16px] space-y-[8px] rounded-[12px] border border-[#FCA5A5] bg-[#FEF2F2] px-[16px] py-[12px] text-left">
                  <div className="text-[13px] font-extrabold text-[#DC2626]">Permanent deletion blocked</div>
                  {deleteSafety.stockBlocker ? <div className="text-[13px] font-semibold text-[#565449]">{deleteSafety.stockBlocker}</div> : null}
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
                  : "This action cannot be undone. The product will be set to inactive and remain in the catalog."}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-[12px]">
              <button onClick={() => setOpenConfirmDelete(false)} className="w-full sm:w-auto px-[24px] py-[10px] border border-slate-300 text-slate-700 rounded-[12px] text-[14px] font-bold hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              {isAdmin && deleteSafetyLoading ? (
                <button disabled className="w-full sm:w-auto px-[24px] py-[10px] bg-red-400 text-white rounded-[12px] text-[14px] font-bold transition-colors cursor-not-allowed">
                  Checking...
                </button>
              ) : isAdmin && deleteSafety?.canPermanentDelete ? (
                <button onClick={onConfirmPermanentDelete} disabled={deleteBusy} className="w-full sm:w-auto px-[24px] py-[10px] bg-red-600 text-white rounded-[12px] text-[14px] font-bold hover:bg-red-700 transition-colors">
                  {deleteBusy ? "Deleting..." : "Delete Forever"}
                </button>
              ) : (
                <button onClick={onConfirmDelete} disabled={deleteBusy} className={cn("w-full rounded-[12px] px-[24px] py-[10px] text-[14px] font-bold text-white transition-colors sm:w-auto", isAdmin && deleteSafety && !deleteSafety.canPermanentDelete ? "bg-[#11120d] hover:bg-[#2a2c27]" : "bg-red-600 hover:bg-red-700")}>
                  {deleteBusy ? "Deactivating..." : isAdmin && deleteSafety && !deleteSafety.canPermanentDelete ? "Deactivate instead" : "Deactivate"}
                </button>
              )}
            </div>
            {isAdmin && deleteSafety && !deleteSafety.canPermanentDelete && !deleteSafetyLoading ? (
              <button type="button" disabled className="mt-3 inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-[12px] bg-[#F3F4F6] text-[13px] font-bold text-[#A3A3A3]"><GoogleIcon name="delete_forever" className="text-[19px]" />Delete Forever</button>
            ) : null}
          </div>
        </div>
      )}

      {!!bulkAction && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-[20px]">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
            onClick={onCloseBulkAction}
          ></div>
          <div className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[26px] border border-slate-100 bg-white px-[20px] pb-[env(safe-area-inset-bottom)] pt-[20px] text-center shadow-2xl transition-all sm:max-w-[440px] sm:rounded-[24px] sm:p-[32px]">
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-[#CFCFD3] sm:hidden" />
            <div className="w-[56px] h-[56px] rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-[20px]">
              <Icon name="warning" className="text-[28px] text-amber-500" />
            </div>

            <h3 className="text-[20px] font-extrabold text-[#11120d] mb-[8px] leading-tight">
              {bulkAction?.title || "Confirm action"}
            </h3>

            <p className="text-[14px] text-[#565449] mb-[12px] leading-relaxed">
              {bulkAction?.message}
            </p>

            {bulkProducts.length > 0 ? (
              <div className="mb-[14px] overflow-hidden rounded-[14px] border border-[#E5E7EB] bg-white text-left">
                {bulkProducts.slice(0, 5).map((product) => (
                  <div key={product.id} className="flex min-h-[58px] items-center gap-3 border-b border-[#E5E7EB] px-3 py-2 last:border-0">
                    <PreviewableImage src={product.imageUrl} alt={product.name} title={product.name} enablePreview="desktop" imgClassName="h-full w-full object-contain p-1" className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-[#E5E7EB] bg-white" fallback={<GoogleIcon name="inventory_2" className="text-[#8C8889]" />} />
                    <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-extrabold text-[#11120d]">{product.name}</div><div className="mt-0.5 truncate font-mono text-[10px] text-[#8C8889]">SKU: {product.sku || "-"}</div></div>
                  </div>
                ))}
                {bulkProducts.length > 5 ? <div className="px-3 py-2 text-center text-[11px] font-bold text-[#565449]">+{bulkProducts.length - 5} more selected products</div> : null}
              </div>
            ) : null}

            <p className="text-[13px] text-[#8C8889] mb-[28px] leading-relaxed bg-slate-50 p-[12px] rounded-[12px]">
              This keeps invoice history and audit logs intact while removing
              these products from active selling flows.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-[12px]">
              <button onClick={onCloseBulkAction} className="w-full sm:w-auto px-[24px] py-[10px] bg-slate-100 text-[#565449] rounded-[12px] text-[14px] font-bold hover:bg-slate-200 transition-colors">
                Cancel
              </button>
              <button onClick={onConfirmBulkAction} className="w-full sm:w-auto px-[24px] py-[10px] bg-amber-500 text-white rounded-[12px] text-[14px] font-bold hover:bg-amber-600 transition-colors shadow-sm shadow-amber-500/20">
                {bulkAction?.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
