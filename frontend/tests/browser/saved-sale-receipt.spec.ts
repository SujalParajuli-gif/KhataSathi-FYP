import { expect, test, type Page } from "@playwright/test";

const actor = { id: "receipt-cashier", name: "Receipt cashier", role: "cashier" };
const account = { id: "11111111-1111-4111-8111-111111111111", providerLabel: "Store bank", accountHolder: "Store", accountIdentifier: "TEST-001", settlementMethod: "BANK_TRANSFER", confirmationMode: "MANUAL_RECEIPT", supportedSettlement: true, version: 3, activeQrAssetId: "22222222-2222-4222-8222-222222222222" };
const product = { id: "receipt-product", name: "Receipt test item", sku: "TEST-RCPT", retailPrice: 100, wholesalePrice: 100, stock: 10, isActive: true, wholesaleEligible: false, quantityStep: 1, unit: "PIECE" };
const invoice = { id: "receipt-invoice", invoiceNo: "TEST-RECEIPT", status: "FINALIZED", netTotal: 100, paidTotal: 0, paymentStatus: "UNPAID", createdAt: "2026-10-08T00:00:00Z", items: [], payments: [] };
const pending = { actorId: actor.id, invoiceId: invoice.id, payload: { method: "BANK_TRANSFER", amount: 25, reference: "BT-ORIGINAL", status: "SUCCESS", receivingAccountId: account.id, receivingAccountVersion: 3, manualReceiptConfirmed: true, manualOperationKey: "original-manual-key-123456" } };
const key = `khatasathi:manualReceipt:${actor.id}:${invoice.id}`;
async function setup(page: Page) {
  await page.addInitScript(({ actor, product }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor));
    localStorage.setItem("khatasathi_token", "test-session");
    if (!localStorage.getItem("khatasathi_billing_cart")) localStorage.setItem("khatasathi_billing_cart", JSON.stringify({ cart: [{ productId: product.id, qty: 1 }], savedAt: new Date().toISOString() }));
  }, { actor, product });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const respond = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname.endsWith("/auth/me")) return respond({ user: actor });
    if (pathname.endsWith("/capabilities")) return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true, stockTracked: true });
    if (pathname.endsWith("/payment-accounts/enabled")) return respond([account]);
    if (pathname.includes("/products")) return respond({ products: [product], total: 1 });
    if (pathname.endsWith("/invoices/checkout")) return respond({ invoice });
    if (pathname.endsWith(`/invoices/${invoice.id}`)) return respond(invoice);
    if (pathname.includes("/parked")) return respond({ drafts: [] });
    if (pathname.includes("/draft-requests")) return respond({ requests: [] });
    if (pathname.includes("/customers")) return respond([]);
    return respond({});
  });
}

test("saved unpaid sale records a confirmed destination, retains exact request after response loss and recovers on reload", async ({ page }) => {
  await setup(page);
  const requests: any[] = [];
  await page.route(`**/api/invoices/${invoice.id}/payments`, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Receipt response lost" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "recorded-receipt", invoiceId: invoice.id, method: "BANK_TRANSFER", reference: "BT-NEW", status: "SUCCESS", receivingAccountId: account.id, amount: 25, receivingDestinationSnapshot: { accountVersion: 3, confirmedById: actor.id } }) });
  });
  await page.goto("/billing");
  await page.getByRole("button", { name: /PAY NOW/ }).click();
  await page.getByRole("button", { name: "Unpaid", exact: true }).click();
  await page.getByRole("button", { name: /CREATE UNPAID INVOICE/ }).click();
  await page.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(page.getByText("Invoice created successfully", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Record Received Payment", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Record received payment", exact: true });
  await expect(modal.getByText(/Remaining due/)).toContainText("NPR 100.00");
  await modal.getByRole("combobox", { name: "Saved receipt method" }).click();
  await page.getByRole("option", { name: "Bank transfer", exact: true }).click();
  await modal.getByRole("combobox", { name: "Saved receipt destination" }).click();
  await page.getByRole("option", { name: /Store bank/ }).click();
  await modal.getByLabel("Saved receipt amount").fill("25");
  await modal.getByLabel("Saved receipt reference").fill("BT-NEW");
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Record Received Payment", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Receipt response lost");
  await expect(modal.getByLabel("Saved receipt amount")).toBeDisabled();
  const retained = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), key);
  expect(retained.payload).toEqual(requests[0]);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: `Recover receipt for ${invoice.id}`, exact: true }).click();
  await modal.getByRole("button", { name: "Recover Original Receipt", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Receipt recorded" })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull();
});

