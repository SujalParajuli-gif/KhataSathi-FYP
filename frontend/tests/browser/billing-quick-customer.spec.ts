import { test, expect } from "@playwright/test";

const cashier = { id: "cashier-1", name: "Cashier One", role: "cashier" };

test("cashier can quick-create a customer, recover from failure, and select the saved customer", async ({ page }) => {
  let quickCreateCalls = 0;
  let releaseQuickCreate: (() => void) | undefined;
  let quickCreatePayload: Record<string, unknown> | undefined;
  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "test-session");
  }, cashier);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (path.endsWith("/auth/me")) return respond({ user: cashier });
    if (path.endsWith("/capabilities")) return respond({
      businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true,
      posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true,
    });
    if (path.endsWith("/customers/quick")) {
      quickCreateCalls++;
      quickCreatePayload = route.request().postDataJSON();
      if (quickCreateCalls === 1) return respond({ error: "Phone number already exists" }, 409);
      await new Promise<void>((resolve) => { releaseQuickCreate = resolve; });
      const input = (quickCreatePayload || {}) as Record<string, any>;
      return respond({
        id: "customer-new", name: input.name, phone: input.phone || null,
        email: input.email || null, panNo: input.panNo || null,
        address: input.address || null, loyaltyPercent: 0, wholesalePercent: 0,
      }, 201);
    }
    if (path.endsWith("/customers")) return respond([]);
    if (path.endsWith("/products")) return respond({ products: [], total: 0, page: 1, pageSize: 50 });
    if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
    return respond({});
  });

  await page.goto("/billing");
  await expect(page.getByRole("button", { name: "Change customer" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Change customer" }).click();
  await page.getByRole("button", { name: "+ Add a customer" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Sita Store");
  await page.getByLabel("Phone (optional)").fill("+9779812345678");
  await page.getByLabel("PAN (optional)").fill("001234567");
  const addButton = page.getByRole("button", { name: "Add customer" });
  await addButton.click();
  await expect(page.getByRole("alert")).toHaveText("Phone number already exists");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Sita Store");

  await addButton.click();
  const pendingButton = page.getByRole("button", { name: "Adding…" });
  await expect(pendingButton).toBeDisabled();
  expect(quickCreateCalls).toBe(2);
  releaseQuickCreate?.();
  await expect(page.getByRole("button", { name: "Customer Sita Store" })).toBeVisible();
  expect(quickCreateCalls).toBe(2);
  expect(Object.keys(quickCreatePayload || {}).sort()).toEqual(["name", "panNo", "phone"]);
});
