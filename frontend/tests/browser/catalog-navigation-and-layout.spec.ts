import { expect, test, type Page } from "@playwright/test";

const capabilities = {
  businessMode: "CATALOG_ONLY", catalogEnabled: true, inventoryEnabled: false,
  posEnabled: false, stockTracked: false, staffDraftRequestsEnabled: false,
};

async function mockCatalog(page: Page, role: "admin" | "staff" = "admin") {
  const user = { id: `${role}-catalog-test`, name: "Catalog tester", role };
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/capabilities")) body = capabilities;
    else if (path.endsWith("/auth/me")) body = { user };
    else if (path.endsWith("/alerts")) body = { alerts: [], unreadCount: 0 };
    else if (path === "/api/users") body = [
      { id: "staff-1", name: "Staff One", role: "STAFF", isActive: true },
    ];
    else if (path === "/api/brands" || path === "/api/products/categories") body = [];
    else if (path === "/api/audit/history") body = {
      category: "product", total: 1, page: 1, pageSize: 20, totalPages: 1,
      events: [{
        id: "price-event", category: "product", action: "PRODUCT_PRICE_UPDATED",
        entityType: "Product", entityId: "product-1", title: "Product price changed: Jar",
        meta: { productName: "Jar", sku: "JAR-1" }, createdAt: "2026-09-26T00:00:00Z",
      }],
    };
    else if (path === "/api/products/price-lookup") body = {
      products: [{
        id: "product-1", name: "Jar", sku: "JAR-1", brand: { name: "Example" },
        ratePerPiece: 100, retailPrice: 150, wholesalePrice: 125, isActive: true,
      }], total: 1, page: 1, pageSize: 20, searchLogId: null,
      visibility: { canViewPurchaseCost: false, canViewWholesalePrice: role === "admin" },
    };
    else if (path === "/api/products") body = { products: [], total: 0, page: 1, pageSize: 20 };
    else if (path === "/api/products/import-batches") body = { batches: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("History preserves the product SKU when opening the catalog", async ({ page }) => {
  await mockCatalog(page);
  const productQueries: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/products") productQueries.push(url.searchParams.get("search") || "");
  });
  await page.goto("/history");
  await page.getByRole("button", { name: "Find product" }).click();
  await expect(page).toHaveURL(/\/products\?q=JAR-1$/);
  await expect.poll(() => productQueries.includes("JAR-1")).toBe(true);
});

test("Settings tabs support direct links and browser Back", async ({ page }) => {
  await mockCatalog(page);
  await page.goto("/settings?tab=brands");
  await expect(page.getByRole("link", { name: "Brands" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Business Rules" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\?tab=brands$/);
  await expect(page.getByRole("link", { name: "Brands" })).toHaveAttribute("aria-current", "page");
});

test("History combines independent filters and restores them with browser Back", async ({ page }, testInfo) => {
  await mockCatalog(page);
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/audit/history") requests.push(url);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/history?q=Jar&actor=staff-1&action=PRICE&from=2026-09-22&to=2026-09-22");
  await expect.poll(() => requests.some((url) =>
    url.searchParams.get("q") === "Jar" &&
    url.searchParams.get("actorId") === "staff-1" &&
    url.searchParams.get("action") === "PRICE" &&
    url.searchParams.get("from") === "2026-09-22" &&
    url.searchParams.get("to") === "2026-09-22",
  )).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("history-filters-desktop.png") });
  await page.getByRole("link", { name: "Imports" }).click();
  await expect(page).toHaveURL(/category=import/);
  await expect(page).not.toHaveURL(/action=PRICE/);
  await page.goBack();
  await expect(page).toHaveURL(/action=PRICE/);
  await expect(page.getByRole("navigation", { name: "History categories" }).getByRole("link", { name: "Products" })).toHaveAttribute("aria-current", "page");
});

test("History and Settings section navigation fits a narrow catalog screen", async ({ page }, testInfo) => {
  await mockCatalog(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/history");
  await expect(page.getByRole("navigation", { name: "History categories" }).getByRole("link", { name: "Products" })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("history-mobile.png") });
  await page.goto("/history?actor=staff-1&action=PRICE");
  await expect(page.getByRole("button", { name: "Open filter, 2 active" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove filter: Price updates" })).toBeVisible();
  await page.goto("/settings?tab=brands");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Brands" })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const role of ["admin", "staff"] as const) {
  test(`mobile Lookup shows only visible price fields for ${role}`, async ({ page }) => {
    await mockCatalog(page, role);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/product-lookup");
    const card = page.getByRole("heading", { name: "Jar" }).locator("xpath=ancestor::article");
    await expect(card).toBeVisible();
    await expect(card.getByText("Cost", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Retail", { exact: true })).toBeVisible();
    await expect(card.getByText("Wholesale", { exact: true })).toHaveCount(role === "admin" ? 1 : 0);
    const visiblePrices = card.getByText("Wholesale", { exact: true });
    if (role === "admin") {
      const bounds = await visiblePrices.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
  });
}
