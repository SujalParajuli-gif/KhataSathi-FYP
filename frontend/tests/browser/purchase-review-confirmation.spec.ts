import { expect, test } from "@playwright/test";
const revision = "11111111-1111-4111-8111-111111111111";
const corrected = { supplierName: "Reviewed supply", supplierId: "supplier", billNumber: "B25", billDate: "2026-10-09", payable: "20", lines: [{ name: "Rice", code: null, unit: "BOX", quantity: "2", cost: "10", productId: "product", conversionFactor: "3" }] };
const detail = { id: "receipt", supplierName: "Reviewed supply", billNumber: "B25", billDate: "2026-10-09", isFinancial: true, payable: "20.00", paidTotal: "0.00", dueAmount: "20.00", items: [{ id: "line", productName: "Rice", inputUnit: "BOX", inputQty: "2", unitAcquisitionCost: "10", lineAmount: "20.00" }] };
async function setup(page: any, lose = false) {
  let review: any = { revision, extractionId: revision, operationKey: revision, corrected, observations: corrected, warnings: [], model: "stub", extractedAt: "2026-10-09T12:00:00Z" };
  const confirmations: any[] = []; const forbidden: string[] = []; let initialLoss = lose;
  await page.addInitScript(() => { localStorage.setItem("khatasathi_auth_user", JSON.stringify({ id: "reviewer", role: "manager", name: "Reviewer" })); localStorage.setItem("khatasathi_token", "test-session"); });
  await page.route((url: URL) => url.pathname.startsWith("/api/"), async (route: any) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname;
    const reply = (body: any, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() !== "GET" && /\/purchases(?:\/|$)|installments|attachments/.test(p)) forbidden.push(p);
    if (p.endsWith("/auth/me")) return reply({ user: { id: "reviewer", name: "Reviewer", role: "manager" } });
    if (p.endsWith("/capabilities")) return reply({ inventoryEnabled: true, posEnabled: true, catalogEnabled: true, businessMode: "FULL_POS" });
    if (p.endsWith("/documents")) return reply({ documents: [{ id: "source", title: "Reviewed source", documentType: "PURCHASE_BILL", linkedEntityId: review.resolution ? "receipt" : null }], totalPages: 1 });
    if (p.endsWith("/file")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="350"><rect width="400" height="350" fill="white"/><text x="20" y="40">Reviewed supply B25</text><text x="20" y="80">Rice 2 BOX 10 Total 20</text></svg>' });
    if (p.endsWith("/confirm")) { const body = req.postDataJSON(); confirmations.push(body); review = { ...review, resolution: { ...body, receiptId: "receipt", actorId: "reviewer", confirmedAt: "2026-10-09T12:30:00Z" } }; if (initialLoss) { initialLoss = false; return route.abort("failed"); } }
    if (p.endsWith("/review") || p.endsWith("/confirm")) return reply({ document: { id: "source", title: "Reviewed source", mimeType: "image/png", fileUrl: "/api/documents/source/file" }, review });
    if (p.endsWith("/candidates")) return reply({ items: [{ id: u.searchParams.get("kind") === "supplier" ? "supplier" : "product", name: "Reviewed supply", sku: "R25", saleUnit: "PIECE", packageUnit: "BOX", packageQuantity: 3 }] });
    if (p.endsWith("/duplicates")) return reply({ items: [{ id: "receipt", billNumber: "B25", supplierName: "Reviewed supply", knownPayable: true, reason: "Same bill reference" }] });
    if (p.endsWith("/purchases/receipt")) return reply({ receipt: detail });
    if (p.endsWith("/purchases")) return reply({ items: [{ id: "receipt", capturedSupplierName: "Reviewed supply", billNumber: "B25", isFinancial: true, knownPayable: true, payable: "20.00", due: "20.00", paymentStatus: "UNPAID" }], totalPages: 1, total: 1 });
    if (p.endsWith("/suppliers")) return reply({ suppliers: [], totalPages: 1 });
    return reply({});
  });
  await page.goto("/purchases"); await page.getByRole("button", { name: "Review bill scan" }).click(); await page.getByLabel("Reviewed source", { exact: true }).check();
  return { confirmations, forbidden };
}
for (const width of [1440, 360]) test(`reviewed create freezes lost response, retries exactly and reopens committed outcome ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const s = await setup(page, true);
  await expect(page.getByText(/Line 1: NPR 20.00/)).toBeVisible(); await expect(page.getByRole("button", { name: "Create reviewed receipt" })).toBeDisabled();
  await page.getByLabel("Purchase decision reason").fill("Checked bill and duplicate candidate; distinct purchase");
  await page.getByLabel(/I reviewed the source/).check(); await page.getByRole("button", { name: "Create reviewed receipt" }).click();
  await expect(page.getByRole("button", { name: "Retry same confirmation" })).toBeEnabled();
  await expect(page.getByLabel("Reviewed payable")).toBeDisabled(); await expect(page.getByRole("button", { name: "Save review", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Review purchase bill" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirmation" }).click(); await expect(page.getByText(/Receipt created and stock posted once/)).toBeVisible();
  expect(s.confirmations).toHaveLength(2); expect(s.confirmations[1]).toEqual(s.confirmations[0]); expect(s.confirmations[0].operationKey).toBeUndefined(); expect(s.forbidden).toEqual([]);
  await page.screenshot({ path: info.outputPath(`confirmed-${width}.png`), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click(); await page.getByRole("button", { name: "Review bill scan" }).click(); await page.getByLabel(/Reviewed source.*Linked source/).check(); await expect(page.getByText(/Receipt created and stock posted once/)).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Review purchase bill" })).toHaveCount(0);
});
test("attachment requires inspected receipt and decision reason; unsaved edits cannot create or attach", async ({ page }) => {
  const s = await setup(page); await page.getByLabel("Reviewed payable").fill("21"); await expect(page.getByText(/Unsaved edits/)).toBeVisible(); await expect(page.getByLabel("Purchase decision reason")).toBeDisabled();
  await page.getByLabel("Reviewed payable").fill("20"); await page.getByLabel("Purchase decision reason").fill("Same purchase as existing receipt");
  await page.getByRole("combobox", { name: "Existing purchase receipt" }).click(); await page.getByRole("option", { name: /B25.*receipt/ }).click();
  await expect(page.getByText(/Existing receipt receipt/)).toBeVisible(); await expect(page.getByRole("button", { name: "Attach to inspected receipt" })).toBeDisabled();
  await page.getByLabel(/I inspected this receipt/).check(); await page.getByRole("button", { name: "Attach to inspected receipt" }).click();
  await expect(page.getByText(/Stock and payments unchanged/)).toBeVisible(); expect(s.confirmations[0]).toEqual({ action: "attach", expectedRevision: revision, reason: "Same purchase as existing receipt", receiptId: "receipt" }); expect(s.forbidden).toEqual([]);
});
