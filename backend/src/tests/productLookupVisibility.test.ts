import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  redactInventoryFromProduct,
  redactProductForLookup,
  resolveProductLookupVisibility,
  sanitizeProductForResponse,
} from "../modules/products/lookupVisibility";
import {
  getByCode,
  getMany,
  getManyForCatalog,
  getOne,
  getRequestProductVisibility,
  list,
  listForPriceLookup,
  update,
} from "../modules/products/controller";
import productRouter from "../modules/products/routes";
import { requireRole } from "../middleware/rbac";
import * as productService from "../modules/products/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";

function createMockRes() {
  let statusCode = 200;
  let body: any = null;
  const headers: Record<string, string> = {};
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    set(key: string, value: string) {
      headers[key] = value;
      return res;
    },
    setHeader(key: string, value: string) {
      headers[key] = value;
      return res;
    },
    send() {
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
  return res;
}

const sampleProduct = {
  id: "prod-1",
  name: "Paint Bucket 20L",
  sku: "PAINT-001",
  barcode: "8901234567890",
  retailPrice: 500,
  wholesalePrice: 420,
  ratePerPiece: 350,
  rateUpdatedAt: new Date("2026-09-01T10:00:00Z"),
  wholesaleEligible: true,
  wholesaleQtyThreshold: 10,
  usesDefaultWholesaleQtyThreshold: false,
  stock: 25,
  availableStock: 25,
  pendingDraftQty: 0,
  lowStockThreshold: 5,
  usesDefaultLowStockThreshold: true,
  allowFractionalQty: false,
  quantityStep: 1,
  saleUnit: "PIECE",
  packageQuantity: 1,
  packageUnit: "PIECE",
  imageUrl: "/uploads/paint.webp",
  thumbnailUrl: "/uploads/paint-thumb.webp",
  isActive: true,
};

function installProductControllerMocks() {
  const originalListProducts = productService.listProducts;
  const originalGetProduct = productService.getProduct;
  const originalGetProductsByIds = productService.getProductsByIds;
  const originalGetProductByCode = productService.getProductByCode;
  const originalUpdateProduct = productService.updateProduct;
  const originalUpsert = prisma.businessSettings.upsert;
  const originalUserFindUnique = prisma.user.findUnique;
  const originalSearchLog = (prisma as any).productSearchQueryLog;

  invalidateBusinessSettingsCache();
  (prisma.businessSettings as any).upsert = async () => ({
    id: 1,
    businessMode: "FULL_POS",
    staffDraftRequestsEnabled: true,
    defaultInitialStock: 30,
    defaultLowStockThreshold: 5,
    defaultWholesaleQtyThreshold: 15,
  });

  (productService as any).listProducts = async () => ({
    products: [{ ...sampleProduct }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  (productService as any).getProduct = async () => ({ ...sampleProduct });
  (productService as any).getProductsByIds = async () => [{ ...sampleProduct }];
  (productService as any).getProductByCode = async () => ({ ...sampleProduct });
  (productService as any).updateProduct = async (id: string, data: any) => ({
    ...sampleProduct,
    id,
    ...data,
    ratePerPiece:
      data.ratePerPiece !== undefined
        ? data.ratePerPiece
        : sampleProduct.ratePerPiece,
    rateUpdatedAt: sampleProduct.rateUpdatedAt,
  });
  (prisma as any).productSearchQueryLog = {
    create: async () => ({ id: "log-1" }),
  };

  return () => {
    (productService as any).listProducts = originalListProducts;
    (productService as any).getProduct = originalGetProduct;
    (productService as any).getProductsByIds = originalGetProductsByIds;
    (productService as any).getProductByCode = originalGetProductByCode;
    (productService as any).updateProduct = originalUpdateProduct;
    prisma.businessSettings.upsert = originalUpsert;
    prisma.user.findUnique = originalUserFindUnique;
    (prisma as any).productSearchQueryLog = originalSearchLog;
    invalidateBusinessSettingsCache();
  };
}

test("catalog redaction removes inventory facts while preserving catalog identity and sale unit", () => {
  const product = redactInventoryFromProduct({
    id: "product-1",
    name: "Bucket",
    imageUrl: "/uploads/products/bucket.webp",
    thumbnailUrl: "/uploads/products/bucket-thumb.webp",
    saleUnit: "PIECE",
    stock: 30,
    availableStock: 28,
    pendingDraftQty: 2,
    lowStockThreshold: 5,
    usesDefaultLowStockThreshold: true,
  });

  assert.equal(product.saleUnit, "PIECE");
  assert.equal(product.imageUrl, "/uploads/products/bucket.webp");
  assert.equal(product.thumbnailUrl, "/uploads/products/bucket-thumb.webp");
  assert.equal("stock" in product, false);
  assert.equal("availableStock" in product, false);
  assert.equal("pendingDraftQty" in product, false);
  assert.equal("lowStockThreshold" in product, false);
});

test("admin always receives purchase cost, catalog rate, and wholesale prices", () => {
  assert.deepEqual(resolveProductLookupVisibility("ADMIN", false), {
    canViewPurchaseCost: true,
    canViewWholesalePrice: true,
    canViewCatalogRate: true,
  });
});

test("VIEW WHOLESALE controls wholesale visibility and catalog rate is role/context scoped", () => {
  // Wholesale privilege for non-admin roles
  for (const role of ["MANAGER", "CASHIER", "STAFF"]) {
    assert.equal(
      resolveProductLookupVisibility(role, false).canViewWholesalePrice,
      false,
    );
    assert.equal(
      resolveProductLookupVisibility(role, true).canViewWholesalePrice,
      true,
    );
    assert.equal(
      resolveProductLookupVisibility(role, true).canViewPurchaseCost,
      false,
    );
  }

  // Catalog rate is allowed for MANAGER only when allowCatalogRate is true
  assert.equal(
    resolveProductLookupVisibility("MANAGER", false, { allowCatalogRate: true })
      .canViewCatalogRate,
    true,
  );
  assert.equal(
    resolveProductLookupVisibility("MANAGER", false, { allowCatalogRate: false })
      .canViewCatalogRate,
    false,
  );
  assert.equal(
    resolveProductLookupVisibility("MANAGER", false).canViewCatalogRate,
    false,
  );

  // CASHIER and STAFF never receive catalog rate even if allowCatalogRate is requested
  for (const role of ["CASHIER", "STAFF"]) {
    assert.equal(
      resolveProductLookupVisibility(role, true, { allowCatalogRate: true })
        .canViewCatalogRate,
      false,
    );
    assert.equal(
      resolveProductLookupVisibility(role, false, { allowCatalogRate: true })
        .canViewCatalogRate,
      false,
    );
  }
});

test("lookup redaction removes protected prices instead of merely hiding them", () => {
  const product = {
    id: "product-1",
    retailPrice: 150,
    wholesalePrice: 125,
    ratePerPiece: 100,
    rateUpdatedAt: new Date("2026-09-01T10:00:00Z"),
    wholesaleEligible: true,
    wholesaleQtyThreshold: 12,
    usesDefaultWholesaleQtyThreshold: false,
  };

  const retailOnly = redactProductForLookup(product, {
    canViewPurchaseCost: false,
    canViewWholesalePrice: false,
    canViewCatalogRate: false,
  });
  assert.equal(retailOnly.retailPrice, 150);
  assert.equal("ratePerPiece" in retailOnly, false);
  assert.equal("rateUpdatedAt" in retailOnly, false);
  assert.equal("wholesalePrice" in retailOnly, false);
  assert.equal("wholesaleQtyThreshold" in retailOnly, false);

  const wholesaleViewer = redactProductForLookup(product, {
    canViewPurchaseCost: false,
    canViewWholesalePrice: true,
    canViewCatalogRate: false,
  });
  assert.equal(wholesaleViewer.wholesalePrice, 125);
  assert.equal("ratePerPiece" in wholesaleViewer, false);
  assert.equal("rateUpdatedAt" in wholesaleViewer, false);

  const managerCatalog = redactProductForLookup(product, {
    canViewPurchaseCost: false,
    canViewWholesalePrice: true,
    canViewCatalogRate: true,
  });
  assert.equal(managerCatalog.wholesalePrice, 125);
  assert.equal(managerCatalog.ratePerPiece, 100);
  assert.ok(managerCatalog.rateUpdatedAt);
});

test("sanitizeProductForResponse removes rate and respects wholesale, catalog rate, and inventory settings", () => {
  // Non-admin without wholesale privilege or catalog rate
  const cashierHiddenWholesale = sanitizeProductForResponse(
    { ...sampleProduct },
    { canViewPurchaseCost: false, canViewWholesalePrice: false, canViewCatalogRate: false },
    true,
  );
  assert.equal(cashierHiddenWholesale.retailPrice, 500);
  assert.equal(cashierHiddenWholesale.stock, 25);
  assert.equal(cashierHiddenWholesale.sku, "PAINT-001");
  assert.equal(cashierHiddenWholesale.allowFractionalQty, false);
  assert.equal("ratePerPiece" in cashierHiddenWholesale, false);
  assert.equal("rateUpdatedAt" in cashierHiddenWholesale, false);
  assert.equal("wholesalePrice" in cashierHiddenWholesale, false);
  assert.equal("wholesaleQtyThreshold" in cashierHiddenWholesale, false);

  // Non-admin with wholesale privilege but no catalog rate
  const cashierAllowedWholesale = sanitizeProductForResponse(
    { ...sampleProduct },
    { canViewPurchaseCost: false, canViewWholesalePrice: true, canViewCatalogRate: false },
    true,
  );
  assert.equal(cashierAllowedWholesale.retailPrice, 500);
  assert.equal(cashierAllowedWholesale.wholesalePrice, 420);
  assert.equal(cashierAllowedWholesale.wholesaleQtyThreshold, 10);
  assert.equal("ratePerPiece" in cashierAllowedWholesale, false);
  assert.equal("rateUpdatedAt" in cashierAllowedWholesale, false);

  // Manager on catalog management (catalog rate allowed)
  const managerCatalogResult = sanitizeProductForResponse(
    { ...sampleProduct },
    { canViewPurchaseCost: false, canViewWholesalePrice: true, canViewCatalogRate: true },
    true,
  );
  assert.equal(managerCatalogResult.ratePerPiece, 350);
  assert.ok(managerCatalogResult.rateUpdatedAt);
  assert.equal(managerCatalogResult.wholesalePrice, 420);

  // Admin
  const adminResult = sanitizeProductForResponse(
    { ...sampleProduct },
    { canViewPurchaseCost: true, canViewWholesalePrice: true, canViewCatalogRate: true },
    true,
  );
  assert.equal(adminResult.ratePerPiece, 350);
  assert.equal(adminResult.wholesalePrice, 420);
  assert.ok(adminResult.rateUpdatedAt);

  // Stock untracked (CATALOG_ONLY)
  const untracked = sanitizeProductForResponse(
    { ...sampleProduct },
    { canViewPurchaseCost: false, canViewWholesalePrice: false, canViewCatalogRate: false },
    false,
  );
  assert.equal("ratePerPiece" in untracked, false);
  assert.equal("stock" in untracked, false);
  assert.equal("availableStock" in untracked, false);
  assert.equal("lowStockThreshold" in untracked, false);
});

test("getRequestProductVisibility resolves admin without DB and respects cashier privileges for other roles", async () => {
  // Admin role: returns full access without querying user privilege
  const adminReq: any = { user: { id: "admin-1", role: "ADMIN" } };
  const adminVis = await getRequestProductVisibility(adminReq);
  assert.deepEqual(adminVis, {
    canViewPurchaseCost: true,
    canViewWholesalePrice: true,
    canViewCatalogRate: true,
  });

  // Manager role: defaults to wholesale true, cost false, catalog rate false without allowCatalogRate
  const restoreMocks = installProductControllerMocks();
  try {
    (prisma.user as any).findUnique = async () => ({
      role: "MANAGER",
      cashierPrivilege: null,
    });
    const managerReq: any = { user: { id: "mgr-1", role: "MANAGER" } };
    const mgrVisDefault = await getRequestProductVisibility(managerReq);
    assert.deepEqual(mgrVisDefault, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: true,
      canViewCatalogRate: false,
    });

    // Manager role on catalog context (allowCatalogRate: true)
    const mgrVisCatalog = await getRequestProductVisibility(managerReq, {
      allowCatalogRate: true,
    });
    assert.deepEqual(mgrVisCatalog, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: true,
      canViewCatalogRate: true,
    });

    // Cashier role with revoked wholesale privilege
    (prisma.user as any).findUnique = async () => ({
      role: "CASHIER",
      cashierPrivilege: { canViewWholesalePrice: false },
    });
    const cashierNoWholesaleReq: any = { user: { id: "c-1", role: "CASHIER" } };
    const c1Vis = await getRequestProductVisibility(cashierNoWholesaleReq);
    assert.deepEqual(c1Vis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: false,
      canViewCatalogRate: false,
    });

    // Cashier role even if allowCatalogRate: true requested
    const c1CatalogVis = await getRequestProductVisibility(cashierNoWholesaleReq, {
      allowCatalogRate: true,
    });
    assert.deepEqual(c1CatalogVis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: false,
      canViewCatalogRate: false,
    });

    // Cashier role with allowed wholesale privilege
    (prisma.user as any).findUnique = async () => ({
      role: "CASHIER",
      cashierPrivilege: { canViewWholesalePrice: true },
    });
    const cashierWholesaleReq: any = { user: { id: "c-2", role: "CASHIER" } };
    const c2Vis = await getRequestProductVisibility(cashierWholesaleReq);
    assert.deepEqual(c2Vis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: true,
      canViewCatalogRate: false,
    });

    // Staff role
    (prisma.user as any).findUnique = async () => ({
      role: "STAFF",
      cashierPrivilege: null,
    });
    const staffReq: any = { user: { id: "s-1", role: "STAFF" } };
    const staffVis = await getRequestProductVisibility(staffReq);
    assert.deepEqual(staffVis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: true,
      canViewCatalogRate: false,
    });

    // Staff role even if allowCatalogRate: true requested
    const staffCatalogVis = await getRequestProductVisibility(staffReq, {
      allowCatalogRate: true,
    });
    assert.deepEqual(staffCatalogVis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: true,
      canViewCatalogRate: false,
    });

    // Missing/unauthenticated user fallback
    const emptyReq: any = {};
    const emptyVis = await getRequestProductVisibility(emptyReq);
    assert.deepEqual(emptyVis, {
      canViewPurchaseCost: false,
      canViewWholesalePrice: false,
      canViewCatalogRate: false,
    });
  } finally {
    restoreMocks();
  }
});

