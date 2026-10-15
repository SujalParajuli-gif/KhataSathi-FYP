import { expect, test, type Page } from "@playwright/test";
async function openReviewedPayment(page: Page) {
  const trigger = page.getByRole("button", { name: /Review in Worksheet|Recover checkout/ });
  const recovery = /Recover checkout/i.test(await trigger.innerText());
  await trigger.click();
  if (!recovery) {
    await page.getByRole("switch",{name:"Physical bill reference unavailable"}).click();
    await page.getByRole("combobox", {name:"Exception reason"}).click();
    await page.getByRole("option", {name:"Other",exact:true}).click();
    await page.getByLabel("Exception details").fill("Explicit test-fixture exception; handwritten reference unavailable");
    await page.getByRole("button", { name: "Continue to Payment", exact: true }).click();
  }
}

test("billing checkout review captures reviewed prices and handles review conflict rollback", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-1",
    name: "Test Review Product",
    sku: "SKU-REV-1",
    retailPrice: 50,
    wholesalePrice: 45,
    stock: 20,
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  let checkoutAttempts: Record<string, unknown>[] = [];
  let conflictReturned = false;

  await page.addInitScript(({ user, product }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      savedAt: new Date().toISOString(),
    }));
  }, { user, product });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.endsWith("/invoices/checkout")) {
      const postData = route.request().postDataJSON();
      checkoutAttempts.push(postData);

      if (!conflictReturned) {
        conflictReturned = true;
        return respond(
          {
            error: "Checkout items or prices have changed since review. Please review and confirm the updated bill.",
            code: "CHECKOUT_REVIEW_REQUIRED",
            reason: "PRICE_OR_TOTAL_CHANGED",
          },
          409,
        );
      }

      return respond(
        {
          invoice: {
            id: "inv-confirmed-1",
            invoiceNo: "INV-001",
            status: "FINALIZED",
            netTotal: 50,
          },
        },
        201,
      );
    }
    if (path.includes("/draft-requests")) return respond({ requests: [] });
    if (path.includes("/invoices/parked")) return respond({ drafts: [] });
    return respond({});
  });

  await page.goto("/billing");

  // Cart has 1 item of Rs 50
  await expect(page.getByRole("button", { name: /Review in Worksheet|Recover checkout/ })).toBeEnabled();
  await openReviewedPayment(page);

  // Keyboard checkout enters the same explicit final confirmation and conflict flow.
  await expect(page.getByRole("button", { name: /FINAL CHECKOUT/ })).toBeEnabled();
  await page.keyboard.press("Shift+Enter");

  // Confirm dialog opens
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeVisible();
  await page.getByRole("button", { name: /^Confirm/i }).click();

  // First attempt returns 409 conflict
  await expect(
    page.getByText(/Items, prices, or payable total changed since review|Checkout items or prices have changed/i).first(),
  ).toBeVisible();

  // Cashier reviews and confirms again (payment modal remains open)
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await page.getByRole("button", { name: /^Confirm/i }).click();

  // Success toast / modal appears or invoice completes
  await expect(page.getByText(/Invoice created successfully|Success/i).first()).toBeVisible();

  // Check that confirmation payload was sent
  expect(checkoutAttempts.length).toBe(2);
  expect((checkoutAttempts[0] as any).confirmation).toBeDefined();
  expect((checkoutAttempts[0] as any).confirmation.items[0].productId).toBe("product-1");
  expect((checkoutAttempts[0] as any).confirmation.items[0].appliedUnitPrice).toBe(50);
  expect((checkoutAttempts[0] as any).confirmation.payableTotal).toBe(50);
});

