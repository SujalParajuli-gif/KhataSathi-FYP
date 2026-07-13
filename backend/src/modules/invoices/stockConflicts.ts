export const STOCK_CONFLICT_CODE = "STOCK_CONFLICT";

export type StockConflictReason =
  | "NOT_FOUND"
  | "INACTIVE"
  | "OUT_OF_STOCK"
  | "INSUFFICIENT_STOCK";

export type StockConflict = {
  productId: string;
  productName: string;
  sku?: string | null;
  barcode?: string | null;
  requestedQty: number;
  availableStock: number;
  reason: StockConflictReason;
};

export function buildInsufficientStockMessage(
  productName: string,
  availableStock: number,
  requestedQty: number,
) {
  return `Insufficient stock for "${productName}". Available: ${availableStock}, Requested: ${requestedQty}`;
}

export function buildStockConflict(input: {
  productId: string;
  productName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  requestedQty: number;
  availableStock?: number | null;
  reason: StockConflictReason;
}): StockConflict {
  return {
    productId: input.productId,
    productName: input.productName || "Unknown product",
    sku: input.sku || null,
    barcode: input.barcode || null,
    requestedQty: Math.max(0, Math.floor(Number(input.requestedQty) || 0)),
    availableStock: Math.max(
      0,
      Math.floor(Number(input.availableStock || 0)),
    ),
    reason: input.reason,
  };
}

export class StockConflictError extends Error {
  code = STOCK_CONFLICT_CODE;
  conflicts: StockConflict[];

  constructor(conflicts: StockConflict[]) {
    const first = conflicts[0];
    super(
      first
        ? buildInsufficientStockMessage(
            first.productName,
            first.availableStock,
            first.requestedQty,
          )
        : "Some cart items no longer have enough stock.",
    );
    this.name = "StockConflictError";
    this.conflicts = conflicts;
  }
}