test("controller endpoints enforce role-aware catalog rate visibility and lookup redaction", async () => {
  const restoreMocks = installProductControllerMocks();
  try {
    const adminReq: any = {
      user: { id: "admin-1", role: "ADMIN" },
      query: { ids: "prod-1", code: "PAINT-001" },
      params: { id: "prod-1" },
      header: () => undefined,
    };
    const managerReq: any = {
      user: { id: "mgr-1", role: "MANAGER" },
      query: { ids: "prod-1", code: "PAINT-001" },
      params: { id: "prod-1" },
      header: () => undefined,
    };
    const cashierReq: any = {
      user: { id: "cashier-1", role: "CASHIER" },
      query: { ids: "prod-1", code: "PAINT-001" },
      params: { id: "prod-1" },
      header: () => undefined,
    };
    const staffReq: any = {
      user: { id: "staff-1", role: "STAFF" },
      query: { ids: "prod-1", code: "PAINT-001" },
      params: { id: "prod-1" },
      header: () => undefined,
    };

    (prisma.user as any).findUnique = async ({ where }: any) => {
      if (where.id === "mgr-1") return { role: "MANAGER", cashierPrivilege: null };
      if (where.id === "cashier-1") return { role: "CASHIER", cashierPrivilege: { canViewWholesalePrice: true } };
      if (where.id === "staff-1") return { role: "STAFF", cashierPrivilege: null };
      return null;
    };

    // 1. GET /products (list) - Catalog Management Read
    // Admin receives rate
    const listAdminRes = createMockRes();
    await list(adminReq, listAdminRes);
    assert.equal(listAdminRes.statusCode, 200);
    assert.equal(listAdminRes.body.products[0].ratePerPiece, 350);
    assert.ok(listAdminRes.body.products[0].rateUpdatedAt);

    // Manager receives rate on catalog list
    const listManagerRes = createMockRes();
    await list(managerReq, listManagerRes);
    assert.equal(listManagerRes.statusCode, 200);
    assert.equal(listManagerRes.body.products[0].ratePerPiece, 350);
    assert.ok(listManagerRes.body.products[0].rateUpdatedAt);

    // Cashier denied rate on catalog list
    const listCashierRes = createMockRes();
    await list(cashierReq, listCashierRes);
    assert.equal(listCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in listCashierRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in listCashierRes.body.products[0], false);

    // Staff denied rate on catalog list
    const listStaffRes = createMockRes();
    await list(staffReq, listStaffRes);
    assert.equal(listStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in listStaffRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in listStaffRes.body.products[0], false);

    // 2. GET /products/:id (getOne) - Catalog Management Read
    // Admin receives rate
    const getOneAdminRes = createMockRes();
    await getOne(adminReq, getOneAdminRes);
    assert.equal(getOneAdminRes.statusCode, 200);
    assert.equal(getOneAdminRes.body.ratePerPiece, 350);
    assert.ok(getOneAdminRes.body.rateUpdatedAt);

    // Manager receives rate on catalog getOne
    const getOneManagerRes = createMockRes();
    await getOne(managerReq, getOneManagerRes);
    assert.equal(getOneManagerRes.statusCode, 200);
    assert.equal(getOneManagerRes.body.ratePerPiece, 350);
    assert.ok(getOneManagerRes.body.rateUpdatedAt);

    // Cashier denied rate on catalog getOne
    const getOneCashierRes = createMockRes();
    await getOne(cashierReq, getOneCashierRes);
    assert.equal(getOneCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in getOneCashierRes.body, false);
    assert.equal("rateUpdatedAt" in getOneCashierRes.body, false);

    // Staff denied rate on catalog getOne
    const getOneStaffRes = createMockRes();
    await getOne(staffReq, getOneStaffRes);
    assert.equal(getOneStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in getOneStaffRes.body, false);
    assert.equal("rateUpdatedAt" in getOneStaffRes.body, false);

    // 3. GET /products/lookup (getMany) - Shared Cart Refresh Read (non-admin redacted)
    // Admin receives rate
    const getManyAdminRes = createMockRes();
    await getMany(adminReq, getManyAdminRes);
    assert.equal(getManyAdminRes.statusCode, 200);
    assert.equal(getManyAdminRes.body.products[0].ratePerPiece, 350);
    assert.ok(getManyAdminRes.body.products[0].rateUpdatedAt);

    // Manager denied rate on lookup
    const getManyManagerRes = createMockRes();
    await getMany(managerReq, getManyManagerRes);
    assert.equal(getManyManagerRes.statusCode, 200);
    assert.equal("ratePerPiece" in getManyManagerRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in getManyManagerRes.body.products[0], false);

    // Cashier denied rate on lookup
    const getManyCashierRes = createMockRes();
    await getMany(cashierReq, getManyCashierRes);
    assert.equal(getManyCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in getManyCashierRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in getManyCashierRes.body.products[0], false);

    // Staff denied rate on lookup
    const getManyStaffRes = createMockRes();
    await getMany(staffReq, getManyStaffRes);
    assert.equal(getManyStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in getManyStaffRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in getManyStaffRes.body.products[0], false);

    // 4. GET /products/lookup-code (getByCode) - Shared Scanner Read (non-admin redacted)
    // Admin receives rate
    const getByCodeAdminRes = createMockRes();
    await getByCode(adminReq, getByCodeAdminRes);
    assert.equal(getByCodeAdminRes.statusCode, 200);
    assert.equal(getByCodeAdminRes.body.ratePerPiece, 350);
    assert.ok(getByCodeAdminRes.body.rateUpdatedAt);

    // Manager denied rate on lookup-code
    const getByCodeManagerRes = createMockRes();
    await getByCode(managerReq, getByCodeManagerRes);
    assert.equal(getByCodeManagerRes.statusCode, 200);
    assert.equal("ratePerPiece" in getByCodeManagerRes.body, false);
    assert.equal("rateUpdatedAt" in getByCodeManagerRes.body, false);

    // Cashier denied rate on lookup-code
    const getByCodeCashierRes = createMockRes();
    await getByCode(cashierReq, getByCodeCashierRes);
    assert.equal(getByCodeCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in getByCodeCashierRes.body, false);
    assert.equal("rateUpdatedAt" in getByCodeCashierRes.body, false);

    // Staff denied rate on lookup-code
    const getByCodeStaffRes = createMockRes();
    await getByCode(staffReq, getByCodeStaffRes);
    assert.equal(getByCodeStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in getByCodeStaffRes.body, false);
    assert.equal("rateUpdatedAt" in getByCodeStaffRes.body, false);

    // 5. GET /products/price-lookup (listForPriceLookup) - Price Lookup (non-admin redacted)
    // Admin receives rate
    const priceLookupAdminRes = createMockRes();
    await listForPriceLookup(adminReq, priceLookupAdminRes);
    assert.equal(priceLookupAdminRes.statusCode, 200);
    assert.equal(priceLookupAdminRes.body.products[0].ratePerPiece, 350);
    assert.ok(priceLookupAdminRes.body.products[0].rateUpdatedAt);

    // Manager denied rate on price-lookup
    const priceLookupManagerRes = createMockRes();
    await listForPriceLookup(managerReq, priceLookupManagerRes);
    assert.equal(priceLookupManagerRes.statusCode, 200);
    assert.equal("ratePerPiece" in priceLookupManagerRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in priceLookupManagerRes.body.products[0], false);

    // Cashier denied rate on price-lookup
    const priceLookupCashierRes = createMockRes();
    await listForPriceLookup(cashierReq, priceLookupCashierRes);
    assert.equal(priceLookupCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in priceLookupCashierRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in priceLookupCashierRes.body.products[0], false);

    // Staff denied rate on price-lookup
    const priceLookupStaffRes = createMockRes();
    await listForPriceLookup(staffReq, priceLookupStaffRes);
    assert.equal(priceLookupStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in priceLookupStaffRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in priceLookupStaffRes.body.products[0], false);
  } finally {
    restoreMocks();
  }
});

