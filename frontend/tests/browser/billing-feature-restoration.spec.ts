import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role = "cashier") {
  const user = { id: "restore-cashier", name: "Fixture operator", role };
  const customer = { id: "restore-buyer", name: "Fixture buyer", phone: "9841000000", address: "Kathmandu" };
  const products = [
    { id: "alpha", name: "Alpha product", sku: "ALPHA", retailPrice: 100, stock: 3, quantityStep: 1, isActive: true, sellingPriceStatus: "READY" },
    { id: "empty", name: "Empty product", sku: "EMPTY", retailPrice: 100, stock: 0, quantityStep: 1, isActive: true, sellingPriceStatus: "READY" },
    { id: "unpriced", name: "Unpriced product", sku: "UNPRICED", retailPrice: 0, stock: 10, quantityStep: 1, isActive: true, sellingPriceStatus: "PENDING" },
  ];
  let request: any = { id: "restore-request", requestNo: "REQ-RESTORE", status: "PENDING", firstViewedAt: null, createdAt: "2026-10-15T08:00:00Z", createdBy: { name: "Fixture staff" }, customerName: customer.name, customerId: customer.id, items: [{ id: "request-line", productId: "alpha", qty: 1, product: products[0], reviewStatus: "ACCEPTED" }] };
  const calls = { accept: 0, viewed: 0, checkout: 0, list: 0, searchHolds: 0 };
  let failAccept = false;
  let failList = false;
  let releaseSearch: (() => void) | null = null;
  let blockSearch = false;
  await page.addInitScript(user => localStorage.setItem("khatasathi_auth_user", JSON.stringify(user)), user);
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return send({ user });
    if (path.endsWith("/capabilities")) return send({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (path.endsWith("/settings/business")) return send({ businessName: "Fixture Shop" });
    if (path.includes("/products")) {
      if (blockSearch && url.searchParams.get("search")) { calls.searchHolds++; await new Promise<void>(resolve => { releaseSearch = resolve; }); }
      return send({ products, total: products.length });
    }
    if (path.endsWith("/customers/lookup")) return send({ items: [customer], total: 1, page: 1, pageSize: 20 });
    if (path.endsWith("/customers")) return send([customer]);
    if (path.endsWith("/receivables-summary")) return send({ state: "NONE", hasDue: false, totalDue: 0, currency: "NPR" });
    if (path.endsWith("/draft-requests")) { calls.list++; return failList ? send({ error: "Request queue unavailable" }, 503) : send({ requests: [request], total: 1 }); }
    if (path.endsWith("/draft-requests/restore-request/viewed")) { calls.viewed++; request = { ...request, firstViewedAt: "2026-10-15T09:00:00Z" }; return send({ request }); }
    if (path.endsWith("/draft-requests/restore-request/accept")) {
      calls.accept++;
      if (failAccept) return send({ error: "Request acceptance failed" }, 503);
      expect(route.request().postDataJSON()).toEqual({ items: [{ itemId: "request-line", action: "ACCEPT", acceptedQty: 1 }] });
      request = { ...request, status: "ACCEPTED", acceptedById: user.id, items: request.items.map((item: any) => ({ ...item, acceptedQty: 1 })) };
      return send({ request });
    }
    if (path.endsWith("/draft-requests/restore-request")) return send({ request });
    if (path.includes("/checkout")) { calls.checkout++; throw new Error("Restoration fixture must not post checkout"); }
    if (path.endsWith("/payment-accounts/enabled") || path.endsWith("/categories") || path.endsWith("/brands")) return send([]);
    if (path.endsWith("/invoices/parked")) return send({ drafts: [] });
    return send({});
  });
  await page.goto("/billing");
  await expect(page.getByRole("button", { name: "Add Alpha product to cart", exact: true })).toBeVisible();
  return { calls, failAccept: (value: boolean) => { failAccept = value; }, failList: (value: boolean) => { failList = value; }, holdSearch: () => { blockSearch = true; }, releaseSearch: () => { blockSearch = false; releaseSearch?.(); } };
}

