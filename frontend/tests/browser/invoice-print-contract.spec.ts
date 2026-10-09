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

const mockBusinessSettings = {
  businessName: "Himalayan Retail Hub",
  legalName: "Himalayan Retail & Trade Pvt. Ltd.",
  panNo: "001234567",
  businessAddress: "Thamel Marg, Ward 26, Kathmandu",
  businessPhone: "+977-1-4412345",
  receiptFooter: "Internal Record",
};

const longUnbrokenString = "A".repeat(180);

const mockInvoices = [
  {
    id: "inv-captured-1",
    invoiceNo: "INV-2026-CAP1",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T10:30:00.000Z",
    customerId: "cust-1",
    customer: {
      id: "cust-1",
      name: "Live Customer Changed Name",
      phone: "9841000000",
      wholesalePercent: 10,
    },
    displayCustomer: {
      name: "Captured Customer Alpha",
      panNo: "009876543",
      address: "Biratnagar, Ward 4",
      source: "CAPTURED",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 850,
    loyaltyDiscountAmount: 50,
    netTotal: 800,
    paidTotal: 800,
    dueAmount: 0,
    notes: "Express counter delivery",
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        qty: 2,
        unitPrice: 425,
        lineTotal: 850,
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
        amount: 800,
        cashTendered: 1000,
        changeAmount: 200,
        createdAt: "2026-04-18T10:30:00.000Z",
      },
    ],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-mixed-2",
    invoiceNo: "INV-2026-MIX2",
    status: "PARTIAL",
    paymentStatus: "PARTIAL",
    createdAt: "2026-04-18T11:00:00.000Z",
    customerId: "cust-2",
    customer: {
      id: "cust-2",
      name: "Current Customer Beta",
      phone: "9842000000",
    },
    displayCustomer: {
      name: "Current Customer Beta",
      panNo: null,
      address: null,
      source: "LEGACY_LIVE_FALLBACK",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 600,
    discount: 0,
    netTotal: 600,
    paidTotal: 400,
    dueAmount: 200,
    items: [
      {
        id: "item-2a",
        productId: "prod-2a",
        qty: 1,
        unitPrice: 200,
        lineTotal: 200,
        product: { id: "prod-2a", name: "Live Item A", sku: "SKU-A" },
        displayProduct: {
          name: "Item A Current Catalog",
          sku: "SKU-A",
          source: "LEGACY_LIVE_FALLBACK",
        },
      },
      {
        id: "item-2b",
        productId: "prod-2b",
        qty: 2,
        unitPrice: 200,
        lineTotal: 400,
        product: { id: "prod-2b", name: "Live Item B", sku: "SKU-B" },
        displayProduct: {
          name: "Unknown item",
          source: "LEGACY_UNAVAILABLE",
        },
      },
    ],
    payments: [
      {
        id: "pay-2",
        method: "FONEPAY",
        kind: "CHARGE",
        status: "SUCCESS",
        amount: 400,
        reference: "FP-887766",
        createdAt: "2026-04-18T11:00:00.000Z",
      },
    ],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-long-content-3",
    invoiceNo: "INV-2026-LONG3",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T12:00:00.000Z",
    customerId: "cust-long",
    customer: {
      id: "cust-long",
      name: "Live Short Name",
      phone: "9843000000",
    },
    displayCustomer: {
      name: `LongCustomer_${longUnbrokenString}`,
      panNo: "001234567",
      address: `Ward 5, ${longUnbrokenString}, Kathmandu`,
      source: "CAPTURED",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 1500,
    discount: 0,
    netTotal: 1500,
    paidTotal: 1500,
    dueAmount: 0,
    items: [
      {
        id: "item-long-1",
        productId: "prod-long-1",
        qty: 3,
        unitPrice: 500,
        lineTotal: 1500,
        product: { id: "prod-long-1", name: "Live Short Product", sku: "SHORT-SKU" },
        displayProduct: {
          name: `LongProduct_${longUnbrokenString}`,
          sku: `SKU_${longUnbrokenString}`,
          source: "CAPTURED",
        },
      },
    ],
    payments: [
      {
        id: "pay-long",
        method: "CASH",
        kind: "CHARGE",
        status: "SUCCESS",
        amount: 1500,
        createdAt: "2026-04-18T12:00:00.000Z",
      },
    ],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-captured-null-4",
    invoiceNo: "INV-2026-NULL4",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T13:00:00.000Z",
    customerId: "cust-4",
    customer: {
      id: "cust-4",
      name: "Live Customer Should Not Leak",
      phone: "9844000000",
      wholesalePercent: 15,
    },
    displayCustomer: {
      name: null,
      panNo: null,
      address: null,
      source: "CAPTURED",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 300,
    discount: 0,
    netTotal: 300,
    paidTotal: 300,
    dueAmount: 0,
    items: [
      {
        id: "item-4",
        productId: "prod-4",
        qty: 1,
        unitPrice: 300,
        lineTotal: 300,
        product: { id: "prod-4", name: "Live Product Should Not Leak", sku: "LIVE-SKU-LEAK" },
        displayProduct: {
          name: null,
          sku: null,
          source: "CAPTURED",
        },
      },
    ],
    payments: [],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-draft-compat-5",
    invoiceNo: "INV-2026-DRAFT5",
    status: "DRAFT",
    paymentStatus: "UNPAID",
    createdAt: "2026-04-18T14:00:00.000Z",
    customerId: "cust-5",
    customer: {
      id: "cust-5",
      name: "Draft Customer Current",
      phone: "9845000000",
    },
    displayCustomer: {
      name: "Draft Customer Current",
      panNo: "998877665",
      address: "Draft Address",
      source: "DRAFT_CURRENT",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 250,
    discount: 0,
    netTotal: 250,
    paidTotal: 0,
    dueAmount: 250,
    items: [
      {
        id: "item-5",
        productId: "prod-5",
        qty: 1,
        unitPrice: 250,
        lineTotal: 250,
        product: { id: "prod-5", name: "Draft Product Current", sku: "DRAFT-SKU" },
        displayProduct: {
          name: "Draft Product Current",
          sku: "DRAFT-SKU",
          source: "DRAFT_CURRENT",
        },
      },
    ],
    payments: [],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-legacy-old-6",
    invoiceNo: "INV-2026-LEGACY6",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T15:00:00.000Z",
    customerId: "cust-6",
    customer: {
      id: "cust-6",
      name: "Old Legacy Customer",
      phone: "9846000000",
    },
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 500,
    discount: 0,
    netTotal: 500,
    paidTotal: 500,
    dueAmount: 0,
    items: [
      {
        id: "item-6",
        productId: "prod-6",
        qty: 1,
        unitPrice: 500,
        lineTotal: 500,
        product: { id: "prod-6", name: "Old Legacy Product", sku: "OLD-SKU-6" },
      },
    ],
    payments: [],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-fast",
    invoiceNo: "INV-FAST",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T16:00:00.000Z",
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 100,
    discount: 0,
    netTotal: 100,
    paidTotal: 100,
    dueAmount: 0,
    items: [
      {
        id: "item-fast",
        productId: "prod-fast",
        qty: 1,
        unitPrice: 100,
        lineTotal: 100,
        product: { id: "prod-fast", name: "Fast Item", sku: "FAST-SKU" },
      },
    ],
    payments: [],
    creditNotesAsOriginal: [],
  },
  {
    id: "inv-slow",
    invoiceNo: "INV-SLOW",
    status: "PAID",
    paymentStatus: "PAID",
    createdAt: "2026-04-18T17:00:00.000Z",
    cashier: { id: "cashier-1", name: "Rita Cashier" },
    subTotal: 200,
    discount: 0,
    netTotal: 200,
    paidTotal: 200,
    dueAmount: 0,
    items: [
      {
        id: "item-slow",
        productId: "prod-slow",
        qty: 1,
        unitPrice: 200,
        lineTotal: 200,
        product: { id: "prod-slow", name: "Slow Item", sku: "SLOW-SKU" },
      },
    ],
    payments: [],
    creditNotesAsOriginal: [],
  },
];

async function setupPrintMocks(
  page: Page,
  options?: {
    settingsStatus?: number;
    settingsDelayMs?: number;
    settingsGate?: () => Promise<void>;
    businessSettings?: unknown;
    invoiceDelayMs?: { [id: string]: number };
  },
) {
  // Stub window.print and track calls in window.__printCallCount (persisted in sessionStorage)
  await page.addInitScript(() => {
    const stored = sessionStorage.getItem("__printCallCount");
    (window as unknown as { __printCallCount: number }).__printCallCount = stored ? parseInt(stored, 10) : 0;
    window.print = () => {
      const current = ((window as unknown as { __printCallCount: number }).__printCallCount || 0) + 1;
      (window as unknown as { __printCallCount: number }).__printCallCount = current;
      sessionStorage.setItem("__printCallCount", String(current));
    };
  });

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

    if (path === "/api/settings/business") {
      if (options?.settingsGate) {
        await options.settingsGate();
      }
      if (options?.settingsDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.settingsDelayMs));
      }
      if (options?.settingsStatus && options.settingsStatus !== 200) {
        return respond({ error: "Unauthorized or server error" }, options.settingsStatus);
      }
      return respond(options?.businessSettings !== undefined ? options.businessSettings : mockBusinessSettings);
    }

    const singleInvoiceMatch = path.match(/^\/api\/invoices\/([^/]+)$/);
    if (singleInvoiceMatch) {
      const invId = singleInvoiceMatch[1];
      if (options?.invoiceDelayMs?.[invId]) {
        await new Promise((resolve) => setTimeout(resolve, options.invoiceDelayMs![invId]));
      }
      const found = mockInvoices.find((i) => i.id === invId);
      if (found) return respond(found);
      return respond({ error: "Invoice not found" }, 404);
    }

    return respond({});
  });
}