test("refreshed prices derive matching payment allocations, change due, and payable total", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  let product = {
    id: "product-1",
    name: "Test Price Product",
    sku: "SKU-PRICE-1",
    retailPrice: 50,
    wholesalePrice: 50,
    stock: 20,
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  let capturedCheckoutPayload: Record<string, any> | null = null;

  await page.addInitScript(({ user, product }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      savedAt: new Date().toISOString(),
    }));
  }, { user, product });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.endsWith("/invoices/checkout")) {
      capturedCheckoutPayload = route.request().postDataJSON();
      return respond(
        {
          invoice: {
            id: "inv-price-1",
            invoiceNo: "INV-PRICE-001",
            status: "FINALIZED",
            netTotal: 100,
          },
        },
        201,
      );
    }
    if (path.includes("/draft-requests")) return respond({ requests: [] });
    if (path.includes("/invoices/parked")) return respond({ drafts: [] });
    return respond({});
  });

  await page.goto("/billing");

  // Open payment modal
  await expect(page.getByRole("button", { name: /Review in Worksheet|Recover checkout/ })).toBeEnabled();
  await openReviewedPayment(page);

  // Enter tendered amount of 500
  const tenderInput = page.getByPlaceholder("0.00");
  await tenderInput.fill("500");

  // Price in catalog updates to 100 before cashier clicks FINAL CHECKOUT
  product = { ...product, retailPrice: 100, wholesalePrice: 100 };

  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();

  // Dialog must show updated price of 100 and exact change of 400
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Finalize this invoice?", exact: true }).getByText(/रु 100/i).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Finalize this invoice?", exact: true }).getByText(/रु 400/i).first()).toBeVisible();

  await page.getByRole("button", { name: /^Confirm/i }).click();

  await expect(page.getByRole("heading", { name: "Sales Worksheet", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue to Payment", exact: true }).click();
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await page.getByRole("button", { name: /^Confirm/i }).click();
  await expect(page.getByText(/Invoice created successfully|Success/i).first()).toBeVisible();

  expect(capturedCheckoutPayload).toBeDefined();
  expect(capturedCheckoutPayload!.confirmation.payableTotal).toBe(100);
  expect(capturedCheckoutPayload!.confirmation.items[0].appliedUnitPrice).toBe(100);
  expect(capturedCheckoutPayload!.payments[0].amount).toBe(100);
  expect(capturedCheckoutPayload!.payments[0].tenderedAmount).toBe(500);
});

test("unresolved cart lines and quantity step mismatches block checkout with visible notices", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const validProduct = {
    id: "product-valid",
    name: "Valid Product",
    sku: "SKU-VAL",
    retailPrice: 20,
    wholesalePrice: 20,
    stock: 5,
    isActive: true,
    quantityStep: 2,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  await page.addInitScript(({ user, validProduct }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [
        { productId: "product-missing", qty: 1 },
        { productId: validProduct.id, qty: 3 }, // Step mismatch (step is 2)
      ],
      savedAt: new Date().toISOString(),
    }));
  }, { user, validProduct });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [validProduct], total: 1 });
    }
    return respond({});
  });

  await page.goto("/billing");

  // Check that badges are rendered
  await expect(page.getByText(/Unavailable/i).first()).toBeVisible();
  await expect(page.getByText(/Step 2/i).first()).toBeVisible();
  await expect(page.getByText(/Requires attention • resolve the item notices/)).toBeVisible();

  // Checkout button is disabled
  await expect(page.getByRole("button", { name: /Review in Worksheet|Recover checkout/ })).toBeDisabled();
});

test("pending recovery snapshot survives and prevents destructive cart clearing", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-rec",
    name: "Recovery Product",
    sku: "SKU-REC",
    retailPrice: 30,
    wholesalePrice: 30,
    stock: 0, // Even if current stock is 0, recovery of submitted operation must succeed!
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  const payload = {
    items: [{ productId: product.id, qty: 1 }],
    payments: [{ method: "CASH", amount: 30, tenderedAmount: 30 }],
    confirmation: {
      items: [{ productId: product.id, qty: 1, appliedUnitPrice: 30 }],
      payableTotal: 30,
    },
  };

  let recoveredOperationKey: string | null = null;

  await page.addInitScript(({ user, product, payload }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      pendingCheckout: {
        operationKey: "recovery-key-1234567890",
        payload,
      },
      savedAt: new Date().toISOString(),
    }));
  }, { user, product, payload });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.endsWith("/invoices/checkout")) {
      const data = route.request().postDataJSON();
      recoveredOperationKey = data.operationKey;
      return respond(
        {
          invoice: {
            id: "inv-recovered-1",
            invoiceNo: "INV-REC-001",
            status: "FINALIZED",
            netTotal: 30,
          },
        },
        200,
      );
    }
    return respond({});
  });

  await page.goto("/billing");

  // Attempting to clear cart is guarded
  await page.getByRole("button", { name: /Clear \(F9\)/i }).click();
  await expect(page.getByText(/A submitted checkout is pending recovery/i).first()).toBeVisible();

  // Recovery button is enabled
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeEnabled();
  await page.getByRole("button", { name: /RECOVER CHECKOUT/i }).click();

  // Recovery confirmation dialog opens
  await expect(page.getByText(/Retry submitted checkout\?/i)).toBeVisible();
  await page.getByRole("button", { name: /Retry Submission/i }).click();

  // Success appears
  await expect(page.getByText(/Invoice created successfully|Success/i).first()).toBeVisible();
  expect(recoveredOperationKey).toBe("recovery-key-1234567890");
});

