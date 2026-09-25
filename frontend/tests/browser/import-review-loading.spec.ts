import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };

type MockState = {
  delayMs?: number;
  forceError?: boolean;
  filterForceError?: boolean;
  mimeType?: string;
  hasRegion?: boolean;
  sourceType?: string;
};

async function setupImportReviewMock(page: Page, state: MockState = {}) {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);

  const requests = {
    sourceBlob: 0,
    sourcePage: 0,
    sourceContext: 0,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const searchParams = new URL(route.request().url()).searchParams;

    const respond = async (body: unknown, status = 200, contentType = "application/json") => {
      if (state.delayMs && !path.includes("/source")) {
        await new Promise(r => setTimeout(r, state.delayMs));
      }
      return route.fulfill({ status, contentType, body: contentType === "application/json" ? JSON.stringify(body) : body as any });
    };

    if (path.endsWith("/capabilities")) {
      return respond({ businessMode: "CATALOG_ONLY", catalogEnabled: true });
    }
    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/alerts")) return respond({ alerts: [], unreadCount: 0 });

    if (path.includes("/source-context")) {
      requests.sourceContext++;
      return respond({ activeRowId: "row-1", rows: [{ id: "row-1" }] });
    }

    if (path.match(/\/source\/pages\/\d+/)) {
      requests.sourcePage++;
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      return respond("pdf page blob", 200, "application/pdf");
    }

    if (path.endsWith("/source")) {
      requests.sourceBlob++;
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      return respond("pdf full blob", 200, "application/pdf");
    }

    if (path.endsWith("/review")) {
      if (state.forceError) {
        return respond({ error: "Initial 503 error" }, 503);
      }
      if (state.filterForceError && searchParams.get("reviewState") === "ATTENTION") {
        return respond({ error: "Failed to load Attention filter" }, 500);
      }

      return respond({
        batch: {
          id: "batch-1",
          status: "REVIEWING",
          sourceType: state.sourceType || "PDF",
          fileName: "test-catalog.pdf",
          supplier: "Test supplier",
          createdAt: new Date().toISOString(),
          source: { available: true, mimeType: state.mimeType || "application/pdf" },
          totalRows: 1,
        },
        decisionCounts: { create: 0, update: 0, keep: 0, ignore: 0, unresolved: 1, committed: 0 },
        rows: [
          {
            id: "row-1",
            batchId: "batch-1",
            status: "NEEDS_REVIEW",
            rowNumber: 1,
            resolution: "CREATE_NEW",
            comparisonStatus: "READY_NEW",
            parsed: { name: "Test Product", brand: "Test supplier", category: "Buckets", sku: "TEST-1", ratePerPiece: 100, retailPrice: null, wholesalePrice: null, availabilityStatus: "CATALOG_LISTED", stock: 0 },
            sourceLocator: state.hasRegion ? { pageNumber: 1, region: { top: 0, left: 0, bottom: 100, right: 100, scale: 1000 } } : { pageNumber: 1 },
          },
          {
            id: "row-2",
            batchId: "batch-1",
            status: "NEEDS_REVIEW",
            rowNumber: 2,
            resolution: "CREATE_NEW",
            comparisonStatus: "READY_NEW",
            parsed: { name: "Second Product", brand: "Test supplier", category: "Buckets", sku: "TEST-2", ratePerPiece: 200, retailPrice: null, wholesalePrice: null, availabilityStatus: "CATALOG_LISTED", stock: 0 },
            sourceLocator: state.hasRegion ? { pageNumber: 2, region: { top: 0, left: 0, bottom: 100, right: 100, scale: 1000 } } : { pageNumber: 2 },
          }
        ],
        pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
        comparisonCounts: { READY_NEW: 1 },
        reviewCounts: { all: 1, attention: 1, edited: 0, missingBrand: 0 },
        priceMapping: { required: false, complete: true, columns: [], mapping: {} },
        coverage: { total: 1, visited: 1, completed: 1, partialPages: [], failedPages: [], unvisitedPages: [], retryablePages: [], emptyPageNumbers: [], outcome: "SUCCESS", canRetry: false, canReprocessEmpty: false, requiresAcknowledgement: false }
      });
    }

    return route.continue();
  });

  return requests;
}