test.describe("Invoice Print Contract (A4 & 80mm Receipt)", () => {
  test("A4 print format displays worksheet headers, configured business identity, provenance, and captured customer fields", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-captured-1/print");

    // Exact required wording
    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.getByText("NOT A TAX INVOICE", { exact: true })).toBeVisible();
    await expect(page.locator("text=Sale Ref:")).toBeVisible();
    await expect(page.locator("text=INV-2026-CAP1").first()).toBeVisible();

    // Configured business details (with leading zero PAN preservation)
    await expect(page.locator("text=Himalayan Retail Hub").first()).toBeVisible();
    await expect(page.locator("text=Himalayan Retail & Trade Pvt. Ltd.")).toBeVisible();
    await expect(page.locator("text=Business PAN:")).toBeVisible();
    await expect(page.locator("text=001234567")).toBeVisible();
    await expect(page.locator("text=Thamel Marg, Ward 26, Kathmandu")).toBeVisible();
    await expect(page.locator("text=+977-1-4412345")).toBeVisible();

    // Customer section: captured name, captured provenance, captured PAN, captured address
    await expect(page.locator("text=Captured Customer Alpha")).toBeVisible();
    await expect(page.locator("text=[Captured at sale]").first()).toBeVisible();
    await expect(page.locator("text=Customer PAN:")).toBeVisible();
    await expect(page.locator("text=009876543")).toBeVisible();
    await expect(page.locator("text=Biratnagar, Ward 4")).toBeVisible();

    // Verify live customer name/subtitle are NOT rendered in the print body
    await expect(page.locator("text=Live Customer Changed Name")).toHaveCount(0);
    await expect(page.locator("text=Wholesale customer")).toHaveCount(0);

    // Items table: historical item name & SKU with captured provenance
    await expect(page.locator("text=Historical Product Alpha")).toBeVisible();
    await expect(page.locator("text=SKU: 00HIST-SKU-1")).toBeVisible();
    await expect(page.locator("text=Live Product Name Different")).toHaveCount(0);

    // Financial totals
    await expect(page.locator("text=Subtotal")).toBeVisible();
    await expect(page.locator("text=Net Total")).toBeVisible();
    await expect(page.locator("text=NPR 800").first()).toBeVisible();
    await expect(page.locator("text=Express counter delivery")).toBeVisible();

    // Automatic print should have fired exactly once
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("80mm Receipt print format displays compact worksheet layout, business identity, and receipt footer", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-captured-1/print?mode=receipt");

    // Header wording on receipt
    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.getByText("NOT A TAX INVOICE", { exact: true })).toBeVisible();
    await expect(page.locator("text=Himalayan Retail Hub").first()).toBeVisible();
    await expect(page.locator("text=Business PAN: 001234567")).toBeVisible();

    // Sale Ref & Customer info
    await expect(page.locator("text=Sale Ref")).toBeVisible();
    await expect(page.locator("text=INV-2026-CAP1").first()).toBeVisible();
    await expect(page.locator("text=Captured Customer Alpha")).toBeVisible();
    await expect(page.locator("text=Customer PAN")).toBeVisible();
    await expect(page.locator("text=009876543")).toBeVisible();

    // Item details
    await expect(page.locator("text=Historical Product Alpha")).toBeVisible();
    await expect(page.locator("text=SKU: 00HIST-SKU-1")).toBeVisible();

    // Receipt footer
    await expect(page.getByText("Internal Record — Not a Tax Invoice", { exact: true })).toBeVisible();

    // Automatic print should have fired
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("B-1 Regression: Long unbroken strings wrap cleanly and fit usable page width in print media for A4 and 80mm receipt", async ({
    page,
  }) => {
    await setupPrintMocks(page);

    // --- A4 PRINT MEDIA EVALUATION ---
    await page.goto("/invoices/inv-long-content-3/print");
    await expect(page.locator("text=INV-2026-LONG3").first()).toBeVisible();
    await page.emulateMedia({ media: "print" });

    // Verify all text ranges and table cells fit within A4 printable area
    const a4Overflow = await page.evaluate(() => {
      const table = document.querySelector("table.table-fixed");
      if (!table) return { error: "table not found", cellsOutOfBounds: true };
      const tableRect = table.getBoundingClientRect();
      const lineTotalCells = Array.from(document.querySelectorAll("td:nth-child(4)"));
      const cellsOutOfBounds = lineTotalCells.some((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.right > tableRect.right + 2;
      });
      return {
        tableWidth: tableRect.width,
        tableRight: tableRect.right,
        cellsOutOfBounds,
      };
    });
    expect(a4Overflow.cellsOutOfBounds).toBe(false);

    // Verify line totals and quantity are visible and bounded
    const lineTotalCell = page.locator("td:has-text('NPR 1,500')").first();
    await expect(lineTotalCell).toBeVisible();

    // --- 80MM RECEIPT PRINT MEDIA EVALUATION (Usable Page Width: 74mm / ~279.69px) ---
    await page.emulateMedia({ media: "screen" });
    await page.goto("/invoices/inv-long-content-3/print?mode=receipt");
    await expect(page.locator("text=Sale Ref")).toBeVisible();
    await page.emulateMedia({ media: "print" });

    // Inspect all rendered text ranges to ensure none exceed the 74mm usable page width
    const receiptGeometry = await page.evaluate(() => {
      const container = document.querySelector(".w-\\[80mm\\], .print\\:w-\\[74mm\\]");
      if (!container) return { error: "container not found", maxRight: 0, textRangeOverflows: [] };

      const containerRect = container.getBoundingClientRect();
      const textNodes: Text[] = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let currentNode = walker.nextNode();
      while (currentNode) {
        if (currentNode.textContent && currentNode.textContent.trim().length > 0) {
          textNodes.push(currentNode as Text);
        }
        currentNode = walker.nextNode();
      }

      let maxRight = 0;
      const textRangeOverflows: { text: string; right: number }[] = [];
      for (const node of textNodes) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.width > 0 && r.height > 0) {
            if (r.right > maxRight) maxRight = r.right;
            // 74mm is ~279.69px; allow a tiny subpixel tolerance of 280.5px
            if (r.right > 280.5) {
              textRangeOverflows.push({
                text: node.textContent?.slice(0, 30) || "",
                right: r.right,
              });
            }
          }
        }
      }

      return {
        containerWidth: containerRect.width,
        maxRight,
        textRangeOverflows,
      };
    });

    expect(receiptGeometry.textRangeOverflows).toEqual([]);
    // Container in print must be 74mm (<= 280.5px)
    expect(receiptGeometry.containerWidth).toBeLessThanOrEqual(280.5);
  });

  test("B-2 Regression: Paper-mode changes reset print target and trigger print for each active mode", async ({
    page,
  }) => {
    await setupPrintMocks(page);

    // Step 1: Open A4 mode -> auto-print fires once
    await page.goto("/invoices/inv-captured-1/print");
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);

    // Step 2: Client-side navigation to receipt mode -> auto-print fires second time
    await page.evaluate(() => {
      window.history.pushState({}, "", "/invoices/inv-captured-1/print?mode=receipt");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(2);

    // Step 3: Client-side navigation back to A4 mode -> auto-print fires third time
    await page.evaluate(() => {
      window.history.pushState({}, "", "/invoices/inv-captured-1/print");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(3);
  });

  test("B-2 Regression: Error return lifecycle resets print guard and triggers print when valid invoice reloads", async ({
    page,
  }) => {
    await setupPrintMocks(page);

    // Step 1: Load valid invoice in receipt mode -> prints once
    await page.goto("/invoices/inv-captured-1/print?mode=receipt");
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);

    // Step 2: Navigate to missing invoice -> fails, print count stays 1, manual Print button disabled
    await page.goto("/invoices/inv-nonexistent/print?mode=receipt");
    await expect(page.locator("text=Failed to load invoice for printing.")).toBeVisible();
    await expect(page.locator("button:has-text('Print')")).toBeDisabled();
    const countAfterError = await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    expect(countAfterError).toBe(1);

    // Step 3: Navigate back to original valid invoice -> reloads and prints second time
    await page.goto("/invoices/inv-captured-1/print?mode=receipt");
    await expect(page.locator("text=INV-2026-CAP1").first()).toBeVisible();
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(2);
  });

  test("B-2 Regression: Navigation before timer fires cancels pending print timeout", async ({
    page,
  }) => {
    await setupPrintMocks(page);

    // Navigate to print page and immediately navigate away before 150ms timeout fires
    await page.goto("/invoices/inv-captured-1/print");
    await page.evaluate(() => {
      // Immediately navigate away to simulate fast bounce
      window.history.pushState({}, "", "/invoices");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Wait 300ms to ensure the original 150ms timer did not fire window.print()
    await page.waitForTimeout(300);
    const printCalls = await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    expect(printCalls).toBe(0);
  });

  test("B-2 / Concurrency: Fast navigation across invoice IDs cancels stale responses without printing obsolete invoice", async ({
    page,
  }) => {
    await setupPrintMocks(page, {
      invoiceDelayMs: {
        "inv-slow": 400,
        "inv-fast": 10,
      },
    });

    // Request slow invoice first (DOM loads, API fetch is pending)
    await page.goto("/invoices/inv-slow/print");
    await page.waitForTimeout(50);

    // Navigate to fast invoice before slow API finishes
    await page.goto("/invoices/inv-fast/print");

    // Fast invoice should display and print
    await expect(page.locator("text=INV-FAST").first()).toBeVisible();
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);

    // Wait for slow invoice delay to pass; verify it did NOT overwrite fast invoice or fire a second print
    await page.waitForTimeout(500);
    await expect(page.locator("text=INV-FAST").first()).toBeVisible();
    await expect(page.locator("text=INV-SLOW")).toHaveCount(0);
    const finalPrintCalls = await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    expect(finalPrintCalls).toBe(1);
  });

  test("B-3 Coverage: Held business settings blocks manual and automatic printing until released", async ({
    page,
  }) => {
    let releaseSettings!: () => void;
    const settingsGatePromise = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });

    await setupPrintMocks(page, {
      settingsGate: () => settingsGatePromise,
    });

    await page.goto("/invoices/inv-captured-1/print");

    // While settings are held/unresolved:
    // 1. Manual print button must be disabled
    const printButton = page.locator("button:has-text('Print')");
    await expect(printButton).toBeDisabled();

    // 2. Loading state is visible
    await expect(page.locator("text=Loading invoice...")).toBeVisible();

    // 3. Automatic print has NOT fired
    const initialPrints = await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    expect(initialPrints).toBe(0);

    // Release settings
    releaseSettings();

    // Once resolved: manual button enabled, business identity displayed, automatic print fires exactly once
    await expect(page.locator("text=Himalayan Retail Hub").first()).toBeVisible();
    await expect(printButton).toBeEnabled();
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("B-3 Coverage: Null and old-shaped business settings fall back safely to KhataSathi branding and print", async ({
    page,
  }) => {
    await setupPrintMocks(page, {
      businessSettings: {
        legacyUnusedKey: "Legacy Value",
      },
    });

    await page.goto("/invoices/inv-captured-1/print");

    // Fallback to KhataSathi default display name
    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.locator("text=KhataSathi").first()).toBeVisible();
    await expect(page.locator("text=Business PAN:")).toHaveCount(0);
    await expect(page.locator("text=Legal Name:")).toHaveCount(0);

    // Invoice content renders cleanly and auto-print fires
    await expect(page.locator("text=INV-2026-CAP1").first()).toBeVisible();
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("B-3 Coverage: Finalized old-compatible legacy invoice renders unverified provenance and prints", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-legacy-old-6/print");

    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.locator("text=INV-2026-LEGACY6").first()).toBeVisible();

    // Customer section from legacy customer
    await expect(page.locator("text=Old Legacy Customer")).toBeVisible();
    await expect(page.locator("text=[Historical identity unverified]").first()).toBeVisible();
    await expect(page.locator("text=Customer PAN:")).toHaveCount(0);

    // Item from legacy item
    await expect(page.locator("text=Old Legacy Product")).toBeVisible();
    await expect(page.locator("text=SKU: OLD-SKU-6")).toBeVisible();

    // Auto-print fires
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("B-3 Coverage: Captured nulls display Unknown customer and omit PAN/SKU without leaking live fields", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-captured-null-4/print");

    // Should show Unknown customer
    await expect(page.locator("text=Unknown customer")).toBeVisible();
    await expect(page.locator("text=[Captured at sale]").first()).toBeVisible();

    // Customer PAN and address should NOT be rendered
    await expect(page.locator("text=Customer PAN:")).toHaveCount(0);

    // Live customer name, phone, wholesale info should NOT leak
    await expect(page.locator("text=Live Customer Should Not Leak")).toHaveCount(0);
    await expect(page.locator("text=9844000000")).toHaveCount(0);
    await expect(page.locator("text=Wholesale")).toHaveCount(0);

    // Item should show Unknown item with no SKU and no live product leakage
    await expect(page.locator("text=Unknown item")).toBeVisible();
    await expect(page.locator("text=SKU:")).toHaveCount(0);
    await expect(page.locator("text=Live Product Should Not Leak")).toHaveCount(0);
    await expect(page.locator("text=LIVE-SKU-LEAK")).toHaveCount(0);

    // Financial calculations intact
    await expect(page.locator("text=NPR 300").first()).toBeVisible();
  });

  test("B-3 Coverage: Draft invoice displays current draft identity and omits uncaptured PAN/address/cost", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-draft-compat-5/print");

    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.locator("text=Identity: [Current draft identity]")).toBeVisible();
    await expect(page.locator("text=[Current draft identity]").first()).toBeVisible();

    // Draft customer should not expose a captured Customer PAN
    await expect(page.locator("text=Customer PAN:")).toHaveCount(0);

    // Invariant: no cost or external bill labels
    await expect(page.locator("text=Cost")).toHaveCount(0);
    await expect(page.locator("text=External Bill")).toHaveCount(0);
  });

  test("Fallback to KhataSathi when business settings request fails (403/500) without blocking print", async ({
    page,
  }) => {
    await setupPrintMocks(page, { settingsStatus: 403 });
    await page.goto("/invoices/inv-captured-1/print");

    // Invoice should still load and display default KhataSathi branding
    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.getByText("NOT A TAX INVOICE", { exact: true })).toBeVisible();
    await expect(page.locator("text=KhataSathi").first()).toBeVisible();

    // Optional business fields should not be present
    await expect(page.locator("text=Business PAN:")).toHaveCount(0);
    await expect(page.locator("text=Legal Name:")).toHaveCount(0);

    // Invoice content is intact
    await expect(page.locator("text=INV-2026-CAP1").first()).toBeVisible();
    await expect(page.locator("text=Captured Customer Alpha")).toBeVisible();

    // Print still triggers automatically
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    }).toBe(1);
  });

  test("Invoice load failure prevents print, disables manual button, and displays error message", async ({ page }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-nonexistent/print");

    // Error state rendered
    await expect(page.locator("text=Failed to load invoice for printing.")).toBeVisible();

    // Print button should be disabled
    const printButton = page.locator("button:has-text('Print')");
    await expect(printButton).toBeDisabled();

    // Print should NEVER be called on invoice failure
    const printCalls = await page.evaluate(() => (window as unknown as { __printCallCount: number }).__printCallCount);
    expect(printCalls).toBe(0);
  });

  test("Mixed provenance labels are rendered for legacy fallback and unavailable historical items", async ({
    page,
  }) => {
    await setupPrintMocks(page);
    await page.goto("/invoices/inv-mixed-2/print");

    await expect(page.getByText("INTERNAL SALES WORKSHEET", { exact: true })).toBeVisible();
    await expect(page.locator("text=INV-2026-MIX2").first()).toBeVisible();

    // Customer legacy identity source
    await expect(page.locator("text=Identity: [Legacy identity — current labels]")).toBeVisible();
    // Non-captured customer should NOT render a Customer PAN
    await expect(page.locator("text=Customer PAN:")).toHaveCount(0);

    // Items with mixed sources
    await expect(page.locator("text=Item A Current Catalog")).toBeVisible();
    await expect(page.locator("text=[Legacy identity — current labels]").first()).toBeVisible();
    await expect(page.locator("text=Unknown item")).toBeVisible();
    await expect(page.locator("text=[Historical identity unavailable]")).toBeVisible();
  });
});
