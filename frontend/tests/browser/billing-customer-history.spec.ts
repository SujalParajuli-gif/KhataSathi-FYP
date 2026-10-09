import { expect, test } from "@playwright/test";

const cashier = { id: "user-cashier", name: "Billing Cashier", role: "cashier" };

test("history preview discloses its 20-product limit and scopes its empty-state claim", async ({ page }) => {
  const products = Array.from({ length: 21 }, (_, index) => ({
    id: `product-${index + 1}`, name: `Test product ${index + 1}`, sku: `SKU-${index + 1}`,
    retailPrice: 25, wholesalePrice: 25, stock: 50, isActive: true, quantityStep: 1,
  }));
  let queriedIds: string[] = [];
  await page.addInitScript(({ user, products }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: products.map((product) => ({ productId: product.id, qty: 1 })),
      selectedCustomerId: "customer", savedAt: new Date().toISOString(),
    }));
  }, { user: cashier, products });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const respond = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/auth/me")) return respond({ user: cashier });
    if (url.pathname.endsWith("/capabilities")) return respond({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (url.pathname.endsWith("/product-history")) {
      queriedIds = (url.searchParams.get("productIds") || "").split(",");
      return respond({ history: [] });
    }
    if (url.pathname.endsWith("/customers")) return respond([{ id: "customer", name: "Test customer", isActive: true }]);
    if (url.pathname.endsWith("/products") || url.pathname.endsWith("/products/lookup")) return respond({ products, total: products.length });
    if (url.pathname.endsWith("/brands") || url.pathname.endsWith("/categories")) return respond([]);
    return respond({});
  });
  await page.goto("/billing");
  await expect(page.getByText("Showing history for the first 20 of 21 cart products.")).toBeVisible();
  await expect(page.getByText("No previous purchases recorded for the 20 products checked.")).toBeVisible();
  expect(queriedIds).toHaveLength(20);
  await expect(page.getByText("No previous purchases recorded for items in this cart.")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();
});

