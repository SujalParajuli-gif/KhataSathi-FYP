import { expect, test } from "@playwright/test";

const cashierUser = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "Cashier User",
  role: "cashier",
};

const mockProducts = [
  {
    id: "11111111-1111-4111-8111-000000000001",
    name: "Sample Product A",
    sku: "SKU-A",
    barcode: "890123450001",
    brand: "Brand A",
    retailPrice: 500,
    wholesalePrice: 450,
    wholesaleEligible: false,
    stock: 50,
    active: true,
    allowFractionalQty: false,
    quantityStep: 1,
    saleUnit: "PIECE",
  },
];

const mockAccounts = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    providerLabel: "Store Fonepay QR",
    accountHolder: "KhataSathi Store",
    accountIdentifier: "9841234567",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    supportedSettlement: true,
    version: 1,
    activeQrAssetId: "aaaaaaaa-1111-4111-8111-111111111111",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/aaaaaaaa-1111-4111-8111-111111111111/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/aaaaaaaa-1111-4111-8111-111111111111/file",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    providerLabel: "Nabil Main Current",
    accountHolder: "KhataSathi Pvt Ltd",
    accountIdentifier: "01200100200300",
    settlementMethod: "BANK_TRANSFER",
    confirmationMode: "MANUAL_RECEIPT",
    supportedSettlement: true,
    version: 1,
    activeQrAssetId: "bbbbbbbb-2222-4222-8222-222222222222",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/22222222-2222-4222-8222-222222222222/qr/bbbbbbbb-2222-4222-8222-222222222222/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/22222222-2222-4222-8222-222222222222/qr/bbbbbbbb-2222-4222-8222-222222222222/file",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    providerLabel: "Owner Personal Khalti",
    accountHolder: "Owner Name",
    accountIdentifier: "9800000000",
    settlementMethod: null,
    confirmationMode: "DISPLAY_ONLY",
    supportedSettlement: false,
    version: 1,
    activeQrAssetId: "cccccccc-3333-4333-8333-333333333333",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/33333333-3333-4333-8333-333333333333/qr/cccccccc-3333-4333-8333-333333333333/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/33333333-3333-4333-8333-333333333333/qr/cccccccc-3333-4333-8333-333333333333/file",
  },
];

async function setupBillingRoutes(page: any, accountsList = mockAccounts) {
  await page.addInitScript((user: any) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-token");
    localStorage.setItem("khatasathi_billing_cart", JSON.stringify({ cart: [{ productId: "11111111-1111-4111-8111-000000000001", qty: 1 }], savedAt: new Date().toISOString() }));
  }, cashierUser);

  await page.route((url: any) => url.pathname.startsWith("/api/"), async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return respond({ user: cashierUser });
    if (path.endsWith("/capabilities"))
      return respond({
        businessMode: "FULL_POS",
        posEnabled: true,
        catalogEnabled: true,
        inventoryEnabled: true,
        stockTracked: true,
      });

    if (path.endsWith("/settings/payment-accounts/enabled")) {
      return respond(accountsList);
    }

    if (path.includes("/products")) {
      return respond({ products: mockProducts, total: mockProducts.length });
    }

    if (path.includes("/customers")) {
      return respond({ items: [], total: 0 });
    }

    if (path.includes("/invoices/parked")) {
      return respond({ drafts: [] });
    }

    if (path.includes("/invoices/draft-requests")) {
      return respond({ requests: [] });
    }

    if (path.includes("/payments/gateway-display")) {
      return respond({
        esewa: { environment: "SANDBOX", label: "eSewa Sandbox" },
      });
    }

    return respond({});
  });
}

