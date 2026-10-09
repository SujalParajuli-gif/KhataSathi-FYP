import { expect, test, type Page } from "@playwright/test";

const supplier = { id: "supplier-1", name: "Himalayan Supply", phone: "", contact: "", panNo: "", address: "", isActive: true };
const product = { id: "product-1", name: "Rice", sku: "RICE", saleUnit: "KG", packageUnit: "BAG", packageQuantity: 25, stock: 10, isActive: true };
const stagedDocument = { id: "doc-1", documentType: "PURCHASE_BILL", title: "Reviewed bill", fileName: "bill.pdf", linkedEntityId: null, visibility: "ADMIN_MANAGER", processingStatus: "UNPROCESSED" };
async function setup(page: Page, role = "manager", inventoryEnabled = true) {
  const actor = { id: "purchase-actor", name: "Purchase manager", role };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  let saved: any = { id: "receipt-1", supplierName: supplier.name, isFinancial: true, payable: "20.00", paidTotal: "0.00", dueAmount: "20.00", paymentStatus: "UNPAID", billNumber: "B-1", billDate: "2026-10-09", items: [], payments: [], documents: [] };
  const legacy = { id: "legacy-1", capturedSupplierName: "Historical supplier", billNumber: "LEGACY", isFinancial: false, knownPayable: false, payable: null, paid: null, due: null };
  const confirmations: any[] = [], payments: any[] = [], attachments: any[] = [];
  const calls: string[] = []; let loseConfirmation = true; let losePayment = true;
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const req = route.request(); const pathname = new URL(req.url()).pathname; calls.push(pathname);
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname.endsWith("/auth/me")) return reply({ user: actor });
    if (pathname.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", posEnabled: true, catalogEnabled: true, inventoryEnabled, stockTracked: inventoryEnabled });
    if (pathname === "/api/products") return reply({ products: [product], total: 1, totalPages: 1 });
    if (pathname === "/api/documents") return reply({ documents: [stagedDocument], total: 1, totalPages: 1 });
    if (pathname.endsWith("/suppliers")) {
      if (req.method() === "POST") return reply({ supplier: { ...supplier, ...req.postDataJSON() } });
      return reply({ suppliers: [supplier], totalPages: 1 });
    }
    if (pathname.includes("/suppliers/")) return reply({ supplier: { ...supplier, ...req.postDataJSON() } });
    if (pathname.endsWith("/purchases") && req.method() === "GET") return reply({ items: [{ ...saved, capturedSupplierName: saved.supplierName, knownPayable: true, paid: saved.paidTotal, due: saved.dueAmount }, legacy], total: 2, totalPages: 1 });
    if (pathname.endsWith("/purchases") && req.method() === "POST") {
      const body = req.postDataJSON(); confirmations.push(body);
      saved = { ...saved, id: "receipt-new", billNumber: body.billNumber, payable: body.payable, dueAmount: body.payable,
        items: body.lines.map((l: any, i: number) => ({ ...l, id: `line-${i}`, productName: product.name, stockQty: l.inputQty, lineAmount: "10.00" })) };
      if (loseConfirmation) { loseConfirmation = false; return route.abort("failed"); }
      return reply({ receipt: saved });
    }
    if (pathname.endsWith("/installments")) {
      const body = req.postDataJSON(); payments.push(body);
      saved = { ...saved, paidTotal: body.amount, dueAmount: "15.00", paymentStatus: "PARTIAL", payments: [{ id: "payment-1", ...body, isVoided: false }] };
      if (losePayment) { losePayment = false; return route.abort("failed"); }
      return reply({ payment: saved.payments[0] });
    }
    if (pathname.endsWith("/void")) { saved = { ...saved, paidTotal: "0.00", dueAmount: saved.payable, paymentStatus: "UNPAID", payments: saved.payments.map((p: any) => ({ ...p, isVoided: true, voidReason: req.postDataJSON().reason })) }; return reply({ payment: saved.payments[0] }); }
    if (pathname.endsWith("/attachments")) { attachments.push(req.postDataJSON()); saved = { ...saved, documents: [stagedDocument] }; return reply({ receipt: saved }); }
    if (pathname.endsWith("/legacy-1")) return reply({ receipt: { ...legacy, supplierName: "Historical supplier", payments: [], documents: [], items: [], paidTotal: null, dueAmount: null } });
    if (/\/purchases\/[^/]+$/.test(pathname)) return reply({ receipt: saved });
    if (pathname.includes("customers")) return reply([]);
    return reply({});
  });
  return { confirmations, payments, attachments, calls };
}

