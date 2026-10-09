import { expect, test, type Page } from "@playwright/test";

const posCapabilities = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  stockTracked: true,
  staffDraftRequestsEnabled: true,
};

const adminUser = {
  id: "admin-1",
  name: "Admin User",
  role: "admin",
};

const mockInvoices = [
  {
    id: "inv-captured-1",
    invoiceNo: "INV-2026-CAP1",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T10:00:00.000Z",
    customerId: "cust-1",
    customer: {
      id: "cust-1",
      name: "Live Customer Changed",
      phone: "9841000000",
      wholesalePercent: 10,
    },
    displayCustomer: {
      name: "Historical Customer Alpha",
      panNo: "009876543",
      address: "Dharan, Nepal",
      source: "CAPTURED",
    },
    cashier: { id: "cashier-1", name: "Main Cashier" },
    subTotal: 500,
    loyaltyDiscountAmount: 0,
    netTotal: 500,
    paidTotal: 500,
    dueAmount: 0,
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        qty: 2,
        unitPrice: 250,
        lineTotal: 500,
        product: {
          id: "prod-1",
          name: "Live Product Name Different",
          sku: "LIVE-SKU",
        },
        displayProduct: {
          name: "Historical Product Alpha",
          sku: "00HIST-SKU-1",
          source: "CAPTURED",
        },
      },
    ],
    payments: [
      {
        id: "pay-1",
        method: "CASH",
        kind: "CHARGE",
        status: "SUCCESS",
        amount: 500,
        createdAt: "2026-04-18T10:00:00.000Z",
      },
    ],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-mixed-2",
    invoiceNo: "INV-2026-MIX2",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T11:00:00.000Z",
    customerId: "cust-2",
    customer: {
      id: "cust-2",
      name: "Customer Beta",
      phone: "9842000000",
    },
    displayCustomer: {
      name: "Customer Beta",
      panNo: null,
      address: null,
      source: "LEGACY_LIVE_FALLBACK",
    },
    cashier: { id: "cashier-1", name: "Main Cashier" },
    subTotal: 300,
    discount: 0,
    netTotal: 300,
    paidTotal: 300,
    dueAmount: 0,
    items: [
      {
        id: "item-2a",
        productId: "prod-2a",
        qty: 1,
        unitPrice: 100,
        lineTotal: 100,
        product: { id: "prod-2a", name: "Item A Live", sku: "SKU-A" },
        displayProduct: {
          name: "Item A Captured",
          sku: "SKU-A",
          source: "CAPTURED",
        },
      },
      {
        id: "item-2b",
        productId: "prod-2b",
        qty: 1,
        unitPrice: 200,
        lineTotal: 200,
        product: { id: "prod-2b", name: "Item B Current Catalog", sku: "SKU-B" },
        displayProduct: {
          name: "Item B Current Catalog",
          sku: "SKU-B",
          source: "LEGACY_LIVE_FALLBACK",
        },
      },
    ],
    payments: [
      {
        id: "pay-2",
        method: "CASH",
        kind: "CHARGE",
        status: "SUCCESS",
        amount: 300,
        createdAt: "2026-04-18T11:00:00.000Z",
      },
    ],
    creditNotesAsOriginal: [],
  },
];

async function setupMockApi(page: Page) {
  await page.addInitScript(
    (value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)),
    adminUser,
  );

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const urlObj = new URL(route.request().url());
    const path = urlObj.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/capabilities")) return respond(posCapabilities);
    if (path.endsWith("/auth/me")) return respond({ user: adminUser });
    if (path.endsWith("/alerts")) return respond({ alerts: [], unreadCount: 0 });
    if (path.endsWith("/users/cashiers/privileges")) {
      return respond({
        canApplyDiscounts: true,
        canOverridePrices: true,
        canVoidPayments: true,
      });
    }
    if (path === "/api/users") {
      return respond([
        { id: "admin-1", name: "Admin User", role: "ADMIN", isActive: true },
        { id: "cashier-1", name: "Main Cashier", role: "CASHIER", isActive: true },
      ]);
    }
    if (path === "/api/invoices/parked") return respond([]);
    if (path === "/api/returns") return respond([]);

    if (path === "/api/invoices") {
      return respond({
        invoices: mockInvoices,
        total: mockInvoices.length,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
    }

    const singleInvoiceMatch = path.match(/^\/api\/invoices\/([^/]+)$/);
    if (singleInvoiceMatch) {
      const invId = singleInvoiceMatch[1];
      const found = mockInvoices.find((i) => i.id === invId);
      if (found) return respond(found);
      return respond({ error: "Not found" }, 404);
    }

    if (path === "/api/audit/history") {
      return respond({
        category: "sales",
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        events: [],
      });
    }

    return respond({});
  });
}

test.describe("Frontend Invoice Historical Identity Consumption", () => {
  test("Desktop: Invoices list and detail modal render historical identity, captured PAN/Address, and provenance badges", async ({
    page,
  }) => {
    await setupMockApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto("/invoices");

    // Check captured customer name is rendered instead of current live customer name
    await expect(page.getByText("Historical Customer Alpha").first()).toBeVisible();
    await expect(page.getByText("Live Customer Changed")).toHaveCount(0);

    // Check customer provenance badges
    await expect(page.getByText("Captured at sale").first()).toBeVisible();
    await expect(page.getByText("Legacy identity — current labels").first()).toBeVisible();

    // Check item provenance notice on invoice with mixed legacy fallback items
    await expect(
      page.getByText("Contains items with current catalog labels").first(),
    ).toBeVisible();

    // Open detail modal for the captured invoice
    await page.getByRole("button", { name: "View invoice INV-2026-CAP1" }).click();

    const modal = page.locator('div[role="dialog"]');
    await expect(modal).toBeVisible();

    // Customer panel inside modal
    await expect(modal.getByText("Historical Customer Alpha")).toBeVisible();
    await expect(modal.getByText("Captured at sale").first()).toBeVisible();
    await expect(modal.getByText("009876543")).toBeVisible();
    await expect(modal.getByText("Dharan, Nepal")).toBeVisible();
    await expect(
      modal.getByText("Current customer information: Wholesale customer | 9841000000"),
    ).toBeVisible();

    // Items list inside modal
    await expect(modal.getByText("Historical Product Alpha")).toBeVisible();
    await expect(modal.getByText("(00HIST-SKU-1)")).toBeVisible();
    await expect(modal.getByText("Live Product Name Different")).toHaveCount(0);

    // Close modal using top-right close button with aria-label
    await modal.getByLabel("Close").click();
    await expect(modal).toHaveCount(0);
  });

  test("Mobile: Invoices cards and History page invoice section render customer provenance and item notices", async ({
    page,
  }) => {
    await setupMockApi(page);
    await page.setViewportSize({ width: 375, height: 812 });

    // 1. Check mobile /invoices view
    await page.goto("/invoices");
    const mobileInvoices = page.locator(".lg\\:hidden");
    await expect(mobileInvoices.getByText("Historical Customer Alpha").first()).toBeVisible();
    await expect(mobileInvoices.getByText("Captured at sale").first()).toBeVisible();
    await expect(
      mobileInvoices.getByText("Contains items with current catalog labels").first(),
    ).toBeVisible();

    // 2. Check /history page
    await page.goto("/history");
    const mobileHistory = page.locator(".lg\\:hidden");
    await expect(mobileHistory.getByText("Historical Customer Alpha").first()).toBeVisible();
    await expect(mobileHistory.getByText("Captured at sale").first()).toBeVisible();
    await expect(
      mobileHistory.getByText("Contains items with current catalog labels").first(),
    ).toBeVisible();
  });
});