test("payment redesign preserves mobile controls and never labels an unverified gateway live", async ({ page }, testInfo) => {
  await setupBillingRoutes(page);
  await page.route("**/api/payments/gateway-display", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ esewa: { environment: "UNVERIFIED", label: "eSewa" } }),
  }));
  await page.goto("/billing");
  await page.getByRole("button", { name: /PAY NOW/ }).click();
  const modal = page.getByRole("dialog", { name: "Confirm Payment", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("NPR NPR", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("payment-desktop.png") });
  await page.setViewportSize({ width: 360, height: 800 });
  await modal.locator('button:has-text("eSewa")').click();
  await expect(modal.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(modal.getByText("Gateway environment is not confirmed.")).toBeVisible();
  await expect(modal.getByText(/Live eSewa/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("payment-mobile.png") });
  await modal.locator('button:has-text("Bank Transfer")').click();
  await expect(modal.locator('input[placeholder*="Voucher no"]')).toBeVisible();
  await modal.locator('button:has-text("Split")').click();
  await expect(modal.getByRole("button", { name: "Remove eSewa payment row", exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "+ Bank Transfer row", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test.describe("POS Billing Receiving Destination Controls", () => {
  test("Bank Transfer method controls, destination selection, attestation, and checkout", async ({
    page,
  }) => {
    let checkoutBody: any = null;
    await setupBillingRoutes(page);

    await page.route("**/api/invoices/checkout", async (route: any) => {
      checkoutBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          invoice: {
            id: "99999999-9999-4999-8999-111111111111",
            invoiceNo: "INV-2080-001",
            netTotal: 500,
            paidTotal: 500,
            paymentStatus: "PAID",
          },
        }),
      });
    });

    await page.goto("/billing");

    // Add product to cart
    await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();

    // Open Payment Modal
    await page.locator('button:has-text("PAY NOW"), button:has-text("Charge"), button:has-text("F4")').first().click();
    await expect(page.locator("text=Payment Method")).toBeVisible();

    // Select Bank Transfer method
    await page.locator('button:has-text("Bank Transfer")').click();

    // Verify DISPLAY_ONLY account is excluded from destination selector combobox & listbox
    const destCombobox = page.locator('button[role="combobox"]').filter({ hasText: "Receiving destination not recorded" }).first();
    await expect(destCombobox).toBeVisible();
    await destCombobox.click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();
    await expect(listbox.locator('button[role="option"]:has-text("Receiving destination not recorded")')).toBeVisible();
    await expect(listbox.locator('button[role="option"]:has-text("Nabil Main Current")')).toBeVisible();
    await expect(listbox.locator('button[role="option"]:has-text("Owner Personal Khalti")')).toHaveCount(0);

    // Select Nabil account
    await listbox.locator('button[role="option"]:has-text("Nabil Main Current")').click();

    // Fill Bank Transfer reference
    const refInput = page.locator('input[placeholder*="Voucher no"]').first();
    await refInput.fill("NABIL-TXN-9988");

    // Attestation checkbox appears
    const attestCheckbox = page.getByRole('checkbox', { name: /I checked this receiving account and received NPR/i });
    await expect(attestCheckbox).toBeVisible();
    await expect(attestCheckbox).not.toBeChecked();

    // Trying to confirm without checking attestation displays error
    await page.locator('button:has-text("FINAL CHECKOUT")').click();
    await expect(page.locator("text=Please confirm that you checked this receiving account")).toBeVisible();

    // Check attestation
    await attestCheckbox.check();

    // Confirm checkout opens review dialog
    await page.locator('button:has-text("FINAL CHECKOUT")').click();
    await expect(page.locator("text=Confirm Bank Transfer?")).toBeVisible();
    await expect(page.locator("text=NABIL-TXN-9988")).toBeVisible();
    await expect(page.getByText("Nabil Main Current", { exact: true })).toBeVisible();

    // Finalize submission
    await page.locator('button:has-text("Confirm Bank Transfer")').click();
    await expect(page.locator("text=Invoice created successfully")).toBeVisible();

    expect(checkoutBody).toBeTruthy();
    expect(checkoutBody.payments).toHaveLength(1);
    expect(checkoutBody.payments[0].method).toBe("BANK_TRANSFER");
    expect(checkoutBody.payments[0].reference).toBe("NABIL-TXN-9988");
    expect(checkoutBody.payments[0].receivingAccountId).toBe("22222222-2222-4222-8222-222222222222");
    expect(checkoutBody.payments[0].receivingAccountVersion).toBe(1);
    expect(checkoutBody.payments[0].manualReceiptConfirmed).toBe(true);
  });

  test("Store Payment QRs Gallery button opens modal and browsing makes 0 financial calls", async ({
    page,
  }) => {
    let financialCalls = 0;
    await setupBillingRoutes(page);

    await page.route("**/api/invoices/checkout", async (route: any) => {
      financialCalls++;
      await route.fulfill({ status: 200, body: "{}" });
    });

    await page.goto("/billing");

    // Click neutral button "Store Payment QRs Gallery" directly from main billing toolbar
    const galleryButton = page.getByRole('button', { name: 'Store Payment QRs Gallery', exact: true });
    await expect(galleryButton).toBeVisible();
    await galleryButton.click();

    // Gallery modal is open
    const galleryModal = page.getByRole("dialog", { name: "Store Payment QRs Gallery" });
    await expect(galleryModal).toBeVisible();
    await expect(galleryModal.locator("text=Store Fonepay QR")).toBeVisible();
    await expect(galleryModal.locator("text=Nabil Main Current")).toBeVisible();

    // Close gallery modal
    const closeBtn = galleryModal.locator('button:has-text("Close")').last();
    await closeBtn.click();
    await expect(galleryModal).toBeHidden();
    await expect(galleryButton).toBeVisible();

    // Verify 0 financial calls were made
    expect(financialCalls).toBe(0);
  });

  test("Stale metadata rejection: updated account version stops review, clears attestation and retains input", async ({
    page,
  }) => {
    let callCount = 0;
    await setupBillingRoutes(page);

    // Dynamic accounts handler where second call returns version 2
    await page.route("**/api/settings/payment-accounts/enabled", async (route: any) => {
      callCount++;
      if (callCount >= 2) {
        // Version upgraded on server
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              ...mockAccounts[0],
              version: 2,
            },
            mockAccounts[1],
          ]),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockAccounts),
        });
      }
    });

    await page.goto("/billing");

    await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();

    await page.locator('button:has-text("PAY NOW"), button:has-text("Charge"), button:has-text("F4")').first().click();
    await page.locator('button:has-text("Fonepay")').click();

    const refInput = page.locator('input[placeholder*="Transaction ID"]').first();
    await refInput.fill("FONEPAY-REF-12345");

    const destCombobox = page.locator('button[role="combobox"]').filter({ hasText: "Receiving destination not recorded" }).first();
    await destCombobox.click();
    const listbox = page.locator('[role="listbox"]');
    await listbox.locator('button[role="option"]:has-text("Store Fonepay QR")').click();

    const attestCheckbox = page.getByRole('checkbox', { name: /I checked this receiving account and received NPR/i });
    await attestCheckbox.check();

    const fonepayMerchantCheckbox = page.getByRole('checkbox', { name: /I have verified the Fonepay merchant/i });
    await fonepayMerchantCheckbox.check();

    // Click confirm: backend enabled accounts refresh returns version 2, rejecting review
    await page.locator('button:has-text("CONFIRM FONEPAY")').click();

    // Error is displayed
    await expect(
      page.locator("text=The selected receiving account was updated or is no longer available"),
    ).toBeVisible();

    // Attestation was cleared
    await expect(attestCheckbox).not.toBeChecked();

    // Reference input retained
    await expect(refInput).toHaveValue("FONEPAY-REF-12345");
  });

  test("Split payment with Bank Transfer row and receiving account attestation", async ({
    page,
  }) => {
    let checkoutBody: any = null;
    await setupBillingRoutes(page);

    await page.route("**/api/invoices/checkout", async (route: any) => {
      checkoutBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          invoice: {
            id: "99999999-9999-4999-8999-222222222222",
            invoiceNo: "INV-2080-002",
            netTotal: 500,
            paidTotal: 500,
            paymentStatus: "PAID",
          },
        }),
      });
    });

    await page.goto("/billing");

    await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();

    await page.locator('button:has-text("PAY NOW"), button:has-text("Charge"), button:has-text("F4")').first().click();
    await page.locator('button:has-text("Split")').click();

    // Split has 2 default rows: Cash (250) and eSewa (250)
    // Remove eSewa row and add Bank Transfer row
    const esewaRowClose = page.getByRole('button', { name: 'Remove eSewa payment row', exact: true });
    await esewaRowClose.click();

    await page.locator('button:has-text("+ Bank Transfer row")').click();

    // Fill Bank Transfer amount and reference
    const amountInputs = page.locator('input[placeholder="Amount"]');
    await amountInputs.nth(1).fill("250");

    const bankRefInput = page.locator('input[placeholder="Bank ref"]');
    await bankRefInput.fill("BT-SPLIT-888");

    // Select receiving account for Bank Transfer row
    const splitDestCombobox = page.locator('button[role="combobox"]').filter({ hasText: "Receiving destination not recorded" }).first();
    await splitDestCombobox.click();
    const listbox = page.locator('[role="listbox"]');
    await listbox.locator('button[role="option"]:has-text("Nabil Main Current")').click();

    // Check row attestation
    const rowAttestCheckbox = page.getByRole('checkbox', { name: /I checked this receiving account and received NPR/i });
    await rowAttestCheckbox.check();

    // Submit split review
    await page.locator('button:has-text("CONFIRM SPLIT PAYMENT")').click();
    await expect(page.locator("text=Confirm split payment?")).toBeVisible();
    await expect(page.locator("text=Bank Transfer amount")).toBeVisible();

    // Finalize
    await page.getByRole('button', { name: 'Confirm Split', exact: true }).click();
    await expect(page.locator("text=Invoice created successfully")).toBeVisible();

    expect(checkoutBody).toBeTruthy();
    expect(checkoutBody.payments).toHaveLength(2);
    const btRow = checkoutBody.payments.find((p: any) => p.method === "BANK_TRANSFER");
    expect(btRow).toBeTruthy();
    expect(btRow.amount).toBe(250);
    expect(btRow.reference).toBe("BT-SPLIT-888");
    expect(btRow.receivingAccountId).toBe("22222222-2222-4222-8222-222222222222");
    expect(btRow.receivingAccountVersion).toBe(1);
    expect(btRow.manualReceiptConfirmed).toBe(true);
  });

  test("lost-response checkout retries identical operationKey and payload without minting a new key", async ({
    page,
  }) => {
    const checkoutRequests: any[] = [];
    let checkoutAttempt = 0;
    await setupBillingRoutes(page);

    await page.route("**/api/invoices/checkout", async (route: any) => {
      checkoutAttempt++;
      const body = JSON.parse(route.request().postData() || "{}");
      checkoutRequests.push(body);
      if (checkoutAttempt === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Network timeout on checkout" }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            invoice: {
              id: "99999999-9999-4999-8999-999999999999",
              invoiceNo: "INV-2080-RETRY",
              netTotal: 500,
              paidTotal: 500,
              paymentStatus: "PAID",
            },
          }),
        });
      }
    });

    await page.goto("/billing");

    // Add product to cart
    await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();

    // Open Payment Modal
    await page.locator('button:has-text("PAY NOW"), button:has-text("Charge"), button:has-text("F4")').first().click();
    await expect(page.locator("text=Payment Method")).toBeVisible();

    // Select Bank Transfer method
    await page.locator('button:has-text("Bank Transfer")').click();

    // Select destination
    const destCombobox = page.locator('button[role="combobox"]').filter({ hasText: "Receiving destination not recorded" }).first();
    await destCombobox.click();
    const listbox = page.locator('[role="listbox"]');
    await listbox.locator('button[role="option"]:has-text("Nabil Main Current")').click();

    // Fill reference & attestation
    const refInput = page.locator('input[placeholder*="Voucher no"]').first();
    await refInput.fill("RETRY-TXN-1122");

    const attestCheckbox = page.getByRole('checkbox', { name: /I checked this receiving account and received NPR/i });
    await attestCheckbox.check();

    // Confirm checkout to open review dialog
    await page.locator('button:has-text("FINAL CHECKOUT")').click();
    await expect(page.locator("text=Confirm Bank Transfer?")).toBeVisible();

    // Finalize submission - fails 500
    await page.locator('button:has-text("Confirm Bank Transfer")').click();
    await expect(page.getByText(/submitted checkout|outcome.*unknown|Network timeout on checkout/i).first()).toBeVisible();

    // Payment button changes to RECOVER CHECKOUT
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const recoverBtn = page.locator('button:has-text("RECOVER CHECKOUT")');
    await expect(recoverBtn).toBeVisible();
    await recoverBtn.click();

    // Retry dialog opens
    await expect(page.locator("text=Retry submitted checkout?")).toBeVisible();
    await page.locator('button:has-text("Retry Submission")').click();

    // Second attempt succeeds
    await expect(page.locator("text=Invoice created successfully")).toBeVisible({ timeout: 4000 });

    expect(checkoutRequests).toHaveLength(2);
    expect(checkoutRequests[0].operationKey).toBeTruthy();
    expect(checkoutRequests[1].operationKey).toBe(checkoutRequests[0].operationKey);
    expect(checkoutRequests[1].payments).toEqual(checkoutRequests[0].payments);
    expect(checkoutRequests[1].items).toEqual(checkoutRequests[0].items);
  });
});
