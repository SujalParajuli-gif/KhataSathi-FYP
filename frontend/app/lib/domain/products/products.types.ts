// display-friendly product status labels
export type ProductStatus = "Active" | "Inactive";

// stock level flags — used for the stock badge on each product row
export type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

// whether a threshold uses the global default or a custom per-product value
export type ThresholdMode = "default" | "custom";

// the normalized product type used across the frontend
// we transform the backend response into this shape so every component works with consistent field names
export type Product = {
  id: string;
  name: string;
  productName?: string;
  sku: string;
  barcode?: string;
  imageUrl?: string;
  thumbnailUrl?: string;

  brand: string; // brand name (not the ID — we resolve it when saving)
  category: string;
  categoryGroup?: string;
  vendorSource?: string;
  productCodeVariant?: string;
  sizeValue?: number | null;
  sizeUnit: string;
  ratePerPiece: number | null;
  packageQuantity: number | null;
  packageUnit: string;
  saleUnit: string;
  allowFractionalQty: boolean;
  quantityStep: number;
  wholesaleEligible: boolean;
  sourceCitation?: string;

  sellingPriceStatus: "PENDING" | "READY";
  availabilityStatus: "CATALOG_LISTED" | "COMING_SOON";
  retailPrice: number | null;
  wholesalePrice: number | null;
  thresholdQty: number; // qty wholesale threshold: above this qty, wholesale pricing kicks in
  thresholdQtyMode: ThresholdMode;

  stock: number;
  draftRequestedQty?: number;
  effectiveAvailableStock?: number;
  lowStockThreshold: number; // when stock falls to or below this number, we show a low stock alert
  lowStockThresholdMode: ThresholdMode;

  status: ProductStatus;
};

/**
 * Short-lived in-memory state used when Product Lookup hands an Admin to the
 * shared Products editor. A short-lived in-memory handoff avoids refetching the
 * selected product and prevents the lookup list from flashing empty on return.
 */
export type ProductLookupSnapshot = {
  products: Product[];
  mobileProducts: Product[];
  brands: string[];
  categories: string[];
  total: number;
  mobileLoadedPage: number;
  activeSearchLogId: string | null;
  canViewPurchaseCost: boolean;
  canViewWholesalePrice: boolean;
};

export type ProductLookupEditHandoff = {
  product: Product;
  snapshot: ProductLookupSnapshot;
};

// toast notification types used by the products page
export type ToastKind = "info" | "success" | "danger";

// the query parameters for fetching products with filters
export type ProductsQuery = {
  q?: string; // search term
  brand?: string; // filter by brand name
  category?: string;
  stockStatus?: "all" | "in" | "low" | "out"; // client-side stock level filter
  status?: "all" | "active" | "inactive"; // active/inactive filter
  lowOnly?: boolean;
  includeDraftReservations?: boolean;
  page?: number;
  pageSize?: number;
};
