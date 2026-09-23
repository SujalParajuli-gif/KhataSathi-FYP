import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };

type MockState = { delayMs?: number, forceError?: boolean, total?: number, productName?: string };

async function setupProductsPageMock(page: Page, state: MockState = {}) {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = async (body: unknown, status = 200) => {
      if (state.delayMs) {
        await new Promise(r => setTimeout(r, state.delayMs));
      }
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    };

    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "CATALOG_ONLY",
        catalogEnabled: true,
        inventoryEnabled: false,
        posEnabled: false,
        stockTracked: false,
        staffDraftRequestsEnabled: false,
      });
    }
    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/brands")) return respond(["Sirpolin"]);
    if (path.endsWith("/categories")) return respond(["Plastic"]);
    if (path.endsWith("/alerts")) return respond({ alerts: [], unreadCount: 0 });
    if (path.endsWith("/alerts/read")) return respond({ readKeys: [] });
    if (path.endsWith("/import-batches")) return respond({ batches: [] });
    if (path.endsWith("/import-templates")) return respond({ templates: [] });

    if (path.endsWith("/products")) {
      if (state.forceError) {
        return respond({ error: "Force failed" }, 500);
      }

      const total = state.total !== undefined ? state.total : 1;
      const products = total > 0 ? [
        {
          id: "prod-1",
          name: state.productName || "Tirpal",
          sku: "TIR-001",
          barcode: "123456",
          brand: "Sirpolin",
          category: "Plastic",
          retailPrice: 750,
          wholesalePrice: 650,
          status: "Active",
          stock: 10,
        },
      ] : [];

      return respond({
        products,
        total,
        page: 1,
        pageSize: 50,
      });
    }

    return respond({});
  });
}

test.describe("Products loading states at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("delayed initial product request shows skeleton", async ({ page }) => {
    await setupProductsPageMock(page, { delayMs: 1000 });
    await page.goto("/products");

    // Skeleton should be visible while loading
    const loadingMessage = page.locator("div[role='status'].sr-only", { hasText: "Loading products" });
    await expect(loadingMessage).toBeAttached(); // it's sr-only, so it might not be 'visible' by playwright's strict bounding-box definition, but it is attached to the DOM. Wait, Playwright considers `sr-only` as not visible if it has height/width 0, or clip: rect(0,0,0,0). So toBeAttached() is safer.

    // Check aria-busy on the table
    await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "true");

    // Final content replaces it
    await expect(page.getByRole("table").getByText("Tirpal")).toBeVisible();
    await expect(loadingMessage).toHaveCount(0);
  });

  test("filtered no-results", async ({ page }) => {
    await setupProductsPageMock(page, { total: 0 });
    await page.goto("/products?q=missing");

    // "No products match these filters" is shown
    await expect(page.getByRole("heading", { name: "No products match these filters" }).first()).toBeVisible();

    // Verify empty state colspan is 11 in CATALOG_ONLY mode
    const emptyCell = page.locator("table tbody tr td");
    await expect(emptyCell).toHaveAttribute("colspan", "11");

    // Clear filters is available
    await expect(page.getByRole("button", { name: "Clear all filters" }).first()).toBeVisible();

    // Retry is absent
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("default active view with no products", async ({ page }) => {
    await setupProductsPageMock(page, { total: 0 });
    await page.goto("/products");

    // "No active products yet" is shown
    await expect(page.getByRole("heading", { name: "No active products yet" }).first()).toBeVisible();

    // Clear filters is absent
    await expect(page.getByRole("button", { name: "Clear all filters" })).toHaveCount(0);

    // Retry is absent
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("failed request", async ({ page }) => {
    const state: MockState = { forceError: true };
    await setupProductsPageMock(page, state);
    await page.goto("/products");

    // "Products could not be loaded" is shown
    await expect(page.getByRole("heading", { name: "Products could not be loaded" }).first()).toBeVisible();

    // Retry is available
    const retryButton = page.getByRole("button", { name: "Retry" }).first();
    await expect(retryButton).toBeVisible();

    // Setup for success on retry
    state.forceError = false;

    // Trigger retry
    await retryButton.click();

    // The success state replaces the error
    await expect(page.getByRole("table").getByText("Tirpal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Products could not be loaded" })).toHaveCount(0);
  });

  test("populated refresh does not show skeleton", async ({ page }) => {
    const state: MockState = {};
    await setupProductsPageMock(page, state);
    await page.goto("/products");

    // 1. The initial request returns a visible product row.
    await expect(page.getByRole("table").getByText("Tirpal")).toBeVisible();

    // 2. A search or filter change starts a delayed second product request.
    state.delayMs = 1000;
    state.productName = "New Product";
    await page.locator("input[placeholder*='Search'] >> visible=true").first().fill("New");

    // 3. The existing product row remains visible while that second request is pending.
    await expect(page.getByRole("table").getByText("Tirpal")).toBeVisible();

    // 4. The initial empty-state skeleton is not shown during that refresh.
    const bodyRows = page.getByRole("table").locator("tbody > tr");
    await expect(bodyRows).toHaveCount(1);

    // Check table has aria-busy while pending
    await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "true");

    // Check accessible message is "Updating products"
    const updatingMessage = page.locator("div[role='status'].sr-only", { hasText: "Updating products" });
    await expect(updatingMessage).toBeAttached();

    // 5. The new result replaces the previous result only after the response completes.
    await expect(page.getByRole("table").getByText("New Product")).toBeVisible();
    await expect(page.getByRole("table").getByText("Tirpal")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  });
});

test.describe("Products loading states at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("delayed initial product request shows skeleton", async ({ page }) => {
    await setupProductsPageMock(page, { delayMs: 1000 });
    await page.goto("/products");

    // Mobile uses a div list, not table rows
    const loadingList = page.locator("div[role='status'][aria-label='Loading products']");
    await expect(loadingList).toBeVisible();
    await expect(loadingList).toHaveAttribute("aria-busy", "true");

    // Final content replaces it
    await expect(page.locator("section[aria-label='Products catalog']").getByText("Tirpal")).toBeVisible();
    await expect(loadingList).toHaveCount(0);
  });

  test("filtered no-results", async ({ page }) => {
    await setupProductsPageMock(page, { total: 0 });
    await page.goto("/products?q=missing");

    await expect(page.getByRole("heading", { name: "No products match these filters" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear all filters" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("default active view with no products", async ({ page }) => {
    await setupProductsPageMock(page, { total: 0 });
    await page.goto("/products");

    await expect(page.getByRole("heading", { name: "No active products yet" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear all filters" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("failed request", async ({ page }) => {
    const state: MockState = { forceError: true };
    await setupProductsPageMock(page, state);
    await page.goto("/products");

    await expect(page.getByRole("heading", { name: "Products could not be loaded" }).first()).toBeVisible();
    const retryButton = page.getByRole("button", { name: "Retry" }).first();
    await expect(retryButton).toBeVisible();

    state.forceError = false;
    await retryButton.click();

    await expect(page.locator("section[aria-label='Products catalog']").getByText("Tirpal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Products could not be loaded" })).toHaveCount(0);
  });
});
