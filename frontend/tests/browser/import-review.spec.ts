import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`catalog findings are visible first and fit at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const state: any = review();
    state.reviewCounts = { all: 1, attention: 1, edited: 0, missingBrand: 0 };
    Object.assign(state.rows[0], { comparisonStatus: "MATCHED_WITH_CHANGES", resolution: null,
      changeSet: [{ field: "ratePerPiece", currentValue: 90, incomingValue: 100 }], reviewChanges: [] });
    await mockApp(page, state);
    await page.goto("/products/imports/test-batch");
    if (viewport.width < 1280) await page.getByRole("button", { name: /Test bucket/ }).first().click();
    await expect(page.getByText("Matches existing product.", { exact: false })).toBeVisible();
    await expect(page.getByText("Choose a decision", { exact: true })).toBeVisible();
    await expect(page.getByText("User changed", { exact: true })).toHaveCount(0);
    const findings = await page.getByText("Catalog comparison: existing → incoming", { exact: true }).boundingBox();
    const name = await page.getByRole("textbox", { name: "Product name", exact: true }).boundingBox();
    expect(findings!.y).toBeLessThan(name!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`review-${viewport.width}.png`) });
    await page.getByRole("textbox", { name: "Product name", exact: true }).fill("Corrected container");
    await expect(page.getByText("Unsaved changes — save this row", { exact: false })).toBeVisible();
    await expect(page.getByText("Catalog comparison: existing → incoming", { exact: true })).toHaveCount(0);
  });
}

test("identifier findings focus a highlighted correctable field", async ({ page }) => {
  const state: any = review();
  Object.assign(state.rows[0], { comparisonStatus: "IDENTIFIER_CONFLICT", resolution: null,
    error: "Barcode belongs to another product.", reviewIssues: [{ field: "barcode", message: "Barcode belongs to another product.", severity: "error" }] });
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button", { name: "Barcode", exact: true }).click();
  const barcode = page.getByRole("textbox", { name: "Barcode", exact: true });
  await expect(barcode).toBeFocused();
  await expect(barcode).toHaveAttribute("aria-invalid", "true");
});

test("an unchanged existing match is explained without a user-edited tag", async ({ page }) => {
  const state: any = review();
  Object.assign(state.rows[0], { comparisonStatus: "EXACT_DUPLICATE", resolution: "KEEP_EXISTING", reviewChanges: [] });
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await expect(page.getByText("Already in catalog.", { exact: false })).toBeVisible();
  await expect(page.getByText("User changed", { exact: true })).toHaveCount(0);
});

test("review progress is explicit and an unavailable source does not leave an empty panel", async ({ page }) => {
  await mockApp(page, review());
  await page.goto("/products/imports/test-batch");
  const progress = page.getByRole("navigation", { name: "Import progress" });
  await expect(progress.getByText("Upload", { exact: true })).toBeVisible();
  await expect(progress.getByRole("listitem").filter({ hasText: "Review" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("heading", { name: "Source document" })).toHaveCount(0);
  await expect(page.getByText("The original file was not retained", { exact: false })).toBeVisible();
  await expect(page.getByLabel("2 of 2 source pages processed")).toBeVisible();
  await expect(page.getByText("2 / 2 source pages processed.", { exact: true })).toHaveCount(0);
});

test("coverage recovery stays compact and mobile review views survive reload", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state: any = review();
  state.batch.source = { available: true, fileName: "test-catalog.pdf", mimeType: "application/pdf" };
  state.coverage.canReprocessEmpty = true;
  state.coverage.emptyPageNumbers = [2];
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  const recovery = page.getByRole("status").filter({ hasText: "marked empty" });
  await expect(recovery).toBeVisible();
  expect((await recovery.boundingBox())!.height).toBeLessThanOrEqual(48);
  await expect(recovery.getByRole("button", { name: "Recheck" })).toBeVisible();
  await page.goto("/products/imports/test-batch?view=source");
  await expect(page).toHaveURL(/view=source/);
  await expect(page.getByRole("heading", { name: "Document" })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/view=source/);
  await expect(page.getByRole("heading", { name: "Document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom out source" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in source" })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in source" }).click();
  await expect(page.getByRole("link", { name: "Open source in a new tab" })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("source-backed-mobile.png") });
});

test("mobile product list uses page scrolling and keeps pagination reachable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state: any = review();
  state.rows = Array.from({ length: 25 }, (_, index) => ({
    ...structuredClone(row),
    id: `row-${index + 1}`,
    rowNumber: index + 1,
    parsed: { ...structuredClone(row.parsed), name: `Test bucket ${index + 1}`, sku: `TEST-${index + 1}` },
  }));
  state.pagination = { page: 1, pageSize: 25, total: 30, totalPages: 2 };
  state.reviewCounts = { all: 30, attention: 5, edited: 2, missingBrand: 0 };
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch?view=list");

  const rowList = page.locator("[data-import-row-list]");
  await expect(rowList).toBeVisible();
  expect(await rowList.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
  const appScroller = page.locator("[data-app-scroll-container]");
  expect(await appScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator("[data-import-pagination]").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-import-pagination]")).toBeInViewport();
  await expect(page.getByRole("button", { name: /Attention 5/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Edited 2/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-list-page-scroll.png"), fullPage: true });
});

test("source-backed review keeps all three desktop work areas in view", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state: any = review();
  state.batch.source = { available: true, fileName: "test-catalog.pdf", mimeType: "application/pdf" };
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await expect(page.getByRole("heading", { name: "Document" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review item" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search import rows" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("source-backed-desktop.png") });
});

test("catalog search state survives reload through the URL", async ({ page }) => {
  await mockApp(page, review());
  await page.goto("/products?q=bucket&sort=name_asc&pageSize=50");
  const search = page.getByRole("textbox", { name: "Search products" });
  await expect(search).toHaveValue("bucket");
  await page.reload();
  await expect(search).toHaveValue("bucket");
  await expect(page).toHaveURL(/q=bucket/);
  await expect(page).toHaveURL(/sort=name_asc/);
  await expect(page).toHaveURL(/pageSize=50/);
});

test("unfinished imports are resumable from the product catalog", async ({ page }) => {
  const state = review();
  await mockApp(page, state, { batches: [state.batch] });
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: /Imports.*need attention/i })).toBeVisible();
  const showList = page.getByRole("button", { name: /Show list/i });
  if (await showList.isVisible()) {
    await showList.click();
  }
  await page.getByRole("button", { name: /Saved draft: test-catalog\.pdf/ }).click();
  await expect(page).toHaveURL(/\/products\/imports\/test-batch/);
});
const row = {id:"row-1",batchId:"test-batch",rowNumber:1,status:"READY",resolution:"CREATE_NEW",comparisonStatus:"READY_NEW",parsed:{name:"Test bucket",brand:"Test supplier",category:"Buckets",sku:"TEST-1",ratePerPiece:100,retailPrice:null,wholesalePrice:null,availabilityStatus:"CATALOG_LISTED",stock:0}};
function review(status = "DRAFT", incomplete = false) {
  return {batch:{id:"test-batch",sourceType:"PDF",fileName:"test-catalog.pdf",supplier:"Test supplier",status,totalRows:1,createdAt:new Date().toISOString(),source:{available:false}},
    rows:status === "DRAFT" ? [structuredClone(row)] : [],pagination:{page:1,pageSize:50,total:1,totalPages:1},comparisonCounts:{READY_NEW:1},
    decisionCounts:{create:1,update:0,keep:0,ignore:0,unresolved:0,committed:0},priceMapping:{required:false,complete:true,columns:[],mapping:{}},
    coverage:{total:2,visited:2,completed:incomplete ? 1 : 2,partialPages:[],failedPages:incomplete ? [{pageNumber:2,message:"This page could not be read."}] : [],unvisitedPages:[],retryablePages:incomplete ? [2] : [],emptyPageNumbers:[],outcome:incomplete ? "PARTIAL" : "COMPLETE",canRetry:incomplete,canReprocessEmpty:false,requiresAcknowledgement:incomplete}};
}
async function mockApp(page: Page, state: ReturnType<typeof review>, options: {failFirstPoll?:boolean; batches?:unknown[]} = {}) {
  let reads = 0;
  let statusReads = 0;
  let contextReads = 0;
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user",JSON.stringify(value)),user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if (path.endsWith("/status")) { statusReads++; if (options.failFirstPoll && statusReads === 2) return respond({error:"Temporary connection problem"},503); return respond({ batch: state.batch, coverage: state.coverage }); }
    if (path.endsWith("/review")) { reads++; return respond(state); }
    if (path.endsWith("source-context")) { contextReads++; return respond({rows:[],columns:[],sourceType:"PDF"}); }
    if (path.endsWith("/rows") && route.request().method() === "PUT") { state.rows[0].parsed = {...state.rows[0].parsed,...route.request().postDataJSON().rows[0]}; return respond({savedCount:1,rows:state.rows}); }
    if (path.endsWith("/capabilities")) return respond({businessMode:"CATALOG_ONLY",catalogEnabled:true,inventoryEnabled:false,posEnabled:false,stockTracked:false,staffDraftRequestsEnabled:false});
    if (path.endsWith("/auth/me")) return respond({user});
    if (path.endsWith("/brands")) return respond([{id:"brand-1",name:"Test supplier"}, {id:"brand-2",name:"Updated supplier"}]);
    if (path.endsWith("/categories")) return respond(["Buckets"]);
    if (path.endsWith("/alerts")) return respond({alerts:[],unreadCount:0});
    if (path.endsWith("/alerts/read")) return respond({readKeys:[]});
    if (path.endsWith("/products")) return respond({products:[],total:0,page:1,pageSize:50});
    if (path.endsWith("/import-batches")) return respond({batches:options.batches || []});
    if (path.endsWith("/import-templates")) return respond({templates:[]});
    return respond({});
  });
  return { get reads() {return reads;}, get statusReads() {return statusReads;}, get contextReads() {return contextReads;} };
}

test("processing recovers after a polling failure without looping on empty source context", async ({page}) => {
  const state = review("PROCESSING");
  const counters = await mockApp(page,state,{failFirstPoll:true});
  await page.goto("/products/imports/test-batch");
  await expect(page.getByRole("heading", { name: "Extracting products…" })).toBeVisible();
  await expect.poll(() => counters.statusReads,{timeout:15000}).toBeGreaterThanOrEqual(3);
  expect(counters.reads).toBe(1);
  state.batch.status = "DRAFT"; state.rows = [structuredClone(row)];
  await page.getByRole("button", { name: "Review products", exact: true }).click({timeout:10000});
  await expect(page.getByRole("heading",{name:"Review item"})).toBeVisible({timeout:10000});
  expect(counters.contextReads).toBeLessThanOrEqual(3);
});

test("minimized progress stays live and completion does not navigate away", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = review("PROCESSING");
  const counters = await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button", { name: "Work in background" }).click();
  await expect(page).toHaveURL(/\/products$/);
  const task = page.getByRole("complementary", { name: "Import task" });
  await expect(task).toContainText("Extracting products");
  state.batch.status = "DRAFT";
  await expect(task).toContainText("Ready for review", { timeout: 10000 });
  await expect(page).toHaveURL(/\/products$/);
  expect(counters.reads).toBe(1);
  const stoppedAt = counters.statusReads;
  await page.waitForTimeout(3000);
  expect(counters.statusReads).toBe(stoppedAt);
  await page.screenshot({ path: testInfo.outputPath("minimized-import-complete-mobile.png") });
  await page.reload();
  await expect(task).toContainText("Ready for review");
  await task.getByRole("button", { name: "Dismiss import notification" }).click();
  await expect(task).toHaveCount(0);
});

test("stopping asks first and cancelling remains a live state", async ({ page }) => {
  const state = review("PROCESSING");
  await mockApp(page, state);
  let cancellations = 0;
  await page.route("**/api/products/import-batches/test-batch/processing", async (route) => {
    cancellations++;
    state.batch.status = "CANCELLING";
    await route.fulfill({ json: { batch: state.batch } });
  });
  await page.goto("/products/imports/test-batch");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Stop extraction", exact: true }).click();
  expect(cancellations).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop extraction", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stopping extraction…" })).toBeVisible();
  expect(cancellations).toBe(1);
  state.batch.status = "INTERRUPTED";
  await expect(page.getByRole("heading", { name: "Extraction stopped — progress saved" })).toBeVisible({ timeout: 10000 });
});

for (const width of [390, 1440]) {
  test(`product photo actions and preview are keyboard accessible at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApp(page, review());
    await page.goto("/products");
    await page.getByRole("button", { name: "Add Product", exact: true }).click();
    await page.locator("#product-image-dropzone").setInputFiles({
      name: "test.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"),
    });
    await expect(page.getByRole("button", { name: "Change photo", exact: true })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Preview Product preview", exact: true });
    await trigger.click();
    const preview = page.getByRole("dialog", { name: "Image preview for Product preview", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("link", { name: "Full size" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`photo-preview-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "Remove photo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change photo", exact: true })).toHaveCount(0);
  });
}

for (const width of [390, 1440]) {
  test(`documents and history distinguish failed reads from empty results at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApp(page, review());
    let fail = true;
    await page.route("**/api/documents?*", (route) => route.fulfill({
      status: fail ? 503 : 200, json: fail ? { error: "Unavailable" } : { documents: [], total: 0 },
    }));
    await page.goto("/documents");
    await expect(page.getByRole("alert").filter({ hasText: "Documents could not be refreshed" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`documents-error-${width}.png`) });
    fail = false;
    await page.getByRole("button", { name: "Retry documents" }).click();
    await expect(page.getByRole("button", { name: "Retry documents" })).toHaveCount(0);
    fail = true;
    await page.route("**/api/audit/history?*", (route) => route.fulfill({
      status: fail ? 503 : 200, json: fail ? { error: "Unavailable" } : { events: [], total: 0, totalPages: 1 },
    }));
    await page.goto("/history");
    await expect(page.getByRole("alert").filter({ hasText: "History could not be refreshed" })).toBeVisible();
    await expect(page.getByText("No category history found.", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`history-error-${width}.png`) });
    fail = false;
    await page.getByRole("button", { name: "Retry history" }).click();
    await expect(page.getByText("No category history found.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("settings reports failed reads and retries without loading hidden sections", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mockApp(page, review());
  let fail = true;
  const unexpected: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/users" || path.startsWith("/api/backups") || path.startsWith("/api/cash-drawers")) unexpected.push(path);
  });
  await page.route("**/api/settings/business", (route) => route.fulfill({
    status: fail ? 503 : 200, json: fail ? { error: "Unavailable" } : {},
  }));
  await page.goto("/settings");
  await expect(page.getByRole("alert").filter({ hasText: "Some settings could not be loaded" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings-error-mobile.png") });
  fail = false;
  await page.getByRole("button", { name: "Retry settings" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some settings could not be loaded" })).toHaveCount(0);
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("lookup starts before unneeded metadata finishes", async ({ page }) => {
  await mockApp(page, review());
  let releaseBrands!: () => void;
  const brandsGate = new Promise<void>((resolve) => { releaseBrands = resolve; });
  await page.route("**/api/brands**", async (route) => { await brandsGate; await route.fulfill({ json: [] }); });
  let lookupReads = 0;
  await page.route("**/api/products/price-lookup**", async (route) => {
    lookupReads++;
    await route.fulfill({ json: { products: [], total: 0, visibility: { canViewPurchaseCost: false, canViewWholesalePrice: false } } });
  });
  try {
    await page.goto("/product-lookup");
    await expect.poll(() => lookupReads).toBeGreaterThan(0);
  } finally { releaseBrands(); }
});

test("dirty review navigation asks to save and incomplete coverage blocks final confirmation", async ({page}) => {
  await mockApp(page,review("DRAFT",true));
  await page.goto("/products/imports/test-batch");
  const productName = page.getByRole("textbox",{name:"Product name",exact:true});
  await productName.fill("Corrected bucket");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Save before leaving review?"})).toBeVisible();
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(productName).toHaveValue("Corrected bucket");
  await page.getByRole("button",{name:/^Save (?:row|& Next)$/}).click();
  await page.getByRole("button",{name:/final import|commit batch|import saved/i}).filter({visible:true}).first().click();
  const dialog = page.getByRole("dialog",{name:"Confirm final import"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Confirm and import"})).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button",{name:"Confirm and import"})).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("blocked final import leads directly back to unresolved products", async ({ page }) => {
  const state: any = review();
  state.decisionCounts = { create: 0, update: 0, keep: 0, ignore: 0, unresolved: 1, committed: 0 };
  state.reviewCounts = { all: 1, attention: 1, edited: 0, missingBrand: 0 };
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch?q=unrelated");
  await page.getByRole("textbox", { name: "Product name", exact: true }).fill("Unsaved correction");
  await page.getByRole("button", { name: /final import|commit batch|import saved/i }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm final import" });
  await expect(dialog.getByText("Unresolved", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review unresolved products" }).click();
  await expect(dialog).toBeHidden();
  const discard = page.getByRole("dialog", { name: "Unsaved product changes" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/filter=ATTENTION/);
  await expect(page.getByRole("textbox", { name: "Search import rows" })).toHaveValue("");
  await expect(page).not.toHaveURL(/q=/);
});

for (const width of [390, 1440]) {
  test(`source image really shrinks and enlarges at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state: any = review();
    state.batch.sourceType = "IMAGE";
    state.batch.source = { available: true, mimeType: "image/svg+xml" };
    await mockApp(page, state);
    await page.route("**/test-batch/source", (route) => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="820" height="1060"><rect width="820" height="1060" fill="white"/><text x="40" y="80" font-size="32">Catalog source</text></svg>',
    }));
    await page.goto("/products/imports/test-batch?view=source");
    const source = page.getByRole("img", { name: "Supplier catalog source" });
    await expect(source).toBeVisible();
    await expect(page.getByText(/Exact product location is unavailable/)).toBeVisible();
    await expect.poll(() => source.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(820);
    const initial = (await source.boundingBox())!.width;
    await page.getByRole("button", { name: "Zoom out source" }).click();
    await expect.poll(async () => (await source.boundingBox())!.width / initial).toBeCloseTo(0.75, 1);
    if (width >= 640) {
      await page.getByRole("button", { name: "Reset source zoom, currently 75%" }).click();
    } else {
      await page.getByRole("button", { name: "Zoom in source" }).click();
    }
    await page.getByRole("button", { name: "Zoom in source" }).click();
    await expect.poll(async () => (await source.boundingBox())!.width / initial).toBeCloseTo(1.25, 1);
    await page.screenshot({ path: testInfo.outputPath(`image-zoom-${width}.png`) });
  });
}

test("catalog restores page 3 only clamping after a successful response", async ({ page }) => {
  await mockApp(page, review());
  const pages: number[] = [];
  await page.route("**/api/products?*", async (route) => {
    const requested = Number(new URL(route.request().url()).searchParams.get("page"));
    pages.push(requested);
    await route.fulfill({ json: { products: [], total: 100, page: requested, pageSize: 20 } });
  });
  await page.goto("/products?page=3");
  await expect.poll(() => pages.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(/page=3/);
  expect(pages).not.toContain(1);
  await page.reload();
  await expect(page).toHaveURL(/page=3/);
});

for (const path of ["/products", "/products/imports/test-batch"]) {
  test(`query controls follow browser history on ${path}`, async ({ page }) => {
    await mockApp(page, review());
    await page.goto(`${path}?q=bucket`);
    const search = page.getByRole("textbox", { name: path === "/products" ? "Search products" : "Search import rows" });
    await expect(search).toHaveValue("bucket");
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${path}?q=jar`);
    await expect(search).toHaveValue("jar");
    await page.goBack();
    await expect(search).toHaveValue("bucket");
  });
}

for (const width of [390, 1440]) {
test(`bulk drawer reuses modal focus and fetches only the selected page at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const state = review();
  state.pagination.total = 1000;
  state.pagination.totalPages = 20;
  const counters = await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await page.getByRole("checkbox", { name: "Select Test bucket for bulk editing" }).check();
  const trigger = page.getByRole("button", { name: "Bulk edit (1)" });
  const before = counters.reads;
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: /Bulk edit/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  expect(counters.reads).toBe(before);
  await page.keyboard.press("Shift+Tab");
  await expect(drawer.getByRole("button", { name: "Review changes" })).toBeFocused();
  await drawer.getByRole("combobox", { name: "Bulk brand", exact: true }).click();
  await page.getByRole("option", { name: "Updated supplier", exact: true }).click();
  await drawer.getByRole("button", { name: "Review changes" }).click();
  await expect.poll(() => counters.reads).toBe(before + 1);
  const preview = page.getByRole("dialog", { name: "Confirm bulk changes", exact: true });
  await expect(preview.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(preview.getByRole("button", { name: "Confirm 1 changes" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`bulk-drawer-${width}.png`) });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard bulk-edit changes?" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(trigger).toBeFocused();
});
}

test("column mapping contains keyboard focus and returns to its trigger", async ({ page }, testInfo) => {
  const state: any = review();
  state.priceMapping = { required: true, complete: false, columns: [{ key: "price", label: "Price" }], mapping: {} };
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  const trigger = page.getByRole("button", { name: /Map price columns/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "File price column mapping", exact: true });
  await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("column-mapping.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a completed commit is recovered after reload without resubmitting products", async ({page}) => {
  await mockApp(page,review());
  await page.addInitScript(() => sessionStorage.setItem("import-commit:test-batch","saved-attempt-token"));
  let commitPosts = 0;
  await page.route((url) => url.pathname.includes("/commits/"), (route) => route.fulfill({contentType:"application/json",body:JSON.stringify({status:"COMPLETED",result:{createdCount:1,updatedCount:0,keptCount:0,errorCount:0,errors:[]}})}));
  page.on("request",(request) => {if (request.method() === "POST" && request.url().endsWith("/commit")) commitPosts++;});
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button",{name:"Check saved result"}).click();
  await expect(page.getByRole("button",{name:"Check saved result"})).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("import-commit:test-batch"))).toBeNull();
  expect(commitPosts).toBe(0);
});

test("spreadsheet preview uploads multipart data and remains editable after a header error", async ({page}) => {
  await mockApp(page,review());
  let contentType = "";
  await page.route((url) => url.pathname.endsWith("/import-spreadsheet-preview"), async (route) => {
    contentType = route.request().headers()["content-type"] || "";
    const body = route.request().postData() || "";
    const invalidHeader = /name="headerRowNumber"\r\n\r\n50/.test(body);
    return route.fulfill({status:invalidHeader ? 400 : 200,contentType:"application/json",body:JSON.stringify(invalidHeader ? {error:"The selected header has no product rows."} : {sheetName:"Catalog",sheets:["Catalog","Other"],headerRowNumber:1,headers:["Name","Rate"],sample:{Name:"Bucket",Rate:"100"},totalRows:1,warnings:[]})});
  });
  await page.goto("/products");
  await page.getByRole("button",{name:/^(upload_file )?Import$/}).click();
  const dialog = page.getByRole("dialog",{name:"Import Products",exact:true});
  await dialog.locator('input[type="file"]').first().setInputFiles({name:"catalog.csv",mimeType:"text/csv",buffer:Buffer.from("Name,Rate\nBucket,100")});
  await expect(dialog.getByRole("navigation", { name: "Import progress" }).getByRole("listitem").filter({ hasText: "Extract" })).toHaveAttribute("aria-current", "step");
  const header = dialog.getByRole("spinbutton",{name:"Header row"});
  await expect(header).toHaveValue("1");
  expect(contentType).toContain("multipart/form-data; boundary=");
  await header.fill("50");
  await expect(dialog.getByRole("alert")).toContainText("selected header");
  await expect(dialog.getByRole("button",{name:"Review Spreadsheet"})).toBeDisabled();
  await header.fill("1");
  await expect(dialog.getByRole("alert")).toBeHidden();
  await expect(dialog.getByRole("button",{name:"Review Spreadsheet"})).toBeEnabled();
});

for (const width of [390, 1440]) {
  test(`selectors separate manual entry from selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApp(page, review());
    await page.goto("/products/imports/test-batch?view=editor");
    const brand = page.getByRole("combobox", { name: "Product brand", exact: true });
    await brand.click();
    await expect(page.getByRole("option", { name: "Test supplier", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const category = page.getByRole("combobox", { name: "Product category", exact: true });
    await category.click();
    const searchInput = page.getByRole("searchbox", { name: "Search Product category" });
    await searchInput.fill("New category");
    const customOption = page.getByRole("option", { name: /Use “New category”/i });
    await expect(customOption).toBeVisible();
    await customOption.click();
    await expect(category).toContainText("New category");
    await category.click();
    await searchInput.fill("Discard this");
    await page.keyboard.press("Escape");
    await expect(category).toContainText("New category");
    await expect(category).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`selectors-${width}.png`) });
  });
}

test("large brand lists allow explicit search but not manual creation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page, review());
  await page.route((url) => url.pathname.endsWith("/brands"), route => route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.from({ length: 16 }, (_, index) => ({ id: `brand-${index}`, name: `Brand ${index}` }))) }));
  await page.goto("/products/imports/test-batch?view=editor");
  const combobox = page.getByRole("combobox", { name: "Product brand", exact: true });
  await expect(page.getByRole("button", { name: "Enter manually…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search options" })).toHaveCount(0);
  await combobox.click();
  const searchInput = page.getByRole("searchbox", { name: "Search Product brand" });
  await searchInput.fill("Brand 15");
  const option = page.getByRole("option", { name: "Brand 15", exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await expect(combobox).toContainText("Brand 15");
});

test("completed review reports actual outcomes without inventing an import date", async ({ page }) => {
  const state: any = review("IMPORTED");
  state.outcomeCounts = { created: 2, updated: 3, kept: 4, ignored: 1 };
  state.batch.totalRows = 10;
  state.batch.importedRows = 9;
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await expect(page.getByText(/2 created · 3 updated · 4 kept · 1 ignored/)).toBeVisible();
  await expect(page.getByText(/imported on|products from this file are active/)).toHaveCount(0);
});

test("mobile row editing and unsaved-change confirmation stay usable", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await mockApp(page,review());
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button",{name:"Review Test bucket",exact:true}).click();
  await page.getByRole("textbox",{name:"Product name",exact:true}).fill("Mobile correction");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  const dialog = page.getByRole("dialog",{name:"Save before leaving review?"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Cancel"})).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Discard & Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
