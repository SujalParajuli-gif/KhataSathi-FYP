import { expect, test } from "@playwright/test";

const cashier = { id: "user-cashier", name: "Billing Cashier", role: "cashier" };

test.describe("Billing Worksheet & Calculator", () => {
  test("opens provisional worksheet modal, verifies line items, and navigates to payment", async ({ page }) => {
    const customer = {
      id: "cust-1",
      name: "Hari Prasad",
      phone: "+9779841234567",
      panNo: "123456789",
      loyaltyPercent: 5,
      wholesalePercent: 0,
      isActive: true,
    };

    const products = [
      {
        id: "prod-1",
        name: "Premium Basmati Rice",
        sku: "RICE-01",
        retailPrice: 120,
        wholesalePrice: 110,
        stock: 50,
        isActive: true,
        saleUnit: "KG",
        quantityStep: 1,
      },
      {
        id: "prod-2",
        name: "Mustard Oil 1L",
        sku: "OIL-02",
        retailPrice: 250,
        wholesalePrice: 240,
        stock: 30,
        isActive: true,
        saleUnit: "BOTTLE",
        quantityStep: 1,
      },
    ];

    await page.addInitScript(({ user, customer, products }) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
      localStorage.setItem(
        "khatasathi_billing_cart",
        JSON.stringify({
          cart: [
            { productId: products[0].id, qty: 2 },
            { productId: products[1].id, qty: 1 },
          ],
          selectedCustomerId: customer.id,
          savedAt: new Date().toISOString(),
        }),
      );
    }, { user: cashier, customer, products });

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

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
      if (path.endsWith("/customers")) return respond([customer]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products, total: products.length });
      if (path.endsWith("/payments/gateways/display"))
        return respond({ esewa: { environment: "SANDBOX", label: "Sandbox Mode" } });
      if (path.endsWith("/product-history")) return respond({ history: [] });
      if (path.includes("/purchase-history"))
        return respond({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Worksheet trigger button should be visible and show item count
    const worksheetBtn = page.locator("#billing-worksheet-trigger");
    await expect(worksheetBtn).toBeVisible();
    await expect(worksheetBtn).toContainText("Worksheet (2)");

    // Click worksheet trigger
    await worksheetBtn.click();

    // Verify worksheet modal elements
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Sales Worksheet", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Provisional line-item summary for customer review before final payment."),
    ).toBeVisible();
    await expect(dialog.getByText("Hari Prasad")).toBeVisible();
    await expect(dialog.getByText("Premium Basmati Rice")).toBeVisible();
    await expect(dialog.getByText("Mustard Oil 1L")).toBeVisible();

    // Continue to Payment button
    const continueBtn = dialog.getByRole("button", { name: "Continue to Payment" });
    await expect(continueBtn).toBeVisible();
    await continueBtn.click();

    // Worksheet modal closes and Payment Modal opens
    await expect(page.getByText("Confirm Payment")).toBeVisible();
  });

  test("opens calculator modal, performs arithmetic expression evaluation, keypad entry, and copy result", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

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
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Click Calculator trigger
    const calcBtn = page.locator("#billing-calculator-trigger");
    await expect(calcBtn).toBeVisible();
    await calcBtn.click();

    // Modal title
    await expect(page.getByText("Scratchpad Calculator", { exact: true })).toBeVisible();

    // Type expression in the calculator input: 150 * 3 + 50
    const calcInput = page.getByPlaceholder("0");
    await expect(calcInput).toBeVisible();
    await calcInput.fill("150 * 3 + 50");
    await page.keyboard.press("Enter");

    // Result should display = 500
    await expect(page.getByText("= 500")).toBeVisible();

    // Press Escape to close calculator
    await page.keyboard.press("Escape");
    await expect(page.getByText("Scratchpad Calculator", { exact: true })).not.toBeVisible();
  });

  test("customer lookup-only selection preserves identity and pricing, and discloses selectable PAN conflict matches", async ({ page }) => {
    const lookupCustomer = {
      id: "cust-lookup-99",
      name: "Server Looked-up Business",
      phone: "+9779801122334",
      panNo: "300123456",
      loyaltyPercent: 10,
      wholesalePercent: 0,
      isActive: true,
    };

    const conflictCustomer = {
      id: "cust-conflict-88",
      name: "Existing Firm with Same PAN",
      phone: "+9779851000000",
      panNo: "300123456",
      loyaltyPercent: 0,
      wholesalePercent: 0,
      isActive: false,
    };

    const product = {
      id: "prod-item-1",
      name: "Test Grocery Product",
      sku: "GROC-01",
      retailPrice: 100,
      wholesalePrice: 90,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true, stockTracked: true });
      if (path.endsWith("/customers/lookup")) {
        const q = urlObj.searchParams.get("q") || "";
        const match = urlObj.searchParams.get("match") || "search";
        if (match === "pan" || q.includes("300123456")) {
          return respond({ items: [lookupCustomer, conflictCustomer], total: 2, page: 1, pageSize: 20 });
        }
        if (q.includes("Looked-up")) {
          return respond({ items: [lookupCustomer], total: 1, page: 1, pageSize: 12 });
        }
        return respond({ items: [], total: 0, page: 1, pageSize: 12 });
      }
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.includes("/purchase-history")) return respond({ items: [], total: 0, page: 1, pageSize: 20 });
      return respond({});
    });

    await page.goto("/billing");

    // 1. Search for customer not in initial local list
    await page.getByRole("button", { name: "Change customer" }).click();
    const customerSearchInput = page.getByPlaceholder("Find by name, phone, or 9-digit PAN...");
    await customerSearchInput.fill("Looked-up");

    // Wait for server search result and select it
    await expect(page.getByText("Server Looked-up Business").first()).toBeVisible();
    await page.getByText("Server Looked-up Business").first().click();

    // 2. Add product to cart
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Test Grocery");
    await page.getByText("Test Grocery Product").first().click();

    // Verify 10% loyalty discount is applied to customer from server lookup
    await expect(page.getByText("Loyalty 10%")).toBeVisible();
    await expect(page.getByText("Server Looked-up Business").first()).toBeVisible();

    // 3. Open customer search again to check PAN conflict matches
    await page.getByRole("button", { name: "Change customer" }).click();
    await customerSearchInput.fill("300123456");

    // Expect conflict alert with selectable profile
    await expect(page.getByText("Existing Firm with Same PAN").first()).toBeVisible();
    await expect(page.getByText("[INACTIVE]").first()).toBeVisible();

    // Click "Select Profile" on the conflicting profile
    await page.getByRole("button", { name: "Select Profile" }).last().click();

    // Selected customer should switch to Existing Firm with Same PAN
    await expect(page.getByText("Existing Firm with Same PAN").first()).toBeVisible();
  });

  test("paper bill draft persists across reload, records after checkout, and resets cleanly between sales", async ({ page }) => {
    const product = {
      id: "prod-pb-1",
      name: "Paper Bill Product",
      sku: "PB-01",
      retailPrice: 200,
      wholesalePrice: 200,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    let checkoutPayload1: any = null;
    let checkoutPayload2: any = null;
    let recordedPayload1: any = null;
    let recordedPayload2: any = null;
    let checkoutAttempts = 0;
    let referenceAttempts = 0;
    let committedInvoice: any = null;
    let committedManualBill: any = null;
    const auditRecords: any[] = [];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true, stockTracked: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        checkoutAttempts++;
        if (checkoutAttempts === 1) {
          checkoutPayload1 = route.request().postDataJSON();
          // Server stages committed sale before connection drops
          committedInvoice = {
            id: "inv-pb-100",
            invoiceNo: "INV-2080-0100",
            status: "FINALIZED",
            netTotal: 200,
            paidTotal: 200,
            paymentStatus: "PAID",
            operationKey: checkoutPayload1.operationKey,
          };
          committedManualBill = {
            id: "inv-pb-100",
            invoiceNo: "INV-2080-0100",
            status: "FINALIZED",
            billingChannel: "MANUAL_EXTERNAL",
            externalDocumentType: null,
            externalBillNo: null,
            externalBillDate: null,
            billRecordStatus: "PENDING",
          };
          return respond({
            code: "NETWORK_TIMEOUT",
            error: "Connection dropped after server checkout commit.",
          }, 500);
        }
        checkoutPayload2 = route.request().postDataJSON();
        return respond({
          invoice: committedInvoice,
        }, 201);
      }
      if (path === "/api/invoices/inv-pb-100" && route.request().method() === "GET") {
        return respond({
          invoice: committedInvoice || {
            id: "inv-pb-100",
            invoiceNo: "INV-2080-0100",
            status: "FINALIZED",
            netTotal: 200,
            paidTotal: 200,
            paymentStatus: "PAID",
          },
        });
      }
      if (path === "/api/invoices/manual-bills/inv-pb-100" && route.request().method() === "GET") {
        return respond(committedManualBill || {
          id: "inv-pb-100",
          invoiceNo: "INV-2080-0100",
          status: "FINALIZED",
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        });
      }
      if (path === "/api/invoices/manual-bills/inv-pb-100/reference" && route.request().method() === "POST") {
        referenceAttempts++;
        if (referenceAttempts === 1) {
          recordedPayload1 = route.request().postDataJSON();
          committedManualBill = {
            ...committedManualBill,
            externalDocumentType: recordedPayload1.reference.externalDocumentType,
            externalBillNo: recordedPayload1.reference.billNo,
            externalBillDate: recordedPayload1.reference.externalBillDate,
            billRecordStatus: "RECORDED",
          };
          auditRecords.push({
            action: "RECORD_MANUAL_BILL",
            invoiceId: "inv-pb-100",
            billNo: recordedPayload1.reference.billNo,
            documentType: recordedPayload1.reference.externalDocumentType,
          });
          return respond({
            code: "REFERENCE_SAVE_FAILED",
            error: "Temporary network timeout while recording paper reference.",
          }, 500);
        }
        recordedPayload2 = route.request().postDataJSON();
        return respond(committedManualBill);
      }
      return respond({});
    });

    await page.goto("/billing");

    // Add item to cart
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Paper Bill");
    await page.getByText("Paper Bill Product").first().click();

    // Open payment modal
    await page.getByRole("button", { name: /PAY NOW/ }).click();

    // Enter paper bill number PB-9999 and cash amount
    await page.getByPlaceholder("e.g. PB-2080-001").fill("PB-9999");
    await page.getByPlaceholder("0.00").fill("200");

    // 1. Initial checkout attempt: server commits sale but response drops (simulated network timeout)
    await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
    await page.getByRole("button", { name: /^Confirm/i }).click();

    // Error toast appears and cart retains pending checkout snapshot
    await expect(page.getByText("Connection dropped after server checkout commit.").first()).toBeVisible();
    expect(checkoutAttempts).toBe(1);
    expect(checkoutPayload1).toBeDefined();

    // 2. Reload page during pending checkout to verify snapshot persistence and replay with identical key and items
    await page.reload();

    // Re-open recovered cart snapshot and confirm checkout
    await page.getByRole("button", { name: /RECOVER CHECKOUT/ }).click();
    await page.getByRole("button", { name: /Retry Submission|Confirm/i }).click();

    // Second checkout response arrives with 201 Created
    await expect(page.getByText("Invoice created successfully")).toBeVisible();
    await expect(page.getByText("INV-2080-0100").first()).toBeVisible();
    expect(checkoutAttempts).toBe(2);
    expect(checkoutPayload2).toBeDefined();
    expect(checkoutPayload2).toEqual(checkoutPayload1);
    expect(checkoutPayload2.operationKey).toBe(checkoutPayload1.operationKey);
    expect(checkoutPayload2.items.length).toBe(checkoutPayload1.items.length);

    // 3. Observe initial reference recording failure (attempt 1) and follow-up banner
    await page.getByRole("button", { name: "Continue Billing" }).click();
    await expect(page.getByText("Temporary network timeout while recording paper reference.")).toBeVisible();

    // 4. Reload page during pending paper reference banner to verify durable committed follow-up survives reload
    await page.reload();
    await expect(page.getByText("Pending Paper Bill Reference")).toBeVisible();
    await expect(page.getByText("INV-2080-0100").first()).toBeVisible();

    // 5. Click Save Paper Reference to replay reference with exact same payload and expected tuple
    await page.getByRole("button", { name: /Save Paper Reference|Retry Recording/i }).click();

    // Verify paper reference payload sent to backend on retry replay without issuing extra checkout
    expect(checkoutAttempts).toBe(2);
    expect(referenceAttempts).toBe(2);
    expect(recordedPayload1).toBeDefined();
    expect(recordedPayload2).toBeDefined();
    expect(recordedPayload2).toEqual(recordedPayload1);
    expect(recordedPayload2.reference).toEqual(recordedPayload1.reference);
    expect(recordedPayload2.reference.billNo).toBe("PB-9999");
    expect(recordedPayload2.reference.externalDocumentType).toBe("PAN_INVOICE");
    expect(recordedPayload2.expected).toEqual(recordedPayload1.expected);
    expect(recordedPayload2.expected.billRecordStatus).toBe("PENDING");
    expect(auditRecords.length).toBe(1);

    // Verify toast shows success and banner is dismissed
    await expect(page.getByText(/Manual bill reference recorded successfully/i)).toBeVisible();
    await expect(page.getByText("Pending Paper Bill Reference")).not.toBeVisible();

    // 6. Open payment modal on next sale
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Paper Bill");
    await page.getByText("Paper Bill Product").first().click();
    await page.getByRole("button", { name: /PAY NOW/ }).click();

    // Paper bill number should be empty for new sale
    const billNoInput = page.getByPlaceholder("e.g. PB-2080-001");
    await expect(billNoInput).toHaveValue("");
  });

  test("dismissed unresolved paper intent survives another sale and each invoice reconciles independently", async ({ page }) => {
    const product = { id: "prod-dismiss", name: "Dismiss Reference Product", sku: "DISMISS-1",
      retailPrice: 200, wholesalePrice: 200, stock: 50, isActive: true, saleUnit: "PIECE", quantityStep: 1 };
    const invoices: Record<string, any> = {};
    const records: Record<string, any> = {};
    const referencePayloads: Record<string, any[]> = {};
    const audits: string[] = [];
    let checkoutAttempts = 0;
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) => route.fulfill({
        status, contentType: "application/json", body: JSON.stringify(body),
      });
      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities")) return respond({ businessMode: "FULL_POS", posEnabled: true,
        catalogEnabled: true, inventoryEnabled: true, stockTracked: true });
      if (path.endsWith("/customers")) return respond([]);
      if (["/products", "/products/lookup", "/products/by-ids"].some((suffix) => path.endsWith(suffix))) {
        return respond({ products: [product], total: 1 });
      }
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        const suffix = ++checkoutAttempts === 1 ? "a" : "b";
        const id = `inv-dismiss-${suffix}`;
        invoices[id] = { id, invoiceNo: `INV-DISMISS-${suffix.toUpperCase()}`, status: "FINALIZED",
          netTotal: 200, paidTotal: 200, paymentStatus: "PAID" };
        records[id] = { ...invoices[id], billingChannel: "MANUAL_EXTERNAL", externalDocumentType: null,
          externalBillNo: null, externalBillDate: null, billRecordStatus: "PENDING" };
        return respond({ invoice: invoices[id] }, 201);
      }
      const referenceMatch = path.match(/\/invoices\/manual-bills\/(inv-dismiss-[ab])\/reference$/);
      if (referenceMatch && route.request().method() === "POST") {
        const id = referenceMatch[1];
        const payload = route.request().postDataJSON();
        const attempts = referencePayloads[id] ||= [];
        attempts.push(payload);
        if (attempts.length === 1) {
          // Commit metadata and one audit effect, then lose the authoritative response.
          records[id] = { ...records[id], externalBillNo: payload.reference.billNo,
            externalDocumentType: payload.reference.externalDocumentType,
            externalBillDate: payload.reference.externalBillDate, billRecordStatus: "RECORDED" };
          audits.push(id);
          return respond({ error: `Reference response lost for ${id}` }, 500);
        }
        expect(payload).toEqual(attempts[0]);
        return respond(records[id]);
      }
      const recordMatch = path.match(/\/invoices\/manual-bills\/(inv-dismiss-[ab])$/);
      if (recordMatch) return respond(records[recordMatch[1]]);
      const invoiceMatch = path.match(/\/invoices\/(inv-dismiss-[ab])$/);
      if (invoiceMatch) return respond({ invoice: invoices[invoiceMatch[1]] });
      return respond({});
    });
    const storedIntents = () => page.evaluate(() => {
      const intents: Record<string, any> = {};
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index)!;
        if (!key.startsWith("khatasathi_billing_paper_followup_v2:")) continue;
        const intent = JSON.parse(sessionStorage.getItem(key)!);
        intents[intent.invoiceId] = intent;
      }
      return intents;
    });
    const saveSale = async (suffix: string) => {
      await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Dismiss Reference");
      await page.getByText(product.name).first().click();
      await page.getByRole("button", { name: /PAY NOW/ }).click();
      await page.getByPlaceholder("e.g. PB-2080-001").fill(`PB-DISMISS-${suffix.toUpperCase()}`);
      await page.getByPlaceholder("0.00").fill("200");
      await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
      await page.getByRole("button", { name: /^Confirm/i }).click();
      await expect(page.getByText("Invoice created successfully")).toBeVisible();
      await page.getByRole("button", { name: "Continue Billing" }).click();
      await expect(page.getByText(`Reference response lost for inv-dismiss-${suffix}`).first()).toBeVisible();
    };

    await page.goto("/billing");
    await saveSale("a");
    const originalA = (await storedIntents())["inv-dismiss-a"];
    expect(originalA.actorId).toBe(cashier.id);
    expect(originalA.draft.billNo).toBe("PB-DISMISS-A");
    expect(originalA.expected).toEqual(referencePayloads["inv-dismiss-a"][0].expected);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.getByText("Pending Paper Bill Reference")).not.toBeVisible();
    expect((await storedIntents())["inv-dismiss-a"]).toEqual(originalA);

    await saveSale("b");
    const both = await storedIntents();
    expect(Object.keys(both).sort()).toEqual(["inv-dismiss-a", "inv-dismiss-b"]);
    expect(both["inv-dismiss-a"]).toEqual(originalA);
    const originalB = both["inv-dismiss-b"];
    expect(originalB.actorId).toBe(cashier.id);
    expect(originalB.draft.billNo).toBe("PB-DISMISS-B");
    expect(originalB.expected).toEqual(referencePayloads["inv-dismiss-b"][0].expected);

    await page.reload();
    await expect(page.getByText("Pending Paper Bill Reference")).toBeVisible();
    await expect(page.getByText("INV-DISMISS-A").first()).toBeVisible();
    await page.getByRole("button", { name: "Save Paper Reference" }).click();
    await expect(page.getByText(/Manual bill reference recorded successfully/i)).toBeVisible();
    await expect.poll(async () => Object.keys(await storedIntents())).toEqual(["inv-dismiss-b"]);
    expect((await storedIntents())["inv-dismiss-b"]).toEqual(originalB);

    await page.reload();
    await expect(page.getByText("Pending Paper Bill Reference")).toBeVisible();
    await expect(page.getByText("INV-DISMISS-B").first()).toBeVisible();
    await page.getByRole("button", { name: "Save Paper Reference" }).click();
    await expect.poll(async () => Object.keys(await storedIntents())).toEqual([]);
    await expect(page.getByText("Pending Paper Bill Reference")).not.toBeVisible();
    expect(checkoutAttempts).toBe(2);
    expect(referencePayloads["inv-dismiss-a"]).toEqual([referencePayloads["inv-dismiss-a"][0], referencePayloads["inv-dismiss-a"][0]]);
    expect(referencePayloads["inv-dismiss-b"]).toEqual([referencePayloads["inv-dismiss-b"][0], referencePayloads["inv-dismiss-b"][0]]);
    expect(audits).toEqual(["inv-dismiss-a", "inv-dismiss-b"]);
  });

  test("keyboard isolation suppresses background F-keys and shortcuts while overlay is open", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Open Calculator modal
    await page.locator("#billing-calculator-trigger").click();
    await expect(page.getByText("Scratchpad Calculator", { exact: true })).toBeVisible();

    // Press F4 (Cash payment shortcut) while calculator is open
    await page.keyboard.press("F4");

    // Confirm Payment modal MUST NOT open underneath calculator
    await expect(page.getByText("Confirm Payment")).not.toBeVisible();

    // Close calculator with Escape
    await page.keyboard.press("Escape");
    await expect(page.getByText("Scratchpad Calculator", { exact: true })).not.toBeVisible();
  });

  test("calculator handles invalid expressions and division by zero with safe error messages", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Open Calculator
    await page.locator("#billing-calculator-trigger").click();
    const calcInput = page.getByPlaceholder("0");

    // Test Division by zero
    await calcInput.fill("100 / 0");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Cannot divide by zero")).toBeVisible();

    // Test Syntax error
    await calcInput.fill("100 + * 5");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Unexpected token/i)).toBeVisible();
  });

  test("paper reference retry handles STALE_RECORD_CONFLICT with explicit acknowledgement", async ({ page }) => {
    const product = {
      id: "prod-stale-1",
      name: "Stale Test Item",
      sku: "STL-01",
      retailPrice: 150,
      wholesalePrice: 150,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    let referenceAttempts = 0;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        return respond({
          invoice: {
            id: "inv-stale-1",
            invoiceNo: "INV-2080-0500",
            status: "FINALIZED",
            netTotal: 150,
            paidTotal: 150,
            paymentStatus: "PAID",
          },
        }, 201);
      }
      if (path === "/api/invoices/manual-bills/inv-stale-1" && route.request().method() === "GET") {
        return respond({
          id: "inv-stale-1",
          invoiceNo: "INV-2080-0500",
          status: "FINALIZED",
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        });
      }
      if (path === "/api/invoices/manual-bills/inv-stale-1/reference" && route.request().method() === "POST") {
        referenceAttempts++;
        if (referenceAttempts === 1) {
          return respond({
            code: "STALE_RECORD_CONFLICT",
            error: "Record state mismatch. Another operator modified this record.",
            currentRecord: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: "PAN_INVOICE",
              externalBillNo: "PB-ORIGINAL",
              externalBillDate: "2026-10-05",
              billRecordStatus: "RECORDED",
            },
          }, 409);
        }
        return respond({
          id: "inv-stale-1",
          invoiceNo: "INV-2080-0500",
          status: "FINALIZED",
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: "PAN_INVOICE",
          externalBillNo: "PB-RESOLVED",
          externalBillDate: "2026-10-05",
          billRecordStatus: "RECORDED",
        });
      }
      return respond({});
    });

    await page.goto("/billing");

    // Add item
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Stale");
    await page.getByText("Stale Test Item").first().click();

    // Open payment modal
    await page.getByRole("button", { name: /PAY NOW/ }).click();
    await page.getByPlaceholder("e.g. PB-2080-001").fill("PB-STALE");
    await page.getByPlaceholder("0.00").fill("150");

    // Checkout
    await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
    await page.getByRole("button", { name: /^Confirm/i }).click();

    // Close success dialog to see the pending paper banner with conflict alert
    await page.getByRole("button", { name: "Continue Billing" }).click();

    // Verify Conflict Alert in the bottom banner
    await expect(page.getByText("Record Conflict: Another operator modified this record on the server.")).toBeVisible();

    // Click "Acknowledge & Update Expected State"
    await page.getByRole("button", { name: "Acknowledge & Update Expected State" }).click();

    // Update bill number in banner form and retry
    const bannerBillInput = page.locator("input[placeholder='e.g. PB-2080-001']").last();
    await bannerBillInput.fill("PB-RESOLVED");

    await page.getByRole("button", { name: "Save Paper Reference" }).click();

    // Banner should close on successful reference recording
    await expect(page.getByText("Record Conflict: Another operator modified this record on the server.")).not.toBeVisible();
    expect(referenceAttempts).toBe(2);
  });

  test("fonepay payment requires reference and merchant confirmation before checkout confirmation", async ({ page }) => {
    const product = {
      id: "prod-fp-1",
      name: "Payment Test Item",
      sku: "PAY-01",
      retailPrice: 500,
      wholesalePrice: 500,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        return respond({
          invoice: {
            id: "inv-fp-100",
            invoiceNo: "INV-2080-0900",
            status: "FINALIZED",
            netTotal: 500,
            paidTotal: 500,
            paymentStatus: "PAID",
          },
        }, 201);
      }
      return respond({});
    });

    await page.goto("/billing");

    // Add item
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Payment");
    await page.getByText("Payment Test Item").first().click();

    // Open payment modal
    await page.getByRole("button", { name: /PAY NOW/ }).click();

    // Select Fonepay payment method
    await page.getByRole("button", { name: /Fonepay/ }).click();

    // 1. Attempt Final Checkout without reference
    await page.getByRole("button", { name: /CONFIRM FONEPAY/ }).click();
    await expect(page.getByText("Enter the Fonepay reference or remarks.")).toBeVisible();

    // Fill Fonepay reference
    await page.getByPlaceholder("Transaction ID, payer phone, or cashier note").fill("FP-REF-9999");

    // 2. Attempt Final Checkout without checking verification box
    await page.getByRole("button", { name: /CONFIRM FONEPAY/ }).click();
    await expect(page.getByText("Please confirm that the Fonepay merchant payment confirmation was verified.")).toBeVisible();

    // Check Fonepay verification checkbox
    await page.getByText("I have verified the Fonepay merchant SMS / app payment confirmation").click();

    // 3. Attempt Final Checkout with reference and confirmation checked
    await page.getByRole("button", { name: /CONFIRM FONEPAY/ }).click();

    // Confirm dialog opens
    await expect(page.getByRole("button", { name: "Confirm Fonepay", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm Fonepay", exact: true }).click();

    // Success dialog
    await expect(page.getByText("Invoice created successfully")).toBeVisible();
  });

  test("quick create customer handles PAN conflicts, pagination, and unverified acknowledgment reset", async ({ page }) => {
    const conflictPage1 = Array.from({ length: 20 }, (_, i) => ({
      id: `cust-pan-dup-${i + 1}`,
      name: `Existing Firm ${i + 1}`,
      phone: `+97798411122${i.toString().padStart(2, "0")}`,
      panNo: "999888777",
      isActive: true,
    }));
    const conflictPage2 = [
      {
        id: "cust-pan-dup-21",
        name: "Existing Firm 21",
        phone: "+9779841112299",
        panNo: "999888777",
        isActive: false,
      },
    ];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers/lookup")) {
        const q = urlObj.searchParams.get("q") || "";
        const pageNum = Number(urlObj.searchParams.get("page") || "1");
        if (q.includes("999888777")) {
          if (pageNum === 2) {
            return respond({ items: conflictPage2, total: 21, page: 2, pageSize: 20 });
          }
          return respond({ items: conflictPage1, total: 21, page: 1, pageSize: 20 });
        }
        return respond({ items: [], total: 0, page: 1, pageSize: 12 });
      }
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Open customer modal
    await page.getByRole("button", { name: "Change customer" }).click();

    // Open Quick Customer form
    await page.getByRole("button", { name: "+ Add a customer" }).click();

    const quickForm = page.locator("form");

    // Enter details with conflicting PAN
    await quickForm.getByLabel("Name", { exact: true }).fill("New Test Firm");
    const panInput = quickForm.getByLabel("PAN (optional)", { exact: true });
    await panInput.fill("999888777");

    // Expect conflict warning with Existing Firm 1 and pagination
    await expect(quickForm.getByText("PAN already registered to existing profile(s):")).toBeVisible();
    await expect(quickForm.getByText("Existing Firm 1").first()).toBeVisible();
    await expect(quickForm.getByText("Page 1 of 2")).toBeVisible();

    // Navigate to Page 2
    await quickForm.getByRole("button", { name: "Next" }).click();
    await expect(quickForm.getByText("Existing Firm 21").first()).toBeVisible();
    await expect(quickForm.getByText("[INACTIVE]").first()).toBeVisible();
    await expect(quickForm.getByText("Page 2 of 2")).toBeVisible();

    // Navigate back to Page 1
    await quickForm.getByRole("button", { name: "Prev" }).click();
    await expect(quickForm.getByText("Existing Firm 1").first()).toBeVisible();

    // Check acknowledgment checkbox
    const ackCheckbox = quickForm.getByText("Proceed creating new customer profile with duplicate PAN");
    await expect(ackCheckbox).toBeVisible();
    await ackCheckbox.click();

    // Modify PAN input to verify acknowledgment resets
    await panInput.fill("999888770");
    await expect(quickForm.getByText("Proceed creating new customer profile with duplicate PAN")).not.toBeVisible();
  });

  test("resumes saved sale result with authoritative payment status and settlement totals", async ({ page }) => {
    const resumedInvoice = {
      id: "inv-resume-99",
      invoiceNo: "INV-2080-9999",
      status: "FINALIZED",
      netTotal: 1200,
      paidTotal: 1200,
      paymentStatus: "PAID",
      payments: [
        {
          id: "pay-1",
          method: "CASH",
          amount: 1200,
          status: "SUCCESS",
        },
      ],
    };

    const resumedManualBill = {
      id: "inv-resume-99",
      invoiceNo: "INV-2080-9999",
      status: "FINALIZED",
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-RESUMED-01",
      externalBillDate: "2026-10-06",
      billRecordStatus: "RECORDED",
    };

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path === "/api/invoices/inv-resume-99") {
        return respond({ invoice: resumedInvoice });
      }
      if (path === "/api/invoices/manual-bills/inv-resume-99") {
        return respond(resumedManualBill);
      }
      return respond({});
    });

    await page.goto("/billing?resumePaperInvoiceId=inv-resume-99");

    // Success dialog appears with authoritative settlement summary
    await expect(page.getByText("Invoice created successfully")).toBeVisible();
    await expect(page.getByText("INV-2080-9999")).toBeVisible();
    await expect(page.getByText("PAID (CASH)")).toBeVisible();
    await expect(page.getByText("Recorded (PB-RESUMED-01)")).toBeVisible();

    // Verify paper bill status is marked recorded and banner is clear
    await expect(page.getByText("Pending Paper Bill Reference")).not.toBeVisible();
  });

  test("resumes saved sale with pending gateway payment and renders pending verification in settlement card", async ({ page }) => {
    const pendingInvoice = {
      id: "inv-resume-pending-88",
      invoiceNo: "INV-2080-8888",
      status: "FINALIZED",
      netTotal: 1500,
      paidTotal: 0,
      paymentStatus: "UNPAID",
      payments: [
        {
          id: "pay-esewa-pending",
          method: "ESEWA",
          amount: 1500,
          status: "PENDING",
        },
      ],
    };

    const pendingManualBill = {
      id: "inv-resume-pending-88",
      invoiceNo: "INV-2080-8888",
      status: "FINALIZED",
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-PENDING-01",
      externalBillDate: "2026-10-06",
      billRecordStatus: "RECORDED",
    };

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path === "/api/invoices/inv-resume-pending-88") {
        return respond({ invoice: pendingInvoice });
      }
      if (path === "/api/invoices/manual-bills/inv-resume-pending-88") {
        return respond(pendingManualBill);
      }
      return respond({});
    });

    await page.goto("/billing?resumePaperInvoiceId=inv-resume-pending-88");

    // Success dialog appears with settlement summary
    await expect(page.getByText("Invoice created successfully")).toBeVisible();
    await expect(page.getByText("INV-2080-8888")).toBeVisible();
    await expect(page.getByText("Pending Verification (Gateway)")).toBeVisible();
    await expect(page.getByText("UNPAID (ESEWA) · PENDING GATEWAY VERIFICATION")).toBeVisible();
  });

  test("duplicate paper bill reference requires manager or administrator review and approval reason", async ({ page }) => {
    const product = {
      id: "prod-dup-1",
      name: "Duplicate Test Item",
      sku: "DUP-01",
      retailPrice: 200,
      wholesalePrice: 200,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    let referenceAttempts = 0;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        return respond({
          invoice: {
            id: "inv-dup-1",
            invoiceNo: "INV-2080-0600",
            status: "FINALIZED",
            netTotal: 200,
            paidTotal: 200,
            paymentStatus: "PAID",
          },
        }, 201);
      }
      if (path === "/api/invoices/manual-bills/inv-dup-1" && route.request().method() === "GET") {
        return respond({
          id: "inv-dup-1",
          invoiceNo: "INV-2080-0600",
          status: "FINALIZED",
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: null,
          externalBillNo: null,
          externalBillDate: null,
          billRecordStatus: "PENDING",
        });
      }
      if (path === "/api/invoices/manual-bills/inv-dup-1/reference" && route.request().method() === "POST") {
        referenceAttempts++;
        if (referenceAttempts === 1) {
          return respond({
            code: "DUPLICATE_REVIEW_REQUIRED",
            error: "Duplicate paper bill number detected. Review approval required.",
          }, 409);
        }
        return respond({
          id: "inv-dup-1",
          invoiceNo: "INV-2080-0600",
          status: "FINALIZED",
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: "PAN_INVOICE",
          externalBillNo: "PB-DUP-01",
          externalBillDate: "2026-10-06",
          billRecordStatus: "RECORDED",
        });
      }
      return respond({});
    });

    await page.goto("/billing");

    // Add item
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Duplicate");
    await page.getByText("Duplicate Test Item").first().click();

    // Open payment modal
    await page.getByRole("button", { name: /PAY NOW/ }).click();
    await page.getByPlaceholder("e.g. PB-2080-001").fill("PB-DUP-01");
    await page.getByPlaceholder("0.00").fill("200");

    // Checkout
    await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
    await page.getByRole("button", { name: /^Confirm/i }).click();

    // Close success dialog to see the pending paper banner
    await page.getByRole("button", { name: "Continue Billing" }).click();

    // Verify Cashier sees duplicate error message that manager/admin approval is required
    await expect(page.getByText("Duplicate paper bill number. Only managers or administrators can approve duplicate paper bills.")).toBeVisible();
  });

  test("compact history overlay supports desktop anchored placement and mobile sheet focus isolation", async ({ page }) => {
    const customer = {
      id: "cust-hist-1",
      name: "Sita Sharma",
      phone: "+9779841000111",
      panNo: "400111222",
      loyaltyPercent: 0,
      wholesalePercent: 0,
      isActive: true,
    };

    const product = {
      id: "prod-hist-1",
      name: "Basmati Rice 5kg",
      sku: "RICE-5K",
      retailPrice: 450,
      wholesalePrice: 400,
      stock: 50,
      isActive: true,
      saleUnit: "KG",
      quantityStep: 1,
    };

    const historyItems = Array.from({ length: 12 }, (_, i) => ({
      id: `hist-${i + 1}`,
      invoiceId: `inv-hist-${i + 1}`,
      invoiceNo: `INV-2080-${(i + 1).toString().padStart(4, "0")}`,
      invoiceDate: "2026-10-01T10:00:00.000Z",
      productId: "prod-hist-1",
      productName: "Basmati Rice 5kg",
      productSku: "RICE-5K",
      appliedUnitPrice: 450 - i * 5,
      qty: 2 + i,
    }));

    await page.addInitScript(({ user, customer, product }) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
      localStorage.setItem(
        "khatasathi_billing_cart",
        JSON.stringify({
          cart: [
            { productId: product.id, qty: 1 },
          ],
          selectedCustomerId: customer.id,
          savedAt: new Date().toISOString(),
        }),
      );
    }, { user: cashier, customer, product });

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([customer]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.includes("/product-history")) return respond({ history: historyItems });
      return respond({});
    });

    await page.goto("/billing");

    // 1. Desktop: verify Recent Items trigger opens compact history anchored overlay
    const recentItemsBtn = page.getByRole("button", { name: "Recent Items" });
    await expect(recentItemsBtn).toBeVisible();
    await recentItemsBtn.click();

    // Verify modal title, long-content items, and persistent footer controls
    const modal = page.locator("[role='dialog']").filter({ hasText: "Recent Cart Item History" });
    await expect(modal).toBeVisible();
    await expect(page.getByText("Recent Cart Item History")).toBeVisible();
    await expect(page.getByText("Basmati Rice 5kg").first()).toBeVisible();
    const searchAllBtn = page.getByRole("button", { name: "Search All Past Purchases" });
    const closeBtn = page.getByRole("button", { name: "Close", exact: true });
    await expect(searchAllBtn).toBeVisible();
    await expect(closeBtn).toBeVisible();

    // Verify anchored bounding box positioning and desktop viewport clamping (configured 1440x1000)
    await expect.poll(async () => {
      const box = await modal.boundingBox();
      return box ? box.y : 0;
    }).toBeGreaterThanOrEqual(16);

    const modalBox = await modal.boundingBox();
    const btnBox = await recentItemsBtn.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    expect(modalBox!.y).toBeGreaterThanOrEqual(16);
    expect(modalBox!.x).toBeGreaterThanOrEqual(0);
    expect(modalBox!.width).toBeGreaterThan(200);
    expect(modalBox!.x + modalBox!.width).toBeLessThanOrEqual(1440);
    expect(modalBox!.y + modalBox!.height).toBeLessThanOrEqual(1000);
    // Compare desktop placement relative to trigger button
    expect(modalBox!.y).toBeGreaterThanOrEqual(btnBox!.y - 20);
    expect(modalBox!.y).toBeLessThanOrEqual(btnBox!.y + 60);

    // Assert actual long-content scrolling with reachable footer
    const scrollContainer = modal.locator(".overflow-y-auto");
    await expect(scrollContainer).toBeVisible();
    const isScrollable = await scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(isScrollable).toBe(true);
    await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(searchAllBtn).toBeVisible();
    await expect(closeBtn).toBeVisible();

    // Tab navigation containment and boundary wrapping inside modal
    await closeBtn.focus();
    await expect(closeBtn).toBeFocused();
    // Press Tab from last element -> wraps to first focusable control inside modal
    await page.keyboard.press("Tab");
    const isFocusInsideAfterTab = await modal.evaluate((el) => el.contains(document.activeElement));
    expect(isFocusInsideAfterTab).toBe(true);
    // Press Shift+Tab -> wraps back to last control (Close button)
    await page.keyboard.press("Shift+Tab");
    await expect(closeBtn).toBeFocused();

    // Close via Escape key and ensure focus returns to trigger
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    await expect(recentItemsBtn).toBeFocused();

    // 2. Mobile Viewport: 390x844
    await page.setViewportSize({ width: 390, height: 844 });
    await recentItemsBtn.click();
    await expect(modal).toBeVisible();
    await expect(page.getByText("Recent Cart Item History")).toBeVisible();
    await expect(searchAllBtn).toBeVisible();
    await expect(closeBtn).toBeVisible();
    const mobileBox = await modal.boundingBox();
    expect(mobileBox).not.toBeNull();
    expect(mobileBox!.y).toBeGreaterThanOrEqual(0);
    expect(mobileBox!.width).toBeGreaterThanOrEqual(350);
    expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);

    // Mobile Tab and Shift+Tab containment
    await page.keyboard.press("Tab");
    const isMobileFocusInside = await modal.evaluate((el) => el.contains(document.activeElement));
    expect(isMobileFocusInside).toBe(true);
    await page.keyboard.press("Shift+Tab");
    const isMobileShiftTabFocusInside = await modal.evaluate((el) => el.contains(document.activeElement));
    expect(isMobileShiftTabFocusInside).toBe(true);

    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    await expect(recentItemsBtn).toBeFocused();
  });

  test("handles browser storage denial gracefully with user advisory warning", async ({ page }) => {
    const product = {
      id: "prod-sd-1",
      name: "Storage Denial Item",
      sku: "SD-01",
      retailPrice: 100,
      wholesalePrice: 100,
      stock: 50,
      isActive: true,
      saleUnit: "PIECE",
      quantityStep: 1,
    };

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
      // Simulate restricted sessionStorage
      const originalSetItem = window.sessionStorage.setItem.bind(window.sessionStorage);
      window.sessionStorage.setItem = (key: string, val: string) => {
        if (key.includes("paper_followup") || key.includes("pending_paper")) {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        return originalSetItem(key, val);
      };
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products") || path.endsWith("/products/lookup") || path.endsWith("/products/by-ids"))
        return respond({ products: [product], total: 1 });
      if (path.endsWith("/payments/gateways/display")) return respond({ esewa: { environment: "SANDBOX", label: "Sandbox" } });
      if (path.endsWith("/invoices/checkout")) {
        return respond({
          invoice: {
            id: "inv-sd-1",
            invoiceNo: "INV-2080-0777",
            status: "FINALIZED",
            netTotal: 100,
            paidTotal: 100,
            paymentStatus: "PAID",
          },
        }, 201);
      }
      return respond({});
    });

    await page.goto("/billing");

    // Add item
    await page.getByPlaceholder("Search product name, SKU, brand... (F2)").fill("Storage");
    await page.getByText("Storage Denial Item").first().click();

    // Open payment modal and enter paper bill details
    await page.getByRole("button", { name: /PAY NOW/ }).click();
    await page.getByPlaceholder("e.g. PB-2080-001").fill("PB-DENY-01");
    await page.getByPlaceholder("0.00").fill("100");

    // Checkout
    await page.getByRole("button", { name: /FINAL CHECKOUT/ }).click();
    await page.getByRole("button", { name: /^Confirm/i }).click();

    // Advisory warning displayed in success dialog
    await expect(page.getByText("Browser storage is full or restricted.").first()).toBeVisible();
  });

  test("isolates pending paper follow-up across different cashier actors", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session");
      // Pre-seed follow-up for a different actor "user-other"
      sessionStorage.setItem(
        "khatasathi_billing_paper_followup_v1",
        JSON.stringify({
          version: 1,
          actorId: "user-other",
          invoiceId: "inv-other-999",
          invoiceNo: "INV-2080-9999",
          draft: {
            billNo: "PB-OTHER",
            externalDocumentType: "PAN_INVOICE",
            externalBillDate: "2026-10-06",
          },
          savedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      );
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const urlObj = new URL(route.request().url());
      const path = urlObj.pathname;
      const respond = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled: true });
      if (path.endsWith("/customers")) return respond([]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0 });
      return respond({});
    });

    await page.goto("/billing");

    // Current cashier (user-cashier) should not see the follow-up banner for user-other
    await expect(page.getByText("Pending Paper Bill Reference")).not.toBeVisible();
    await expect(page.getByText("INV-2080-9999")).not.toBeVisible();
  });
});
