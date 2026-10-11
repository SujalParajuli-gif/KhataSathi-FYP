import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role = "manager", correction = false) {
  const actor = { id: "credit-actor", name: "Credit actor", role };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  const state = { posts: [] as any[], lost: false, reject: false, reads: 0, application: null as any, sourceCredit: 200, targetDue: 300 };
  await page.route(u => u.pathname.startsWith("/api/"), async route => {
    const p = new URL(route.request().url()).pathname;
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p.endsWith("/auth/me")) return reply({ user: actor });
    if (p.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (p === "/api/customers/receivables") {
      state.reads++;
      return reply({ items: [{ id: "customer", name: "Original customer", isActive: true, due: state.targetDue, retainedCredit: state.sourceCredit, supportedDue: state.targetDue, supportedCredit: state.sourceCredit, unresolvedCount: 0, invoices: [
        { invoiceId: "source", invoiceNo: "SOURCE-1", basis: "ORIGINAL_SALE_DEBT_FIRST", reason: null, originalPayable: 1000, returnAdjustment: 800, recordedReceipts: 400, due: 0, retainedCredit: state.sourceCredit, usedCredit: 200-state.sourceCredit, appliedCredit: 0, creditSources: [{ ...(correction ? { correctionId: "correction-one" } : { returnId: "return-one" }), retainedCredit: 200, availableCredit: state.sourceCredit }], applications: state.application ? [state.application] : [] },
        { invoiceId: "target", invoiceNo: "TARGET-1", basis: "ORIGINAL_SALE_DEBT_FIRST", reason: null, originalPayable: 300, returnAdjustment: 0, recordedReceipts: 0, due: state.targetDue, retainedCredit: 0, appliedCredit: 300-state.targetDue, applications: [] },
        { invoiceId: "legacy", invoiceNo: "LEGACY-1", basis: "UNRESOLVED", reason: "Legacy settlement unresolved", due: null, retainedCredit: null },
      ] }], total: 1, totalPages: 1 });
    }
    if (p.startsWith("/api/customers/credit-applications")) {
      const body = route.request().postDataJSON(); state.posts.push(body);
      if (state.reject) { state.reject = false; return reply({ error: "Application exceeds this return's available credit" }, 409); }
      if (p.endsWith("/reverse")) {
        state.sourceCredit = 200; state.targetDue = 300;
        state.application = { ...state.application, reversedAt: "2026-10-10T14:00:00Z", reversedById: actor.id, reversalReason: body.reason };
      } else {
        state.sourceCredit = 200-body.amount; state.targetDue = 300-body.amount;
        state.application = { id: "application-one", sourceInvoiceId: "source", sourceInvoiceNo: "SOURCE-1", targetInvoiceId: "target", targetInvoiceNo: "TARGET-1", sourceReturnId: correction ? null : "return-one", sourceCorrectionId: correction ? "correction-one" : null, amount: body.amount, reason: body.reason, actorId: actor.id, createdAt: "2026-10-10T13:00:00Z", reversedAt: null };
      }
      if (state.lost) { state.lost = false; return route.abort("failed"); }
      return reply(state.application, p.endsWith("/reverse") ? 200 : 201);
    }
    return reply({});
  });
  return state;
}
async function open(page: Page, correction = false) {
  await page.goto("/receivables"); await page.locator("summary").first().focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: correction ? "Apply credit from correction correction-one" : "Apply credit from return return-one" }).click();
  await page.getByRole("spinbutton", { name: "Credit amount (NPR)" }).fill("150"); await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Settle customer target sale");
}
for (const width of [1440, 390]) test(`explicit credit application and reversal separate receipts at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 }); const state = await setup(page); await open(page);
  await expect(page.getByRole("combobox", { name: "Target sale" })).toContainText("TARGET-1");
  await page.getByRole("combobox", { name: "Target sale" }).click(); await expect(page.getByRole("option")).toHaveCount(1); await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath(`credit-modal-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Confirm credit application", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Credit applied." })).toContainText("Recorded receipts are unchanged");
  await expect(page.locator("summary")).toContainText("NPR 150"); await expect(page.locator("summary")).toContainText("NPR 50");
  await expect(page.getByText("Successful recorded receipts: NPR 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Applied credit: NPR 150", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reverse credit application to TARGET-1" }).click();
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Correct wrong application"); await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Credit application reversed." })).toContainText("application reversed");
  await expect(page.locator("summary")).toContainText("NPR 300"); await expect(page.locator("summary")).toContainText("NPR 200");
  await expect(page.getByText("Reversal: Correct wrong application")).toBeVisible(); expect(state.posts).toHaveLength(2);
});
test("unknown application and reversal freeze payload and retain exact replay identity", async ({ page }) => {
  const state = await setup(page); await open(page); state.lost = true;
  await page.getByRole("button", { name: "Confirm credit application", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed"); await expect(page.getByRole("spinbutton")).toBeDisabled(); await expect(page.getByRole("combobox", { name: "Target sale" })).toBeDisabled(); await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible(); await page.getByRole("button", { name: "Retry same credit operation" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(state.posts[0]).toEqual(state.posts[1]);
  await page.getByRole("button", { name: "Reverse credit application to TARGET-1" }).click(); await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Correct target"); state.lost = true;
  await page.getByRole("button", { name: "Confirm reversal" }).click(); await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed"); await expect(page.getByRole("textbox", { name: "Reason", exact: true })).toBeDisabled(); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry same credit operation" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(state.posts[2]).toEqual(state.posts[3]);
});
test("known conflict preserves inputs and releases identity for a corrected operation", async ({ page }) => {
  const state = await setup(page); await open(page); state.reject = true;
  await page.getByRole("button", { name: "Confirm credit application", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("available credit");
  await expect(page.getByRole("spinbutton")).toBeEnabled(); await page.getByRole("spinbutton").fill("100"); await page.getByRole("button", { name: "Confirm credit application", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(state.posts[0].operationKey).not.toBe(state.posts[1].operationKey); expect(state.posts[1].reason).toBe(state.posts[0].reason);
});
test("cashier cannot access credit actions or query receivables", async ({ page }) => {
  const state = await setup(page, "cashier"); await page.goto("/receivables"); await expect(page.getByRole("button", { name: /Apply credit/ })).toHaveCount(0); expect(state.reads).toBe(0); expect(state.posts).toHaveLength(0);
});

for (const width of [1440, 390]) test(`correction credit application/reversal and unknown replay at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 }); const state = await setup(page, "manager", true); await open(page, true);
  await expect(page.getByText("Source correction credit available: NPR 200")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`correction-credit-modal-${width}.png`), fullPage: true });
  state.lost = true; await page.getByRole("button", { name: "Confirm credit application", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed"); await expect(page.getByRole("spinbutton")).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Retry same credit operation" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts[0]).toEqual(state.posts[1]); expect(state.posts[0].sourceCorrectionId).toBe("correction-one"); expect(state.posts[0].sourceReturnId).toBeUndefined();
  await expect(page.locator("summary")).toContainText("NPR 50");
  await expect(page.getByText("Successful recorded receipts: NPR 0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reverse credit application to TARGET-1" }).click();
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Restore original correction credit"); state.lost = true;
  await page.getByRole("button", { name: "Confirm reversal" }).click(); await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed");
  await expect(page.getByRole("textbox", { name: "Reason", exact: true })).toBeDisabled(); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry same credit operation" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts[2]).toEqual(state.posts[3]); await expect(page.locator("summary")).toContainText("NPR 200");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
