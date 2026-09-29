import { expect, test, type Page } from "@playwright/test";

const user = { id: "catalog-admin", name: "Catalog admin", role: "admin" };
const products = ["Tirpal", "Deep Tub Mug", "Round Jar"].map((name, index) => ({
  id: `product-${index + 1}`, name, sku: `SKU-${index + 1}`, barcode: `CODE-${index + 1}`,
  brand: { id: "brand-1", name: "Example" }, category: "Household", ratePerPiece: 100 + index * 10,
  retailPrice: null, wholesalePrice: null, stock: 0, isActive: true,
  availabilityStatus: "CATALOG_LISTED", sellingPriceStatus: "PENDING",
}));

async function mockCatalog(page: Page, catalogProducts = products, serverSkipLast = false, saveBehavior?: "timeout" | "partial") {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/capabilities")) body = { businessMode: "CATALOG_ONLY", catalogEnabled: true, inventoryEnabled: false, posEnabled: false, stockTracked: false, staffDraftRequestsEnabled: false };
    else if (path.endsWith("/auth/me")) body = { user };
    else if (path.endsWith("/alerts")) body = { alerts: [], unreadCount: 0 };
    else if (path.endsWith("/brands")) body = [{ id: "brand-1", name: "Example" }];
    else if (path.endsWith("/categories")) body = ["Household"];
    else if (path.endsWith("/import-batches")) body = { batches: [] };
    else if (path.endsWith("/import-templates")) body = { templates: [] };
    else if (path.endsWith("/products/lookup")) body = { products: catalogProducts };
    else if (path.endsWith("/products/bulk-price-update")) {
      const request = route.request().postDataJSON() as { previewOnly?: boolean; previewPage?: number; previewPageSize?: number };
      if (!request.previewOnly && saveBehavior === "timeout") {
        return route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: "Gateway timeout" }) });
      }
      if (!request.previewOnly && saveBehavior === "partial") {
        body = { updatedCount: 1, skippedMissingRate: 0, skippedComingSoon: 0, skippedExisting: 0,
          errorCount: 1, errors: [{ productId: "product-2", message: "Database write failed" }],
          products: [{ id: "product-1", name: "Tirpal", sku: "SKU-1" }], partialSuccess: true, auditWarning: null };
      } else {
      const eligible = serverSkipLast ? catalogProducts.slice(0, -1) : catalogProducts;
      const previewPage = request.previewPage || 1;
      const previewPageSize = request.previewPageSize || 25;
      body = {
      previewRevision: "a".repeat(64), previewCount: eligible.length, previewPage, previewPageSize,
      previewTotalPages: Math.max(1, Math.ceil(eligible.length / previewPageSize)),
      errorCount: 0, errors: [], skippedMissingRate: 0, skippedComingSoon: 0, skippedExisting: serverSkipLast ? 1 : 0,
      preview: eligible.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize).map((product) => ({
        productId: product.id, name: product.name, sku: product.sku,
        currentRate: product.ratePerPiece, newRate: product.ratePerPiece, rate: product.ratePerPiece,
        currentWholesalePrice: null, newWholesalePrice: product.ratePerPiece * 1.18,
        currentRetailPrice: null, newRetailPrice: null, willChange: true,
      })),
    };
      }
    }
    else if (path.endsWith("/products")) body = { products: catalogProducts, total: catalogProducts.length, page: 1, pageSize: 50 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("an uncertain save cannot submit the old confirmation again", async ({ page }) => {
  await mockCatalog(page, products, false, "timeout");
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set selling prices" });
  await dialog.getByRole("button", { name: /Calculate preview for/ }).click();
  await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Market price changed");
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  await page.getByRole("dialog", { name: "Confirm price update" }).getByRole("button", { name: "Confirm 3 updates" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm price update" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Set selling prices" })).toContainText("Save outcome is uncertain");
  await expect(page.getByRole("button", { name: "Confirm 3 updates" })).toHaveCount(0);
});

test("known partial failures retain product identity and require fresh selection for retry", async ({ page }) => {
  await mockCatalog(page, products, false, "partial");
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set selling prices" });
  await dialog.getByRole("button", { name: /Calculate preview for/ }).click();
  await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Market price changed");
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  await page.getByRole("dialog", { name: "Confirm price update" }).getByRole("button", { name: "Confirm 3 updates" }).click();
  const result = page.getByRole("dialog", { name: "Bulk price update complete" });
  await expect(result).toContainText("Deep Tub Mug");
  await result.getByRole("button", { name: "Retry 1 failed" }).click();
  await expect(page.getByRole("dialog", { name: "Set selling prices" })).toContainText("Failed products were reloaded");
  await expect(page.getByRole("dialog", { name: "Set selling prices" })).toContainText("To edit: 1 of 1 in scope");
});

