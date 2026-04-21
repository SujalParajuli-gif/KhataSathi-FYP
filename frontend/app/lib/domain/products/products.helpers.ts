import type { Product, StockFlag } from "./products.types";

// helper to join CSS class names — filters out false, null, and undefined values
export function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// formatting a number as Nepalese Rupees with 2 decimal places
export function formatNpr(n: number) {
  return `Rs ${n.toFixed(2)}`;
}

// determining the stock level flag based on current stock vs low stock threshold
// this is used to show the correct badge color on each product row
export function getStockFlag(p: Product): StockFlag {
  if (p.stock <= 0) return "Out of Stock";
  if (p.stock <= p.lowStockThreshold) return "Low Stock";
  return "In Stock";
}

