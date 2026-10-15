export type PaperReview =
  | { kind: "REFERENCE"; billNo: string; billDate: string; documentType: "PAN_INVOICE" | "VAT_TAX_INVOICE" | "ABBREVIATED_TAX_INVOICE" | "OTHER_MANUAL_SALES_DOCUMENT" }
  | { kind: "EXCEPTION"; reason: string };

export function validPaperDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function paperReviewIssue(review: PaperReview): string | null {
  if (review.kind === "EXCEPTION") return review.reason.trim() ? null : "Enter a reason for the paper-reference exception.";
  if (!review.billNo.trim()) return "Enter the physical bill number or select a paper-reference exception.";
  if (!validPaperDate(review.billDate)) return "Enter a valid physical bill date.";
  return null;
}
export function shopToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function latestComparablePurchase<T extends { appliedUnitPrice: number; invoiceDate?: string | null; saleUnit?: string | null }>(history: T[], saleUnit?: string | null): T | undefined {
  return history.filter(h => !h.saleUnit || !saleUnit || h.saleUnit === saleUnit).sort((a, b) => Date.parse(b.invoiceDate || "1970-01-01") - Date.parse(a.invoiceDate || "1970-01-01"))[0];
}

export function formatBillingMoney(value: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  return `रु ${value.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
export const PAPER_EXCEPTION_REASONS = ["Reference not yet entered — busy counter", "Bill book unavailable", "Paper reference unreadable"] as const;

// Matches the invoice API notes contract; shared by Worksheet and payment review.
export const BILLING_NOTE_MAX_LENGTH = 1000;
