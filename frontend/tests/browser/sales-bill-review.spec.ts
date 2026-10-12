import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role = "manager") {
  const actor = { id: "reviewer", name: "Reviewer", role }, document = { id: "source", fileName: "sale.png", title: "Retained sales proof", mimeType: "image/png", saleRecoveryStatus: "UNRESOLVED", uploadedBy: actor, createdAt: "2026-10-12T02:00:00Z" };
  const observations = { billNumber: "BILL-12", customerName: null, billDate: null, total: "20.00", lines: [{ name: "Rice", code: "R1", unit: "PIECE", quantity: null, unitPrice: "10.00" }] };
  const state: any = { review: null, document, failSave: false, writes: 0, postingRequests: 0 };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  await page.route(u => u.pathname.startsWith("/api/"), async route => {
    const p = new URL(route.request().url()).pathname, method = route.request().method();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && p !== "/api/users/me/presence" && !p.endsWith("/review") && !p.endsWith("/extract")) state.postingRequests++;
    const reply = (data: any, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p.endsWith("/auth/me")) return reply({ user: actor });
    if (p.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true });
    if (p === "/api/sales-evidence") return reply({ documents: [document], total: 1 });
    if (p.endsWith("/source/file")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=", "base64") });
    if (p.endsWith("/source/extract")) return reply({ error: "Bill reading is not configured. Manual review remains available." }, 503);
    if (p.endsWith("/source/review")) {
      if (method === "PATCH") {
        if (state.failSave) return reply({ error: "Review changed. Your edits are retained; reload before saving." }, 409);
        state.writes++; state.review = { revision: `revision-${state.writes}`, model: "MANUAL", observations, corrected: route.request().postDataJSON().corrected };
      }
      return reply({ document, review: state.review });
    }
    if (p.endsWith("/source/review-matches")) return reply({ searched: !!state.review, limit: 20, warning: "Bounded suggestions cannot establish that a sale is missing.",
      products: [{ id: "rice-A", name: "Rice A", sku: "R1", saleUnit: "PIECE", packageUnit: "BAG", packageQuantity: 10, brand: { name: "Local" } }, { id: "rice-B", name: "Rice B", sku: "R2", saleUnit: "PIECE", packageUnit: "BAG", packageQuantity: 20, brand: { name: "Local" } }],
      duplicates: [{ id: "duplicate", fileName: "duplicate.png", saleRecoveryStatus: "ATTACHED", linkedEntityId: "cancelled" }],
      candidates: [{ id: "cancelled", invoiceNo: "INV-CANCELLED", netTotal: 20, eligible: false, warning: "Cancelled or replaced sale; do not attach.", differences: ["Printed reference differs"], customerName: "Sita", externalBillNo: "BILL-12", externalBillDate: null },
        { id: "candidate", invoiceNo: "INV-CANDIDATE", netTotal: 21, eligible: true, warning: "Candidate only; compare source before attaching.", differences: ["Printed total differs from invoice net total"], customerName: "Sita", externalBillNo: "BILL-12", externalBillDate: null }] });
    if (p.endsWith("/source/candidates")) return reply({ candidates: [] });
    if (p.endsWith("/source/recovery")) return reply({ status: "UNPREPARED", document, invoice: null, retryEligible: false });
    return reply({ items: [], invoices: [], products: [], customers: [], total: 0, alerts: [] });
  });
  await page.goto("/manual-bills?tab=evidence"); await page.getByRole("button", { name: "Review bill and matches" }).click();
  await expect(page.getByRole("heading", { name: "Human corrections" })).toBeVisible();
  return state;
}

