export type ProductDeletePolicyInput = {
  referenceCount: number;
  stock: number;
  reservedStock: number;
};

export function evaluateProductDeletePolicy({
  referenceCount,
  stock,
  reservedStock,
}: ProductDeletePolicyInput) {
  const hasReferences = referenceCount > 0;
  const hasStock = stock !== 0;
  const hasReservedStock = reservedStock !== 0;

  return {
    canPermanentDelete: !hasReferences && !hasStock && !hasReservedStock,
    canDiscardStockAndDelete: !hasReferences && hasStock && !hasReservedStock,
  };
}