test("billing displays bounded advisory customer purchase history for cart items without altering cart pricing", async ({ page }) => {
  const testCustomer = {
    id: "cust-1",
    name: "Ram Kumar Shrestha",
    phone: "+9779841234567",
    loyaltyPercent: 0,
    wholesalePercent: 0,
    isActive: true,
  };
  const alternateCustomer = {
    id: "cust-2",
    name: "Sita Store",
    phone: "+9779812345678",
    loyaltyPercent: 0,
    wholesalePercent: 0,
    isActive: true,
  };

  const product1 = {
    id: "prod-1",
    name: "Wai Wai Instant Noodles",
    sku: "WAI-101",
    barcode: "8901234567890",
    retailPrice: 25,
    wholesalePrice: 22,
    wholesaleQtyThreshold: 10,
    stock: 50,
    isActive: true,
    allowFractionalQty: false,
    quantityStep: 1,
  };

  let productHistoryCalls = 0;
  let requestedProductIds: string[] = [];
  let shouldFailHistory = false;
  let holdNextHistory = false;
  let releaseHeldHistory: (() => void) | undefined;

  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, cashier);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const urlObj = new URL(route.request().url());
    const path = urlObj.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user: cashier });
    if (path.endsWith("/capabilities"))
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });

    if (path.includes("/product-history")) {
      productHistoryCalls++;
      const productIdsParam = urlObj.searchParams.get("productIds") || "";
      requestedProductIds = productIdsParam.split(",").filter(Boolean);

      if (holdNextHistory) {
        holdNextHistory = false;
        await new Promise<void>((resolve) => { releaseHeldHistory = resolve; });
        try {
          return await respond({
            history: [{
              id: "stale-item",
              invoiceId: "stale-invoice",
              invoiceNo: "STALE-1",
              invoiceDate: "2026-08-10T14:30:00.000Z",
              productId: "prod-1",
              productName: "Wai Wai Instant Noodles",
              productSku: "WAI-101",
              qty: 99,
              appliedUnitPrice: 1,
            }],
          });
        } catch {
          // The browser may already have aborted this obsolete request.
          return;
        }
      }

      if (shouldFailHistory) {
        return respond({ error: "Internal error" }, 500);
      }

      if (path.includes("/cust-2/")) return respond({ history: [] });

      // Return historical purchase at Rs 20 (current retail is Rs 25)
      return respond({
        history: [
          {
            id: "inv-item-old-1",
            invoiceId: "inv-old-101",
            invoiceNo: "INV-2026-0042",
            invoiceDate: "2026-08-10T14:30:00.000Z",
            productId: "prod-1",
            productName: "Wai Wai Instant Noodles",
            productSku: "WAI-101",
            displayProduct: { name: "Historical noodles", sku: "OLD-101", source: "LEGACY_LIVE_FALLBACK" },
            qty: 5,
            appliedUnitPrice: 20,
          },
        ],
      });
    }

    if (path.endsWith("/customers")) return respond([testCustomer, alternateCustomer]);
    if (path.endsWith("/products"))
      return respond({
        products: [product1],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
    return respond({});
  });

  await page.goto("/billing");

  // 1. Initial empty state: No history section visible when no customer/cart
  await expect(page.getByText("Recent Cart Purchases")).not.toBeVisible();

  // 2. Select customer
  await expect(page.getByRole("button", { name: "Change customer" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Change customer" }).click();
  await page.getByText("Ram Kumar Shrestha").click();

  // Still not visible because cart is empty
  await expect(page.getByText("Recent Cart Purchases")).not.toBeVisible();

  // 3. Search and add product to cart
  const searchInput = page.getByPlaceholder("Search product name, SKU, brand... (F2)");
  await searchInput.fill("Wai Wai");
  await page.getByText("Wai Wai Instant Noodles").first().click();

  // 4. Verify advisory history section appears with historical details
  await expect(page.getByText("Recent Cart Purchases")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Advisory")).toBeVisible();
  await expect(page.getByText("NPR 20")).toBeVisible(); // Historical applied unit price
  await expect(page.getByText("Qty: 5 ·")).toBeVisible();
  await expect(page.getByRole("link", { name: "View invoice INV-2026-0042" })).toBeVisible();
  await expect(page.getByText("Historical noodles")).toBeVisible();
  await expect(page.getByText("Legacy identity — current labels")).toBeVisible();
  await expect(
    page.getByText("Historical prices are reference context only and do not modify current billing rates."),
  ).toBeVisible();

  // 5. CRITICAL CHECK: Current cart pricing must remain the active catalog price (Rs 25), NOT historical (Rs 20)
  const cartSubtotal = page.locator("div.font-mono.font-extrabold", { hasText: "NPR 25" });
  await expect(cartSubtotal.first()).toBeVisible();

  // A response for the previous customer must not become visible after customer selection changes.
  holdNextHistory = true;
  await page.getByRole("button", { name: "Increase quantity for Wai Wai Instant Noodles" }).click();
  await expect.poll(() => productHistoryCalls).toBe(2);
  await page.getByRole("button", { name: "Change customer" }).click();
  await page.getByRole("button", { name: /Sita Store/ }).click();
  await expect(page.getByText("No previous purchases recorded for items in this cart.")).toBeVisible();
  releaseHeldHistory?.();
  await page.waitForTimeout(100);
  await expect(page.getByText("STALE-1")).not.toBeVisible();

  // 6. Test non-blocking failure: If history API fails, checkout is still available
  shouldFailHistory = true;
  await page.getByRole("button", { name: "Increase quantity for Wai Wai Instant Noodles" }).click();
  await expect(page.getByText("Unable to load recent purchase history")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay/i }).first()).toBeEnabled();
});