test("validation returns to an invalid product on another preview page", async ({ page }) => {
  const manyProducts = Array.from({ length: 30 }, (_, index) => ({
    ...products[index % products.length], id: `product-${index + 1}`, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`,
  }));
  await mockCatalog(page, manyProducts);
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  await page.getByRole("dialog", { name: "Set selling prices" }).getByRole("button", { name: "Manual", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Enter exact selling prices" });
  await dialog.getByRole("button", { name: "Review selected prices" }).click();
  await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Correcting an entry mistake");
  await dialog.getByRole("button", { name: "Next preview page" }).click();
  const invalid = dialog.locator('[data-price-field="product-28-ratePerPiece"]').first();
  await invalid.fill("0");
  await dialog.getByRole("button", { name: "Previous preview page" }).click();
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  await expect(invalid).toBeFocused();
  await expect(dialog).toContainText("Enter a Rate greater than 0");
});

test("filtered override validation stays editable when its product is off-page", async ({ page }, testInfo) => {
  const manyProducts = Array.from({ length: 30 }, (_, index) => ({
    ...products[index % products.length], id: `product-${index + 1}`, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`,
  }));
  await mockCatalog(page, manyProducts);
  await page.route((url) => url.pathname === "/api/products", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ products: manyProducts.slice(0, 10), total: manyProducts.length, page: 1, pageSize: 10 }),
  }));
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Select all 30 matching products" }).click();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set selling prices" });
  await expect(dialog.getByText("Product 1", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "All 30 matching products included" })).toBeDisabled();
  const excludeShown = dialog.getByRole("button", { name: /Exclude \d+ products shown on this page/ });
  await expect(excludeShown).toBeEnabled();
  await excludeShown.click();
  await dialog.getByRole("button", { name: "Include all 30 matching products" }).click();
  await page.screenshot({ path: testInfo.outputPath("filtered-price-setup-desktop.png") });
  await dialog.getByRole("button", { name: /Calculate preview for/ }).click();
  await dialog.getByRole("button", { name: "Adjust" }).first().click();
  await dialog.locator('[data-price-field="product-1-ratePerPiece"]').first().fill("0");
  await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Correcting an entry mistake");
  await dialog.getByRole("button", { name: "Next preview page" }).click();
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  const correction = dialog.getByRole("region", { name: "Price needing correction" });
  await expect(correction).toBeVisible();
  await expect(correction.locator('[data-price-field="product-1-ratePerPiece"]')).toBeFocused();
  await correction.locator('[data-price-field="product-1-ratePerPiece"]').fill("100");
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  const review = page.getByRole("dialog", { name: "Confirm price update" });
  await expect(review).toBeVisible();
  await expect(review.getByText("Preview sample (25 of 30)")).toBeVisible();
});