test.describe("Import Review Loading and Reliability", () => {
  test("initial 503 then Retry", async ({ page }) => {
    let forceError = true;
    await setupImportReviewMock(page, { get forceError() { return forceError; } });

    await page.goto("/products/imports/batch-1");

    const alert = page.locator("text=Import review unavailable");
    await expect(alert).toBeVisible();
    await expect(page.locator("text=Initial 503 error")).toBeVisible();

    forceError = false;
    await page.getByRole("button", { name: "Retry request" }).click();

    await expect(page.locator("text=Test Product")).toBeVisible();
  });

  test("failed All→Attention switch shows unambiguous error", async ({ page }) => {
    const state = { filterForceError: true };
    await setupImportReviewMock(page, state);

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();

    await page.getByRole("button", { name: /Attention/ }).first().click();

    const banner = page.locator("text=Unable to load requested rows");
    await expect(banner).toBeVisible();
    await expect(page.locator("text=Failed to load Attention filter")).toBeVisible();
    await expect(page.locator("text=Showing previous results for ALL filter, page 1 (25/page)")).toBeVisible();
    await expect(page.locator("text=Test Product")).toBeVisible(); // old rows still visible

    // verify previous list cannot be interacted with
    const rowList = page.locator("[data-import-row-list]");
    await expect(rowList).toHaveClass(/pointer-events-none/);

    // Validate controls are natively disabled for both mouse and keyboard
    const rowButton = page.getByRole("button", { name: /Review Test Product/ });
    await expect(rowButton).toBeDisabled();

    const selectAllBtn = page.getByRole("button", { name: /Select all/ }).first();
    await expect(selectAllBtn).toBeDisabled();

    // Verify Select page is natively disabled for mouse and keyboard
    const selectPageChk = page.locator('label', { hasText: 'Select page' }).locator('input[type="checkbox"]');
    await expect(selectPageChk).toBeDisabled();

    // attempting to press Space on Select page natively fails because it's disabled
    await selectPageChk.press("Space");

    // Retry successfully
    state.filterForceError = false;
    await page.getByRole("button", { name: "Retry" }).click();

    // Verify successful load
    await expect(page.locator("text=Unable to load requested rows")).not.toBeVisible();

    // Verify Select page is enabled again
    await expect(selectPageChk).toBeEnabled();

    // Verify no stale selection appears in Bulk edit
    await expect(page.locator('text=/All \\d+ selected/')).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Bulk edit/ })).not.toBeVisible();
  });

  test("delayed populated refresh does not hide rows", async ({ page }) => {
    await setupImportReviewMock(page, { delayMs: 500 });

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();

    await page.getByRole("button", { name: /Attention/ }).first().click();

    const updatingBanner = page.locator("text=Updating rows… Previous results remain visible.");
    await expect(updatingBanner).toBeVisible();
    await expect(page.locator("text=Test Product")).toBeVisible(); // old rows remain visible

    await updatingBanner.waitFor({ state: "hidden" });
  });

  test("PDF with region fetches page blob and not source context", async ({ page }) => {
    const reqs = await setupImportReviewMock(page, { hasRegion: true, mimeType: "application/pdf", sourceType: "PDF" });

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();

    await expect.poll(() => reqs.sourcePage, { timeout: 2000 }).toBe(1);

    expect(reqs.sourceBlob).toBe(0);
    expect(reqs.sourceContext).toBe(0);
  });

  test("PDF without region fetches full blob and not source context", async ({ page }) => {
    const reqs = await setupImportReviewMock(page, { hasRegion: false, mimeType: "application/pdf", sourceType: "PDF" });

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();

    await expect.poll(() => reqs.sourceBlob, { timeout: 2000 }).toBe(1);

    expect(reqs.sourcePage).toBe(0);
    expect(reqs.sourceContext).toBe(0);
  });

  test("mobile Source deep link and reload load the preview", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const reqs = await setupImportReviewMock(page, { hasRegion: false, mimeType: "application/pdf", sourceType: "PDF" });

    await page.goto("/products/imports/batch-1?view=source");
    await expect(page.getByRole("heading", { name: "Document" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom in source" })).toBeVisible();
    await expect.poll(() => reqs.sourceBlob).toBe(1);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Document" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom in source" })).toBeVisible();
    await expect.poll(() => reqs.sourceBlob).toBe(2);
    expect(reqs.sourcePage).toBe(0);
    expect(reqs.sourceContext).toBe(0);
  });

  test("mobile List→Source deferral", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const reqs = await setupImportReviewMock(page, { hasRegion: false, mimeType: "application/pdf", sourceType: "PDF" });

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();

    // allow a brief moment to ensure no fetch happens on load
    await page.waitForTimeout(500);
    expect(reqs.sourceBlob).toBe(0);

    await page.locator("text=Test Product").click();
    await expect(page.getByRole("button", { name: "Toggle source document peek" })).toBeVisible();
    await page.getByRole("button", { name: "Toggle source document peek" }).click();

    // Should fetch exactly once after switching to Source view
    await expect.poll(() => reqs.sourceBlob, { timeout: 2000 }).toBe(1);
    expect(reqs.sourcePage).toBe(0);
  });

  test("rapid row switching out of order responses are handled correctly", async ({ page }) => {
    const reqs = await setupImportReviewMock(page, { hasRegion: true, mimeType: "application/pdf", sourceType: "PDF" });

    // Add specific out-of-order route handling
    let page1Resolve: () => void;
    const page1Promise = new Promise<void>(r => { page1Resolve = r; });
    let sourcePageCount = 0;

    await page.route("**/source/pages/*", async (route) => {
      sourcePageCount++;
      const url = route.request().url();
      if (url.includes("/pages/1")) {
        await page1Promise; // Block until we say so
        await route.fulfill({ status: 200, contentType: "application/pdf", body: "page 1 data" });
      } else if (url.includes("/pages/2")) {
        await route.fulfill({ status: 200, contentType: "application/pdf", body: "page 2 data" });
      } else {
        await route.continue();
      }
    });

    await page.goto("/products/imports/batch-1");
    await expect(page.locator("text=Test Product")).toBeVisible();
    await expect(page.locator("text=Second Product")).toBeVisible();

    // Select first row, which triggers the slow request
    await page.locator("text=Test Product").click();

    // Immediately select second row, which triggers the fast request
    await page.locator("text=Second Product").click();

    // Release the slow request now that the fast one should have completed
    page1Resolve!();

    // Assert the displayed preview's content is from page 2
    await expect.poll(async () => {
      const src = await page.getAttribute('img[alt="Supplier catalog source"]', 'src');
      if (!src) return null;
      return page.evaluate(async (url) => {
        try {
          const res = await fetch(url);
          return await res.text();
        } catch { return null; }
      }, src);
    }, { timeout: 2000 }).toBe("page 2 data");

    // Ensure the UI is stable and doesn't crash
    await expect(page.locator("text=Second Product")).toBeVisible();

    // After the UI settles, assert final source-request counts so a later duplicate cannot pass unnoticed
    await page.waitForLoadState("networkidle");
    expect(reqs.sourceBlob).toBe(0);
    // Page 1 fetch may be counted before abort, or may be aborted early.
    // The main point is we don't fetch source context.
    expect(reqs.sourceContext).toBe(0);

    // Both page requests should have been initiated exactly once
    expect(sourcePageCount).toBe(2);
  });
});
