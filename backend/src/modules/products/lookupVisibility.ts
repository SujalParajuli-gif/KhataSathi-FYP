export type ProductLookupVisibility = {
  canViewPurchaseCost: boolean;
  canViewWholesalePrice: boolean;
  canViewCatalogRate?: boolean;
};

export function resolveProductLookupVisibility(
  role: string,
  canViewWholesalePrice: boolean,
  options?: { allowCatalogRate?: boolean },
): ProductLookupVisibility {
  const normalizedRole = String(role || "").toUpperCase();
  const isAdmin = normalizedRole === "ADMIN";
  const isManager = normalizedRole === "MANAGER";
  const canViewCatalogRate =
    isAdmin || (options?.allowCatalogRate === true && isManager);

  return {
    canViewPurchaseCost: isAdmin,
    canViewWholesalePrice:
      isAdmin || canViewWholesalePrice === true,
    canViewCatalogRate,
  };
}

export function redactProductForLookup<T extends Record<string, any>>(
  product: T,
  visibility: ProductLookupVisibility,
) {
  const visibleProduct = { ...product } as Record<string, any>;

  const allowsCatalogRate =
    visibility.canViewCatalogRate !== undefined
      ? visibility.canViewCatalogRate
      : visibility.canViewPurchaseCost;

  if (!allowsCatalogRate) {
    delete visibleProduct.ratePerPiece;
    delete visibleProduct.rateUpdatedAt;
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

export function sanitizeProductForResponse<T extends Record<string, any>>(
  product: T,
  visibility: ProductLookupVisibility,
  stockTracked: boolean,
) {
  if (!product) return product;
  const visible = redactProductForLookup(product, visibility);
  return stockTracked ? visible : redactInventoryFromProduct(visible);
}
