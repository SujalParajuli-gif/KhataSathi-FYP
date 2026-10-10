import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  const actor = { id: "balance-manager", name: "Manager", role: "manager" };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  const supplier = { id: "s1", name: "Supply One", isActive: true, contact: null, phone: null, panNo: null, address: null };
  const other = { ...supplier, id: "s2", name: "Supply Two", isActive: false };
  const state = { fail: false, slow: false, unknown: 0, count: 2, paid: "30.01", due: "70.29", balanceCalls: 0, receiptQueries: [] as URLSearchParams[] };
  const balance = (s: typeof supplier) => ({ supplier: s, basis: "RECORDED_SUPPLIER_RECEIPTS", postedReceiptCount: state.count, unknownReceiptCount: state.unknown, payable: state.count ? "100.30" : "0.00", paid: state.paid, due: state.due, recordedBalance: state.unknown ? null : state.due });
  const receipt = () => ({ id: "r1", supplierName: supplier.name, billNumber: "B1", isFinancial: true, payable: "100.30", paidTotal: state.paid, dueAmount: state.due, paymentStatus: "PARTIAL", billDate: null, items: [], documents: [], payments: [{ id: "p1", amount: state.paid, method: "CASH", reference: null, paidAt: "2026-10-10T00:00:00Z", isVoided: state.paid === "0.00", voidReason: "Correction" }] });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path.endsWith("/auth/me")) return reply({ user: actor });
    if (path.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true });
    if (path.endsWith("/suppliers")) return reply({ suppliers: [supplier, other], totalPages: 1 });
    if (path.endsWith("/balance")) {
      state.balanceCalls++;
      const result = balance(path.includes("/s2/") ? other : supplier);
      if (state.slow && path.includes("/s1/")) await new Promise(resolve => setTimeout(resolve, 400));
      return state.fail ? reply({ error: "Balance unavailable" }, 503) : reply({ balance: result });
    }
    if (path.endsWith("/installments")) { state.paid = "40.01"; state.due = "60.29"; return reply({ payment: {} }); }
    if (path.endsWith("/void")) { state.paid = "0.00"; state.due = "100.30"; return reply({ payment: {} }); }
    if (path.endsWith("/purchases")) {
      state.receiptQueries.push(url.searchParams);
      return reply({ items: [{ id: "r1", capturedSupplierName: supplier.name, billNumber: "B1", isFinancial: true, knownPayable: true, payable: "100.30", paid: state.paid, due: state.due, paymentStatus: "PARTIAL" }], total: 1, totalPages: 1 });
    }
    if (path.endsWith("/purchases/r1")) return reply({ receipt: receipt() });
    return reply({});
  });
  return state;
}

for (const width of [1440, 360]) test(`supplier balance reconciles refreshed installments and source navigation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await setup(page); await page.goto("/purchases");
  await page.getByRole("button", { name: "Supply One", exact: true }).focus(); await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Supplier balance", exact: true });
  await expect(panel.getByText("NPR 70.29", { exact: true })).toBeVisible();
  await expect(panel).toContainText("Opening balances and unlinked historical receipts are not established");
  await page.getByLabel("Search receipts").fill("restricted search");
  await panel.getByRole("button", { name: "View source receipts" }).click();
  await expect(page.getByLabel("Search receipts")).toHaveValue("");
  await expect.poll(() => state.receiptQueries.at(-1)?.get("supplierId")).toBe("s1");
  expect(state.receiptQueries.at(-1)?.get("kind")).toBe("ALL");
  await page.getByRole("button", { name: "Supply One · B1", exact: true }).click();
  await page.getByRole("button", { name: "Record installment", exact: true }).click();
  await page.getByLabel("Installment amount").fill("10.00");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByText("NPR 60.29", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Void payment", exact: true }).click();
  await page.getByLabel("Void reason").fill("Correcting payment"); await page.getByRole("button", { name: "Confirm void" }).click();
  await expect(panel.locator("dl > div").filter({ hasText: "Known due" }).locator("dd")).toHaveText("NPR 100.30");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`balance-${width}.png`), fullPage: true });
});

test("unknown and empty subtotals, inactive history, stale switching, loading and retry never show obsolete money", async ({ page }) => {
  const state = await setup(page); state.unknown = 1; await page.goto("/purchases");
  await page.getByRole("button", { name: "Supply One", exact: true }).click();
  const panel = page.getByRole("region", { name: "Supplier balance", exact: true });
  await expect(panel).toContainText("Recorded balance is unknown: 1 linked receipt has");
  await expect(panel).toContainText("Known due above is a subtotal");
  state.slow = true; state.unknown = 0; state.count = 0; state.paid = "0.00"; state.due = "0.00";
  await page.getByRole("button", { name: "Supply Two · inactive", exact: true }).click();
  await expect(panel).toContainText("No linked receipts recorded");
  await expect(panel).toContainText("Supplier is inactive");
  await page.getByRole("button", { name: "Supply One", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Loading supplier balance");
  await expect(panel.getByText("NPR 0.00", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Supply Two · inactive", exact: true }).click();
  await expect(panel).toContainText("Supplier is inactive");
  await page.waitForTimeout(500); await expect(panel).toContainText("Supplier is inactive");
  state.fail = true; state.slow = false;
  await page.getByRole("button", { name: "Supply One", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Balance unavailable");
  await expect(panel.getByText("NPR 0.00", { exact: true })).toHaveCount(0);
  state.fail = false; state.count = 1; state.due = "999999999999999999.99";
  await panel.getByRole("button", { name: "Retry balance" }).focus(); await page.keyboard.press("Enter");
  await expect(panel.getByText("NPR 999999999999999999.99", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
