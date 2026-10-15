import { expect, test, type Page } from "@playwright/test";

const fullPosCapabilities = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  stockTracked: true,
  staffDraftRequestsEnabled: true,
};

async function setupMockUser(
  page: Page,
  role: "admin" | "manager" | "cashier" | "staff" = "admin",
) {
  const user = {
    id: `${role}-nav-test`,
    name: role === "admin" ? "John Doe" : role === "staff" ? "Staff User" : "Cashier User",
    role,
  };

  await page.addInitScript((val) => {
    localStorage.setItem("khatasathi_auth_user", JSON.stringify(val));
    localStorage.setItem("khatasathi_session_token", "test-token");
  }, user);

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};

    if (path.endsWith("/capabilities")) {
      body = fullPosCapabilities;
    } else if (path.endsWith("/auth/me")) {
      body = { user };
    } else if (path.endsWith("/alerts")) {
      body = { alerts: [], unreadCount: 0 };
    } else if (path === "/api/users/presence") {
      body = { ok: true };
    } else if (path.includes("/manual-bills")) {
      body = { items: [], totalCount: 0, totalPages: 1 };
    } else if (path.includes("/audit/history")) {
      body = { category: "sales", total: 0, page: 1, pageSize: 20, totalPages: 1, events: [] };
    } else if (path === "/api/products/price-lookup") {
      body = { products: [], total: 0, page: 1, pageSize: 20, visibility: {} };
    } else if (path.endsWith("/stats") || path.endsWith("/metrics")) {
      body = {};
    } else {
      body = [];
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("Desktop expanded and collapsed sidebar navigation with flyout and persistence", async ({
  page,
}, testInfo) => {
  await setupMockUser(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const sidebar = page.locator("#app-sidebar");
  await expect(sidebar).toBeVisible();

  // Verify sidebar width is 260px expanded
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(260, 5);

  // Take screenshot: expanded desktop
  await page.screenshot({ path: testInfo.outputPath("desktop-expanded.png") });

  // Verify Quick Access destinations
  await expect(sidebar.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Product Lookup" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Invoices" })).toBeVisible();

  // Verify Accordion toggle in Workspaces
  const salesToggle = sidebar.locator("[data-group-toggle='sales']");
  await expect(salesToggle).toBeVisible();
  await salesToggle.click();
  await expect(sidebar.getByRole("link", { name: "Customer Receivables" })).toBeVisible();

  // Collapse sidebar to icon rail
  const collapseBtn = page.getByRole("button", { name: /Collapse sidebar/i });
  await expect(collapseBtn).toBeVisible();
  await collapseBtn.click();

  // Verify collapsed width smoothly animates to 80px
  await expect(sidebar).toHaveClass(/lg:w-\[80px\]/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(80, 5);

  // Take screenshot: collapsed desktop
  await page.screenshot({ path: testInfo.outputPath("desktop-collapsed.png") });

  // Click group icon in rail to open floating flyout menu
  await sidebar.locator("[data-group-toggle='sales']").click();
  const flyout = page.locator("[data-nav-flyout]");
  await expect(flyout).toBeVisible();
  await expect(flyout.getByRole("link", { name: "Customer Receivables" })).toBeVisible();
  await expect(flyout.getByRole("link", { name: "Manual Bills" })).toBeVisible();

  // Click outside to dismiss flyout
  await page.mouse.click(500, 300);
  await expect(flyout).toBeHidden();

  // Re-expand sidebar
  const expandBtn = page.getByRole("button", { name: /Expand sidebar/i });
  await expandBtn.click();
  await expect(sidebar).toHaveClass(/lg:w-\[260px\]/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(260, 5);
});

test("Command Search modal search and keyboard navigation", async ({ page }) => {
  await setupMockUser(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // Trigger search via topbar search button or keyboard shortcut
  const searchBtn = page.getByRole("button", { name: "Search navigation pages" });
  await expect(searchBtn).toBeVisible();
  await searchBtn.click();

  const dialog = page.getByRole("dialog", { name: "Find a page" });
  await expect(dialog).toBeVisible();

  // Capture screenshot of centered, larger modal
  await page.screenshot({ path: "test-results/screenshots/command-search-modal.png" });

  const searchInput = dialog.getByRole("searchbox", { name: "Search navigation pages" });
  await expect(searchInput).toBeFocused();

  // Verify auto-scrolling with keyboard ArrowDown navigation
  const scrollContainer = dialog.locator(".overflow-y-auto");
  const initialScrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(initialScrollTop).toBe(0);

  // Press ArrowDown 10 times to navigate past visible view height
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowDown");
  }

  // Confirm auto-scroll scrolled down to keep selected element in view
  const scrolledDownTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrolledDownTop).toBeGreaterThan(0);

  // Press ArrowUp 10 times to navigate back to the top item
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowUp");
  }

  const scrolledBackTop = await scrollContainer.evaluate((el) => el.scrollTop);
  expect(scrolledBackTop).toBe(0);

  // Type search query
  await searchInput.fill("Lookup");
  const lookupOption = dialog.getByRole("option", { name: /Product Lookup/i });
  await expect(lookupOption).toBeVisible();

  // Press Enter to navigate
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/product-lookup$/);
});

