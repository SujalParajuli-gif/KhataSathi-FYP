import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, options: { role?: string; pos?: boolean; recordConflict?: boolean; decisionConflict?: "stale" | "terminal" } = {}) {
  const user = { id: "test-user", name: "Test reviewer", role: options.role || "ADMIN" };
  let record: any = { id: "sale", invoiceNo: "INV-TEST-1", status: "FINALIZED", billingChannel: "MANUAL_EXTERNAL",
    externalDocumentType: null, externalBillNo: null, externalBillDate: null, billRecordStatus: "PENDING",
    netTotal: 500, finalizedAt: "2026-10-04T10:00:00Z", cancelledAt: null, paymentStatus: "PAID",
    customerName: null, customerPan: null, originalInvoiceId: null, replacementInvoiceId: null, attachedProofs: [], history: [] };
  let proof: any = { id: "proof", documentType: "SALE_BILL", title: "Paper proof", fileName: "paper.pdf", storedFileName: "paper.pdf",
    storedPath: "documents", mimeType: "application/pdf", fileSize: 20, checksum: null, thumbnailFileName: null,
    thumbnailSize: null, remarks: null, linkedEntityType: null, linkedEntityId: null, visibility: "ADMIN_MANAGER",
    saleRecoveryStatus: "UNRESOLVED", uploadedById: user.id, createdAt: "2026-10-04T10:00:00Z" };
  const unexpected: string[] = [], payloads: any[] = [];
  let recordCalls = 0, attachCalls = 0;
  await page.addInitScript(({ user }) => { localStorage.setItem("khatasathi_auth_user", JSON.stringify(user)); localStorage.setItem("khatasathi_token", "test-session-token"); }, { user });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "GET" && path === "/api/auth/me") return respond({ user });
    if (method === "GET" && path === "/api/alerts") return respond({ alerts: [] });
    if (method === "PATCH" && path === "/api/users/me/presence") return respond({ ok: true });
    if (method === "GET" && path.endsWith("/capabilities")) return respond({ businessMode: options.pos === false ? "CATALOG_ONLY" : "FULL_POS", catalogEnabled: true, inventoryEnabled: options.pos !== false, posEnabled: options.pos !== false, stockTracked: options.pos !== false, staffDraftRequestsEnabled: true });
    if (method === "GET" && path === "/api/invoices/manual-bills/queue") {
      const items = record.billRecordStatus === "PENDING" || record.billRecordStatus === "MISSING" ? [{ ...record, attachedProofCount: 0 }] : [];
      return respond({ items, total: items.length, page: 1, pageSize: 15, totalPages: 1 });
    }
    if (method === "GET" && path === "/api/invoices/manual-bills/sale") return respond(record);
    if (method === "POST" && path === "/api/invoices/manual-bills/sale/reference") {
      recordCalls++; const body = request.postDataJSON(); payloads.push(body);
      if (options.recordConflict && recordCalls === 1) {
        record = { ...record, externalBillNo: "OTHER-PAPER", externalBillDate: "2026-10-04", externalDocumentType: "PAN_INVOICE", billRecordStatus: "RECORDED" };
        return respond({ code: "STALE_RECORD_CONFLICT", error: "Another reviewer recorded this sale", currentRecord: record }, 409);
      }
      record = { ...record, externalBillNo: body.reference.billNo, externalBillDate: body.reference.externalBillDate, externalDocumentType: body.reference.externalDocumentType, billRecordStatus: "RECORDED" };
      return respond(record);
    }
    if (method === "GET" && path === "/api/sales-evidence") {
      const matches = !url.searchParams.get("saleRecoveryStatus") || proof.saleRecoveryStatus === url.searchParams.get("saleRecoveryStatus");
      return respond({ documents: matches ? [proof] : [], total: matches ? 1 : 0, page: 1, pageSize: 20, totalPages: 1 });
    }
    if (method === "GET" && path === "/api/sales-evidence/proof") return respond(proof);
    if (method === "GET" && path === "/api/sales-evidence/proof/candidates") return respond({ candidates: [record] });
    if (method === "GET" && path === "/api/sales-evidence/proof/file") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4 test document" });
    if (method === "POST" && path === "/api/sales-evidence/proof/attach") {
      attachCalls++; const body = request.postDataJSON(); payloads.push(body);
      if (options.decisionConflict && attachCalls === 1) {
        if (options.decisionConflict === "terminal") proof = { ...proof, saleRecoveryStatus: "ARCHIVED" };
        else record = { ...record, billRecordStatus: "RECORDED", externalBillNo: "OTHER-PAPER", externalBillDate: "2026-10-04", externalDocumentType: "PAN_INVOICE" };
        return respond({ code: options.decisionConflict === "terminal" ? "ARCHIVED_CONFLICT" : "STALE_RECORD_CONFLICT", error: "Another reviewer changed this decision", document: options.decisionConflict === "terminal" ? proof : undefined }, 409);
      }
      proof = { ...proof, saleRecoveryStatus: "ATTACHED", linkedEntityType: "Invoice", linkedEntityId: "sale" };
      return respond({ document: proof, invoice: record, replayed: false });
    }
    if (method === "POST" && path === "/api/sales-evidence/proof/archive") {
      payloads.push(request.postDataJSON());
      if (options.decisionConflict === "terminal") {
        proof = { ...proof, saleRecoveryStatus: "ATTACHED", linkedEntityType: "Invoice", linkedEntityId: "sale" };
        return respond({ code: "ATTACHED_CONFLICT", error: "Attached by another reviewer", document: proof }, 409);
      }
      proof = { ...proof, saleRecoveryStatus: "ARCHIVED" }; return respond({ document: proof, replayed: false });
    }
    unexpected.push(`${method} ${path}`); return respond({ error: "Unexpected test request" }, 501);
  });
  return { unexpected, payloads };
}