test("cashier Requests opens the queue, retains failed review and loads the accepted association", async ({ page }) => {
  const fixture = await setup(page);
  const trigger = page.getByRole("button", { name: "Requests (1 pending, 1 unseen)", exact: true });
  await trigger.click();
  const queue = page.getByRole("dialog", { name: "Incoming Requests", exact: true });
  await queue.getByRole("button", { name: /REQ-RESTORE/ }).click();
  const review = page.getByRole("dialog", { name: "REQ-RESTORE", exact: true });
  await expect(review).toContainText("Alpha product");
  expect(fixture.calls.viewed).toBe(1);
  fixture.failAccept(true);
  await review.getByRole("button", { name: "Review & Load", exact: true }).click();
  await expect(page.getByText("Request acceptance failed", { exact: true }).first()).toBeVisible();
  await expect(review).toBeVisible();
  await expect(page.locator(".billing-cart-row")).toHaveCount(0);
  fixture.failAccept(false);
  await review.getByRole("button", { name: "Review & Load", exact: true }).click();
  await expect(page.locator(".billing-cart-row")).toHaveCount(1);
  await expect(page.getByText("Staff request loaded. Finalizing this bill completes the request automatically.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("khatasathi_billing_cart") || "{}").activeDraftRequestId)).toBe("restore-request");
  await page.getByRole("button", { name: "Dismiss staff request notice" }).click();
  await expect(page.getByRole("button", { name: "Dismiss staff request notice" })).toHaveCount(0);
  expect(fixture.calls.accept).toBe(2);
  expect(fixture.calls.checkout).toBe(0);
});

test("queue read errors remain visible and Refresh retries", async ({ page }) => {
  const fixture = await setup(page); await expect(page.getByRole("button", { name: /Requests \(1 pending/ })).toBeVisible();
  fixture.failList(true); await page.getByRole("button", { name: /Requests \(1 pending/ }).click();
  const dialog = page.getByRole("dialog", { name: "Incoming Requests", exact: true });
  await expect(dialog).toContainText("Request queue unavailable");
  fixture.failList(false); await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(dialog.getByText("Request queue unavailable")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /REQ-RESTORE/ })).toBeVisible();
});

test("manager does not get the cashier incoming Requests entry", async ({ page }) => {
  await setup(page, "manager"); await expect(page.getByRole("button", { name: /^Requests \(/ })).toHaveCount(0);
});

test("catalog keyboard selection respects stock, pricing and Escape clears the actual query", async ({ page }) => {
  await setup(page); const search = page.getByRole("combobox", { name: "Search products", exact: true });
  await search.fill("product"); await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", "catalog-result-alpha");
  await search.press("ArrowDown"); await expect(search).toHaveAttribute("aria-activedescendant", "catalog-result-empty"); await search.press("Enter");
  await expect(page.locator(".billing-cart-row")).toHaveCount(0);
  await search.press("ArrowDown"); await search.press("Enter"); await expect(page.locator(".billing-cart-row")).toHaveCount(0);
  await search.press("ArrowUp"); await search.press("ArrowUp"); await search.press("Enter");
  await expect(page.locator("#qty-input-alpha")).toHaveValue("1");
  await search.press("Enter"); await search.press("Enter"); await expect(page.locator("#qty-input-alpha")).toHaveValue("3");
  await expect(page.getByRole("button", { name: "Add Alpha product to cart", exact: true })).toBeDisabled();
  await search.press("Enter"); await expect(page.locator("#qty-input-alpha")).toHaveValue("3");
  await search.press("Escape"); await expect(search).toHaveValue("");
});

test("pending catalog results cannot be added from stale keyboard selection", async ({ page }) => {
  const fixture = await setup(page); fixture.holdSearch();
  const search = page.getByRole("combobox", { name: "Search products", exact: true }); await search.fill("delayed");
  await expect.poll(() => fixture.calls.searchHolds).toBe(1);
  await expect(search).toHaveAttribute("aria-expanded", "false"); await search.press("Enter");
  await expect(page.locator(".billing-cart-row")).toHaveCount(0);
  fixture.releaseSearch(); await expect(search).toHaveAttribute("aria-expanded", "true");
});

test("empty customer draft has Clear with cancellation and existing reset semantics", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Select", exact: true }).first().click();
  await page.getByRole("button", { name: "Select Fixture buyer", exact: true }).click();
  await page.getByRole("button", { name: "Clear (F9)", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear this cart?", exact: true });
  await expect(dialog).toContainText("Fixture buyer"); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".billing-customer-section")).toContainText("Fixture buyer");
  await page.getByRole("button", { name: "Clear (F9)", exact: true }).click();
  await dialog.getByRole("button", { name: "Clear Cart", exact: true }).click();
  await expect(page.locator(".billing-customer-section")).toContainText("Walk-in Customer");
});

test("shortcut help restores discoverability of existing held, quantity and payment bindings", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name: "Keyboard Shortcuts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "POS Keyboard Shortcuts", exact: true });
  for (const text of ["Alt + H", "Alt + Backspace", "Alt + P", "Alt + 1 / 2 / 3 / 4", "Alt + A", "↑ / ↓, Enter"]) await expect(dialog).toContainText(text);
});


test("catalog keyboard leaves modified cart and review shortcuts to Billing", async ({ page }) => {
  await setup(page);
  const search = page.getByRole("combobox", { name: "Search products", exact: true });
  await search.fill("product");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await search.press("Alt+ArrowDown");
  await expect(search).toHaveAttribute("aria-activedescendant", "catalog-result-alpha");
  await search.press("Enter");
  await expect(page.locator("#qty-input-alpha")).toHaveValue("1");
  await search.press("Shift+Enter");
  await expect(page.getByRole("heading", { name: "Sales Worksheet", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("khatasathi_billing_cart") || "{}").cart?.[0]?.qty)).toBe(1);
});