for (const width of [1440, 390]) test(`retained receipt keyboard recovery isolates actor/invoice and never refreshes disabled destination (${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  await page.addInitScript(({ pending, key }) => {
    sessionStorage.setItem(key, JSON.stringify(pending));
    sessionStorage.setItem(`khatasathi:manualReceipt:other-actor:${pending.invoiceId}`, JSON.stringify({ ...pending, actorId: "other-actor" }));
    sessionStorage.setItem(`${key}-other`, JSON.stringify({ ...pending, invoiceId: `${pending.invoiceId}-other` }));
  }, { pending, key });
  let accountReads = 0; let requests: any[] = [];
  await page.route("**/api/settings/payment-accounts/enabled", async (route) => { accountReads++; return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });
  await page.route(`**/api/invoices/${invoice.id}/payments`, async (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "original-recorded", invoiceId: invoice.id, method: "BANK_TRANSFER", reference: "BT-ORIGINAL", status: "FAILED", receivingAccountId: account.id, amount: 25, receivingDestinationSnapshot: { accountVersion: 3, confirmedById: actor.id } }) });
  });
  await page.goto("/billing");
  const restore = page.getByRole("button", { name: `Recover receipt for ${invoice.id}`, exact: true });
  await restore.focus(); await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Record received payment", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel("Saved receipt reference")).toHaveValue("BT-ORIGINAL");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const retry = modal.getByRole("button", { name: "Recover Original Receipt", exact: true });
  await retry.focus(); await page.keyboard.press("Enter");
  await expect(modal).toBeHidden();
  expect(requests).toEqual([pending.payload]); expect(accountReads).toBe(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(`${key}-other`), key)).not.toBeNull();
  expect(await page.evaluate((invoiceId) => sessionStorage.getItem(`khatasathi:manualReceipt:other-actor:${invoiceId}`), invoice.id)).not.toBeNull();
});

test("receipt storage denial sends no payment; mismatched response never clears the original slot", async ({ page }) => {
  await setup(page);
  await page.addInitScript(({ key, pending }) => sessionStorage.setItem(key, JSON.stringify(pending)), { key, pending });
  let requests = 0;
  await page.route(`**/api/invoices/${invoice.id}/payments`, async (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "wrong-receipt", invoiceId: "different-invoice", method: "BANK_TRANSFER", reference: pending.payload.reference, amount: 25, receivingAccountId: account.id }) });
  });
  await page.goto("/billing");
  await page.getByRole("button", { name: `Recover receipt for ${invoice.id}`, exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Record received payment", exact: true });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__receiptSetItem = original;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("khatasathi:manualReceipt:")) throw new Error("Receipt storage denied");
      return original.call(this, key, value);
    };
  });
  await modal.getByRole("button", { name: "Recover Original Receipt", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Receipt storage denied");
  expect(requests).toBe(0);
  await page.evaluate(() => { Storage.prototype.setItem = (window as any).__receiptSetItem; });
  await modal.getByRole("button", { name: "Recover Original Receipt", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("could not be reconciled");
  expect(requests).toBe(1);
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), key)).toEqual(pending);
});

test("actor change during delayed receipt return hides old details and retains its original recovery slot", async ({ page }) => {
  await setup(page);
  await page.addInitScript(({ key, pending }) => sessionStorage.setItem(key, JSON.stringify(pending)), { key, pending });
  let release!: () => void;
  const returned = new Promise<void>((resolve) => { release = resolve; });
  let submitted!: () => void;
  const dispatched = new Promise<void>((resolve) => { submitted = resolve; });
  await page.route(`**/api/invoices/${invoice.id}/payments`, async (route) => {
    submitted(); await returned;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "old-actor-receipt", invoiceId: invoice.id, method: "BANK_TRANSFER", reference: pending.payload.reference, amount: 25, status: "SUCCESS", receivingAccountId: account.id, receivingDestinationSnapshot: { accountVersion: 3, confirmedById: actor.id } }) });
  });
  await page.goto("/billing");
  await page.getByRole("button", { name: `Recover receipt for ${invoice.id}`, exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Record received payment", exact: true });
  await modal.getByRole("button", { name: "Recover Original Receipt", exact: true }).click();
  await dispatched;
  await page.evaluate(() => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify({ id: "other-actor", name: "Other cashier", role: "cashier" }));
    window.dispatchEvent(new Event("storage"));
  });
  await expect(modal).toBeHidden();
  const response = page.waitForResponse(`**/api/invoices/${invoice.id}/payments`);
  release(); await response;
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), key)).toEqual(pending);
  await expect(page.getByRole("status").filter({ hasText: "Receipt recorded" })).toHaveCount(0);
});

test("definite destination rejection preserves receipt edits and requires destination and confirmation again", async ({ page }) => {
  await setup(page);
  await page.addInitScript(({ key, pending }) => sessionStorage.setItem(key, JSON.stringify(pending)), { key, pending });
  await page.route(`**/api/invoices/${invoice.id}/payments`, (route) => route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ code: "RECEIVING_ACCOUNT_CHANGED", error: "Receiving destination changed. Review it again." }),
  }));
  await page.goto("/billing");
  await page.getByRole("button", { name: `Recover receipt for ${invoice.id}`, exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Record received payment", exact: true });
  await modal.getByRole("button", { name: "Recover Original Receipt", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("Review it again");
  await expect(modal.getByLabel("Saved receipt amount")).toHaveValue("25");
  await expect(modal.getByLabel("Saved receipt reference")).toHaveValue("BT-ORIGINAL");
  await expect(modal.getByRole("checkbox")).not.toBeChecked();
  await expect(modal.getByRole("button", { name: "Record Received Payment", exact: true })).toBeDisabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull();
});
