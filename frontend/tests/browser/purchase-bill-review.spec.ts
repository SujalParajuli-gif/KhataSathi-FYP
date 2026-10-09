import { expect, test } from "@playwright/test";
const observed = { supplierName: "Himalayan Supply", billNumber: "B-25", billDate: null, payable: null, lines: [{ name: "Rice", code: "wrong-code", unit: "BOX?", quantity: null, cost: "10" }] };
async function setup(page: any, role = "manager", inventoryEnabled = true, fileMode: "image" | "pdf" | "missing" | "delayed" = "image") {
  const financial: string[] = []; const reads: any[] = []; const saves: any[] = [];
  const files: { url: string }[] = [];
  let releaseFile: (() => Promise<void>) | undefined;
  let review: any = null; let conflict = false; let loseRead = true;
  const response = () => ({ document: { id: "doc1", title: "Supplier paper bill", mimeType: fileMode === "pdf" ? "application/pdf" : "image/png", fileUrl: "/api/documents/doc1/file" }, review });
  await page.addInitScript(() => {
    const state = { created: [] as string[], revoked: [] as string[], credentials: [] as boolean[] };
    (window as any).previewUrls = state;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) { state.credentials.push(this.withCredentials); return send.call(this, body); };
  });
  await page.addInitScript((r: string) => { localStorage.setItem("khatasathi_auth_user", JSON.stringify({ id: "test-user", name: "Reviewer", role: r })); localStorage.setItem("khatasathi_token", "test-session"); }, role);
  await page.route((url: URL) => url.pathname.startsWith("/api/"), async (route: any) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname;
    const reply = (data: any, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (req.method() !== "GET" && /\/purchases(?:\/|$)|\/installments|\/attachments/.test(p)) financial.push(p);
    if (p.endsWith("/auth/me")) return reply({ user: { id: "test-user", role, name: "Reviewer" } });
    if (p.endsWith("/capabilities")) return reply({ inventoryEnabled, posEnabled: true, catalogEnabled: true, businessMode: "FULL_POS" });
    if (p.endsWith("/documents/doc1/file")) {
      files.push({ url: req.url() });
      if (fileMode === "missing") return reply({ error: "Document file is unavailable" }, 404);
      if (fileMode === "pdf") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" });
      const fulfill = () => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="450"><rect width="500" height="450" fill="white"/><text x="30" y="50" font-size="22">Himalayan Supply</text><text x="30" y="100">Bill B-25</text><text x="30" y="160">Rice | 2 BOX | 10.00</text><text x="30" y="240">Total 20.00</text></svg>' });
      if (fileMode === "delayed") { releaseFile = fulfill; return; }
      return fulfill();
    }
    if (p.endsWith("/documents")) return reply({ documents: [{ id: "doc1", title: "Supplier paper bill", documentType: "PURCHASE_BILL", linkedEntityId: null }], totalPages: 1 });
    if (p.endsWith("/candidates")) return reply({ items: u.searchParams.get("kind") === "supplier" ? [{ id: "s1", name: "Himalayan Supply" }, { id: "s2", name: "Himalayan Supply West" }] : [{ id: "p1", name: "Rice", sku: "RICE-1", saleUnit: "PIECE", packageUnit: "BOX", packageQuantity: 2 }] });
    if (p.endsWith("/duplicates")) return reply({ items: [{ id: "legacy", billNumber: "B-25", supplierName: "Old supplier text", knownPayable: false, reason: "Same bill reference; identity requires human review" }] });
    if (p.endsWith("/extract")) {
      const body = req.postDataJSON(); reads.push(body);
      review ||= { revision: "11111111-1111-4111-8111-111111111111", extractionId: "22222222-2222-4222-8222-222222222222", operationKey: body.operationKey, observations: observed, corrected: null, warnings: ["Payable not read", "Line 1 quantity not read", "Bill date is unknown"], model: "test-reader", extractedAt: "2026-10-09T12:00:00Z" };
      if (loseRead) { loseRead = false; return route.abort("failed"); } return reply(response());
    }
    if (p.endsWith("/review")) {
      if (req.method() === "PATCH") { const body = req.postDataJSON(); saves.push(body); if (conflict) return reply({ error: "Review changed. Your edits are preserved; reload before saving." }, 409); review = { ...review, revision: "33333333-3333-4333-8333-333333333333", corrected: body.corrected }; }
      return reply(response());
    }
    if (p.endsWith("/suppliers")) return reply({ suppliers: [], totalPages: 1 });
    if (p.endsWith("/purchases")) return reply({ items: [], totalPages: 1, total: 0 });
    return reply({});
  });
  return { financial, reads, saves, files, releaseFile: () => releaseFile!(), setConflict: () => { conflict = true; } };
}

