import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

async function setup(page: Page, role = "admin") {
  const actor = { id: "basis-actor", name: "Basis actor", role };
  await page.addInitScript(actor => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor));
    localStorage.setItem("khatasathi_token", "test-session");
  }, actor);
  const state = { fail: false, empty: false, analyticsReads: 0 };
  await page.route(u => u.pathname.startsWith("/api/"), async route => {
    const p = new URL(route.request().url()).pathname;
    const reply = (data: any, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p.endsWith("/auth/me")) return reply({ user: actor });
    if (p.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (p.endsWith("/reports/sales")) return reply({ totalSales: 900, totalRevenue: 900, invoiceCount: 1, totalPaid: 350, totalCollected: 350 });
    if (p.endsWith("/reports/analytics")) {
      state.analyticsReads++;
      if (state.fail) return reply({ error: "Report unavailable" }, 503);
      const url = new URL(route.request().url());
      return reply({ filters: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
        meta: { generatedAt: "2026-10-12T02:00:00Z", bucketGranularity: "day", rangeDays: 7 }, cashiers: [],
        summary: { invoiceCount: state.empty ? 0 : 1, finalizedInvoiceCount: state.empty ? 0 : 1, cancelledInvoiceCount: 0, paidInvoiceCount: 0, partiallyPaidInvoiceCount: 1, unpaidInvoiceCount: 0, customerCount: 1, cashierCount: 1, walkInInvoiceCount: 0, netSales: 900, grossSales: 1000, discountTotal: 100, collectedTotal: 350, dueTotal: 550, averageBasketSize: 900, collectionRate: 38.89, discountRate: 10, itemsSold: 10 },
        topProducts: [], topCustomers: [], brandPerformance: [], cashierPerformance: [], paymentDistribution: [],
        salesOverTime: [{ key: "today", label: "Today", revenue: 900, collected: 350, due: 550, discount: 100, invoices: 1, itemsSold: 10, averageBasket: 900 }],
        operations: { cashDrawers: { openCount: 0, openDrawers: [] }, stock: { outOfStockCount: 0, lowStockCount: 0, slowMovingCount: 0, lowStockProducts: [] }, discountRequests: { pendingCount: 0, recent: [] }, returns: { pendingCount: 0, approvedCount: 1, refundAmount: 200 }, parkedBills: { count: 0, recent: [] }, recentStockReceives: [] } });
    }
    if (p === "/api/invoices") return reply({ invoices: [], total: 0 });
    if (p === "/api/products") return reply({ products: [], total: 0 });
    return reply({ items: [], total: 0, alerts: [] });
  });
  return state;
}

for (const width of [1440, 390]) {
  for (const role of ["admin", "manager"]) {
    test(`${role} dashboard and analytics show invoice basis at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 }); await setup(page, role); await page.goto("/");
      const notice = page.getByRole("region", { name: "Sales reporting basis" });
      await expect(notice.getByText("Invoice sales: after discounts, before returns", { exact: true })).toBeVisible();
      await expect(page.getByText(role === "manager" ? "Invoice Sales Today" : "Invoice Sales (7d)", { exact: true }).first()).toBeVisible();
      if (role === "manager") await expect(page.getByText("Approved Return Requests Today", { exact: true })).toBeVisible();
      const summary = notice.locator("summary"); await summary.focus(); await page.keyboard.press("Enter");
      await expect(notice.getByText(/lifetime successful non-refund charges, capped/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`dashboard-${role}-${width}.png`), fullPage: true });
      await page.goto("/analytics");
      await expect(page.getByText("Invoice Sales", { exact: true })).toBeVisible();
      await expect(page.getByText("Invoice-basis Due", { exact: true })).toBeVisible();
      await expect(page.getByText("Net Sales", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Export Excel" })).toHaveCount(role === "admin" ? 1 : 0);
      await page.getByRole("region", { name: "Sales reporting basis" }).locator("summary").click();
      await expect(page.getByText(/Tax is not removed or assumed known/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const fonts = await page.evaluate(async () => { await document.fonts.ready; return { plex: document.fonts.check('13px "IBM Plex Sans"'), symbols: document.fonts.check('24px "Material Symbols Rounded"') }; });
      expect(fonts).toEqual({ plex: true, symbols: true });
      await page.screenshot({ path: info.outputPath(`analytics-${role}-${width}.png`), fullPage: true });
    });
  }
}

test("Excel download preserves amounts and includes detached reporting basis", async ({ page }) => {
  await setup(page); await page.goto("/analytics");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Excel", exact: true }).click();
  const download = await downloading;
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await download.path())!);
  const basis = workbook.getWorksheet("Reporting Basis")!;
  expect(basis.getRow(1).values).toContain("Basis / limitations");
  const contents = JSON.stringify(basis.getSheetValues());
  expect(contents).toContain("before approved-return or refund adjustments");
  expect(contents).toContain("not return-adjusted net revenue");
  const rows = workbook.getWorksheet("Summary")!.getSheetValues() as any[];
  expect(rows.some(row => row?.[1] === "Invoice sales (after discounts, before returns)" && row[2] === 900)).toBe(true);
  expect(rows.some(row => row?.[1] === "Recorded collections" && row[2] === 350)).toBe(true);
  expect(rows.some(row => row?.[1] === "Invoice-basis due" && row[2] === 550)).toBe(true);
  expect(workbook.getWorksheet("Sales Over Time")!.getRow(1).values).toContain("Invoice sales");
});

test("basis remains visible for analytics empty/error and dashboard summary fallback", async ({ page }) => {
  const state = await setup(page); state.empty = true; await page.goto("/analytics");
  await expect(page.getByText("No finalized sales data found", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sales reporting basis" })).toBeVisible();
  state.fail = true; await page.reload();
  await expect(page.getByText("Analytics unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sales reporting basis" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Recorded Collections (7d)", { exact: true })).toBeVisible();
  await expect(page.getByText("Invoice-basis Due (7d)", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sales reporting basis" })).toBeVisible();
});