for (const width of [1440, 390]) {
  test(`record reference with keyboard modal and correct expected payload at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const f = await fixture(page, { role: "CASHIER" });
    await page.goto("/manual-bills"); await expect(page.getByText("INV-TEST-1")).toBeVisible();
    await expect(page.getByRole("button", { name: /Proof & Matching/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Record$/ }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab"); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: /^Record$/ }).click();
    await page.getByPlaceholder("e.g. PB-2081-0042").fill("PAPER-NEW");
    await page.getByRole("button", { name: "Record Reference", exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(f.payloads[0].expected).toEqual({ billingChannel: "MANUAL_EXTERNAL", externalDocumentType: null, externalBillNo: null, externalBillDate: null, billRecordStatus: "PENDING" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(f.unexpected).toEqual([]);
  });
}

test("reference stale conflict keeps input and submits reviewed expected state", async ({ page }) => {
  const f = await fixture(page, { recordConflict: true }); await page.goto("/manual-bills");
  await page.getByRole("button", { name: /^Record$/ }).click(); await page.getByPlaceholder("e.g. PB-2081-0042").fill("MY-PAPER");
  await page.getByRole("button", { name: "Record Reference", exact: true }).click();
  await expect(page.getByText("OTHER-PAPER", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge & Keep My Input" }).click();
  await expect(page.getByPlaceholder("e.g. PB-2081-0042")).toHaveValue("MY-PAPER");
  await page.getByPlaceholder("Reason for modifying this paper reference...").fill("Reviewed correction");
  await page.getByRole("button", { name: "Update Reference" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.payloads[1].expected.externalBillNo).toBe("OTHER-PAPER"); expect(f.payloads[1].reference.billNo).toBe("MY-PAPER"); expect(f.unexpected).toEqual([]);
});

async function evidence(page: Page) { await page.goto("/manual-bills"); await page.getByRole("button", { name: /Proof & Matching/ }).click(); await expect(page.getByText("Paper proof", { exact: true })).toBeVisible(); }
async function attachForm(page: Page) {
  await page.getByRole("button", { name: /^Attach$/ }).click();
  await page.getByRole("button", { name: /INV-TEST-1/ }).click();
  await page.getByPlaceholder("e.g. PB-2081-0042").fill("MY-PAPER");
  await page.getByPlaceholder("Note for attaching this proof...").fill("Reviewed original paper");
}

test("attach stale conflict refreshes candidates, requires selection and preserves reference/reason", async ({ page }) => {
  const f = await fixture(page, { role: "MANAGER", decisionConflict: "stale" }); await evidence(page); await attachForm(page);
  await page.getByRole("button", { name: "Confirm Attachment" }).click();
  await expect(page.getByRole("button", { name: "Confirm Attachment" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh and review outcome" }).click();
  await expect(page.getByText("Review and select the refreshed sale before submitting. Your input has been kept.")).toBeVisible();
  await page.getByRole("button", { name: /INV-TEST-1/ }).click();
  await expect(page.getByPlaceholder("e.g. PB-2081-0042")).toHaveValue("MY-PAPER");
  await expect(page.getByPlaceholder("Note for attaching this proof...")).toHaveValue("Reviewed original paper");
  await page.getByRole("button", { name: "Confirm Attachment" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.payloads[1].expectedInvoice.externalBillNo).toBe("OTHER-PAPER"); expect(f.payloads[1].reference.billNo).toBe("MY-PAPER"); expect(f.unexpected).toEqual([]);
});

for (const action of ["attach", "archive"]) {
  test(`${action} losing terminal conflict shows permitted winner and disables further decision`, async ({ page }) => {
    const f = await fixture(page, { decisionConflict: "terminal" }); await evidence(page);
    if (action === "attach") await attachForm(page);
    else { await page.getByRole("button", { name: /^Archive$/ }).click(); await page.getByPlaceholder(/Reason for archiving/).fill("Not a sale"); }
    const submit = page.getByRole("button", { name: action === "attach" ? "Confirm Attachment" : "Confirm Archive" });
    await submit.click(); await expect(submit).toBeDisabled();
    await page.getByRole("button", { name: "Refresh and review outcome" }).click();
    await expect(page.getByText(`Current outcome: ${action === "attach" ? "ARCHIVED" : "ATTACHED"}`, { exact: false })).toBeVisible();
    if (action === "archive") await expect(submit).toBeDisabled();
    await page.keyboard.press("Escape"); expect(f.unexpected).toEqual([]);
  });
}

test("archive submits nonposting reason and closes after committed response", async ({ page }) => {
  const f = await fixture(page); await evidence(page); await page.getByRole("button", { name: /^Archive$/ }).click();
  await page.getByPlaceholder(/Reason for archiving/).fill("No operational sale"); await page.getByRole("button", { name: "Confirm Archive" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(f.payloads[0]).toEqual({ reason: "No operational sale" }); expect(f.unexpected).toEqual([]);
});

test("proof preview releases authenticated blob URL on close and workspace unmount", async ({ page }) => {
  const f = await fixture(page);
  await page.addInitScript(() => { const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL); (window as any).blobCounts = { created: 0, revoked: 0 }; URL.createObjectURL = blob => { (window as any).blobCounts.created++; return create(blob); }; URL.revokeObjectURL = url => { (window as any).blobCounts.revoked++; revoke(url); }; });
  await evidence(page); await page.getByRole("button", { name: "Preview Paper proof" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).blobCounts.created)).toBe(1);
  await page.keyboard.press("Escape"); await expect.poll(() => page.evaluate(() => (window as any).blobCounts.revoked)).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Preview Paper proof" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).blobCounts.created)).toBe(2);
  // Route change unmounts the workspace with an open preview, as navigation can do.
  await page.getByRole("button", { name: /Recording Queue/ }).dispatchEvent("click");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).blobCounts.revoked)).toBeGreaterThanOrEqual(2); expect(f.unexpected).toEqual([]);
});

for (const options of [{ role: "STAFF" }, { role: "ADMIN", pos: false }]) {
  test(`manual workspace denied for ${options.role} with POS ${options.pos !== false}`, async ({ page }) => {
    const f = await fixture(page, options); await page.goto("/manual-bills");
    await expect(page.getByText("Paper Bill Recording & Review")).toHaveCount(0); expect(f.payloads).toEqual([]);
  });
}
