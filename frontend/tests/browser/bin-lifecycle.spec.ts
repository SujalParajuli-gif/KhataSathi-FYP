import { expect, test, type Page, type Route } from "@playwright/test";

const user = { id: "bin-admin", name: "Bin admin", role: "admin" };
const capabilities = {
  businessMode: "CATALOG_ONLY", catalogEnabled: true, inventoryEnabled: false,
  posEnabled: false, stockTracked: false, staffDraftRequestsEnabled: false,
};

function record(id: string, entityType = "Document") {
  return {
    id, entityId: id, entityLabel: id, entityType, deletedById: user.id,
    deleteReason: null, entitySnapshot: {}, purgeAfter: "2026-10-26T00:00:00Z",
    purgedAt: null, createdAt: "2026-09-26T00:00:00Z", deletedBy: { name: user.name },
  };
}

function binResponse(records: ReturnType<typeof record>[]) {
  return { records, total: records.length, page: 1, pageSize: 20, totalPages: 1 };
}

async function mockCatalog(page: Page, onBin: (route: Route) => Promise<void>) {
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/bin") return onBin(route);
    const body = path.endsWith("/capabilities") ? capabilities
      : path.endsWith("/auth/me") ? { user }
      : path.endsWith("/alerts") ? { alerts: [], unreadCount: 0 }
      : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

for (const width of [1440, 390]) {
  test.describe(`Bin lifecycle at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    async function chooseType(page: Page, name: string) {
      if (width < 1024) await page.getByRole("group", { name: "Bin record type" }).getByRole("button", { name }).click();
      else await page.getByRole("button", { name, exact: true }).click();
    }

    test("failed initial load and retry do not claim the bin is empty", async ({ page }) => {
      let requests = 0;
      await mockCatalog(page, async (route) => {
        requests++;
        await route.fulfill({
          status: requests === 1 ? 500 : 200,
          contentType: "application/json",
          body: JSON.stringify(requests === 1 ? { message: "Temporary failure" } : binResponse([record("Recovered document")])),
        });
      });
      await page.goto("/bin");
      await expect(page.getByText("Failed to load bin")).toBeVisible();
      await expect(page.getByText("Bin is empty")).toHaveCount(0);
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("Recovered document")).toBeVisible();
      expect(requests).toBe(2);
    });

    test("rate-limited initial load never reports an empty bin before recovery", async ({ page }) => {
      test.setTimeout(30000);
      let requests = 0;
      let releaseRecovery: (() => void) | undefined;
      let markRecoveryStarted!: () => void;
      const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
      await mockCatalog(page, async (route) => {
        requests++;
        if (requests === 2) {
          markRecoveryStarted();
          await new Promise<void>((resolve) => { releaseRecovery = resolve; });
        }
        await route.fulfill({
          status: requests === 1 ? 429 : 200,
          headers: requests === 1 ? { "Retry-After": "1" } : {},
          contentType: "application/json",
          body: JSON.stringify(requests === 1 ? { message: "Too many requests" } : binResponse([])),
        });
      });
      try {
        await page.goto("/bin");
        await recoveryStarted;
        await expect(page.getByText("Bin is empty")).toHaveCount(0);
        await expect(page.getByText("Loading bin...")).toBeVisible();
        releaseRecovery?.();
        await expect(page.getByText("Bin is empty")).toBeVisible({ timeout: 10000 });
        expect(requests).toBe(2);
      } finally {
        releaseRecovery?.();
      }
    });

    test("filter failure preserves labelled old results and a retry replaces them", async ({ page }) => {
      let filteredRequests = 0;
      await mockCatalog(page, async (route) => {
        const filter = new URL(route.request().url()).searchParams.get("entityType");
        if (filter === "ProductImportBatch") filteredRequests++;
        const fail = filter === "ProductImportBatch" && filteredRequests === 1;
        await route.fulfill({
          status: fail ? 500 : 200, contentType: "application/json",
          body: JSON.stringify(fail ? { message: "Filter failed" } : binResponse([
            filter === "ProductImportBatch" ? record("Import batch A", "ProductImportBatch") : record("Document A"),
          ])),
        });
      });
      await page.goto("/bin");
      await expect(page.getByText("Document A")).toBeVisible();
      await chooseType(page, "Import Reviews");
      if (width < 1024) {
        await expect(page.getByRole("group", { name: "Bin record type" }).getByRole("button", { name: "Import Reviews" })).toHaveAttribute("aria-pressed", "true");
      }
      await expect(page.getByRole("alert").filter({ hasText: "Showing previous results" })).toBeVisible();
      await expect(page.getByText("Document A")).toBeVisible();
      await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled();
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("Import batch A")).toBeVisible();
      await expect(page.getByText("Document A")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Restore" })).toBeEnabled();
    });

    test("late response from an older filter cannot replace the selected filter", async ({ page }) => {
      let releaseOld: (() => void) | undefined;
      let markStarted!: () => void;
      let markHandled!: () => void;
      const oldStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      const oldHandled = new Promise<void>((resolve) => { markHandled = resolve; });
      await mockCatalog(page, async (route) => {
        const filter = new URL(route.request().url()).searchParams.get("entityType");
        if (filter === "Document") {
          markStarted();
          await new Promise<void>((resolve) => { releaseOld = resolve; });
          try {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(binResponse([record("Old document")])) });
          } catch {
            // An aborted request no longer has a live response to fulfill.
          } finally {
            markHandled();
          }
          return;
        }
        const result = filter === "ProductImportBatch"
          ? binResponse([record("Current import", "ProductImportBatch")])
          : binResponse([record("Initial document")]);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
      });
      try {
        await page.goto("/bin");
        await expect(page.getByText("Initial document")).toBeVisible();
        await chooseType(page, "Documents");
        await oldStarted;
        await chooseType(page, "Import Reviews");
        await expect(page.getByText("Current import")).toBeVisible();
        releaseOld?.();
        await oldHandled;
        await expect(page.getByText("Current import")).toBeVisible();
        await expect(page.getByText("Old document")).toHaveCount(0);
      } finally {
        releaseOld?.();
      }
    });
  });
}
