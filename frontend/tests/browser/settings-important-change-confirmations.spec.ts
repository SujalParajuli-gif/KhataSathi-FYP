import { expect, test, type Page, type Route } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const admin = { id: "settings-confirm-admin", name: "Settings Admin", role: "admin" };

type SettingsState = {
  businessMode: "FULL_POS";
  staffDraftRequestsEnabled: boolean;
  defaultLowStockThreshold: number;
  defaultWholesaleQtyThreshold: number;
  loyaltyDiscountPercent: number;
  returnWindowDays: number;
  parkedBillExpiryHours: number;
  draftRequestExpiryMinutes: number;
  defaultInitialStock: number;
  taxCalculationMode: "UNKNOWN" | "NO_VAT" | "VAT_EXCLUSIVE";
  defaultBillingChannel: "MANUAL_EXTERNAL" | null;
};

function initialSettings(): SettingsState {
  return {
    businessMode: "FULL_POS",
    staffDraftRequestsEnabled: false,
    defaultLowStockThreshold: 5,
    defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 2,
    returnWindowDays: 7,
    parkedBillExpiryHours: 8,
    draftRequestExpiryMinutes: 30,
    defaultInitialStock: 30,
    taxCalculationMode: "UNKNOWN",
    defaultBillingChannel: null,
  };
}

async function mockSettings(page: Page, options?: { failTaxSave?: boolean }) {
  let settings = initialSettings();
  const updates: Array<Partial<SettingsState>> = [];

  await page.addInitScript((user) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
    localStorage.setItem("khatasathi_token", "settings-confirm-token");
  }, admin);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me") return respond({ user: admin });
    if (path === "/api/settings/capabilities") {
      return respond({
        businessMode: "FULL_POS",
        catalogEnabled: true,
        inventoryEnabled: true,
        posEnabled: true,
        stockTracked: true,
        staffDraftRequestsEnabled: false,
      });
    }
    if (path === "/api/settings/business" && method === "GET") return respond(settings);
    if (path === "/api/settings/business" && method === "PUT") {
      const patch = route.request().postDataJSON() as Partial<SettingsState>;
      updates.push(patch);
      if (options?.failTaxSave && patch.taxCalculationMode) {
        return respond({ error: "Tax status could not be saved for this test." }, 500);
      }
      settings = { ...settings, ...patch };
      return respond(settings);
    }
    if (path === "/api/settings/cashiers") return respond({ cashiers: [] });
    if (path === "/api/settings/override-policy") return respond({ enabled: false });
    if (path === "/api/brands") return respond({ brands: [] });
    return respond({});
  });

  return { updates };
}

async function chooseProjectSelectOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("Settings important-change confirmations", () => {
  test("tax status stays staged until confirmed and cancellation restores its saved value", async ({ page }) => {
    const { updates } = await mockSettings(page);
    await page.goto("/settings");

    const taxStatus = page.getByRole("combobox", { name: "VAT registration status" });
    await expect(taxStatus).toContainText("Not configured");
    await chooseProjectSelectOption(page, "VAT registration status", "VAT registered — prices exclude VAT");
    await page.getByRole("button", { name: "Review change" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Current status")).toBeVisible();
    await expect(dialog.getByText("Not configured — keep tax status unknown")).toBeVisible();
    await expect(dialog.getByText("VAT registered — prices exclude VAT")).toBeVisible();
    expect(updates).toHaveLength(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(taxStatus).toContainText("Not configured");
    expect(updates).toHaveLength(0);

    await chooseProjectSelectOption(page, "VAT registration status", "VAT registered — prices exclude VAT");
    await page.getByRole("button", { name: "Review change" }).click();
    await dialog.getByRole("button", { name: "Save VAT status" }).click();

    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0]).toEqual({ taxCalculationMode: "VAT_EXCLUSIVE" });
    await expect(dialog).toHaveCount(0);
    await expect(taxStatus).toContainText("VAT registered");
    await page.getByRole("heading", { name: "Business VAT status" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), "TASK-UI-003-settings-desktop.png") });
  });

  test("billing-channel change is not saved before confirmation and tax save failures remain recoverable", async ({ page }) => {
    const { updates } = await mockSettings(page, { failTaxSave: true });
    await page.goto("/settings");

    const billingChannel = page.getByRole("combobox", { name: "Default billing channel" });
    await expect(billingChannel).toContainText("Standard POS Register");
    await chooseProjectSelectOption(page, "Default billing channel", "Manual External Paper Bill");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Current default")).toBeVisible();
    await expect(dialog.getByText("Standard POS Register")).toBeVisible();
    await expect(dialog.getByText("Manual External Paper Bill")).toBeVisible();
    await expect(billingChannel).toContainText("Standard POS Register");
    expect(updates).toHaveLength(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(billingChannel).toContainText("Standard POS Register");

    const taxStatus = page.getByRole("combobox", { name: "VAT registration status" });
    await chooseProjectSelectOption(page, "VAT registration status", "VAT registered — prices exclude VAT");
    await page.getByRole("button", { name: "Review change" }).click();
    await dialog.getByRole("button", { name: "Save VAT status" }).click();

    await expect.poll(() => updates.length).toBe(1);
    await expect(dialog.getByRole("alert")).toContainText("Tax status could not be saved for this test.");
    await expect(taxStatus).toContainText("VAT registered");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(taxStatus).toContainText("Not configured");
  });

  test("mobile keyboard confirmation saves billing channel once and Escape cancels staged VAT status", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { updates } = await mockSettings(page);
    await page.goto("/settings");
    const billingChannel = page.getByRole("combobox", { name: "Default billing channel" });
    await billingChannel.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(updates).toHaveLength(0);
    await page.screenshot({ path: join(tmpdir(), "TASK-UI-003-settings-mobile-dialog.png") });
    await dialog.getByRole("button", { name: "Save billing channel" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(updates).toEqual([{ defaultBillingChannel: "MANUAL_EXTERNAL" }]);
    await expect(billingChannel).toContainText("Manual External Paper Bill");

    await chooseProjectSelectOption(page, "VAT registration status", "VAT registered — prices exclude VAT");
    await page.getByRole("button", { name: "Review change" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "VAT registration status" })).toContainText("Not configured");
    expect(updates).toHaveLength(1);
    await page.getByRole("heading", { name: "Business VAT status" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), "TASK-UI-003-settings-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