test("manager edit preserves unchanged ratePerPiece and rateUpdatedAt", async () => {
  const restoreMocks = installProductControllerMocks();
  try {
    const managerReq: any = {
      user: { id: "mgr-1", role: "MANAGER" },
      params: { id: "prod-1" },
      body: {
        retailPrice: 550,
      },
      header: () => undefined,
    };
    const res = createMockRes();
    await update(managerReq, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.retailPrice, 550);
    assert.equal(res.body.ratePerPiece, 350);
    assert.equal(
      res.body.rateUpdatedAt.getTime(),
      sampleProduct.rateUpdatedAt.getTime(),
    );
  } finally {
    restoreMocks();
  }
});

test("route ordering places /catalog-lookup before /:id and enforces role authorization", () => {
  // Check express route stack ordering
  const routes = productRouter.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
    }));

  const catalogLookupIndex = routes.findIndex((r: any) => r.path === "/catalog-lookup");
  const paramIdIndex = routes.findIndex((r: any) => r.path === "/:id");

  assert.notEqual(catalogLookupIndex, -1, "/catalog-lookup route must be registered");
  assert.notEqual(paramIdIndex, -1, "/:id route must be registered");
  assert.ok(
    catalogLookupIndex < paramIdIndex,
    `route /catalog-lookup (index ${catalogLookupIndex}) must precede /:id (index ${paramIdIndex})`,
  );

  // Check RBAC middleware: requireRole("ADMIN", "MANAGER")
  const catalogGuard = requireRole("ADMIN", "MANAGER");

  // Admin caller passes
  let adminNext = false;
  const adminRes = createMockRes();
  catalogGuard({ user: { id: "a-1", role: "ADMIN" } } as any, adminRes, (() => {
    adminNext = true;
  }) as any);
  assert.equal(adminNext, true);

  // Manager caller passes
  let mgrNext = false;
  const mgrRes = createMockRes();
  catalogGuard({ user: { id: "m-1", role: "MANAGER" } } as any, mgrRes, (() => {
    mgrNext = true;
  }) as any);
  assert.equal(mgrNext, true);

  // Cashier caller is rejected with 403
  let cashierNext = false;
  const cashierRes = createMockRes();
  catalogGuard({ user: { id: "c-1", role: "CASHIER" } } as any, cashierRes, (() => {
    cashierNext = true;
  }) as any);
  assert.equal(cashierNext, false);
  assert.equal(cashierRes.statusCode, 403);

  // Staff caller is rejected with 403
  let staffNext = false;
  const staffRes = createMockRes();
  catalogGuard({ user: { id: "s-1", role: "STAFF" } } as any, staffRes, (() => {
    staffNext = true;
  }) as any);
  assert.equal(staffNext, false);
  assert.equal(staffRes.statusCode, 403);
});