test("unclassified HTTP 400 preserves pending recovery and prevents fresh cart editing", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-unclassified",
    name: "Unclassified 400 Product",
    sku: "SKU-UNC-400",
    retailPrice: 40,
    wholesalePrice: 40,
    stock: 10,
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  const payload = {
    items: [{ productId: product.id, qty: 1 }],
    payments: [{ method: "CASH", amount: 40, tenderedAmount: 40 }],
    confirmation: {
      items: [{ productId: product.id, qty: 1, appliedUnitPrice: 40 }],
      payableTotal: 40,
    },
  };

  await page.addInitScript(({ user, product, payload }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      pendingCheckout: {
        operationKey: "unclassified-key-1234567890",
        payload,
      },
      savedAt: new Date().toISOString(),
    }));
  }, { user, product, payload });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.endsWith("/invoices/checkout")) {
      return respond(
        {
          error: "Unclassified proxy or gateway bad request.",
        },
        400,
      );
    }
    return respond({});
  });

  await page.goto("/billing");

  // Attempt recovery
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeEnabled();
  await page.getByRole("button", { name: /RECOVER CHECKOUT/i }).click();

  await expect(page.getByText(/Retry submitted checkout\?/i)).toBeVisible();
  await page.getByRole("button", { name: /Retry Submission/i }).click();

  // Intercepted with 400 error banner
  await expect(page.getByText(/Unclassified proxy or gateway bad request/i).first()).toBeVisible();

  // Pending checkout MUST NOT be cleared
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeVisible();

  // Attempting to park or clear is still guarded
  await page.getByRole("button", { name: /Clear \(F9\)/i }).click();
  await expect(page.getByText(/A submitted checkout is pending recovery/i).first()).toBeVisible();
});

test("legacy submitted recovery without confirmed payable displays not recorded", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-legacy",
    name: "Legacy Product",
    sku: "SKU-LEGACY",
    retailPrice: 75,
    wholesalePrice: 75,
    stock: 10,
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  const payload = {
    items: [{ productId: product.id, qty: 1 }],
    payments: [{ method: "CASH", amount: 75 }],
    // No confirmation object and no payableTotal field (legacy format)
  };

  await page.addInitScript(({ user, product, payload }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      pendingCheckout: {
        operationKey: "legacy-op-key-1234567890",
        payload,
      },
      savedAt: new Date().toISOString(),
    }));
  }, { user, product, payload });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [product], total: 1 });
    }
    return respond({});
  });

  await page.goto("/billing");

  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeEnabled();
  await page.getByRole("button", { name: /RECOVER CHECKOUT/i }).click();

  // Recovery dialog must display "Not recorded (legacy submission)" rather than live total
  await expect(page.getByText(/Not recorded \(legacy submission\)/i).first()).toBeVisible();
});