test("Admin mobile bottom navigation and deduplicated secondary drawer", async ({
  page,
}, testInfo) => {
  await setupMockUser(page, "admin");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();

  // Verify Admin primary bottom destinations
  await expect(bottomNav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Product Lookup" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Invoices" })).toBeVisible();
  const moreBtn = bottomNav.getByRole("button", { name: /Open more navigation options/i });
  await expect(moreBtn).toBeVisible();

  // Take screenshot: Admin mobile
  await page.screenshot({ path: testInfo.outputPath("admin-mobile.png") });

  // Open secondary drawer
  await moreBtn.click();
  const drawer = page.locator("#mobile-drawer");
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath("admin-mobile-drawer.png") });

  // CRITICAL CHECK: Bottom nav items (Dashboard, Product Lookup, Invoices) MUST NOT appear in drawer!
  await expect(drawer.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(drawer.getByRole("link", { name: "Product Lookup" })).toHaveCount(0);
  await expect(drawer.getByRole("link", { name: "Invoices" })).toHaveCount(0);

  // Remaining authorized destinations MUST be discoverable in drawer
  await expect(drawer.locator("[data-group-toggle='sales']")).toBeVisible();
  await expect(drawer.locator("[data-group-toggle='inventory']")).toBeVisible();
  await expect(drawer.locator("[data-group-toggle='operations']")).toBeVisible();
  await expect(drawer.locator("[data-group-toggle='system']")).toBeVisible();

  // Open Sales group and navigate to Manual Bills
  await drawer.locator("[data-group-toggle='sales']").click();
  const manualBillsLink = drawer.getByRole("link", { name: "Manual Bills" });
  await expect(manualBillsLink).toBeVisible();
  await manualBillsLink.click();

  // Drawer closes after selection and URL updates
  await expect(page).toHaveURL(/\/manual-bills$/);
  await expect(drawer).not.toHaveClass(/translate-x-0/);

  // When on secondary route /manual-bills, More tab indicates active secondary state
  const activeMoreBtn = page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: /Open more navigation options/i });
  await expect(activeMoreBtn).toHaveClass(/text-slate-950/);
});

test("Staff mobile navigation preserves Lookup, Requests, Profile and deduplicates", async ({
  page,
}, testInfo) => {
  await setupMockUser(page, "staff");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/product-lookup");

  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();

  // Staff primary tabs
  await expect(bottomNav.getByRole("link", { name: "Product Lookup" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Requests" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Profile" })).toBeVisible();
  const moreBtn = bottomNav.getByRole("button", { name: /Open more navigation options/i });
  await expect(moreBtn).toBeVisible();

  // Take screenshot: Staff mobile
  await page.screenshot({ path: testInfo.outputPath("staff-mobile.png") });

  // Open drawer
  await moreBtn.click();
  const drawer = page.locator("#mobile-drawer");
  await expect(drawer).toBeVisible();

  // Deduplication: Lookup, Requests, Profile are NOT duplicated in drawer links
  await expect(drawer.getByRole("link", { name: "Product Lookup" })).toHaveCount(0);
  await expect(drawer.getByRole("link", { name: "Requests" })).toHaveCount(0);

  // Logout is safely available in drawer footer
  await expect(drawer.getByRole("link", { name: "Logout" })).toBeVisible();
});
