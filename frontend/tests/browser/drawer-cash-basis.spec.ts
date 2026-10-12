import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role = "manager") {
  const actor = { id: "drawer-actor", name: "Drawer actor", role };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  const basis = { kind: "CURRENT_SOURCE_ROWS", asOf: "2026-10-12T00:00:00Z", legacyCashRefundCount: 1 };
  const drawer = { id: "open", cashierId: actor.id, cashier: actor, status: "OPEN", openedAt: "2026-10-11T10:00:00Z", openingFloat: 100, expectedTotal: 140.25, cashSalesTotal: 50.25, cashInTotal: 10, cashOutTotal: 20, actualTotal: null, difference: null, cashBasis: basis };
  const saved = { ...drawer, id: "closed", status: "CLOSED", closedAt: "2026-10-11T11:00:00Z", expectedTotal: 777, actualTotal: 780, difference: 3, cashBasis: { ...basis, kind: "CLOSED_CAPTURE", legacyCashRefundCount: null } };
  const state = { fail: false, drawerReads: 0 };
  await page.route(u => u.pathname.startsWith("/api/"), async route => {
    const p = new URL(route.request().url()).pathname;
    const reply = (data: any, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p.endsWith("/auth/me")) return reply({ user: actor });
    if (p.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (p.startsWith("/api/cash-drawers")) { state.drawerReads++; if (state.fail) return reply({ error: "Source unavailable" }, 503); return reply(p.endsWith("/current") ? { drawer } : { drawers: [drawer, saved] }); }
    if (p.endsWith("/reports/analytics")) {
      if (state.fail) return reply({ error: "Source unavailable" }, 503);
      return reply({ summary: { netSales: 1000, totalInvoices: 1 }, topProducts: [], brandPerformance: [], cashierPerformance: [], salesTrend: [], paymentDistribution: [], operations: { cashDrawers: { openCount: 1, openDrawers: [drawer] }, stock: { outOfStockCount: 0, lowStockCount: 0, slowMovingCount: 0, lowStockProducts: [] }, discountRequests: { pendingCount: 0, recent: [] }, returns: { pendingCount: 0, approvedCount: 0, refundAmount: 0 }, parkedBills: { count: 0, recent: [] }, recentStockReceives: [] } });
    }
    if (p === "/api/invoices") return reply({ invoices: [], total: 0 });
    if (p === "/api/products") return reply({ products: [], total: 0 });
    return reply({ items: [], total: 0, alerts: [], settings: { businessMode: "FULL_POS" } });
  });
  return state;
}

for (const width of [1440, 390]) {
  test(`drawer settings disclose current and saved cash basis with keyboard controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await setup(page, "admin"); await page.goto("/settings?tab=drawer");
    await expect(page.getByText("Current source totals", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Legacy refunds are not deducted automatically/).first()).toBeVisible();
    await expect(page.getByText(/Saved closing totals/).first()).toBeVisible();
    await expect(page.getByText(/drawer attribution is unknown/).first()).toBeVisible();
    const close = page.getByRole("button", { name: "Close Drawer", exact: true }); await close.focus(); await page.keyboard.press("Enter");
    await expect(page.getByText(/Expected balance is Rs/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`drawer-settings-${width}.png`), fullPage: true });
  });
  test(`manager dashboard discloses source cash and legacy limit at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await setup(page); await page.goto("/");
    await expect(page.getByText(/Opening float \+ recorded cash charges/)).toBeVisible();
    await expect(page.getByText(/legacy cash refund entries; attribution unknown/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByText(/Opening float \+ recorded cash charges/).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`drawer-dashboard-${width}.png`), fullPage: true });
  });
}

test("failed drawer sources withhold balances and recover through existing retry", async ({ page }) => {
  const state = await setup(page, "admin"); state.fail = true; await page.goto("/settings?tab=drawer");
  await expect(page.getByRole("alert").filter({ hasText: "Some settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Drawer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close Drawer", exact: true })).toHaveCount(0);
  state.fail = false; await page.getByRole("button", { name: "Retry settings", exact: true }).click();
  await expect(page.getByText("Current source totals", { exact: true }).first()).toBeVisible(); expect(state.drawerReads).toBeGreaterThan(2);
});

test("manager source failure is unavailable rather than an empty drawer result", async ({ page }) => {
  const state = await setup(page); state.fail = true; await page.goto("/");
  await expect(page.getByText("Cash drawer totals unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No open cash drawers", { exact: true })).toHaveCount(0);
});