test("customer wholesale vs loyalty mode change invalidates open checkout review candidate", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-qty-wholesale",
    name: "Qty Wholesale Product",
    sku: "SKU-QW-1",
    retailPrice: 50,
    wholesalePrice: 40,
    wholesaleEligible: true,
    wholesaleQtyThreshold: 1,
    stock: 20,
    isActive: true,
    quantityStep: 1,
    unit: "PIECE",
  };

  let customer = {
    id: "customer-1",
    name: "Pricing Customer",
    phone: "9800000000",
    loyaltyPercent: 10,
    wholesalePercent: 0,
  };

  let checkoutAttempts: Record<string, unknown>[] = [];

  await page.addInitScript(({ user, product, customer }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      selectedCustomerId: customer.id,
      savedAt: new Date().toISOString(),
    }));
  }, { user, product, customer });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers")) {
      return respond([customer]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.endsWith("/invoices/checkout")) {
      const postData = route.request().postDataJSON();
      checkoutAttempts.push(postData);
      return respond(
        {
          invoice: {
            id: "inv-confirmed-1",
            invoiceNo: "INV-001",
            status: "FINALIZED",
            netTotal: (postData as any)?.confirmation?.payableTotal ?? 45,
          },
        },
        201,
      );
    }
    return respond({});
  });

  await page.goto("/billing");

  // Open payment modal
  await expect(page.getByRole("button", { name: /Review in Worksheet|Recover checkout/ })).toBeEnabled();
  await openReviewedPayment(page);

  // Enter sufficient cash tender
  await page.getByPlaceholder("0.00").fill("500");

  // Click FINAL CHECKOUT to reach confirm dialog (based on initial loyalty mode: wholesale 40 - 10% loyalty = 36)
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Finalize this invoice?", exact: true }).getByText(/रु 36/i).first()).toBeVisible();

  // While confirmation dialog is open, customer pricing mode changes on server to wholesale mode:
  // loyaltyPercent 0, wholesalePercent 10.
  // In wholesale mode, customer wholesale discount applies on retail price (50 - 10% = 45) and disables qty-wholesale pricing.
  customer = {
    ...customer,
    loyaltyPercent: 0,
    wholesalePercent: 10,
  };

  // Trigger customer refresh through window focus event
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });

  // Because customer pricing mode changed, fingerprint changed and dialog is AUTOMATICALLY dismissed
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeHidden();

  // Cashier reviews renewed candidate and clicks FINAL CHECKOUT again
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeVisible();

  // Renewed dialog shows updated price (retail 50 - 10% wholesale = 45)
  await expect(page.getByRole("dialog", { name: "Finalize this invoice?", exact: true }).getByText(/रु 45/i).first()).toBeVisible();

  await page.getByRole("button", { name: /^Confirm/i }).click();

  // Invoice finalized successfully
  await expect(page.getByRole("heading", { name: "Sales Worksheet", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue to Payment", exact: true }).click();
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await page.getByRole("button", { name: /^Confirm/i }).click();
  await expect(page.getByText(/Invoice created successfully|Success/i).first()).toBeVisible();
  expect(checkoutAttempts.length).toBeGreaterThan(0);
  const lastAttempt = checkoutAttempts[checkoutAttempts.length - 1];
  expect((lastAttempt as any).confirmation).toBeDefined();
  expect((lastAttempt as any).confirmation.items[0].productId).toBe("product-qty-wholesale");
  expect((lastAttempt as any).confirmation.items[0].appliedUnitPrice).toBe(50);
  expect((lastAttempt as any).confirmation.payableTotal).toBe(45);
});

test("delayed parking mutation serializes fresh checkout and preserves pending recovery under synchronous guards", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = {
    id: "product-switch-guard",
    name: "Switch Guard Product",
    sku: "SKU-SG-1",
    retailPrice: 60,
    wholesalePrice: 60,
    stock: 10,
    isActive: true,
    quantityStep: 1,
    wholesaleEligible: false,
    unit: "PIECE",
  };

  let checkoutAttempts: Record<string, any>[] = [];
  let resolveParkPromise: ((data: unknown) => void) | null = null;
  const parkPromise = new Promise((resolve) => {
    resolveParkPromise = resolve;
  });

  await page.addInitScript(({ user, product }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      savedAt: new Date().toISOString(),
    }));
  }, { user, product });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: true,
      });
    }
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) {
      return respond([]);
    }
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
      return respond({ products: [product], total: 1 });
    }
    if (path.includes("/invoices/parked") && method === "POST") {
      // Hold the response in flight until explicitly released
      await parkPromise;
      return respond({
        id: "parked-draft-1",
        invoiceNo: "DRF-001",
        items: [{ productId: product.id, qty: 1 }],
      });
    }
    if (path.includes("/invoices/parked")) {
      return respond({ drafts: [] });
    }
    if (path.endsWith("/invoices/checkout")) {
      const postData = route.request().postDataJSON();
      checkoutAttempts.push(postData);
      // Simulate network timeout or 500 unknown error so checkout becomes pending recovery
      return respond({ error: "Network timeout or server failure" }, 500);
    }
    return respond({});
  });

  await page.goto("/billing");

  // Part 1: Real UI-triggered held parking mutation and checkout serialization
  // Trigger park from the UI
  await page.getByRole("button", { name: /Park \(F6\)/i }).click();
  await expect(page.getByText(/Park this bill\?/i)).toBeVisible();
  await page.getByRole("button", { name: "Park Bill" }).click();

  // While parking mutation is in-flight on the server, parkedBusy is active
  // Assert fresh checkout is disabled and cannot be opened/submitted
  await expect(page.getByRole("button", { name: /Review in Worksheet|Recover checkout/i })).toBeDisabled();
  expect(checkoutAttempts.length).toBe(0);

  // Release the in-flight parking response
  resolveParkPromise!({});
  await expect(page.getByText(/Bill parked/i).first()).toBeVisible();

  // Verify cart is cleanly reset
  const emptyCartState = await page.evaluate(() => {
    return JSON.parse(localStorage.getItem("khatasathi_billing_cart") || "{}");
  });
  expect(emptyCartState.cart?.length || 0).toBe(0);

  // Part 2: Add item, trigger checkout entering pending recovery, and assert synchronous guards
  // Add item back to cart
  await page.evaluate(({ product }) => {
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
      cart: [{ productId: product.id, qty: 1 }],
      savedAt: new Date().toISOString(),
    }));
  }, { product });
  await page.reload();

  // Open payment and submit checkout
  await openReviewedPayment(page);
  await page.getByPlaceholder("0.00").fill("100");
  await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
  await expect(page.getByText(/Finalize this invoice\?/i)).toBeVisible();
  await page.getByRole("button", { name: /^Confirm/i }).click();

  // Checkout enters unknown outcome / pending recovery state
  await expect(page.getByText(/Network timeout or server failure|Checkout outcome is unknown/i).first()).toBeVisible();

  // An uncertain response returns directly to Billing with the frozen recovery action.
  await expect(page.getByRole("button", { name: "Close dialog", exact: true })).not.toBeVisible();

  // Verify RECOVER CHECKOUT is visible on screen
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeVisible();

  // Check stored operation key and payable total
  const storedRecovery = await page.evaluate(() => {
    return JSON.parse(localStorage.getItem("khatasathi_billing_cart") || "{}");
  });
  expect(storedRecovery.pendingCheckout?.operationKey).toBeDefined();
  const originalOpKey = storedRecovery.pendingCheckout.operationKey;
  expect(storedRecovery.pendingCheckout.payload.confirmation.payableTotal).toBe(60);

  // Synchronous entry guards block subsequent destructive actions while pending recovery exists
  await page.getByRole("button", { name: /Park \(F6\)/i }).click();
  await expect(page.getByText(/A submitted checkout is pending recovery/i).first()).toBeVisible();

  await page.getByRole("button", { name: /Clear \(F9\)/i }).click();
  await expect(page.getByText(/A submitted checkout is pending recovery/i).first()).toBeVisible();

  // Assert pending checkout identity and UI remain completely intact
  const storedAfterGuards = await page.evaluate(() => {
    return JSON.parse(localStorage.getItem("khatasathi_billing_cart") || "{}");
  });
  expect(storedAfterGuards.pendingCheckout?.operationKey).toBe(originalOpKey);
  expect(storedAfterGuards.pendingCheckout?.payload?.confirmation?.payableTotal).toBe(60);
  await expect(page.getByRole("button", { name: /RECOVER CHECKOUT/i })).toBeVisible();
});