for (const reviewWidth of [390, 1440]) test(`server-skipped products and later review pages are reachable at ${reviewWidth}px`, async ({ page }, testInfo) => {
  const manyProducts = Array.from({ length: 55 }, (_, index) => ({
    ...products[index % products.length], id: `product-${index + 1}`, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`,
  }));
  await mockCatalog(page, manyProducts, true);
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  await page.setViewportSize({ width: reviewWidth, height: reviewWidth < 500 ? 844 : 900 });
  const dialog = page.getByRole("dialog", { name: "Set selling prices" });
  await dialog.getByRole("button", { name: /Calculate preview for/ }).click();
  await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Supplier Rate changed");
  await dialog.getByRole("button", { name: /Review changes/ }).click();
  const review = page.getByRole("dialog", { name: "Confirm price update" });
  await expect(review.getByRole("button", { name: "Confirm 54 updates" })).toBeVisible();
  const auditReason = review.getByRole("combobox", { name: "Price update audit reason" });
  await expect(auditReason).toBeInViewport();
  await auditReason.fill("");
  await review.getByRole("button", { name: "Confirm 54 updates" }).click();
  await expect(review.getByRole("alert")).toContainText("Enter a reason");
  await auditReason.fill("Supplier Rate changed");
  await expect(review.getByText("Page 1 of 3")).toBeVisible();
  await review.getByRole("button", { name: "Next review page" }).click();
  await expect(review.getByText("Page 2 of 3")).toBeVisible();
  await review.getByRole("button", { name: "Next review page" }).click();
  await expect(review.getByText("Product 54", { exact: true })).toBeVisible();
  await expect(review.getByText("Product 55", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`server-review-${reviewWidth}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 390]) {
  test(`three-product price workflow uses content-sized layout at ${width}px`, async ({ page }, testInfo) => {
    await mockCatalog(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/products");
    await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
    await page.getByRole("button", { name: "Set Prices", exact: true }).click();
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    const dialog = page.getByRole("dialog", { name: "Set selling prices" });
    await expect(dialog).toBeVisible();
    const stepper = dialog.getByLabel("Workflow steps");
    const mode = dialog.getByRole("group", { name: "Pricing method" });
    const stepperBounds = await stepper.boundingBox();
    const modeBounds = await mode.boundingBox();
    expect(stepperBounds).not.toBeNull();
    expect(modeBounds).not.toBeNull();
    if (width < 500) expect(modeBounds!.y).toBeGreaterThan(stepperBounds!.y + stepperBounds!.height);
    else expect(Math.abs(modeBounds!.y - stepperBounds!.y)).toBeLessThan(20);
    await page.screenshot({ path: testInfo.outputPath(`price-setup-${width}.png`) });
    await dialog.getByRole("button", { name: /Calculate preview for 3 products/ }).click();
    await expect(dialog.getByRole("button", { name: /Review changes/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`price-preview-${width}.png`) });
    await dialog.getByRole("combobox", { name: "Price update audit reason" }).fill("Supplier Rate changed");
    await dialog.getByRole("button", { name: /Review changes/ }).click();
    const review = page.getByRole("dialog", { name: "Confirm price update" });
    await expect(review).toBeVisible();
    if (width >= 500) {
      const comparison = review.getByText("Wholesale", { exact: true }).first().locator("..");
      const comparisonBounds = await comparison.boundingBox();
      expect(comparisonBounds!.width).toBeGreaterThan(400);
    }
    await page.screenshot({ path: testInfo.outputPath(`price-review-${width}.png`) });
    const bounds = await page.getByRole("dialog", { name: "Confirm price update" }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeLessThan(width < 500 ? 844 : 800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`three-product manual price flow stays compact at ${width}px`, async ({ page }, testInfo) => {
    await mockCatalog(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/products");
    await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
    await page.getByRole("button", { name: "Set Prices", exact: true }).click();
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.getByRole("dialog", { name: "Set selling prices" }).getByRole("button", { name: "Manual", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Enter exact selling prices" });
    await expect(dialog.getByText("Target Products (3)")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`manual-setup-${width}.png`) });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeLessThan(width < 500 ? 844 : 800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const width of [320, 375, 1440]) test(`manual preview scrolls and product filters work at ${width}px`, async ({ page }, testInfo) => {
  const manyProducts = Array.from({ length: 20 }, (_, index) => ({
    ...products[index % products.length], id: `product-${index + 1}`, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`,
  }));
  await mockCatalog(page, manyProducts);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/products");
  await page.getByRole("checkbox", { name: "Select all rows on this page" }).check();
  await page.getByRole("button", { name: "Set Prices", exact: true }).click();
  await page.setViewportSize({ width, height: width < 500 ? 667 : 900 });
  await page.getByRole("dialog", { name: "Set selling prices" }).getByRole("button", { name: "Manual", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Enter exact selling prices" });
  if (width < 500) {
    const mode = dialog.getByRole("group", { name: "Pricing method" });
    for (const name of ["Formula", "Manual"]) {
      const box = await mode.getByRole("button", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeLessThan(50);
    }
  }
  const selectAll = dialog.getByRole("button", { name: "Select all 20 visible products" });
  const clearAll = dialog.getByRole("button", { name: "Clear all 20 visible products" });
  await expect(selectAll).toBeVisible();
  await expect(clearAll).toBeVisible();
  for (const button of [selectAll, clearAll]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(50);
  }
  await clearAll.click();
  await expect(dialog).toContainText("To edit: 0 of 20 in scope");
  await selectAll.click();
  await expect(dialog).toContainText("To edit: 20 of 20 in scope");
  await dialog.getByRole("button", { name: "Review selected prices" }).click();
  if (width < 500) {
    for (const name of ["Modify settings", "Review changes"]) {
      const box = await dialog.getByRole("button", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(50);
    }
  }
  const filterGroup = dialog.getByRole("group", { name: "Preview products" });
  await expect(filterGroup.getByRole("button", { name: "Included" })).toBeVisible();
  if (width < 500) {
    const body = dialog.locator(":scope > div").nth(1);
    const before = await body.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(before.scrollHeight).toBeGreaterThan(before.height);
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(dialog.getByRole("combobox", { name: "Price update audit reason" })).toBeInViewport();
  }
  const rows = dialog.locator(width < 500 ? "article" : "tbody tr");
  await rows.filter({ has: page.getByText("Product 1", { exact: true }) }).first().getByRole("button", { name: "Exclude" }).click();
  await filterGroup.getByRole("button", { name: "Excluded" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Product 1");
  await filterGroup.getByRole("button", { name: "Included" }).click();
  await expect(rows).toHaveCount(19);
  await expect(rows.filter({ has: page.getByText("Product 1", { exact: true }) })).toHaveCount(0);
  await filterGroup.getByRole("button", { name: "All" }).click();
  await expect(rows).toHaveCount(20);
  await page.screenshot({ path: testInfo.outputPath(`manual-preview-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
