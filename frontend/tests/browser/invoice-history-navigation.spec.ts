import { expect, test, type Page, type Route } from "@playwright/test";

const user = { id: "cashier", name: "Cashier", role: "cashier" };
const product = { id: "product", name: "History product", sku: "SKU-H", retailPrice: 25, wholesalePrice: 25, stock: 50, isActive: true, quantityStep: 1 };
const customer = { id: "customer", name: "History customer", isActive: true };
const invoice = (id: string, invoiceNo = id) => ({
  id, invoiceNo, status: "PAID", paymentStatus: "PAID", createdAt: "2026-08-10T14:30:00.000Z",
  subTotal: 25, netTotal: 25, paidTotal: 25, dueAmount: 0, items: [],
  cashier: { id: "cashier", name: "Cashier" },
});

async function setup(page: Page, detail: (route: Route, id: string) => Promise<void>, list: unknown[] = []) {
  const writes: string[] = [];
  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    // The app shell has an existing presence heartbeat; invoice navigation must add no domain writes.
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method()) && path !== "/api/users/me/presence") writes.push(path);
    const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return respond({ user });
    if (path.endsWith("/capabilities")) return respond({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (path === "/api/invoices") return respond({ invoices: list, total: list.length });
    if (path.startsWith("/api/invoices/")) return detail(route, decodeURIComponent(path.slice("/api/invoices/".length)));
    if (path.endsWith("/customers")) return respond([customer]);
    if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids")) return respond({ products: [product], total: 1 });
    if (path.endsWith("/product-history")) return respond({ history: [
      { id: "history", invoiceId: "inv &?#/1", invoiceNo: "ENCODED", invoiceDate: "2026-08-10T14:30:00Z", productId: product.id, productName: product.name, qty: 2, appliedUnitPrice: 25 },
      ...[null, "  ", 42, "bad\u0000id", "\ud800"].map((invoiceId, index) => ({ id: `invalid-${index}`, invoiceId, invoiceNo: `INVALID-${index}`, invoiceDate: "2026-08-10T14:30:00Z", productId: product.id, productName: product.name, qty: 1, appliedUnitPrice: 25 })),
    ] });
    return respond({});
  });
  return writes;
}

test("encoded history link preserves the exact pending checkout, draft and request through client navigation", async ({ page }) => {
  let fetchedId = "";
  const writes = await setup(page, async (route, id) => {
    fetchedId = id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(invoice(id, "ENCODED")) });
  });
  const pending = {
    operationKey: "checkout-history-navigation-123",
    payload: { customerId: customer.id, draftInvoiceId: "draft-1", draftRequestId: "request-1", items: [{ productId: product.id, qty: 2 }], payments: [{ method: "CASH", amount: 50 }], confirmation: { payableTotal: 50 } },
    activeDraftRequestId: "request-1",
  };
  await page.addInitScript(({ pending }) => {
    if (sessionStorage.getItem("history-cart-seeded")) return;
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({ cart: pending.payload.items, pendingCheckout: pending, selectedCustomerId: pending.payload.customerId, activeDraftInvoiceId: "draft-1", activeDraftRequestId: "request-1", savedAt: new Date().toISOString() }));
    sessionStorage.setItem("history-cart-seeded", "true");
  }, { pending });
  await page.goto("/billing");
  const link = page.getByRole("link", { name: "View invoice ENCODED" });
  await expect(link).toHaveAttribute("href", "/invoices?invoiceId=inv%20%26%3F%23%2F1");
  for (let index = 0; index < 5; index++) {
    await expect(page.getByText(`Qty: 1 · Inv #INVALID-${index}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `View invoice INVALID-${index}` })).toHaveCount(0);
  }
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Invoice ENCODED", exact: true })).toBeVisible();
  expect(fetchedId).toBe("inv &?#/1");
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem("khatasathi_billing_cart")!));
  expect((await state()).pendingCheckout).toEqual(pending);
  await page.goBack();
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /History customer/ })).toBeVisible();
  const restored = await state();
  expect(restored.pendingCheckout).toEqual(pending);
  expect(restored.cart).toEqual(pending.payload.items);
  expect(restored.activeDraftInvoiceId).toBe("draft-1");
  expect(restored.activeDraftRequestId).toBe("request-1");
  expect(restored.selectedCustomerId).toBe(customer.id);
  expect(writes).toEqual([]);
});

for (const failure of ["forbidden", "not-found", "network", "unauthorized"] as const) {
  test(`${failure} detail read never falls back to a cached list invoice`, async ({ page }) => {
    let reads = 0;
    const writes = await setup(page, async (route) => {
      reads++;
      if (failure === "network") return route.abort("failed");
      await route.fulfill({ status: failure === "forbidden" ? 403 : failure === "unauthorized" ? 401 : 404, contentType: "application/json", body: JSON.stringify({ error: `Detail ${failure}` }) });
    }, [invoice("cached", "CACHED")]);
    await page.goto("/invoices?invoiceId=cached");
    if (failure === "unauthorized") {
      await expect(page).toHaveURL(/\/login/);
    } else {
      const dialog = page.getByRole("dialog", { name: "Invoice load error" });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Invoice CACHED", exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page).toHaveURL(/\/invoices$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(reads).toBe(1);
    }
    expect(writes).toEqual([]);
  });
}

test("URL target removal, target switching and same-ID reopening discard older responses", async ({ page }) => {
  let release: (() => void) | undefined;
  let held = false;
  let reads = 0;
  const writes = await setup(page, async (route, id) => {
    reads++;
    if (id === "slow" && reads === 1) {
      held = true;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(invoice(id, id === "slow" ? "SLOW" : "FAST")) });
  }, [invoice("slow", "SLOW"), invoice("fast", "FAST")]);
  await page.goto("/invoices");
  // Real browser history changes drive React Router's query entrypoint.
  const target = (id: string | null) => page.evaluate((id) => {
    history.pushState({ ...history.state }, "", id ? `/invoices?invoiceId=${id}` : "/invoices");
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
  await target("slow");
  await expect(page.getByRole("dialog", { name: "Loading invoice details" })).toBeVisible();
  await expect.poll(() => held).toBe(true);
  await target(null);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await target("fast");
  await expect(page.getByRole("dialog", { name: "Invoice FAST", exact: true })).toBeVisible();
  await target("slow");
  await expect(page.getByRole("dialog", { name: "Loading invoice details" })).toBeVisible();
  // The API coalesces in-flight reads. Only the current opener may consume that response.
  release!();
  await expect(page.getByRole("dialog", { name: "Invoice SLOW", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Invoice SLOW", exact: true }).getByLabel("Close", { exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Ordinary row opening still fetches authoritative detail.
  await page.getByRole("button", { name: "View invoice FAST" }).click();
  await expect(page.getByRole("dialog", { name: "Invoice FAST", exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});
