export type ProductLookupVisibility = {
  canViewPurchaseCost: boolean;
  canViewWholesalePrice: boolean;
};

export function resolveProductLookupVisibility(
  role: string,
  canViewWholesalePrice: boolean,
): ProductLookupVisibility {
  const normalizedRole = String(role || "").toUpperCase();
  return {
    canViewPurchaseCost: normalizedRole === "ADMIN",
    canViewWholesalePrice:
      normalizedRole === "ADMIN" || canViewWholesalePrice === true,
  };
}

export function redactProductForLookup<T extends Record<string, any>>(
  product: T,
  visibility: ProductLookupVisibility,
) {
  const visibleProduct = { ...product } as Record<string, any>;

  if (!visibility.canViewPurchaseCost) {
    delete visibleProduct.ratePerPiece;
  }

  if (!visibility.canViewWholesalePrice) {
    delete visibleProduct.wholesalePrice;
    delete visibleProduct.wholesaleEligible;
    delete visibleProduct.wholesaleQtyThreshold;
    delete visibleProduct.usesDefaultWholesaleQtyThreshold;
  }

  return visibleProduct as Omit<T, "ratePerPiece" | "wholesalePrice"> & {
    ratePerPiece?: T extends { ratePerPiece: infer V } ? V : never;
    wholesalePrice?: T extends { wholesalePrice: infer V } ? V : never;
  };
}

const INVENTORY_ONLY_PRODUCT_FIELDS = [
  "stock",
  "availableStock",
  "pendingDraftQty",
  "lowStockThreshold",
  "usesDefaultLowStockThreshold",
  "stockTransactions",
] as const;

export function redactInventoryFromProduct<T extends Record<string, any>>(
  product: T,
) {
  const catalogProduct = { ...product } as Record<string, any>;
  for (const field of INVENTORY_ONLY_PRODUCT_FIELDS) {
    delete catalogProduct[field];
  }
  return catalogProduct;
}
