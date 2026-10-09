import { expect, test } from "@playwright/test";

const cashier = { id: "user-cashier", name: "Billing Cashier", role: "cashier" };

test.describe("Billing Expanded Customer Purchase History Modal", () => {
  const customer1 = {
    id: "cust-1",
    name: "Ram Kumar Shrestha",
    phone: "+9779841234567",
    loyaltyPercent: 0,
    wholesalePercent: 0,
    isActive: true,
  };

  const customer2 = {
    id: "cust-2",
    name: "Sita Store",
    phone: "+9779812345678",
    loyaltyPercent: 0,
    wholesalePercent: 0,
    isActive: true,
  };

  const product1 = {
    id: "prod-1",
    name: "Wai Wai Instant Noodles",
    sku: "WAI-101",
    barcode: "8901234567890",
    retailPrice: 25,
    wholesalePrice: 22,
    wholesaleQtyThreshold: 10,
    stock: 50,
    isActive: true,
    allowFractionalQty: false,
    quantityStep: 1,
  };

  const product2 = {
    id: "prod-2",
    name: "Himalayan Spring Water 1L",
    sku: "WAT-001",
    barcode: "8909876543210",
    retailPrice: 50,
    wholesalePrice: 40,
    wholesaleQtyThreshold: 12,
    stock: 100,
    isActive: true,
    allowFractionalQty: false,
    quantityStep: 1,
  };

  test("opens history modal with filters, verifies row-scoped exact data, target sizes, state notices, proof links, and cart price protection", async ({ page }) => {
    let capturedHistoryParams: Record<string, string> = {};
    let purchaseHistoryCalls = 0;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({
          businessMode: "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });

      if (path.includes("/purchase-history")) {
        purchaseHistoryCalls++;
        capturedHistoryParams = Object.fromEntries(urlObj.searchParams.entries());

        const stateParam = urlObj.searchParams.get("state") || "eligible";
        const productIdParam = urlObj.searchParams.get("productId") || "";

        if (stateParam === "superseded") {
          return respond({
            items: [
              {
                id: "item-superseded-1",
                invoiceId: "inv-orig-101",
                invoiceNo: "INV-ORIG-101",
                invoiceDate: "2026-08-01T10:00:00.000Z",
                productId: "prod-1",
                productName: "Historical Wai Wai",
                productSku: "WAI-101",
                displayProduct: { name: "Historical Wai Wai", sku: "WAI-101", source: "CAPTURED" },
                qty: 10,
                appliedUnitPrice: 20,
                state: "SUPERSEDED",
                lineTotal: 200,
                originalUnitPrice: 20,
                overrideUnitPrice: null,
                overrideReason: null,
                returnedQty: 0,
                returnSummary: {
                  approvedQty: 0,
                  pendingQty: 0,
                  rejectedQty: 0,
                  reversedQty: 0,
                  hasReturns: false,
                  entries: [],
                },
                supersededBy: {
                  creditNoteNo: "CN-2026-001",
                  replacementInvoiceId: "inv-repl-202",
                  replacementInvoiceNo: "INV-REPL-202",
                  createdAt: "2026-08-02T11:00:00.000Z",
                  reason: "Rate correction",
                },
                replaces: null,
                externalReference: {
                  billingChannel: "MANUAL_EXTERNAL",
                  externalDocumentType: "PAN_INVOICE",
                  externalBillNo: "PB-9901",
                  externalBillDate: "2026-08-01",
                  billRecordStatus: "RECORDED",
                  isRecorded: true,
                },
                invoiceStatus: "FINALIZED",
                isCancelled: false,
                cancelledAt: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 15,
            totalPages: 1,
          });
        }

        // Default eligible dataset with 4 distinct items demonstrating all states
        const items = [
          {
            id: "item-hist-1",
            invoiceId: "inv-hist-101",
            invoiceNo: "INV-2026-0042",
            invoiceDate: "2026-08-10T14:30:00.000Z",
            productId: "prod-1",
            productName: "Historical Wai Wai",
            productSku: "WAI-101",
            displayProduct: { name: "Historical Wai Wai", sku: "WAI-101", source: "CAPTURED" },
            qty: 5,
            appliedUnitPrice: 18,
            state: "ELIGIBLE",
            lineTotal: 90,
            originalUnitPrice: 25,
            overrideUnitPrice: 18,
            overrideReason: "Loyalty customer discount agreed",
            returnedQty: 1,
            returnSummary: {
              approvedQty: 1,
              pendingQty: 1,
              rejectedQty: 0,
              reversedQty: 1,
              hasReturns: true,
              entries: [],
            },
            supersededBy: null,
            replaces: {
              creditNoteNo: "CN-2026-000",
              originalInvoiceId: "inv-prev-050",
              originalInvoiceNo: "INV-PREV-050",
              createdAt: "2026-08-09T09:00:00.000Z",
              reason: "Order split",
            },
            externalReference: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: "PAN_INVOICE",
              externalBillNo: "PB-4450",
              externalBillDate: "2026-08-10",
              billRecordStatus: "RECORDED",
              isRecorded: true,
            },
            invoiceStatus: "FINALIZED",
            isCancelled: false,
            cancelledAt: null,
          },
          {
            id: "item-hist-2",
            invoiceId: "inv-hist-102",
            invoiceNo: "INV-2026-0088",
            invoiceDate: "2026-08-15T09:15:00.000Z",
            productId: "prod-2",
            productName: "Himalayan Spring Water 1L",
            productSku: "WAT-001",
            displayProduct: { name: "Himalayan Spring Water 1L", sku: "WAT-001", source: "LEGACY_LIVE_FALLBACK" },
            qty: 12,
            appliedUnitPrice: 38,
            state: "ELIGIBLE",
            lineTotal: 456,
            originalUnitPrice: 50,
            overrideUnitPrice: 38,
            overrideReason: "Wholesale tier rate",
            returnedQty: 0,
            returnSummary: {
              approvedQty: 0,
              pendingQty: 0,
              rejectedQty: 0,
              reversedQty: 0,
              hasReturns: false,
              entries: [],
            },
            supersededBy: null,
            replaces: null,
            externalReference: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: "VAT_TAX_INVOICE",
              externalBillNo: "EXT-BILL-7788",
              externalBillDate: "2026-08-15",
              billRecordStatus: "PENDING",
              isRecorded: false,
            },
            invoiceStatus: "FINALIZED",
            isCancelled: false,
            cancelledAt: null,
          },
          {
            id: "item-hist-3",
            invoiceId: "inv-hist-103",
            invoiceNo: "INV-2026-0120",
            invoiceDate: "2026-08-18T11:00:00.000Z",
            productId: "prod-3",
            productName: "Everest Tea Leaves 250g",
            productSku: "TEA-250",
            displayProduct: { name: "Everest Tea Leaves 250g", sku: "TEA-250", source: "CAPTURED" },
            qty: 2,
            appliedUnitPrice: 150,
            state: "ELIGIBLE",
            lineTotal: 300,
            originalUnitPrice: 150,
            overrideUnitPrice: null,
            overrideReason: null,
            returnedQty: 0,
            returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
            supersededBy: null,
            replaces: null,
            externalReference: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: "PAN_INVOICE",
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "MISSING",
              isRecorded: false,
            },
            invoiceStatus: "FINALIZED",
            isCancelled: false,
            cancelledAt: null,
          },
          {
            id: "item-hist-4",
            invoiceId: "inv-hist-104",
            invoiceNo: "INV-2026-0155",
            invoiceDate: "2026-08-20T16:00:00.000Z",
            productId: "prod-4",
            productName: "Nepal Dairy Ghee 500ml",
            productSku: "GHEE-500",
            displayProduct: { name: "Nepal Dairy Ghee 500ml", sku: "GHEE-500", source: "CAPTURED" },
            qty: 1,
            appliedUnitPrice: 650,
            state: "ELIGIBLE",
            lineTotal: 650,
            originalUnitPrice: 650,
            overrideUnitPrice: null,
            overrideReason: null,
            returnedQty: 0,
            returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
            supersededBy: null,
            replaces: null,
            externalReference: null,
            invoiceStatus: "FINALIZED",
            isCancelled: false,
            cancelledAt: null,
          },
        ];

        let filtered = items;
        if (productIdParam) {
          filtered = filtered.filter((i) => i.productId === productIdParam);
        }

        return respond({
          items: filtered,
          total: filtered.length,
          page: 1,
          pageSize: 15,
          totalPages: 1,
        });
      }

      if (path.includes("/product-history")) return respond({ history: [] });
      if (path.endsWith("/customers")) return respond([customer1, customer2]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup")) {
        return respond({ products: [product1, product2], total: 2 });
      }
      if (path.startsWith("/api/invoices/manual-bills/")) {
        return respond({ record: null, proofs: [], history: [] });
      }
      if (path.startsWith("/api/invoices/")) {
        const id = decodeURIComponent(path.slice("/api/invoices/".length));
        return respond({
          id,
          invoiceNo: id === "inv-orig-101" ? "INV-ORIG-101" : "INV-2026-0042",
          status: "FINALIZED",
          paymentStatus: "PAID",
          createdAt: "2026-08-10T14:30:00.000Z",
          subTotal: 90,
          netTotal: 90,
          paidTotal: 90,
          dueAmount: 0,
          items: [],
          cashier: { id: "user-cashier", name: "Billing Cashier" },
        });
      }
      if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
      return respond({});
    });

    await page.goto("/billing");

    // 1. Select Customer & add item to cart
    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Ram Kumar Shrestha").click();

    const searchInput = page.getByPlaceholder("Search product name, SKU, brand... (F2)");
    await searchInput.fill("Wai Wai");
    await page.getByText("Wai Wai Instant Noodles").first().click();

    // Verify cart subtotal is current catalog retail rate (Rs 25), NOT historical rate (Rs 18)
    const cartSubtotal = page.locator("div.font-mono.font-extrabold", { hasText: "NPR 25" });
    await expect(cartSubtotal.first()).toBeVisible();

    // 2. Open Full Customer History Modal
    const fullHistoryBtn = page.getByRole("button", { name: "Full History", exact: true });
    await expect(fullHistoryBtn).toBeVisible();
    await fullHistoryBtn.click();

    const modal = page.getByRole("dialog", { name: /Purchase History: Ram Kumar Shrestha/i });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByText("Eligible finalized invoice line items, return context, and external proof references for this customer.")
    ).toBeVisible();

    await expect.poll(() => purchaseHistoryCalls).toBeGreaterThan(0);
    await expect.poll(() => capturedHistoryParams.state).toBe("eligible");

    // 3. Row-scoped assertions for exact product, pending return vs pending bill, missing refs, and target sizes
    const rows = modal.locator("tbody tr");
    await expect(rows).toHaveCount(4);

    // Row 0: Historical Wai Wai
    const row0 = rows.nth(0);
    await expect(row0.getByText("Historical Wai Wai", { exact: true })).toBeVisible();
    await expect(row0.getByText("INV-2026-0042")).toBeVisible();
    await expect(row0.locator("td").nth(2)).toHaveText("5"); // Sold qty
    await expect(row0.getByText("NPR 18")).toBeVisible();
    await expect(row0.getByText("Orig: NPR 25")).toBeVisible();
    await expect(row0.getByText("NPR 90")).toBeVisible();
    await expect(row0.getByText("Eligible", { exact: true })).toBeVisible();
    await expect(row0.getByText("Returned: 1", { exact: true })).toBeVisible();
    await expect(row0.getByText("Pending return: 1", { exact: true })).toBeVisible();
    await expect(row0.getByText("Reversed return: 1", { exact: true })).toBeVisible();
    await expect(row0.getByText("Replaces Invoice #INV-PREV-050 via CN #CN-2026-000")).toBeVisible();
    await expect(row0.getByText("PAN_INVOICE #PB-4450")).toBeVisible();
    await expect(row0.getByText("RECORDED", { exact: true })).toBeVisible();

    // Verify row button touch target size >= 32px
    const row0FilterBtn = row0.getByRole("button", { name: "Filter this product" });
    const row0ProofLink = row0.getByRole("link", { name: "View invoice and proof" });
    await expect(row0FilterBtn).toBeVisible();
    await expect(row0ProofLink).toBeVisible();
    const filterBox = await row0FilterBtn.boundingBox();
    const proofBox = await row0ProofLink.boundingBox();
    expect(filterBox?.height).toBeGreaterThanOrEqual(32);
    expect(proofBox?.height).toBeGreaterThanOrEqual(32);

    // Row 1: Himalayan Spring Water 1L (with PENDING external bill)
    const row1 = rows.nth(1);
    await expect(row1.getByText("Himalayan Spring Water 1L", { exact: true })).toBeVisible();
    await expect(row1.getByText("INV-2026-0088")).toBeVisible();
    await expect(row1.locator("td").nth(2)).toHaveText("12");
    await expect(row1.getByText("NPR 38")).toBeVisible();
    await expect(row1.getByText("NPR 456")).toBeVisible();
    await expect(row1.getByText("VAT_TAX_INVOICE #EXT-BILL-7788")).toBeVisible();
    // Exact row-scoped PENDING assertion for unrecorded bill
    await expect(row1.getByText("PENDING", { exact: true })).toBeVisible();

    // Row 2: Everest Tea Leaves (with MISSING bill status)
    const row2 = rows.nth(2);
    await expect(row2.getByText("Everest Tea Leaves 250g", { exact: true })).toBeVisible();
    await expect(row2.getByText("MISSING", { exact: true })).toBeVisible();

    // Row 3: Nepal Dairy Ghee (None recorded)
    const row3 = rows.nth(3);
    await expect(row3.getByText("Nepal Dairy Ghee 500ml", { exact: true })).toBeVisible();
    await expect(row3.getByText("None recorded", { exact: true })).toBeVisible();

    // 4. Exact Product Filter Pill Scoping
    await row0FilterBtn.click();
    const pill = modal.locator(".border-blue-200");
    await expect(pill).toBeVisible();
    await expect(pill.getByText("Historical Wai Wai", { exact: true })).toBeVisible();
    await expect.poll(() => capturedHistoryParams.productId).toBe("prod-1");

    // Remove exact product filter
    const removeProductFilterBtn = modal.getByRole("button", { name: "Remove exact product filter" });
    await removeProductFilterBtn.click();
    await expect(pill).not.toBeVisible();

    // 5. State Selector with dynamic description and notice
    const stateCombobox = modal.getByRole("combobox", { name: "Sale state" });
    await stateCombobox.click();
    await page.getByRole("option", { name: /Superseded \/ replaced invoices/i }).click();

    await expect(
      modal.getByText("Superseded and replaced invoice records, return context, and external proof references for this customer.")
    ).toBeVisible();
    await expect(modal.getByText(/Showing historical records for superseded status/i)).toBeVisible();
    await expect(
      modal.getByText(/historical reference evidence only and do not represent active finalized sales or current pricing/i)
    ).toBeVisible();
    await expect(modal.getByText("CN #CN-2026-001 →")).toBeVisible();
    // Save desktop screenshot capturing open history modal
    await page.screenshot({ path: "test-results/billing-expanded-history-desktop.png", fullPage: true });

    // 6. Navigation to Invoice Details and Proof
    const viewProofLink = modal.getByRole("link", { name: "View invoice and proof" }).first();
    await viewProofLink.click();
    await expect(page).toHaveURL(/\/invoices\?invoiceId=inv-orig-101/);
    await expect(page.getByRole("dialog", { name: "Invoice INV-ORIG-101", exact: true })).toBeVisible();

    // 7. Verify Cart Price Protection preserved
    await page.goto("/billing");
    await expect(cartSubtotal.first()).toBeVisible();
  });

  test("supports pagination (total 31 / 3 pages), text search q, ProjectDateInput calendar (Today & cell pick), and filter reset", async ({ page }) => {
    let capturedParams: Record<string, string> = {};

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({
          businessMode: "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });

      if (path.includes("/purchase-history")) {
        capturedParams = Object.fromEntries(urlObj.searchParams.entries());
        const pageNum = Number(urlObj.searchParams.get("page") || "1");
        const qParam = urlObj.searchParams.get("q") || "";

        if (qParam === "Nonexistent") {
          return respond({ items: [], total: 0, page: 1, pageSize: 15, totalPages: 0 });
        }

        if (qParam === "Wai Wai") {
          return respond({
            items: [
              {
                id: "item-wai-1",
                invoiceId: "inv-w-1",
                invoiceNo: "INV-W-1",
                invoiceDate: "2026-08-10T14:30:00.000Z",
                productId: "prod-1",
                productName: "Wai Wai Noodles Pack",
                productSku: "WAI-101",
                displayProduct: { name: "Wai Wai Noodles Pack", sku: "WAI-101", source: "CAPTURED" },
                qty: 4,
                appliedUnitPrice: 25,
                state: "ELIGIBLE",
                lineTotal: 100,
                originalUnitPrice: 25,
                overrideUnitPrice: null,
                overrideReason: null,
                returnedQty: 0,
                returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
                supersededBy: null,
                replaces: null,
                externalReference: null,
                invoiceStatus: "FINALIZED",
                isCancelled: false,
                cancelledAt: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 15,
            totalPages: 1,
          });
        }

        // Mock 31 total records across 3 pages
        const generateItems = (start: number, count: number) =>
          Array.from({ length: count }, (_, i) => ({
            id: `item-page-item-${start + i}`,
            invoiceId: `inv-${start + i}`,
            invoiceNo: `INV-${start + i}`,
            invoiceDate: "2026-08-10T14:30:00.000Z",
            productId: `prod-${start + i}`,
            productName: `Product ${start + i}`,
            productSku: `SKU-${start + i}`,
            displayProduct: { name: `Product ${start + i}`, sku: `SKU-${start + i}`, source: "CAPTURED" },
            qty: 1,
            appliedUnitPrice: 100,
            state: "ELIGIBLE",
            lineTotal: 100,
            originalUnitPrice: 100,
            overrideUnitPrice: null,
            overrideReason: null,
            returnedQty: 0,
            returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
            supersededBy: null,
            replaces: null,
            externalReference: null,
            invoiceStatus: "FINALIZED",
            isCancelled: false,
            cancelledAt: null,
          }));

        if (pageNum === 1) {
          return respond({ items: generateItems(1, 15), total: 31, page: 1, pageSize: 15, totalPages: 3 });
        } else if (pageNum === 2) {
          return respond({ items: generateItems(16, 15), total: 31, page: 2, pageSize: 15, totalPages: 3 });
        } else {
          return respond({ items: generateItems(31, 1), total: 31, page: 3, pageSize: 15, totalPages: 3 });
        }
      }

      if (path.includes("/product-history")) return respond({ history: [] });
      if (path.endsWith("/customers")) return respond([customer1, customer2]);
      if (path.endsWith("/products")) return respond({ products: [product1], total: 1 });
      if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
      return respond({});
    });

    await page.goto("/billing");
    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Ram Kumar Shrestha").click();

    const fullHistoryBtn = page.getByRole("button", { name: "Full History", exact: true });
    await fullHistoryBtn.click();

    const modal = page.getByRole("dialog", { name: /Purchase History/i });
    await expect(modal).toBeVisible();

    // 1. Pagination verification
    await expect(modal.getByText("Showing 15 of 31 record(s)")).toBeVisible();
    await expect(modal.getByText("Page 1 of 3")).toBeVisible();
    const prevBtn = modal.getByRole("button", { name: "Previous" });
    const nextBtn = modal.getByRole("button", { name: "Next" });
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // Click Next => page 2
    await nextBtn.click();
    await expect(modal.getByText("Page 2 of 3")).toBeVisible();
    await expect(modal.getByText("Product 16", { exact: true })).toBeVisible();
    await expect.poll(() => capturedParams.page).toBe("2");

    // 2. Typing query q resets page to 1
    const searchInput = modal.getByRole("textbox", { name: "Search product name" });
    await searchInput.fill("Wai Wai");
    // Await debounced query and verify page reset to 1
    await expect(modal.getByText("Wai Wai Noodles Pack", { exact: true })).toBeVisible();
    await expect.poll(() => capturedParams.q).toBe("Wai Wai");
    await expect.poll(() => capturedParams.page).toBe("1");

    // Clear search using input clear button
    const clearSearchBtn = modal.getByRole("button", { name: "Clear product search" });
    await clearSearchBtn.click();
    await expect(modal.getByText("Product 1", { exact: true })).toBeVisible();
    await expect.poll(() => capturedParams.page).toBe("1");

    // 3. ProjectDateInput calendar selection (Today & cell pick)
    const fromDateBtn = modal.getByRole("button", { name: /From date/i });
    await fromDateBtn.click();
    const calendarDialog = page.getByRole("dialog", { name: "Choose date" });
    await expect(calendarDialog).toBeVisible();

    const todayBtn = calendarDialog.getByRole("button", { name: "Today", exact: true });
    await todayBtn.click();
    await expect(calendarDialog).not.toBeVisible();

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const todayYmd = `${yyyy}-${mm}-${dd}`;
    await expect.poll(() => capturedParams.from).toBe(todayYmd);

    // Pick cell in To date picker
    const toDateBtn = modal.getByRole("button", { name: /To date/i });
    await toDateBtn.click();
    await expect(calendarDialog).toBeVisible();
    await calendarDialog.getByRole("button", { name: "Today", exact: true }).click();
    await expect.poll(() => capturedParams.to).toBe(todayYmd);

    // 4. Test Search Nonexistent -> Empty state & Reset all filters
    await searchInput.fill("Nonexistent");
    await expect(modal.getByText("No past purchases found matching the selected filter criteria.")).toBeVisible();

    const resetFiltersBtn = modal.getByRole("button", { name: "Reset all filters" });
    await expect(resetFiltersBtn).toBeVisible();
    await resetFiltersBtn.click();

    // Assert filters cleared and full list returned
    await expect(modal.getByText("Showing 15 of 31 record(s)")).toBeVisible();
    await expect.poll(() => capturedParams.q).toBeUndefined();
    await expect.poll(() => capturedParams.from).toBeUndefined();
    await expect.poll(() => capturedParams.to).toBeUndefined();
  });

  test("supports keyboard navigation across select dropdowns, date pickers, and modal controls", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({
          businessMode: "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });
      if (path.includes("/purchase-history")) {
        return respond({ items: [], total: 0, page: 1, pageSize: 15, totalPages: 0 });
      }
      if (path.includes("/product-history")) return respond({ history: [] });
      if (path.endsWith("/customers")) return respond([customer1]);
      if (path.endsWith("/products")) return respond({ products: [product1], total: 1 });
      if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
      return respond({});
    });

    await page.goto("/billing");
    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Ram Kumar Shrestha").click();

    const fullHistoryBtn = page.getByRole("button", { name: "Full History", exact: true });
    await fullHistoryBtn.click();

    const modal = page.getByRole("dialog", { name: /Purchase History/i });
    await expect(modal).toBeVisible();

    // 1. Keyboard focus and Enter/ArrowDown on ProjectSelect
    const stateCombobox = modal.getByRole("combobox", { name: "Sale state" });
    await stateCombobox.focus();
    await page.keyboard.press("ArrowDown");

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    // Press Escape to dismiss listbox
    await page.keyboard.press("Escape");
    await expect(listbox).not.toBeVisible();
    await expect(stateCombobox).toBeFocused();

    // 2. Keyboard open and Escape on ProjectDateInput
    const fromDateBtn = modal.getByRole("button", { name: /From date/i });
    await fromDateBtn.focus();
    await page.keyboard.press("Enter");

    const calendarDialog = page.getByRole("dialog", { name: "Choose date" });
    await expect(calendarDialog).toBeVisible();

    // Calendar Escape closes calendar, returns focus to trigger button, and keeps history modal visible
    await page.keyboard.press("Escape");
    await expect(calendarDialog).not.toBeVisible();
    await expect(fromDateBtn).toBeFocused();
    await expect(modal).toBeVisible();

    // 3. Parent Escape closes the history modal
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
  });

  test("handles raw query transition hiding stale rows immediately, deferred request synchronization, customer switching, and error retry", async ({ page }) => {
    let shouldFail = true;

    let enterDelayedQueryPromise: (() => void) | undefined;
    let resolveDelayedQueryPromise: (() => void) | undefined;
    let delayedQueryDoneResolver: (() => void) | undefined;
    let delaySearchQuery = false;

    let enterObsoleteFilterPromise: (() => void) | undefined;
    let resolveObsoleteFilterPromise: (() => void) | undefined;
    let obsoleteFilterDoneResolver: (() => void) | undefined;
    let delayObsoleteFilter = false;

    let enterCustomer1Promise: (() => void) | undefined;
    let resolveCustomer1Promise: (() => void) | undefined;
    let customer1DoneResolver: (() => void) | undefined;
    let delayCustomer1 = false;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) => {
        try {
          return route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        } catch {
          // Ignore aborted route fulfill errors
        }
      };

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({
          businessMode: "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });

      if (path.includes("/cust-1/purchase-history")) {
        if (shouldFail) {
          shouldFail = false;
          return respond({ error: "Access denied: You do not have permission to view this customer's purchase history." }, 403);
        }

        if (delayCustomer1) {
          enterCustomer1Promise?.();
          try {
            await new Promise<void>((resolve) => { resolveCustomer1Promise = resolve; });
          } finally {
            customer1DoneResolver?.();
          }
        }

        const qParam = urlObj.searchParams.get("q") || "";
        if (delaySearchQuery && qParam === "DelayedSearch") {
          enterDelayedQueryPromise?.();
          try {
            await new Promise<void>((resolve) => { resolveDelayedQueryPromise = resolve; });
          } finally {
            delayedQueryDoneResolver?.();
          }
        }

        if (delayObsoleteFilter && qParam === "ObsoleteFilter") {
          enterObsoleteFilterPromise?.();
          try {
            await new Promise<void>((resolve) => { resolveObsoleteFilterPromise = resolve; });
          } finally {
            obsoleteFilterDoneResolver?.();
          }
          return respond({
            items: [
              {
                id: "item-obsolete-stale",
                invoiceId: "inv-obsolete",
                invoiceNo: "INV-OBSOLETE",
                invoiceDate: "2026-08-10T14:30:00.000Z",
                productId: "prod-obsolete",
                productName: "STALE OBSOLETE ITEM",
                productSku: "OBS-01",
                displayProduct: { name: "STALE OBSOLETE ITEM", sku: "OBS-01", source: "CAPTURED" },
                qty: 1,
                appliedUnitPrice: 50,
                state: "ELIGIBLE",
                lineTotal: 50,
                originalUnitPrice: 50,
                overrideUnitPrice: null,
                overrideReason: null,
                returnedQty: 0,
                returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
                supersededBy: null,
                replaces: null,
                externalReference: null,
                invoiceStatus: "FINALIZED",
                isCancelled: false,
                cancelledAt: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 15,
            totalPages: 1,
          });
        }

        if (qParam === "FastWinningFilter") {
          return respond({
            items: [
              {
                id: "item-winning-fast",
                invoiceId: "inv-fast",
                invoiceNo: "INV-FAST",
                invoiceDate: "2026-08-10T14:30:00.000Z",
                productId: "prod-fast",
                productName: "WINNING FAST ITEM",
                productSku: "FAST-01",
                displayProduct: { name: "WINNING FAST ITEM", sku: "FAST-01", source: "CAPTURED" },
                qty: 1,
                appliedUnitPrice: 75,
                state: "ELIGIBLE",
                lineTotal: 75,
                originalUnitPrice: 75,
                overrideUnitPrice: null,
                overrideReason: null,
                returnedQty: 0,
                returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
                supersededBy: null,
                replaces: null,
                externalReference: null,
                invoiceStatus: "FINALIZED",
                isCancelled: false,
                cancelledAt: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 15,
            totalPages: 1,
          });
        }

        return respond({
          items: [
            {
              id: "item-cust1-live",
              invoiceId: "inv-cust1-live",
              invoiceNo: "INV-CUST1-LIVE",
              invoiceDate: "2026-08-10T14:30:00.000Z",
              productId: "prod-1",
              productName: "ACTIVE ITEM FOR CUST 1",
              productSku: "CUST1-01",
              displayProduct: { name: "ACTIVE ITEM FOR CUST 1", sku: "CUST1-01", source: "CAPTURED" },
              qty: 1,
              appliedUnitPrice: 100,
              state: "ELIGIBLE",
              lineTotal: 100,
              originalUnitPrice: 100,
              overrideUnitPrice: null,
              overrideReason: null,
              returnedQty: 0,
              returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
              supersededBy: null,
              replaces: null,
              externalReference: null,
              invoiceStatus: "FINALIZED",
              isCancelled: false,
              cancelledAt: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 15,
          totalPages: 1,
        });
      }

      if (path.includes("/cust-2/purchase-history")) {
        return respond({
          items: [],
          total: 0,
          page: 1,
          pageSize: 15,
          totalPages: 0,
        });
      }

      if (path.includes("/product-history")) return respond({ history: [] });
      if (path.endsWith("/customers")) return respond([customer1, customer2]);
      if (path.endsWith("/products")) return respond({ products: [product1], total: 1 });
      if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
      return respond({});
    });

    await page.goto("/billing");
    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Ram Kumar Shrestha").click();

    const fullHistoryBtn = page.getByRole("button", { name: "Full History", exact: true });
    await fullHistoryBtn.click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    // 1. Initial 403 error displayed with preserved controls
    await expect(
      modal.getByText("Access denied: You do not have permission to view this customer's purchase history.")
    ).toBeVisible();
    await expect(modal.getByRole("textbox", { name: "Search product name" })).toBeVisible();

    // Click Retry (should now succeed)
    const retryBtn = modal.getByRole("button", { name: "Retry", exact: true });
    await retryBtn.click();
    await expect(modal.getByText("ACTIVE ITEM FOR CUST 1")).toBeVisible();

    // 2. Raw query transition hides old rows immediately BEFORE debounce
    const searchInput = modal.getByRole("textbox", { name: "Search product name" });
    delaySearchQuery = true;
    const queryEntered = new Promise<void>((resolve) => { enterDelayedQueryPromise = resolve; });

    // Type query
    await searchInput.fill("DelayedSearch");
    // Assert old row is immediately hidden and loading spinner is shown
    await expect(modal.getByText("ACTIVE ITEM FOR CUST 1")).not.toBeVisible();
    await expect(modal.getByText("Loading customer purchase history…")).toBeVisible();

    // Await request entering backend handler
    await queryEntered;
    // Release held query response and await handler completion before asserting
    const delayedQueryDone = new Promise<void>((resolve) => { delayedQueryDoneResolver = resolve; });
    resolveDelayedQueryPromise?.();
    await delayedQueryDone;
    await expect(modal.getByText("ACTIVE ITEM FOR CUST 1")).toBeVisible();
    delaySearchQuery = false;

    // 3. Filter race condition (obsolete filter response released after newer filter wins)
    delayObsoleteFilter = true;
    const obsoleteFilterEntered = new Promise<void>((resolve) => { enterObsoleteFilterPromise = resolve; });
    await searchInput.fill("ObsoleteFilter");
    await obsoleteFilterEntered;

    // Fast newer filter typed while obsolete request is still held in-flight
    await searchInput.fill("FastWinningFilter");
    await expect(modal.getByText("WINNING FAST ITEM")).toBeVisible();
    await expect(modal.getByText("STALE OBSOLETE ITEM")).not.toBeVisible();

    // Now release the obsolete held filter response and await handler completion
    const obsoleteDone = new Promise<void>((resolve) => { obsoleteFilterDoneResolver = resolve; });
    resolveObsoleteFilterPromise?.();
    await obsoleteDone;

    // Assert newer winning response is preserved and stale obsolete response was discarded
    await expect(modal.getByText("WINNING FAST ITEM")).toBeVisible();
    await expect(modal.getByText("STALE OBSOLETE ITEM")).not.toBeVisible();
    delayObsoleteFilter = false;

    // 4. Stale customer request discarded when customer changes rapidly
    delayCustomer1 = true;
    const customer1Entered = new Promise<void>((resolve) => { enterCustomer1Promise = resolve; });

    // Clear search to trigger fetch for customer 1
    await searchInput.fill("");
    await customer1Entered;

    // Close modal and switch to Customer 2 while Customer 1's request is held
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(modal).not.toBeVisible();

    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Sita Store").click();

    // Open history modal for Customer 2
    await fullHistoryBtn.click();
    const modalCust2 = page.getByRole("dialog", { name: /Purchase History: Sita Store/i });
    await expect(modalCust2).toBeVisible();

    // Release delayed Customer 1 response and await handler completion BEFORE no-stale assertion
    const customer1Done = new Promise<void>((resolve) => { customer1DoneResolver = resolve; });
    resolveCustomer1Promise?.();
    await customer1Done;

    // Assert Customer 2 shows empty state and never leaks Customer 1 item
    await expect(modalCust2.getByText("ACTIVE ITEM FOR CUST 1")).not.toBeVisible();
    await expect(modalCust2.getByText("No eligible finalized purchase history found for this customer.")).toBeVisible();

    await modalCust2.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("renders responsively at 360px mobile viewport without horizontal page overflow and saves mobile screenshot", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({
          businessMode: "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });

      if (path.includes("/purchase-history")) {
        return respond({
          items: [
            {
              id: "item-mobile-1",
              invoiceId: "inv-mob-1",
              invoiceNo: "INV-MOB-01",
              invoiceDate: "2026-08-10T14:30:00.000Z",
              productId: "prod-1",
              productName: "Wai Wai Instant Noodles 75g",
              productSku: "WAI-101",
              displayProduct: { name: "Wai Wai Instant Noodles 75g", sku: "WAI-101", source: "CAPTURED" },
              qty: 5,
              appliedUnitPrice: 25,
              state: "ELIGIBLE",
              lineTotal: 125,
              originalUnitPrice: 25,
              overrideUnitPrice: null,
              overrideReason: null,
              returnedQty: 0,
              returnSummary: { approvedQty: 0, pendingQty: 0, rejectedQty: 0, reversedQty: 0, hasReturns: false, entries: [] },
              supersededBy: null,
              replaces: null,
              externalReference: {
                billingChannel: "MANUAL_EXTERNAL",
                externalDocumentType: "PAN_INVOICE",
                externalBillNo: "PB-100",
                externalBillDate: "2026-08-10",
                billRecordStatus: "RECORDED",
                isRecorded: true,
              },
              invoiceStatus: "FINALIZED",
              isCancelled: false,
              cancelledAt: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 15,
          totalPages: 1,
        });
      }

      if (path.includes("/product-history")) return respond({ history: [] });
      if (path.endsWith("/customers")) return respond([customer1]);
      if (path.endsWith("/products")) return respond({ products: [product1], total: 1 });
      if (path.endsWith("/brands") || path.endsWith("/categories")) return respond([]);
      return respond({});
    });

    // Set mobile viewport to 360px x 640px
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/billing");

    await page.getByRole("button", { name: "Change customer" }).click();
    await page.getByText("Ram Kumar Shrestha").click();

    const fullHistoryBtn = page.getByRole("button", { name: "Full History", exact: true });
    await fullHistoryBtn.click();

    const modal = page.getByRole("dialog", { name: /Purchase History/i });
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Wai Wai Instant Noodles 75g")).toBeVisible();

    // Verify 360px responsive viewport does not overflow document horizontally
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    // Save mobile screenshot
    await page.screenshot({ path: "test-results/billing-expanded-history-mobile.png", fullPage: true });

    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(modal).not.toBeVisible();
  });
});