for (const width of [1440, 390]) {
  test(`manual source review preserves errors and explicit product/match decisions at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); const state = await setup(page);
    await expect(page.getByRole("img", { name: "Retained sales bill source" })).toBeVisible();
    await page.getByRole("button", { name: "Read bill with OCR" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Manual review remains available" })).toBeVisible();
    await page.getByLabel("Printed bill reference", { exact: true }).fill("BILL-12");
    await page.getByLabel("Printed total (NPR)", { exact: true }).fill("20.00");
    await page.getByRole("button", { name: "Add printed line manually" }).click();
    await page.getByLabel("Printed item name line 1").fill("Rice");
    await page.getByLabel("Printed item code line 1").fill("R1");
    await expect(page.getByText("Unresolved; no product is selected", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Find product for line 1" }).click();
    await page.getByRole("button", { name: /Rice A · R1/ }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByText("Chosen product: rice-A", { exact: true })).toBeVisible();
    state.failSave = true; await page.getByRole("button", { name: "Save human corrections" }).click();
    await expect(page.getByLabel("Printed bill reference", { exact: true })).toHaveValue("BILL-12");
    await expect(page.getByRole("alert").filter({ hasText: "Review changed" })).toBeVisible();
    await page.getByRole("button", { name: "Refresh saved review and outcome" }).click();
    await page.getByRole("button", { name: "Keep my entered edits" }).click(); state.failSave = false;
    await page.getByRole("button", { name: "Save human corrections" }).click(); await expect(page.getByRole("status").filter({ hasText: "Human corrections saved" })).toBeVisible();
    expect(state.writes).toBe(1); expect(state.review.observations.lines[0].quantity).toBeNull(); expect(state.review.corrected.lines[0].productId).toBe("rice-A");
    await page.getByRole("button", { name: "Compare saved review with sales" }).click();
    await expect(page.getByText(/Possible duplicate source: duplicate.png/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Review attachment to INV-CANCELLED" })).toBeDisabled();
    await expect(page.getByText("Printed total differs from invoice net total", { exact: true })).toBeVisible();
    const overflow = await page.locator('[role="dialog"]').evaluate(el => el.scrollWidth > el.clientWidth + 1); expect(overflow).toBe(false);
    await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Review attachment to INV-CANDIDATE" }).click();
    await expect(page.getByText("INV-CANDIDATE", { exact: true }).first()).toBeVisible();
    expect(state.writes, "candidate handoff never calls attach or checkout").toBe(1);
  });
}

test("administrator review keeps manager-only missing-sale checkout disabled and terminal review retained", async ({ page }) => {
  const state = await setup(page, "admin");
  await page.getByLabel("Printed bill reference", { exact: true }).fill("BILL-12");
  await page.getByRole("button", { name: "Save human corrections" }).click();
  await page.getByRole("button", { name: "Compare saved review with sales" }).click();
  await expect(page.getByRole("button", { name: "Review missing-sale checkout (manager)" })).toBeDisabled();
  await expect(page.getByText("A manager must perform missing-sale checkout.", { exact: false })).toBeVisible();
  expect(state.writes).toBe(1);
  state.document.saleRecoveryStatus = "ARCHIVED";
  await page.getByRole("button", { name: "Refresh saved review and outcome" }).click();
  await expect(page.getByText(/Current source outcome: ARCHIVED/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save human corrections" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review archive without posting" })).toBeDisabled();
  await expect(page.getByRole("img", { name: "Retained sales bill source" })).toBeVisible();
});

test("saved human review opens protected checkout and reasoned archive without posting", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Printed bill reference", { exact: true }).fill("BILL-12");
  await page.getByLabel("Printed total (NPR)", { exact: true }).fill("20.00");
  await page.getByRole("button", { name: "Save human corrections" }).click();
  await page.getByRole("button", { name: "Compare saved review with sales" }).click();
  await page.getByRole("button", { name: "Review missing-sale checkout (manager)" }).click();
  await expect(page.getByRole("heading", { name: "Saved human review for comparison" })).toBeVisible();
  await expect(page.getByText("Printed customer: Unknown · Printed total: NPR 20.00.", { exact: true })).toBeVisible();
  await expect(page.locator('input[value="BILL-12"]')).toBeVisible();
  await expect(page.getByText("0 product(s) added", { exact: true })).toBeVisible();
  expect(state.postingRequests).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Review bill and matches" }).click();
  await page.getByRole("button", { name: "Compare saved review with sales" }).click();
  await page.getByRole("button", { name: "Review archive without posting" }).click();
  await expect(page.getByRole("dialog", { name: "Archive Sales Evidence" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Archive" })).toBeDisabled();
  expect(state.postingRequests).toBe(0);
});