test("cart quantity controls follow unit steps and mobile review clears the bottom navigation", async ({page}) => {
 const user={id:"cashier",name:"Cashier",role:"cashier"};
 const product={id:"stepped",name:"Stepped Product",sku:"STEP",retailPrice:20,wholesalePrice:20,stock:20,isActive:true,quantityStep:2,saleUnit:"PIECE"};
 await page.addInitScript(({user,product})=>{
  localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));
  localStorage.setItem("khatasathi_billing_cart",JSON.stringify({cart:[{productId:product.id,qty:2}],savedAt:new Date().toISOString()}));
 },{user,product});
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;
  let body: unknown={};
  if(path.endsWith("/auth/me"))body={user};
  else if(path.endsWith("/capabilities"))body={businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true};
  else if(path.includes("/products"))body={products:[product],total:1};
  else if(["/customers","/brands","/categories"].some(end=>path.endsWith(end)))body=[];
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
 });
 await page.goto("/billing");
 const quantity=page.getByRole("spinbutton",{name:"Quantity of Stepped Product"});
 await expect(quantity).toHaveValue("2");
 await page.getByRole("button",{name:"Increase quantity of Stepped Product"}).click();
 await expect(quantity).toHaveValue("4");
 await page.getByRole("button",{name:"Decrease quantity of Stepped Product"}).click();
 await expect(quantity).toHaveValue("2");
 await page.setViewportSize({width:390,height:844});
 const review=page.getByRole("button",{name:"Review in Worksheet",exact:true});
 await expect(review).toBeVisible();
 await expect.poll(async()=>{const box=await review.boundingBox();return box ? box.y+box.height:9999;}).toBeLessThan(780);
 await review.click(); await expect(page.getByRole("heading",{name:"Sales Worksheet"}).first()).toBeVisible();
});