test("billing customer purchase history link navigates to /invoices and opens detail modal for invoice including off-page invoices and preserves cart on return", async ({ page }) => {
  const testCustomer = {
    id: "cust-1",
    name: "Ram Kumar Shrestha",
    phone: "+9779841234567",
    loyaltyPercent: 0,
    wholesalePercent: 0,
    isActive: true,
  };

  const product1 = {
    id: "prod-1",
    name: "Wai Wai Instant Noodles",
    sku: "WAI-101",
    barcode: "8901234567890",
    retailPrice: 25,
    wholesalePrice: 22,
    wholesaleQtyThreshold: 10,
    stock: 50,
    isActive: true,
    allowFractionalQty: false,
    quantityStep: 1,
  };

  const offPageInvoiceDetail = {
    id: "inv-old-101",
    invoiceNo: "INV-2026-0042",
    status: "PAID",
    paymentStatus: "PAID",
    paymentMethod: "CASH",
    createdAt: "2026-08-10T14:30:00.000Z",
    customerId: "cust-1",
    customerName: "Ram Kumar Shrestha",
    customer: { id: "cust-1", name: "Ram Kumar Shrestha", phone: "+9779841234567" },
    displayCustomer: { name: "Ram Kumar Shrestha", source: "CAPTURED" },
    cashier: { id: "cashier-1", name: "Main Cashier" },
    subTotal: 100,
    discount: 0,
    netTotal: 100,
    paidTotal: 100,
    dueAmount: 0,
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        qty: 5,
        unitPrice: 20,
        lineTotal: 100,
        product: { id: "prod-1", name: "Wai Wai Instant Noodles", sku: "WAI-101" },
        displayProduct: { name: "Historical noodles", sku: "OLD-101", source: "LEGACY_LIVE_FALLBACK" },
      },
    ],
    payments: [
      { id: "pay-1", method: "CASH", kind: "CHARGE", status: "SUCCESS", amount: 100, createdAt: "2026-08-10T14:30:00.000Z" },
    ],
    creditNotesAsOriginal: [],
  };

  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, cashier);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const urlObj = new URL(route.request().url());
    const path = urlObj.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user: cashier });
    if (path.endsWith("/capabilities"))
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });

    if (path.includes("/product-history")) {
      return respond({
        history: [
          {
            id: "inv-item-old-1",
            invoiceId: "inv-old-101",
            invoiceNo: "INV-2026-0042",
            invoiceDate: "2026-08-10T14:30:00.000Z",
            productId: "prod-1",
            productName: "Wai Wai Instant Noodles",
            productSku: "WAI-101",
            displayProduct: { name: "Historical noodles", sku: "OLD-101", source: "LEGACY_LIVE_FALLBACK" },
            qty: 5,
            appliedUnitPrice: 20,
          },
        ],
      });
    }

    if (path.endsWith("/customers")) return respond([testCustomer]);
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({
        products: [product1],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    }

    // Invoice list does NOT include inv-old-101 (tests off-page deep-link lookup)
    if (path === "/api/invoices" && route.request().method() === "GET") {
      return respond({
        invoices: [
          {
            id: "inv-other-999",
            invoiceNo: "INV-2026-9999",
            status: "PAID",
            paymentStatus: "PAID",
            createdAt: "2026-09-01T10:00:00.000Z",
            customerId: null,
            cashier: { id: "cashier-1", name: "Main Cashier" },
            subTotal: 50,
            netTotal: 50,
            paidTotal: 50,
            dueAmount: 0,
            items: [],
          },
        ],
        total: 1,
      });
    }

    if (path === "/api/invoices/inv-old-101") {
      return respond(offPageInvoiceDetail);
    }

    if (path.endsWith("/cashiers/me/privileges")) {
      return respond({ privilege: { canVoidPayment: false } });
    }

    return respond({});
  });

  await page.goto("/billing");

  // Select customer & add product
  await page.getByRole("button", { name: "Change customer" }).click();
  await page.getByText("Ram Kumar Shrestha").click();
  await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Wai Wai");
  await page.getByText("Wai Wai Instant Noodles").first().click();

  // Verify link exists
  const invoiceLink = page.getByRole("link", { name: "View invoice INV-2026-0042" });
  await expect(invoiceLink).toBeVisible();

  // Click the link to navigate to invoices
  await invoiceLink.click();

  // Verify URL is /invoices?invoiceId=inv-old-101
  await expect(page).toHaveURL(/\/invoices\?invoiceId=inv-old-101/);

  // Verify Invoice Detail Modal is opened with full hydrated details
  const modal = page.getByRole("dialog", { name: "Invoice INV-2026-0042" });
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal.getByText("INV-2026-0042")).toBeVisible();
  await expect(modal.getByText("Ram Kumar Shrestha")).toBeVisible();
  await expect(modal.getByText("Historical noodles")).toBeVisible();
  await expect(modal.getByText("NPR 100").first()).toBeVisible();

  // Close the modal
  await modal.getByRole("button", { name: "Close" }).first().click();
  await expect(modal).not.toBeVisible();

  // Query parameter invoiceId should be removed upon close
  await expect(page).toHaveURL(/\/invoices(?!\?invoiceId=)/);

  // Return to billing and verify cart/customer state was preserved in localStorage
  await page.goto("/billing");
  await expect(page.getByRole("button", { name: /Ram Kumar Shrestha/ })).toBeVisible();
  await expect(page.getByText("Wai Wai Instant Noodles")).toBeVisible();
  const cartSubtotal = page.locator("div.font-mono.font-extrabold", { hasText: "NPR 25" });
  await expect(cartSubtotal.first()).toBeVisible();
});

