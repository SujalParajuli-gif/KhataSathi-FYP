import { expect, test, type Page } from "@playwright/test";

const user = { id: "focus-admin", name: "Focus admin", role: "admin" };

async function mockCatalog(page: Page) {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/capabilities")) body = {
      businessMode: "CATALOG_ONLY", catalogEnabled: true, inventoryEnabled: false,
      posEnabled: false, stockTracked: false, staffDraftRequestsEnabled: false,
    };
    else if (path.endsWith("/auth/me")) body = { user };
    else if (path.endsWith("/alerts")) body = { alerts: [{
      key: "focus-alert", title: "Catalog update", message: "Review the import",
      level: "INFO", type: "Product", createdAt: "2026-09-26T00:00:00Z",
      read: false, resolved: false,
    }], unreadCount: 1 };
    else if (path.endsWith("/bin")) body = { records: [], total: 0, page: 1, pageSize: 20, totalPages: 1 };
    else if (path.endsWith("/products")) body = { products: [], total: 0, page: 1, pageSize: 50 };
    else if (path.endsWith("/import-batches")) body = { batches: [] };
    else if (path.endsWith("/brands") || path.endsWith("/categories")) body = [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("Catalog mobile keyboard and actions", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("closed sidebar is not keyboard reachable; Escape restores focus", async ({ page }) => {
    await mockCatalog(page);
    await page.goto("/bin");
    const trigger = page.getByRole("button", { name: "Open sidebar" });
    const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
    await expect(trigger).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(sidebar.getByRole("link", { name: "Products" })).toBeHidden();
    await trigger.focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getElementById("app-sidebar")?.contains(document.activeElement))).toBe(false);
    await trigger.click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Close navigation drawer" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("alert actions expand without clipping and Escape returns focus", async ({ page }) => {
    await mockCatalog(page);
    await page.goto("/alerts");
    await expect(page.getByText("Catalog update")).toBeVisible();
    const trigger = page.getByRole("button", { name: "Actions" });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const actions = page.getByRole("group", { name: "Alert actions" });
    await expect(actions.getByRole("button", { name: "Read" })).toBeVisible();
    const bounds = await actions.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await actions.getByRole("button", { name: "Read" }).focus();
    await page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await actions.getByRole("button", { name: "Read" }).click();
    await trigger.click();
    await expect(actions.getByRole("button", { name: "Unread" })).toBeVisible();
    await page.keyboard.press("Escape");
    const unreadOnly = page.getByRole("checkbox", { name: "Unread only" });
    await unreadOnly.focus();
    await page.keyboard.press("Space");
    await expect(unreadOnly).toBeChecked();
    await expect(page.getByText("No alerts found.")).toBeVisible();
  });

  test("product actions and filters have keyboard focus and restore it", async ({ page }) => {
    await mockCatalog(page);
    await page.goto("/products");
    const actionsTrigger = page.getByRole("button", { name: "More product actions" });
    await expect(actionsTrigger).toBeVisible();
    await actionsTrigger.click();
    const actions = page.getByRole("dialog", { name: "Product actions" });
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button", { name: "Import products" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    await expect(actionsTrigger).toBeFocused();

    const filtersTrigger = page.getByRole("button", { name: /^Open filter/ });
    await filtersTrigger.click();
    const filters = page.getByRole("dialog", { name: "Filters" });
    await expect(filters).toBeVisible();
    await expect(filters.getByRole("button", { name: "Close filters" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(filters).toHaveCount(0);
    await expect(filtersTrigger).toBeFocused();

    await actionsTrigger.click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(actions).toHaveCount(0);
  });

  test("product editor tabs support keyboard navigation and linked panels", async ({ page }) => {
    await mockCatalog(page);
    await page.goto("/products");
    await page.getByRole("button", { name: "Add Product" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Product" });
    const tabs = dialog.getByRole("tablist", { name: "Product form steps" });
    const basic = tabs.locator("#tab-basic");
    const units = tabs.locator("#tab-units");
    await expect(basic).toHaveAttribute("aria-selected", "true");
    await expect(units).toHaveAttribute("aria-controls", "panel-units");
    await expect(dialog.locator("#panel-review")).toBeAttached();
    await basic.focus();
    await page.keyboard.press("ArrowRight");
    await expect(units).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(units).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator("#panel-units")).toBeVisible();
  });
});