test("portaled customer picker selects customers and quick creation retains failed input before retry", async ({page}) => {
 const user={id:"cashier",name:"Cashier",role:"cashier"};
 const existing={id:"customer-existing",name:"Existing Buyer",phone:"9841000001",address:"Kathmandu",loyaltyPercent:0,wholesalePercent:0};
 const created={id:"customer-new",name:"New Buyer",phone:"9841000002",address:"Lalitpur",loyaltyPercent:0,wholesalePercent:0};
 let createAttempts=0;
 await page.addInitScript(user=>localStorage.setItem("khatasathi_auth_user",JSON.stringify(user)),user);
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;
  const respond=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
  if(path.endsWith("/auth/me"))return respond({user});
  if(path.endsWith("/capabilities"))return respond({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true});
  if(path.endsWith("/customers/quick")){
   createAttempts++;
   expect(route.request().postDataJSON()).toMatchObject({name:created.name,phone:created.phone,address:created.address});
   return createAttempts===1 ? respond({error:"Temporary create failure"},503):respond(created,201);
  }
  if(path.endsWith("/customers/lookup"))return respond({items:[existing],total:1,page:1,pageSize:20});
  if(path.endsWith("/customers"))return respond([existing]);
  if(path.includes("receivables-summary"))return respond({state:"NONE",hasDue:false,totalDue:0,currency:"NPR"});
  if(path.includes("/products"))return respond({products:[],total:0});
  if(path.endsWith("/brands")||path.endsWith("/categories"))return respond([]);
  return respond({});
 });
 await page.goto("/billing");
 await page.getByRole("button",{name:"Select",exact:true}).click();
 const picker=page.getByRole("dialog",{name:"Choose customer",exact:true});
 await expect(picker).toBeVisible();
 await picker.getByPlaceholder("Find by name, phone, or 9-digit PAN...").fill("Existing");
 await picker.getByText(existing.name,{exact:true}).click();
 await expect(picker).not.toBeVisible();
 await expect(page.getByText(existing.name,{exact:true}).first()).toBeVisible();
 await page.getByRole("button",{name:"Change",exact:true}).click();
 await picker.getByRole("button",{name:"+ Add a customer",exact:true}).click();
 const create=page.getByRole("dialog",{name:"Create customer",exact:true});
 await expect(create).toBeVisible();
 await create.getByPlaceholder("e.g. Ramesh Shrestha").fill(created.name);
 await create.getByPlaceholder("e.g. 9841234567").fill(created.phone);
 await create.getByPlaceholder("e.g. Kalanki, Kathmandu").fill(created.address);
 await create.getByRole("button",{name:"Save & Select Customer"}).click();
 await expect(create.getByText(/Failed to create customer|503|Temporary create failure/)).toBeVisible();
 await expect(create.getByPlaceholder("e.g. Ramesh Shrestha")).toHaveValue(created.name);
 await create.getByRole("button",{name:"Save & Select Customer"}).click();
 await expect(create).not.toBeVisible(); await expect(picker).not.toBeVisible();
 await expect(page.getByText(created.name,{exact:true}).first()).toBeVisible();
 expect(createAttempts).toBe(2);
 await page.getByRole("button",{name:"Change",exact:true}).click();
 await page.keyboard.press("Escape"); await expect(picker).not.toBeVisible();
 await expect(page.getByText(created.name,{exact:true}).first()).toBeVisible();
});
