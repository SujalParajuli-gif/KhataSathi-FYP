import type { BillScanObservations } from "./api/manualBills";

export type ComparisonItem = { productId: string; name: string; sku?: string | null; qty: number; appliedUnitPrice: number; saleUnit?: string | null };
export function observationNumber(value: string | null): number | null {
  if (value === null || !/^\s*\d+(?:,\d{3})*(?:\.\d+)?\s*$/.test(value)) return null;
  const number = Number(value.replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}
const identity = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const unit = (value: string) => { const key = identity(value); return ["pc", "pcs", "piece", "pieces"].includes(key) ? "piece" : key; };
export function compareBillLines(observations: BillScanObservations, cart: ComparisonItem[]) {
  return observations.lines.map(line => {
    const candidates = cart.filter(item => (line.code && item.sku && identity(line.code) === identity(item.sku)) || identity(line.name) === identity(item.name));
    const item = candidates.length === 1 ? candidates[0] : null;
    const quantity = observationNumber(line.quantity); const rate = observationNumber(line.unitPrice);
    const mismatch = item && ((quantity !== null && quantity !== item.qty) || (rate !== null && rate !== item.appliedUnitPrice) || (line.unit && item.saleUnit && unit(line.unit) !== unit(item.saleUnit)));
    const status = !item ? "UNMATCHED" : mismatch ? "DIFFER" : quantity === null || rate === null || !line.unit || !item.saleUnit ? "UNREADABLE" : "MATCH";
    return { line, item, quantity, rate, status };
  });
}