for (const width of [1440, 360]) test(`purchase scan correction/save/reopen preserves uncertainty and never posts at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const s = await setup(page);
  await page.goto("/purchases"); await page.getByRole("button", { name: "Review bill scan" }).click();
  await page.getByLabel("Supplier paper bill", { exact: true }).check(); await page.getByRole("button", { name: "Read bill", exact: true }).click();
  const preview = page.getByRole("img", { name: "Purchase bill source" });
  await expect(preview).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(500);
  expect(new URL(s.files[0].url).origin).not.toBe(new URL(page.url()).origin);
  expect(await page.evaluate(() => (window as any).previewUrls.credentials.every(Boolean))).toBe(true);
  await expect(page.getByRole("button", { name: "Retry same read" })).toBeEnabled(); await page.getByRole("button", { name: "Retry same read" }).click();
  await expect(page.getByLabel("Reviewed payable")).toHaveValue(""); expect(s.reads[0]).toEqual(s.reads[1]);
  await expect(page.getByText("Payable not read", { exact: true })).toBeVisible(); await expect(page.getByText(/legacy financial authority unknown/)).toBeVisible();
  await page.getByLabel("Reviewed line 1 code").fill(""); await page.getByLabel("Reviewed line 1 quantity").fill("2"); await page.getByLabel("Reviewed line 1 unit").fill("BOX"); await page.getByLabel("Reviewed payable").fill("20.00");
  await page.getByRole("combobox", { name: "Choose supplier" }).click(); await page.getByRole("option", { name: "Himalayan Supply", exact: true }).click();
  await page.getByRole("combobox", { name: "Choose product" }).click(); await page.getByRole("option", { name: /Rice.*RICE-1/ }).click();
  await expect(page.getByText(/Catalog unit: PIECE/)).toBeVisible();
  await page.getByRole("button", { name: "Save review", exact: true }).click(); await expect(page.getByText("Review saved. No stock, payment or receipt was posted.")).toBeVisible();
  expect(s.saves[0].corrected.supplierId).toBe("s1"); expect(s.saves[0].corrected.lines[0].productId).toBe("p1"); expect(s.saves[0].corrected.lines[0].quantity).toBe("2"); expect(s.saves[0].corrected.billDate).toBeNull();
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click(); await page.getByRole("button", { name: "Review bill scan" }).click(); await page.getByLabel("Supplier paper bill", { exact: true }).check(); await expect(page.getByLabel("Reviewed payable")).toHaveValue("20.00");
  s.setConflict(); await page.getByLabel("Reviewed payable").fill("21.00"); await page.getByRole("button", { name: "Save review", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("Review changed"); await expect(page.getByLabel("Reviewed payable")).toHaveValue("21.00");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Review purchase bill" })).toHaveCount(0); expect(s.financial).toEqual([]);
  const urls = await page.evaluate(() => (window as any).previewUrls);
  expect(urls.created.length).toBeGreaterThan(0); expect(urls.revoked.sort()).toEqual(urls.created.sort());
});

for (const mode of ["pdf", "missing", "delayed"] as const) test(`protected purchase source ${mode} handles preview lifecycle without posting`, async ({ page }) => {
  const s = await setup(page, "manager", true, mode);
  await page.goto("/purchases"); await page.getByRole("button", { name: "Review bill scan" }).click();
  await page.getByLabel("Supplier paper bill", { exact: true }).check();
  if (mode === "pdf") {
    await expect(page.locator('iframe[title="Purchase bill source"]')).toHaveAttribute("src", /^blob:/);
  } else if (mode === "missing") {
    await expect(page.getByRole("alert")).toContainText("Source preview: Document file is unavailable");
    await expect(page.getByRole("img", { name: "Purchase bill source" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry source preview" })).toBeVisible();
  } else {
    await expect.poll(() => s.files.length).toBe(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await s.releaseFile();
    await expect(page.getByRole("dialog", { name: "Review purchase bill" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).previewUrls.created)).toEqual([]);
  }
  expect(await page.evaluate(() => (window as any).previewUrls.credentials.every(Boolean))).toBe(true);
  expect(new URL(s.files[0].url).origin).not.toBe(new URL(page.url()).origin);
  expect(s.reads).toEqual([]); expect(s.financial).toEqual([]);
});

for (const [role, inventory] of [["cashier", true], ["manager", false]] as const) test(`purchase scan review denied for ${role} inventory=${inventory}`, async ({ page }) => {
  const s = await setup(page, role, inventory); await page.goto("/purchases"); await expect(page).not.toHaveURL(/\/purchases$/); await expect(page.getByRole("button", { name: "Review bill scan" })).toHaveCount(0); expect(s.reads).toEqual([]); expect(s.saves).toEqual([]);
});
