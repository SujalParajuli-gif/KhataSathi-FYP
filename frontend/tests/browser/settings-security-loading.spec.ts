import { expect, test, type Page, type Route } from "@playwright/test";

const user = { id: "browser-admin", name: "Settings Admin", role: "admin" };

type AuditResponse = { logs: Array<Record<string, unknown>>; total: number };

async function setupSettingsMock(
  page: Page,
  onAudit: (route: Route, url: URL) => Promise<void>,
) {
  await page.addInitScript((value) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(value));
  }, user);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/settings/capabilities") {
      return respond({
        businessMode: "CATALOG_ONLY",
        catalogEnabled: true,
        inventoryEnabled: false,
        posEnabled: false,
        stockTracked: false,
        staffDraftRequestsEnabled: false,
      });
    }
    if (url.pathname === "/api/auth/me") return respond({ user });
    if (url.pathname === "/api/settings/business") return respond({ name: "Test Store" });
    if (url.pathname === "/api/audit") return onAudit(route, url);
    if (url.pathname === "/api/audit/login-attempts") {
      return respond({ attempts: [], total: 0 });
    }
    return respond({});
  });
}

async function openSecurityTab(page: Page) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Audit & Security" }).click();
}

async function applyAuditAction(page: Page, action: string) {
  await page.getByRole("textbox", { name: "Audit Action" }).fill(action);
  await page.getByRole("button", { name: "Apply Filters" }).click();
}

function auditRow(id: string, action: string) {
  return {
    id,
    action,
    entityType: "PRODUCT",
    entityId: id,
    meta: {},
    actor: { name: "Settings Admin" },
    createdAt: "2026-09-26T00:00:00.000Z",
  };
}

test.describe("Settings security request lifecycle", () => {
  test("discarded responses cannot replace a newer filter, and returning to a filter reloads its rows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let releaseCreate!: () => void;
    let releaseUpdate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let createRequests = 0;
    let updateRequests = 0;

    await setupSettingsMock(page, async (route, url) => {
      const action = url.searchParams.get("action");
      let body: AuditResponse = { logs: [], total: 0 };
      if (action === "CREATE") {
        createRequests++;
        if (createRequests === 1) await createGate;
        body = { logs: [auditRow("created-product", "CREATE")], total: 1 };
      } else if (action === "UPDATE") {
        updateRequests++;
        await updateGate;
        body = { logs: [auditRow("updated-product", "UPDATE")], total: 1 };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    try {
      await openSecurityTab(page);
      await expect(page.getByText("No audit activity matches these filters").first()).toBeVisible();

      await applyAuditAction(page, "CREATE");
      await expect.poll(() => createRequests).toBe(1);
      await applyAuditAction(page, "UPDATE");
      await expect.poll(() => updateRequests).toBe(1);

      releaseCreate();
      await expect(page.getByRole("status").filter({ hasText: "Loading security activity" })).toBeVisible();
      await expect(page.getByText("created-product", { exact: false })).toHaveCount(0);

      releaseUpdate();
      await expect(page.getByText("ID: updated-product")).toBeVisible();
      await expect(page.getByText("ID: created-product")).toHaveCount(0);

      await applyAuditAction(page, "CREATE");
      await expect.poll(() => createRequests).toBe(2);
      await expect(page.getByText("ID: created-product")).toBeVisible();
      await expect(page.getByText("ID: updated-product")).toHaveCount(0);
    } finally {
      releaseCreate();
      releaseUpdate();
    }
  });

  for (const width of [1440, 390]) {
    test(`initial request failure is not an empty result and retry works at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      let failAudit = true;
      let auditRequests = 0;
      let releaseInitial!: () => void;
      const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
      await setupSettingsMock(page, async (route) => {
        auditRequests++;
        if (auditRequests === 1) await initialGate;
        await route.fulfill({
          status: failAudit ? 503 : 200,
          contentType: "application/json",
          body: JSON.stringify(failAudit ? { message: "Temporarily unavailable" } : { logs: [], total: 0 }),
        });
      });

      try {
        await openSecurityTab(page);
        await expect.poll(() => auditRequests).toBe(1);
        await expect(page.getByRole("status").filter({ hasText: "Loading security activity" })).toBeVisible();
        await expect(page.getByText("No audit activity matches these filters")).toHaveCount(0);

        releaseInitial();
        await expect(page.getByRole("alert").filter({ hasText: "security activity could not be loaded" })).toBeVisible();
        await expect(page.getByText("No audit activity matches these filters")).toHaveCount(0);

        failAudit = false;
        await page.getByRole("button", { name: "Retry security activity" }).click();
        await expect.poll(() => auditRequests).toBe(2);
        await expect(page.getByRole("alert").filter({ hasText: "security activity could not be loaded" })).toHaveCount(0);
        await expect(page.getByText("No audit activity matches these filters").nth(width === 390 ? 1 : 0)).toBeVisible();
      } finally {
        releaseInitial();
      }
    });
  }
});
