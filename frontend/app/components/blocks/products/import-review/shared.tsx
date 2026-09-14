import { cloneElement, isValidElement } from "react";
import type { ProductImportRow } from "~/lib/api/endpoints";
import { parsedImportRow } from "~/features/product-imports/reviewModel";

export type MobilePanel = "list" | "editor" | "source";

export type ReviewFilter = "ALL" | "EDITED" | "ATTENTION" | NonNullable<ProductImportRow["comparisonStatus"]>;

export const COMPARISON_FILTERS: Array<{
  value: NonNullable<ProductImportRow["comparisonStatus"]>;
  label: string;
}> = [
    { value: "READY_NEW", label: "New" },
    { value: "MATCHED_WITH_CHANGES", label: "Catalog updates" },
    { value: "EXACT_DUPLICATE", label: "Exact matches" },
    { value: "IDENTIFIER_CONFLICT", label: "Conflicts" },
    { value: "IN_FILE_DUPLICATE", label: "File duplicates" },
    { value: "FAILED", label: "Failed" },
    { value: "NEEDS_REVIEW", label: "Needs attention" },
  ];

export function reviewFilterParams(filter: ReviewFilter) {
  if (filter === "EDITED" || filter === "ATTENTION") return { reviewState: filter } as const;
  if (filter === "ALL") return {};
  return { comparisonStatus: filter };
}

export function rowName(row: ProductImportRow) {
  const parsed = parsedImportRow(row);
  return String(parsed.name || parsed.productName || row.rawText || `Row ${row.rowNumber}`);
}

export function rowSku(row: ProductImportRow) {
  return String(parsedImportRow(row).sku || "No SKU");
}

export function statusTone(status?: ProductImportRow["comparisonStatus"]) {
  if (status === "READY_NEW") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "MATCHED_WITH_CHANGES" || status === "NEEDS_REVIEW") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status === "FAILED" || status === "IDENTIFIER_CONFLICT") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (status === "IN_FILE_DUPLICATE") return "border-violet-200 bg-violet-50 text-violet-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function cellsFromRow(row: Pick<ProductImportRow, "rawText" | "sourceLocator">) {
  const located = row.sourceLocator?.cells;
  if (located && typeof located === "object") return located;
  try {
    const parsed = JSON.parse(row.rawText || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function numberInput(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function Field({ label, children, field, issue }: { label: string; children: React.ReactNode; field?: string; issue?: { message: string; severity: "error" | "warning" } }) {
  const issueId = field ? `review-issue-${field}` : undefined;
  return (
    <label id={field ? `review-field-${field}` : undefined} className={`grid min-w-0 gap-1 text-[11px] font-extrabold text-[#4B5563] xl:text-[10px] ${issue ? issue.severity === "error" ? "[&_input]:border-rose-400 [&_input]:bg-rose-50/40" : "[&_input]:border-amber-400 [&_input]:bg-amber-50/40" : ""}`}>
      <span>{label}</span>
      {isValidElement(children) && typeof children.type === "string" ? cloneElement(children as React.ReactElement<any>, {
        "aria-label": label, "aria-invalid": issue?.severity === "error" || undefined, "aria-describedby": issue ? issueId : undefined,
      }) : children}
      {issue ? <span id={issueId} className={`text-[10px] font-semibold leading-4 ${issue.severity === "error" ? "text-rose-800" : "text-amber-800"}`}>{issue.message}</span> : null}
    </label>
  );
}

export const inputClass = "h-9 min-w-0 rounded-[9px] border border-[#D4D7DC] bg-white px-2.5 text-[11px] font-semibold text-[#11120d] outline-none transition focus:border-[#11120d] focus:ring-2 focus:ring-[#11120d]/15";
