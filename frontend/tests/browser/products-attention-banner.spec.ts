import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };

const mockBatches = [
  {
    id: "batch-pdf",
    sourceType: "PDF",
    fileName: "Household SPL.pdf",
    status: "DRAFT",
    totalRows: 192,
    importedRows: 0,
    failedRows: 0,
    createdAt: "2026-09-20T10:00:00.000Z",
  },
  {
    id: "batch-excel",
    sourceType: "XLSX",
    fileName: "KhataSathi_Super_Plastic_Catalog.xlsx",
    status: "DRAFT",
    totalRows: 44,
    importedRows: 0,
    failedRows: 0,
    createdAt: "2026-09-18T10:00:00.000Z",
  },
  {
    id: "batch-image",
    sourceType: "IMAGE",
    fileName: "KI MOP.jpeg",
    status: "FAILED",
    totalRows: 17,
    importedRows: 0,
    failedRows: 2,
    createdAt: "2026-09-15T10:00:00.000Z",
  },
];

async function setupProductsPageMock(page: Page, batches = mockBatches) {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

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
    if (path.endsWith("/brands")) return respond([{ id: "brand-1", name: "Sirpolin" }]);
    if (path.endsWith("/categories")) return respond(["Plastic"]);
    if (path.endsWith("/alerts")) return respond({ alerts: [], unreadCount: 0 });
    if (path.endsWith("/alerts/read")) return respond({ readKeys: [] });
    if (path.endsWith("/products")) {
      return respond({
        products: [
          {
            id: "prod-1",
            name: "Tirpal",
            sku: "TIR-001",
            barcode: "123456",
            brand: { id: "brand-1", name: "Sirpolin" },
            category: "Plastic",
            retailPrice: 750,
            wholesalePrice: 650,
            isActive: true,
            stock: 10,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    }
    if (path.endsWith("/import-batches")) return respond({ batches });
    if (path.endsWith("/import-templates")) return respond({ templates: [] });
    return respond({});
  });
}

test("attention badge counts every pending batch while showing only three previews", async ({ page }) => {
  await setupProductsPageMock(page, Array.from({ length: 5 }, (_, index) => ({ ...mockBatches[0], id: `batch-${index}` })));
  await page.goto("/products");
  const banner = page.locator("section[aria-labelledby='import-activity-heading']");
  await expect(banner.getByText("5", { exact: true })).toBeVisible();
  await banner.getByRole("button", { name: "Show list" }).click();
  await expect(banner.getByRole("button", { name: /Ready to review: Household/ })).toHaveCount(3);
});

test("attention summary includes older batches outside the recent history page", async ({ page }) => {
  await setupProductsPageMock(page);
  await page.route((url) => url.pathname.endsWith("/import-batches"), route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ batches: [], attentionCount: 42, attentionBatches: [mockBatches[0]] }),
  }));
  await page.goto("/products");
  const banner = page.locator("section[aria-labelledby='import-activity-heading']");
  await expect(banner.getByText("42", { exact: true })).toBeVisible();
  await banner.getByRole("button", { name: "Show list" }).click();
  await expect(banner.getByRole("button", { name: /Ready to review: Household/ })).toBeVisible();
});

