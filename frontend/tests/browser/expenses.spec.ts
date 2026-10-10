import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role = "manager") {
  const actor = { id: "expense-actor", name: "Manager", role };
  await page.addInitScript(actor => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(actor)); localStorage.setItem("khatasathi_token", "test-session"); }, actor);
  const state = { expense: null as any, revisions: [] as any[], operations: new Map<string, any>(), posts: [] as any[], loseResponse: false, stale: false, slow: false, failList: false, reads: 0 };
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path.endsWith("/auth/me")) return reply({ user: actor });
    if (path.endsWith("/capabilities")) return reply({ businessMode: "CATALOG_ONLY", catalogEnabled: true, inventoryEnabled: false, posEnabled: false, staffDraftRequestsEnabled: false, stockTracked: false });
    if (path.includes("/expenses")) {
      if (req.method() === "POST") {
        const body = req.postDataJSON(); state.posts.push(body);
        if (state.stale) { state.stale = false; state.expense.revision++; state.expense.amount = "77.00"; return reply({ code: "EXPENSE_CONFLICT", error: "Expense changed; reload the current entry before correcting it" }, 409); }
        let result = state.operations.get(body.operationKey);
        if (!result) {
          const action = path.endsWith("/void") ? "VOID" : path.endsWith("/corrections") ? "CORRECT" : "CREATE";
          state.expense = { ...(state.expense || {}), ...(action === "VOID" ? {} : { amount: body.amount, occurredOn: body.occurredOn, category: body.category, description: body.description }), id: "expense-one", revision: (state.expense?.revision || 0) + 1, status: action === "VOID" ? "VOIDED" : "RECORDED", createdAt: "2026-10-10T00:00:00Z" };
          state.revisions.push({ ...state.expense, action, reason: body.reason || null, actor }); result = { expenseId: state.expense.id, revision: state.expense.revision, action }; state.operations.set(body.operationKey, result);
        }
        if (state.loseResponse) { state.loseResponse = false; return route.abort("failed"); }
        return reply({ result }, path.endsWith("/expenses") ? 201 : 200);
      }
      state.reads++;
      if (path.endsWith("/expense-one")) { const detail = { ...state.expense, revisions: [...state.revisions] }; if (state.slow) await new Promise(r => setTimeout(r, 400)); return reply({ expense: detail }); }
      if (state.failList) return reply({ error: "Expense service unavailable" }, 503);
      const matches = state.expense && (url.searchParams.get("status") === "ALL" || state.expense.status === url.searchParams.get("status")) && (state.expense.category + state.expense.description).toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase());
      return reply({ items: matches ? [state.expense] : [], total: matches ? 1 : 0, totalPages: matches ? 1 : 0, page: 1, pageSize: 20 });
    }
    return reply({});
  });
  return state;
}
async function fill(page: Page) {
  await page.getByRole("button", { name: "Record expense", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Amount (NPR)", { exact: true }).fill("10.20");
  await modal.getByLabel("Category", { exact: true }).fill("Utilities");
  await modal.getByLabel("Description", { exact: true }).fill("Electricity receipt " + "detail ".repeat(30));
  await modal.getByRole("button", { name: "Review expense", exact: true }).focus(); await page.keyboard.press("Enter");
  return modal;
}
for (const width of [1440, 360]) test(`expenses retain corrections and void history with keyboard at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const state = await setup(page); await page.goto("/expenses");
  const modal = await fill(page); await expect(modal).toContainText("does not move drawer cash");
  await modal.getByRole("button", { name: "Edit input" }).click(); await expect(modal.getByLabel("Amount (NPR)", { exact: true })).toHaveValue("10.20");
  await modal.getByRole("button", { name: "Review expense" }).click(); await modal.getByRole("button", { name: "Confirm expense", exact: true }).click();
  const detail = page.getByRole("region", { name: "Expense detail", exact: true }); await expect(detail).toContainText("Revision 1");
  await detail.getByRole("button", { name: "Correct expense", exact: true }).click();
  await modal.getByLabel("Amount (NPR)", { exact: true }).fill("20.01"); await modal.getByRole("button", { name: "Review expense" }).click(); await expect(modal.getByRole("alert")).toContainText("reason");
  await modal.getByLabel("Reason", { exact: true }).fill("Corrected receipt amount"); await modal.getByRole("button", { name: "Review expense" }).click(); await modal.getByRole("button", { name: "Confirm correction" }).click();
  await expect(detail).toContainText("Revision 2"); await expect(detail).toContainText("NPR 10.20"); await expect(detail).toContainText("Corrected receipt amount");
  await detail.getByRole("button", { name: "Void expense", exact: true }).click(); await modal.getByLabel("Reason", { exact: true }).fill("Duplicate receipt"); await modal.getByRole("button", { name: "Review expense" }).click(); await modal.getByRole("button", { name: "Confirm void" }).click();
  await expect(detail).toContainText("Revision 3"); await expect(detail).toContainText("VOIDED"); await expect(detail.getByRole("button", { name: "Correct expense" })).toHaveCount(0);
  expect(state.revisions.map(r => r.action)).toEqual(["CREATE", "CORRECT", "VOID"]); expect(state.posts.every(b => typeof b.operationKey === "string")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`expenses-${width}.png`), fullPage: true });
});
test("lost create/correction responses retry exact operations, block Escape/edit and reject stale correction until reload", async ({ page }) => {
  const state = await setup(page); await page.goto("/expenses"); const modal = await fill(page);
  state.loseResponse = true; await modal.getByRole("button", { name: "Confirm expense", exact: true }).click();
  await expect(modal.getByRole("button", { name: "Retry same operation" })).toBeVisible(); await page.keyboard.press("Escape"); await expect(modal).toBeVisible(); await expect(modal.getByRole("button", { name: "Edit input" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Retry same operation" }).click(); expect(state.posts[0]).toEqual(state.posts[1]);
  const detail = page.getByRole("region", { name: "Expense detail" }); await expect(detail).toContainText("Revision 1"); expect(state.revisions.length).toBe(1);
  await detail.getByRole("button", { name: "Correct expense", exact: true }).click(); await modal.getByLabel("Reason", { exact: true }).fill("Correction retry"); await modal.getByLabel("Amount (NPR)", { exact: true }).fill("22.00"); await modal.getByRole("button", { name: "Review expense" }).click();
  state.loseResponse = true; await modal.getByRole("button", { name: "Confirm correction" }).click(); await modal.getByRole("button", { name: "Retry same operation" }).click(); expect(state.posts[2]).toEqual(state.posts[3]); await expect(detail).toContainText("Revision 2"); expect(state.revisions.length).toBe(2);
  await detail.getByRole("button", { name: "Correct expense", exact: true }).click(); await modal.getByLabel("Reason", { exact: true }).fill("Stale correction"); await modal.getByRole("button", { name: "Review expense" }).click(); state.stale = true; await modal.getByRole("button", { name: "Confirm correction" }).click();
  await expect(modal.getByRole("alert")).toContainText("reload"); await expect(modal.getByRole("button", { name: "Confirm correction" })).toBeDisabled(); await modal.getByRole("button", { name: "Reload current expense" }).click(); await expect(detail).toContainText("NPR 77.00");
});
test("expense list errors retry, search clears stale rows; denied roles never request expense records", async ({ page }) => {
  const state = await setup(page); state.failList = true; await page.goto("/expenses"); await expect(page.getByRole("alert")).toContainText("Expense service unavailable"); state.failList = false; await page.getByRole("button", { name: "Retry expenses" }).click(); await expect(page.getByText("No expense records match these filters.")).toBeVisible();
  const modal = await fill(page); await modal.getByRole("button", { name: "Confirm expense" }).click(); await expect(page.getByRole("region", { name: "Expense detail" })).toBeVisible(); await page.getByLabel("Search expenses").fill("unmatched"); await expect(page.getByText("No expense records match these filters.")).toBeVisible();
});
for (const role of ["cashier", "staff"]) test(`${role} cannot navigate to expenses`, async ({ page }) => {
  const state = await setup(page, role); await page.goto("/expenses"); await expect(page.getByRole("heading", { name: "Expenses", exact: true })).toHaveCount(0); await expect.poll(() => new URL(page.url()).pathname).not.toBe("/expenses"); expect(state.reads).toBe(0);
});
