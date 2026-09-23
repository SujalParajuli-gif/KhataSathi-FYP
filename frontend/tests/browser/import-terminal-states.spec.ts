import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };

async function setupMock(page: Page, status: string = "PROCESSING") {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);

  let currentStatus = status;
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) return respond({ businessMode: "CATALOG_ONLY", catalogEnabled: true });
    if (path.endsWith("/alerts") || path.endsWith("/alerts/read")) return respond({ alerts: [], unreadCount: 0, readKeys: [] });
    if (path.endsWith("/products")) return respond({ products: [], page: 1, totalPages: 0, totalCount: 0 });

    if (path.endsWith("/update-mock-status")) {
        const body = route.request().postDataJSON();
        currentStatus = body.status;
        return respond({ success: true });
    }

    if (path.includes("/status")) {
      if (currentStatus === "503") {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service Unavailable" }) });
      }

      const isNewBatch = path.includes("new-batch");
      return respond({
        batch: {
          id: isNewBatch ? "new-batch" : "test-batch",
          fileName: isNewBatch ? "other.xlsx" : "prices.xlsx",
          status: isNewBatch ? "PROCESSING" : (currentStatus === "DRAFT_SINGULAR" ? "DRAFT" : currentStatus),
          totalRows: isNewBatch ? 5 : 10,
          importedRows: isNewBatch ? 0 : (currentStatus === "IMPORTED" ? 10 : 0),
          failedRows: isNewBatch ? 0 : (currentStatus === "DRAFT" ? 2 : currentStatus === "DRAFT_SINGULAR" ? 1 : 0),
          createdAt: new Date().toISOString()
        },
        coverage: {
          total: isNewBatch ? 2 : 5, visited: isNewBatch ? 1 : 5, completed: isNewBatch ? 1 : 5, canRetry: false, outcome: isNewBatch ? "PARTIAL" : "FULL"
        }
      });
    }

    return route.continue();
  });
}

test.describe("Import Terminal States", () => {
  for (const width of [1440, 390]) {
    test(`completion while minimized and explicit dismissal at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "PROCESSING");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products");

      const pill = page.locator("aside", { hasText: "prices.xlsx" });
      await expect(pill).toBeVisible();
      await expect(pill).toContainText("Extracting products…");

      await page.evaluate(() => fetch("/api/update-mock-status", { method: "POST", body: JSON.stringify({ status: "IMPORTED" }) }));

      await expect(pill).toContainText("10 applied, 0 ignored, 0 failed.");

      await pill.getByRole("button", { name: "Dismiss import notification" }).click();
      await expect(pill).not.toBeVisible();
    });

    test(`reload persistence at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "DRAFT");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products");

      const pill = page.locator("aside", { hasText: "prices.xlsx" });
      await expect(pill).toBeVisible();
      await expect(pill).toContainText("Extraction completed. Review 10 extracted rows; 2 need attention.");

      await page.reload();
      await expect(pill).toBeVisible();
      await expect(pill).toContainText("Extraction completed. Review 10 extracted rows; 2 need attention.");
    });

    test(`replacement by a new import at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "IMPORTED");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products");

      const pill = page.locator("aside", { hasText: "prices.xlsx" });
      await expect(pill).toBeVisible();

      await page.evaluate(() => sessionStorage.setItem("active_product_import_batch_id", "new-batch"));
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("active_product_import_changed", { detail: { batchId: "new-batch" } })));

      const newPill = page.locator("aside", { hasText: "other.xlsx" });
      await expect(newPill).toBeVisible();
      await expect(pill).not.toBeVisible();

      const storedId = await page.evaluate(() => sessionStorage.getItem("active_product_import_batch_id"));
      expect(storedId).toBe("new-batch");
    });

    test(`expanded widget terminal states at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "DRAFT");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products?openImport=true");

      const widget = page.locator("section[aria-label='Import progress']");
      await expect(widget).toBeVisible();

      await expect(widget).toContainText("Extraction completed. Review 10 extracted rows; 2 need attention.");

      await page.evaluate(() => fetch("/api/update-mock-status", { method: "POST", body: JSON.stringify({ status: "FAILED" }) }));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(widget).toContainText("Saved work remains available for review or retry.");

      await page.evaluate(() => fetch("/api/update-mock-status", { method: "POST", body: JSON.stringify({ status: "INTERRUPTED" }) }));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(widget).toContainText("Saved work remains available for review or retry.");

      await page.evaluate(() => fetch("/api/update-mock-status", { method: "POST", body: JSON.stringify({ status: "IMPORTED" }) }));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(widget).toContainText("10 applied, 0 ignored, 0 failed.");
    });

    test(`connection error after terminal state at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "DRAFT");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products?openImport=true");

      const widget = page.locator("section[aria-label='Import progress']");
      await expect(widget).toBeVisible();

      await expect(widget).toContainText("Extraction completed. Review 10 extracted rows; 2 need attention.");

      await page.evaluate(() => fetch("/api/update-mock-status", { method: "POST", body: JSON.stringify({ status: "503" }) }));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      await expect(widget).toContainText("Extraction completed. Review 10 extracted rows; 2 need attention.");
      await expect(widget).toContainText("Status connection lost. Retrying automatically; your import stays saved.");
    });
    test(`singular failed row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setupMock(page, "DRAFT_SINGULAR");
      await page.addInitScript(() => sessionStorage.setItem("active_product_import_batch_id", "test-batch"));

      await page.goto("/products?openImport=true");

      const widget = page.locator("section[aria-label='Import progress']");
      await expect(widget).toBeVisible();

      await expect(widget).toContainText("Extraction completed. Review 10 extracted rows; 1 needs attention.");
    });
  }
});