test("catalog batch read enforces the 50-product limit and supports empty lists", async () => {
  const restoreMocks = installProductControllerMocks();
  try {
    const managerReqOverLimit: any = {
      user: { id: "mgr-1", role: "MANAGER" },
      query: { ids: Array.from({ length: 51 }, (_, i) => `prod-${i}`).join(",") },
      header: () => undefined,
    };
    const resOverLimit = createMockRes();
    await getManyForCatalog(managerReqOverLimit, resOverLimit);
    assert.equal(resOverLimit.statusCode, 400);
    assert.deepEqual(resOverLimit.body, {
      error: "A maximum of 50 products can be refreshed at once.",
    });

    const managerReqEmpty: any = {
      user: { id: "mgr-1", role: "MANAGER" },
      query: { ids: "" },
      header: () => undefined,
    };
    const resEmpty = createMockRes();
    await getManyForCatalog(managerReqEmpty, resEmpty);
    assert.equal(resEmpty.statusCode, 200);
    assert.deepEqual(resEmpty.body, { products: [] });

    // Shared /lookup endpoint also enforces 50-product limit
    const cashierReqOverLimit: any = {
      user: { id: "cashier-1", role: "CASHIER" },
      query: { ids: Array.from({ length: 51 }, (_, i) => `prod-${i}`).join(",") },
      header: () => undefined,
    };
    const resLookupOverLimit = createMockRes();
    await getMany(cashierReqOverLimit, resLookupOverLimit);
    assert.equal(resLookupOverLimit.statusCode, 400);
    assert.deepEqual(resLookupOverLimit.body, {
      error: "A maximum of 50 products can be refreshed at once.",
    });
  } finally {
    restoreMocks();
  }
});