test("product page status filter defaults to Active with only Active and Inactive options", async ({ page }) => {
  await setupProductsPageMock(page);
  await page.goto("/products");

  // On desktop toolbar: verify only Active and Inactive buttons exist (no All button)
  const statusFilterGroup = page.locator("div.inline-flex.shrink-0.items-center.rounded-\\[10px\\].border");
  await expect(statusFilterGroup.getByRole("button", { name: "Active", exact: true })).toBeVisible();
  await expect(statusFilterGroup.getByRole("button", { name: "Inactive", exact: true })).toBeVisible();
  await expect(statusFilterGroup.getByRole("button", { name: "All", exact: true })).toHaveCount(0);

  // Active should be selected by default (has dark background class)
  const activeButton = statusFilterGroup.getByRole("button", { name: "Active", exact: true });
  await expect(activeButton).toHaveClass(/bg-\[#11120d\]/);
});

test("attention banner has badge with count, text without repeated number, and same-row buttons", async ({ page }) => {
  await setupProductsPageMock(page);
  await page.goto("/products");

  const heading = page.getByRole("heading", { name: "Imports need attention", exact: true });
  await expect(heading).toBeVisible();

  // The badge shows 3
  const banner = page.locator("section[aria-labelledby='import-activity-heading']");
  await expect(banner.locator("span", { hasText: "3" }).first()).toBeVisible();

  // Heading text does NOT contain "3"
  const headingText = await heading.textContent();
  expect(headingText?.trim()).toBe("Imports need attention");

  // Verify buttons exist: Recent imports, then Show list
  const recentImportsBtn = banner.getByRole("button", { name: /Recent imports/i });
  const showListBtn = banner.getByRole("button", { name: /Show list/i });
  await expect(recentImportsBtn).toBeVisible();
  await expect(showListBtn).toBeVisible();

  // Verify Recent imports appears BEFORE Show list in DOM order
  const buttons = banner.locator("button");
  const btnTexts = await buttons.allTextContents();
  const recentIdx = btnTexts.findIndex((t) => t.includes("Recent imports"));
  const showIdx = btnTexts.findIndex((t) => t.includes("Show list"));
  expect(recentIdx).toBeLessThan(showIdx);

  // Expand list and check separated cards with distinct file icons and badges
  await showListBtn.click();
  await expect(banner.getByRole("button", { name: /Hide list/i })).toBeVisible();

  // Card 1: PDF has picture_as_pdf icon
  const pdfCard = banner.locator("button", { hasText: "Household SPL.pdf" });
  await expect(pdfCard).toBeVisible();
  await expect(pdfCard.locator("span.material-symbols-rounded:has-text('picture_as_pdf')")).toBeVisible();
  await expect(pdfCard.getByText("Ready to review")).toBeVisible();

  // Card 2: XLSX has table_chart icon
  const excelCard = banner.locator("button", { hasText: "KhataSathi_Super_Plastic_Catalog.xlsx" });
  await expect(excelCard).toBeVisible();
  await expect(excelCard.locator("span.material-symbols-rounded:has-text('table_chart')")).toBeVisible();

  // Card 3: IMAGE has image icon and Needs attention badge
  const imageCard = banner.locator("button", { hasText: "KI MOP.jpeg" });
  await expect(imageCard).toBeVisible();
  await expect(imageCard.locator("span.material-symbols-rounded:has-text('image')")).toBeVisible();
  await expect(imageCard.getByText("Needs attention")).toBeVisible();
});

test("attention banner remains on a single row without wrapping on mobile (375px)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setupProductsPageMock(page);
  await page.goto("/products");

  const banner = page.locator("section[aria-labelledby='import-activity-heading']");
  await expect(banner).toBeVisible();

  const heading = banner.locator("#import-activity-heading");
  const recentBtn = banner.getByRole("button", { name: /Recent imports/i });
  const showBtn = banner.getByRole("button", { name: /Show list/i });

  await expect(heading).toBeVisible();
  await expect(recentBtn).toBeVisible();
  await expect(showBtn).toBeVisible();

  // Check that heading and buttons are on the same row (their vertical centers / top positions align)
  const headingBox = await heading.boundingBox();
  const recentBox = await recentBtn.boundingBox();
  const showBox = await showBtn.boundingBox();

  expect(headingBox).not.toBeNull();
  expect(recentBox).not.toBeNull();
  expect(showBox).not.toBeNull();

  // Vertical overlap: all three items share a common horizontal line
  const maxYTop = Math.max(headingBox!.y, recentBox!.y, showBox!.y);
  const minYBottom = Math.min(
    headingBox!.y + headingBox!.height,
    recentBox!.y + recentBox!.height,
    showBox!.y + showBox!.height
  );
  expect(minYBottom).toBeGreaterThan(maxYTop); // They overlap vertically, i.e. Same row!

  // No horizontal page overflow
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
