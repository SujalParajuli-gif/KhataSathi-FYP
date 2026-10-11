import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, correction = true, hasDrawer = true) {
  const actor = { id: "cash-actor", name: "Cash manager", role: "manager" };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  const state = { posts: [] as any[], lost: false, reject: false, payout: null as any, credit: 400, cashOut: 0, cashIn: 0 };
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const req = route.request(), path = new URL(req.url()).pathname, reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return reply({ user: actor });
    if (path.endsWith("/capabilities")) return reply({ businessMode: "FULL_POS", catalogEnabled: true, inventoryEnabled: true, posEnabled: true, stockTracked: true, staffDraftRequestsEnabled: true });
    if (path === "/api/settings") return reply({ businessMode: "FULL_POS", staffDraftRequestsEnabled: true, currency: "NPR" });
    if (path === "/api/cash-drawers/current") return reply({ drawer: hasDrawer ? { id: "owned-drawer", cashierId: actor.id, status: "OPEN", openingFloat: 1000, cashSalesTotal: 400, cashInTotal: state.cashIn, cashOutTotal: state.cashOut, expectedTotal: 1400-state.cashOut+state.cashIn } : null });
    if (path === "/api/customers/receivables") return reply({ items: [{ id: "customer", name: "Original customer", isActive: true, due: 300, retainedCredit: state.credit, supportedDue: 300, supportedCredit: state.credit, unresolvedCount: 0, invoices: [
      { invoiceId: "source", invoiceNo: "SOURCE-1", basis: correction ? "CAPTURED_CORRECTION" : "ORIGINAL_SALE_DEBT_FIRST", reason: null, originalPayable: 1000, returnAdjustment: correction ? 0 : 1000, recordedReceipts: 400, due: 0, retainedCredit: state.credit, paidOutCredit: 400-state.credit,
        creditSources: [{ ...(correction ? { correctionId: "correction-one" } : { returnId: "return-one" }), retainedCredit: 400, availableCredit: state.credit }], payouts: state.payout ? [state.payout] : [] },
      { invoiceId: "target", invoiceNo: "TARGET-1", basis: "ORIGINAL_SALE_DEBT_FIRST", reason: null, originalPayable: 300, returnAdjustment: 0, recordedReceipts: 0, due: 300, retainedCredit: 0 },
    ] }], total: 1, totalPages: 1 });
    if (path.startsWith("/api/customers/credit-payouts") && req.method() === "POST") {
      const body = req.postDataJSON(); state.posts.push(body);
      if (state.reject) { state.reject = false; return reply({ error: "Select your own open cash drawer" }, 409); }
      if (path.endsWith("/recover")) {
        state.credit = 400; state.cashIn = 150; state.payout = { ...state.payout, recoveredAt: "2026-10-11T07:00:00Z", recoveredById: actor.id, recoveryReason: body.reason, recoveryEventId: "cash-in", recoveryDrawerId: body.drawerId };
      } else {
        state.credit = 400-body.amount; state.cashOut = body.amount; state.payout = { id: "payout-one", sourceInvoiceId: "source", sourceReturnId: correction ? null : "return-one", sourceCorrectionId: correction ? "correction-one" : null, amount: body.amount, reason: body.reason, actorId: actor.id, createdAt: "2026-10-11T06:00:00Z", payoutEventId: "cash-out", drawerId: body.drawerId, recoveredAt: null };
      }
      if (state.lost) { state.lost = false; return route.abort("failed"); }
      return reply(state.payout, path.endsWith("/recover") ? 200 : 201);
    }
    return reply({ items: [], total: 0 });
  }); return state;
}
async function open(page: Page, correction = true) {
  await page.goto("/receivables"); await page.locator("summary").first().focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: correction ? "Confirm cash payout from correction correction-one" : "Confirm cash payout from return return-one" }).click();
  await expect(page.getByText("Your open drawer: owned-drawer")).toBeVisible();
}
for (const width of [1440,390]) for (const correction of [true,false]) test(`confirmed ${correction ? "correction" : "return"} payout/recovery exact retry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 }); const state = await setup(page, correction); await open(page, correction);
  await page.getByRole("spinbutton", { name: "Cash payout amount (NPR)" }).fill("150");
  await page.getByRole("textbox", { name: "Cash reason", exact: true }).fill("Actually paid original customer");
  await page.getByRole("checkbox", { name: "I have actually handed this cash amount to the original customer." }).check();
  await page.getByRole("checkbox", { name: "This is a new payout and has not already been recorded as a manual cash-out." }).check();
  await page.screenshot({ path: info.outputPath(`cash-payout-${width}.png`), fullPage: true });
  state.lost = true; await page.getByRole("button", { name: "Confirm new cash payout", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cash outcome unconfirmed"); await expect(page.getByRole("spinbutton")).toBeDisabled();
  await expect(page.getByRole("checkbox").first()).toBeDisabled(); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Retry same cash operation" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts[0]).toEqual(state.posts[1]); expect(state.posts[0].drawerId).toBe("owned-drawer"); expect(state.posts[0].cashConfirmed).toBe(true); expect(state.posts[0].newPayoutConfirmed).toBe(true);
  expect(state.posts[0][correction ? "sourceCorrectionId" : "sourceReturnId"]).toBe(correction ? "correction-one" : "return-one"); expect(state.posts[0][correction ? "sourceReturnId" : "sourceCorrectionId"]).toBeUndefined();
  await expect(page.locator("summary")).toContainText("NPR 250"); await expect(page.getByText("Successful recorded receipts: NPR 0", { exact: true })).toBeVisible();
  await expect(page.getByText(/Drawer owned-drawer; CASH_OUT cash-out/)).toBeVisible();
  await page.getByRole("button", { name: "Record actual cash recovery" }).click();
  await page.getByRole("textbox", { name: "Cash reason", exact: true }).fill("All cash actually received");
  await page.getByRole("checkbox", { name: "I have actually received the full cash amount from this customer." }).check();
  state.lost = true; await page.getByRole("button", { name: "Confirm actual cash received" }).click();
  await expect(page.getByRole("alert")).toContainText("Cash outcome unconfirmed"); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Retry same cash operation" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.posts[2]).toEqual(state.posts[3]); expect(state.posts[2].cashReceivedConfirmed).toBe(true); expect(state.posts[2].amount).toBeUndefined();
  await expect(page.locator("summary")).toContainText("NPR 400"); await expect(page.getByText(/CASH_IN cash-in/)).toBeVisible(); await expect(page.getByRole("button", { name: "Record actual cash recovery" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("no open drawer withholds confirmation without a cash write", async ({ page }) => {
  const state = await setup(page, true, false); await page.goto("/receivables"); await page.locator("summary").click(); await page.getByRole("button", { name: "Confirm cash payout from correction correction-one" }).click();
  await expect(page.getByRole("alert")).toContainText("Open your own cash drawer"); await expect(page.getByRole("button", { name: "Confirm new cash payout", exact: true })).toBeDisabled(); expect(state.posts).toHaveLength(0);
});
test("known conflict preserves cash confirmation inputs and releases operation identity", async ({ page }) => {
  const state = await setup(page); await open(page); await page.getByRole("spinbutton").fill("150"); await page.getByRole("textbox", { name: "Cash reason", exact: true }).fill("Confirmed cash"); await page.getByRole("checkbox").first().check(); await page.getByRole("checkbox").last().check();
  state.reject = true; await page.getByRole("button", { name: "Confirm new cash payout", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("own open"); await expect(page.getByRole("spinbutton")).toHaveValue("150"); await expect(page.getByRole("spinbutton")).toBeEnabled();
  await page.getByRole("button", { name: "Confirm new cash payout", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(state.posts[0].operationKey).not.toBe(state.posts[1].operationKey);
});
