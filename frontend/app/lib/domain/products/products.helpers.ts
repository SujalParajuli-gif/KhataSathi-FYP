// frontend/app/lib/domain/products/products.helpers.ts
import type { Product, StockFlag } from "./products.types";

export function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export function formatNpr(n: number) {
  return `Rs ${n.toFixed(2)}`;
}

export function getStockFlag(p: Product): StockFlag {
  if (p.stock <= 0) return "Out of Stock";
  if (p.stock <= p.lowStockThreshold) return "Low Stock";
  return "In Stock";
}
