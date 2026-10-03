import { expect, test } from "@playwright/test";

test("request checkout survives a lost response/reload and clears the posted cart before eSewa redirect", async ({ page }) => {
  const user = { id: "cashier", name: "Cashier", role: "cashier" };
  const product = { id: "product", name: "Checkout product", sku: "SKU-1", retailPrice: 25, wholesalePrice: 25, stock: 50, isActive: true, quantityStep: 1, wholesaleEligible: false };
  const payload = { draftRequestId: "request-1", items: [{ productId: "product", qty: 1 }], payments: [{ method: "ESEWA", amount: 25 }] };
  const key = "checkout-browser-retry-123";
  let attempts: Record<string, unknown>[] = [];
  let completions = 0;
  await page.addInitScript(({ user, payload, key }) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
    if (!sessionStorage.getItem("checkout-test-seeded")) {
      localStorage.setItem("khatasathi_billing_cart", JSON.stringify({
        cart: payload.items, activeDraftRequestId: "request-1",
        pendingCheckout: { operationKey: key, payload, activeDraftRequestId: "request-1" },
        savedAt: new Date().toISOString(),
      }));
      localStorage.setItem("khatasathi_pending_draft_completion", JSON.stringify({ draftRequestId: "legacy-request", invoiceId: "legacy-sale" }));
      sessionStorage.setItem("checkout-test-seeded", "true");
    }
    HTMLFormElement.prototype.submit = function () { (window as any).__gatewaySubmitted = this.action; };
  }, { user, payload, key });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/complete")) completions++;
    if (path.endsWith("/auth/me")) return respond({ user });
    if (path.endsWith("/capabilities")) return respond({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (path.endsWith("/customers") || path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
    if (path.endsWith("/products") || path.endsWith("/products/lookup")) return respond({ products: [product], total: 1 });
    if (path.endsWith("/invoices/checkout")) {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) return route.abort("failed");
      return respond({ invoice: { id: "committed-sale" }, esewaPaymentIntent: { formAction: "https://gateway.example.test/pay", fields: { amount: "25" } } }, 201);
    }
    if (path.includes("/draft-requests")) return respond({ requests: [] });
    return respond({});
  });

  async function submitPending() {
    await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeEnabled();
    await page.getByRole("button", { name: /PAY NOW/ }).click();
    await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
    await page.getByRole("button", { name: /^Confirm NPR/ }).click();
  }
  await page.goto("/billing");
  await submitPending();
  await expect(page.getByText("Checkout outcome is unknown. Your bill is saved; retry to recover the same invoice.").first()).toBeVisible();
  await page.reload();
  await submitPending();
  await expect.poll(() => page.evaluate(() => (window as any).__gatewaySubmitted)).toBe("https://gateway.example.test/pay");
  expect(attempts).toEqual([{ ...payload, operationKey: key }, { ...payload, operationKey: key }]);
  expect(completions).toBe(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("khatasathi_billing_cart"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("khatasathi_pending_draft_completion"))).toContain("legacy-sale");
  await page.reload();
  await expect(page.getByRole("button", { name: /PAY NOW/ })).toBeDisabled();
});