test("handles keyboard link activation and plain text fallback for missing invoiceId", async ({ page }) => {
  const testCustomer = {
    id: "cust-1",
    name: "Ram Kumar Shrestha",
    phone: "+9779841234567",
    isActive: true,
  };

  const product1 = {
    id: "prod-1",
    name: "Wai Wai Instant Noodles",
    sku: "WAI-101",
    retailPrice: 25,
    wholesalePrice: 22,
    stock: 50,
    isActive: true,
  };

  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, cashier);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const urlObj = new URL(route.request().url());
    const path = urlObj.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return respond({ user: cashier });
    if (path.endsWith("/capabilities"))
      return respond({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true });
    if (path.includes("/product-history")) {
      return respond({
        history: [
          {
            id: "item-with-id",
            invoiceId: "inv-valid-1",
            invoiceNo: "INV-VALID-01",
            invoiceDate: "2026-08-10T14:30:00.000Z",
            productId: "prod-1",
            productName: "Wai Wai Instant Noodles",
            qty: 1,
            appliedUnitPrice: 25,
          },
          {
            id: "item-without-id",
            invoiceId: "",
            invoiceNo: "INV-NO-ID",
            invoiceDate: "2026-08-09T14:30:00.000Z",
            productId: "prod-1",
            productName: "Wai Wai Instant Noodles",
            qty: 2,
            appliedUnitPrice: 25,
          },
        ],
      });
    }
    if (path.endsWith("/customers")) return respond([testCustomer]);
    if (path.endsWith("/products")) return respond({ products: [product1], total: 1 });
    if (path === "/api/invoices/inv-valid-1") {
      return respond({
        id: "inv-valid-1",
        invoiceNo: "INV-VALID-01",
        status: "PAID",
        paymentStatus: "PAID",
        createdAt: "2026-08-10T14:30:00.000Z",
        customerId: "cust-1",
        customerName: "Ram Kumar Shrestha",
        cashier: { id: "cashier-1", name: "Main Cashier" },
        subTotal: 25,
        netTotal: 25,
        paidTotal: 25,
        dueAmount: 0,
        items: [],
      });
    }
    if (path.endsWith("/cashiers/me/privileges")) return respond({ privilege: { canVoidPayment: false } });
    return respond({});
  });

  await page.goto("/billing");
  await page.getByRole("button", { name: "Change customer" }).click();
  await page.getByText("Ram Kumar Shrestha").click();
  await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Wai Wai");
  await page.getByText("Wai Wai Instant Noodles").first().click();

  // Item with no invoiceId should render as plain text, not a link
  await expect(page.getByText("Qty: 2 · Inv #INV-NO-ID")).toBeVisible();
  await expect(page.getByRole("link", { name: "View invoice INV-NO-ID" })).not.toBeVisible();

  // Item with invoiceId has a keyboard-focusable link
  const validLink = page.getByRole("link", { name: "View invoice INV-VALID-01" });
  await expect(validLink).toBeVisible();
  await validLink.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/invoices\?invoiceId=inv-valid-1/);
  await expect(page.getByRole("dialog", { name: "Invoice INV-VALID-01" })).toBeVisible({ timeout: 10_000 });
});

test("handles invoice detail errors gracefully and prevents obsolete async response overwrite", async ({ page }) => {
  let holdInvoice = false;
  let releaseInvoice: (() => void) | undefined;

  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, cashier);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const urlObj = new URL(route.request().url());
    const path = urlObj.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return respond({ user: cashier });
    if (path.endsWith("/capabilities"))
      return respond({ businessMode: "FULL_POS", posEnabled: true });
    if (path === "/api/invoices" && route.request().method() === "GET") {
      return respond({ invoices: [], total: 0 });
    }
    if (path === "/api/invoices/not-found-id") {
      return respond({ error: "Invoice not found or deleted." }, 404);
    }
    if (path === "/api/invoices/slow-id") {
      if (holdInvoice) {
        holdInvoice = false;
        await new Promise<void>((resolve) => { releaseInvoice = resolve; });
      }
      return respond({
        id: "slow-id",
        invoiceNo: "INV-SLOW-01",
        status: "PAID",
        paymentStatus: "PAID",
        createdAt: "2026-08-10T14:30:00.000Z",
        customerId: null,
        cashier: { id: "cashier-1", name: "Main Cashier" },
        subTotal: 50,
        netTotal: 50,
        paidTotal: 50,
        dueAmount: 0,
        items: [],
      });
    }
    if (path.endsWith("/cashiers/me/privileges")) return respond({ privilege: { canVoidPayment: false } });
    return respond({});
  });

  // 1. Test 404 / Error State
  await page.goto("/invoices?invoiceId=not-found-id");
  const errorDialog = page.getByRole("dialog", { name: "Invoice load error" });
  await expect(errorDialog).toBeVisible({ timeout: 10_000 });
  await expect(errorDialog.getByText("Unable to load invoice")).toBeVisible();
  await expect(errorDialog.getByText("Invoice not found or deleted.")).toBeVisible();

  // Close error dialog
  await errorDialog.getByRole("button", { name: "Close" }).click();
  await expect(errorDialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/invoices(?!\?invoiceId=)/);

  // 2. Test In-Flight Cancellation / Obsolete Response
  holdInvoice = true;
  await page.goto("/invoices?invoiceId=slow-id");
  const loadingDialog = page.getByRole("dialog", { name: "Loading invoice details" });
  await expect(loadingDialog).toBeVisible({ timeout: 5_000 });

  // Close loading dialog before server responds
  await loadingDialog.getByRole("button", { name: "Close" }).click();
  await expect(loadingDialog).not.toBeVisible();

  // Now release slow response
  releaseInvoice?.();
  await page.waitForTimeout(100);

  // The modal should NOT reappear
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