test("manager bulk pricing receives catalog rates on /catalog-lookup while /lookup remains redacted for non-admins", async () => {
  const restoreMocks = installProductControllerMocks();
  try {
    const managerReq: any = {
      user: { id: "mgr-1", role: "MANAGER" },
      query: { ids: "prod-1" },
      header: () => undefined,
    };
    const adminReq: any = {
      user: { id: "admin-1", role: "ADMIN" },
      query: { ids: "prod-1" },
      header: () => undefined,
    };
    const cashierReq: any = {
      user: { id: "cashier-1", role: "CASHIER" },
      query: { ids: "prod-1" },
      header: () => undefined,
    };
    const staffReq: any = {
      user: { id: "staff-1", role: "STAFF" },
      query: { ids: "prod-1" },
      header: () => undefined,
    };

    (prisma.user as any).findUnique = async ({ where }: any) => {
      if (where.id === "mgr-1") return { role: "MANAGER", cashierPrivilege: null };
      if (where.id === "cashier-1") return { role: "CASHIER", cashierPrivilege: { canViewWholesalePrice: true } };
      if (where.id === "staff-1") return { role: "STAFF", cashierPrivilege: null };
      return null;
    };

    // 1. Manager on /catalog-lookup (used by bulk pricing dialog, edit product modal, error recovery)
    const catalogLookupMgrRes = createMockRes();
    await getManyForCatalog(managerReq, catalogLookupMgrRes);
    assert.equal(catalogLookupMgrRes.statusCode, 200);
    assert.equal(catalogLookupMgrRes.body.products.length, 1);
    const mgrProduct = catalogLookupMgrRes.body.products[0];
    assert.equal(mgrProduct.ratePerPiece, 350);
    assert.ok(mgrProduct.rateUpdatedAt);
    assert.equal(mgrProduct.retailPrice, 500);
    assert.equal(mgrProduct.wholesalePrice, 420);

    // 2. Admin on /catalog-lookup
    const catalogLookupAdminRes = createMockRes();
    await getManyForCatalog(adminReq, catalogLookupAdminRes);
    assert.equal(catalogLookupAdminRes.statusCode, 200);
    assert.equal(catalogLookupAdminRes.body.products[0].ratePerPiece, 350);
    assert.ok(catalogLookupAdminRes.body.products[0].rateUpdatedAt);

    // 3. Handler-level defense-in-depth: cashier and staff on getManyForCatalog
    const catalogLookupCashierRes = createMockRes();
    await getManyForCatalog(cashierReq, catalogLookupCashierRes);
    assert.equal(catalogLookupCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in catalogLookupCashierRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in catalogLookupCashierRes.body.products[0], false);

    const catalogLookupStaffRes = createMockRes();
    await getManyForCatalog(staffReq, catalogLookupStaffRes);
    assert.equal(catalogLookupStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in catalogLookupStaffRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in catalogLookupStaffRes.body.products[0], false);

    // 4. Shared POS /lookup: rate is redacted for Manager, Cashier, and Staff
    const posLookupMgrRes = createMockRes();
    await getMany(managerReq, posLookupMgrRes);
    assert.equal(posLookupMgrRes.statusCode, 200);
    assert.equal("ratePerPiece" in posLookupMgrRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in posLookupMgrRes.body.products[0], false);

    const posLookupCashierRes = createMockRes();
    await getMany(cashierReq, posLookupCashierRes);
    assert.equal(posLookupCashierRes.statusCode, 200);
    assert.equal("ratePerPiece" in posLookupCashierRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in posLookupCashierRes.body.products[0], false);

    const posLookupStaffRes = createMockRes();
    await getMany(staffReq, posLookupStaffRes);
    assert.equal(posLookupStaffRes.statusCode, 200);
    assert.equal("ratePerPiece" in posLookupStaffRes.body.products[0], false);
    assert.equal("rateUpdatedAt" in posLookupStaffRes.body.products[0], false);

    // Admin on /lookup still receives rate
    const posLookupAdminRes = createMockRes();
    await getMany(adminReq, posLookupAdminRes);
    assert.equal(posLookupAdminRes.statusCode, 200);
    assert.equal(posLookupAdminRes.body.products[0].ratePerPiece, 350);
    assert.ok(posLookupAdminRes.body.products[0].rateUpdatedAt);
  } finally {
    restoreMocks();
  }
});
