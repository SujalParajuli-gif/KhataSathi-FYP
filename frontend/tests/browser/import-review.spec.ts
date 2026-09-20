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
    await expect(page.getByText("An existing product matches.", { exact: false })).toBeVisible();
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
  await page.getByRole("button", { name: "Check Barcode", exact: true }).click();
  const barcode = page.getByRole("textbox", { name: "Barcode", exact: true });
  await expect(barcode).toBeFocused();
  await expect(barcode).toHaveAttribute("aria-invalid", "true");
});

test("an unchanged existing match is explained without a user-edited tag", async ({ page }) => {
  const state: any = review();
  Object.assign(state.rows[0], { comparisonStatus: "EXACT_DUPLICATE", resolution: "KEEP_EXISTING", reviewChanges: [] });
  await mockApp(page, state);
  await page.goto("/products/imports/test-batch");
  await expect(page.getByText("Already in your catalog.", { exact: false })).toBeVisible();
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
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page).toHaveURL(/view=source/);
  await expect(page.getByRole("heading", { name: "Source document" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Reset source zoom, currently 100%" })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in source" }).click();
  await expect(page.getByRole("button", { name: "Reset source zoom, currently 125%" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open source in a new tab" })).toHaveAttribute("target", "_blank");
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
  await expect(page.getByRole("button", { name: /Needs attention 5/ })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Source document" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Imports that need attention" })).toBeVisible();
  await page.getByRole("button", { name: /Ready to review: test-catalog\.pdf/ }).click();
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
  let contextReads = 0;
  await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user",JSON.stringify(value)),user);
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if (path.endsWith("/review")) { reads++; if (options.failFirstPoll && reads === 2) return respond({error:"Temporary connection problem"},503); return respond(state); }
    if (path.endsWith("source-context")) { contextReads++; return respond({rows:[],columns:[],sourceType:"PDF"}); }
    if (path.endsWith("/rows") && route.request().method() === "PUT") { state.rows[0].parsed = {...state.rows[0].parsed,...route.request().postDataJSON().rows[0]}; return respond({savedCount:1,rows:state.rows}); }
    if (path.endsWith("/capabilities")) return respond({businessMode:"CATALOG_ONLY",catalogEnabled:true,inventoryEnabled:false,posEnabled:false,stockTracked:false,staffDraftRequestsEnabled:false});
    if (path.endsWith("/auth/me")) return respond({user});
    if (path.endsWith("/brands")) return respond([{id:"brand-1",name:"Test supplier"}]);
    if (path.endsWith("/categories")) return respond(["Buckets"]);
    if (path.endsWith("/alerts")) return respond({alerts:[],unreadCount:0});
    if (path.endsWith("/alerts/read")) return respond({readKeys:[]});
    if (path.endsWith("/products")) return respond({products:[],total:0,page:1,pageSize:50});
    if (path.endsWith("/import-batches")) return respond({batches:options.batches || []});
    if (path.endsWith("/import-templates")) return respond({templates:[]});
    return respond({});
  });
  return { get reads() {return reads;}, get contextReads() {return contextReads;} };
}

test("processing recovers after a polling failure without looping on empty source context", async ({page}) => {
  const state = review("PROCESSING");
  const counters = await mockApp(page,state,{failFirstPoll:true});
  await page.goto("/products/imports/test-batch");
  await expect(page.getByRole("status")).toContainText("Extracting Supplier Rate List");
  await expect.poll(() => counters.reads,{timeout:12000}).toBeGreaterThanOrEqual(3);
  state.batch.status = "DRAFT"; state.rows = [structuredClone(row)];
  await expect(page.getByRole("heading",{name:"Review item"})).toBeVisible({timeout:10000});
  expect(counters.contextReads).toBeLessThanOrEqual(3);
});

test("dirty review navigation asks to save and incomplete coverage blocks final confirmation", async ({page}) => {
  await mockApp(page,review("DRAFT",true));
  await page.goto("/products/imports/test-batch");
  const productName = page.getByRole("textbox",{name:"Product name",exact:true});
  await productName.fill("Corrected bucket");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Unsaved product changes"})).toBeVisible();
  await page.getByRole("button",{name:"Keep Editing",exact:true}).click();
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
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button", { name: /final import|commit batch|import saved/i }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Confirm final import" });
  await expect(dialog.getByText("Unresolved", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review unresolved products" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/filter=ATTENTION/);
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
  const dialog = page.getByRole("dialog",{name:"Import Products from Spreadsheet, PDF, or Image"});
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

test("mobile row editing and unsaved-change confirmation stay usable", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await mockApp(page,review());
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button",{name:"Review Test bucket",exact:true}).click();
  await page.getByRole("textbox",{name:"Product name",exact:true}).fill("Mobile correction");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  const dialog = page.getByRole("dialog",{name:"Unsaved product changes"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Keep editing"})).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