for (const width of [1440, 360]) test(`purchase review, exact retry, installment void and attachment recovery at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const state = await setup(page);
  await page.goto("/purchases");
  await page.getByRole("button", { name: "Himalayan Supply", exact: true }).click();
  await page.getByRole("button", { name: "New purchase", exact: true }).click();
  await page.getByRole("button", { name: "Add Rice", exact: true }).click(); await page.getByRole("button", { name: "Add Rice", exact: true }).click();
  await page.getByLabel("Acquisition cost line 1").fill("10"); await page.getByLabel("Acquisition cost line 2").fill("10");
  await page.getByLabel("Known payable").fill("19"); await page.getByRole("button", { name: "Review purchase", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("must equal");
  await page.getByLabel("Known payable").fill("20"); await page.getByRole("button", { name: "Review purchase", exact: true }).click();
  await expect(page.getByText("Known payable: NPR 20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm receipt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same confirmation" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click();
  await expect(page.getByRole("heading", { name: supplier.name, exact: true })).toBeVisible();
  expect(state.confirmations).toHaveLength(2); expect(state.confirmations[1]).toEqual(state.confirmations[0]); expect(state.confirmations[0].lines).toHaveLength(2);
  await page.getByRole("button", { name: "Record installment" }).click(); await page.getByLabel("Installment amount").fill("5");
  await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("button", { name: "Retry same payment" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same payment" }).click(); await expect(page.getByRole("button", { name: "Void payment" })).toBeVisible();
  expect(state.payments).toHaveLength(2); expect(state.payments[1]).toEqual(state.payments[0]);
  await page.getByRole("button", { name: "Void payment" }).click(); await page.getByLabel("Void reason").fill("Correcting recorded payment"); await page.getByRole("button", { name: "Confirm void" }).click();
  await expect(page.getByText(/Voided: Correcting recorded payment/)).toBeVisible();
  await page.getByRole("button", { name: "Add bill attachments" }).click(); await page.getByLabel("Reviewed bill", { exact: true }).check(); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("link", { name: "Reviewed bill" })).toBeVisible(); expect(state.attachments).toEqual([{ documentIds: ["doc-1"] }]); expect(state.confirmations).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`purchase-${width}.png`), fullPage: true });
  await page.getByRole("button", { name: "Historical supplier · LEGACY" }).click(); await expect(page.getByText("Historical stock-only receipt. No supplier debt or payment total is inferred.")).toBeVisible();
});

test("keyboard review can return to preserved draft and supplier edit retains selection", async ({ page }) => {
  await setup(page); await page.goto("/purchases");
  await page.getByRole("button", { name: "Edit supplier Himalayan Supply" }).click(); await page.getByLabel("Contact", { exact: true }).fill("Operations contact"); await page.getByRole("button", { name: "Save supplier" }).click();
  await expect(page.getByText("Selected:")).toContainText(supplier.name);
  await page.getByRole("button", { name: "New purchase", exact: true }).click(); await page.getByRole("button", { name: "Add Rice", exact: true }).click();
  await page.getByLabel("Acquisition cost line 1").fill("0"); await page.getByLabel("Known payable").fill("0"); await page.getByRole("button", { name: "Review purchase", exact: true }).click();
  await page.getByRole("button", { name: "Edit lines", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.getByLabel("Acquisition cost line 1")).toHaveValue("0");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const [role, inventory] of [["cashier", true], ["staff", true], ["manager", false]] as const) test(`purchase API never called for ${role} inventory=${inventory}`, async ({ page }) => {
  const state = await setup(page, role, inventory); await page.goto("/purchases"); await expect(page).not.toHaveURL(/\/purchases$/);
  expect(state.calls.some(p => p.startsWith("/api/inventory/purchases") || p.startsWith("/api/inventory/suppliers"))).toBe(false);
});
