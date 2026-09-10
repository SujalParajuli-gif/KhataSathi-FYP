import { test, expect, type Page } from "@playwright/test";

const user = { id: "browser-admin", name: "Review admin", role: "admin" };
const row = {id:"row-1",batchId:"test-batch",rowNumber:1,status:"READY",resolution:"CREATE_NEW",comparisonStatus:"READY_NEW",parsed:{name:"Test bucket",brand:"Test supplier",category:"Buckets",sku:"TEST-1",ratePerPiece:100,retailPrice:null,wholesalePrice:null,availabilityStatus:"CATALOG_LISTED",stock:0}};
function review(status = "DRAFT", incomplete = false) {
  return {batch:{id:"test-batch",sourceType:"PDF",fileName:"test-catalog.pdf",supplier:"Test supplier",status,totalRows:1,createdAt:new Date().toISOString(),source:{available:false}},
    rows:status === "DRAFT" ? [structuredClone(row)] : [],pagination:{page:1,pageSize:50,total:1,totalPages:1},comparisonCounts:{READY_NEW:1},
    decisionCounts:{create:1,update:0,keep:0,ignore:0,unresolved:0,committed:0},priceMapping:{required:false,complete:true,columns:[],mapping:{}},
    coverage:{total:2,completed:incomplete ? 1 : 2,failedPages:incomplete ? [{pageNumber:2,message:"This page could not be read."}] : [],requiresAcknowledgement:incomplete}};
}
async function mockApp(page: Page, state: ReturnType<typeof review>, options: {failFirstPoll?:boolean} = {}) {
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
    if (path.endsWith("/import-batches")) return respond({batches:[]});
    if (path.endsWith("/import-templates")) return respond({templates:[]});
    return respond({});
  });
  return { get reads() {return reads;}, get contextReads() {return contextReads;} };
}

test("processing recovers after a polling failure without looping on empty source context", async ({page}) => {
  const state = review("PROCESSING");
  const counters = await mockApp(page,state,{failFirstPoll:true});
  await page.goto("/products/imports/test-batch");
  await expect(page.getByRole("heading",{name:"Preparing import review"})).toBeVisible();
  await expect.poll(() => counters.reads,{timeout:12000}).toBeGreaterThanOrEqual(3);
  state.batch.status = "DRAFT"; state.rows = [structuredClone(row)];
  await expect(page.getByRole("heading",{name:"test-catalog.pdf"})).toBeVisible({timeout:10000});
  expect(counters.contextReads).toBeLessThanOrEqual(3);
});

test("dirty review navigation asks to save and incomplete coverage blocks final confirmation", async ({page}) => {
  await mockApp(page,review("DRAFT",true));
  await page.goto("/products/imports/test-batch");
  const productName = page.getByRole("textbox",{name:"Product name",exact:true});
  await productName.fill("Corrected bucket");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Unsaved row changes"})).toBeVisible();
  await page.getByRole("button",{name:"Keep editing",exact:true}).click();
  await expect(productName).toHaveValue("Corrected bucket");
  await page.getByRole("button",{name:"Save and next",exact:true}).click();
  await page.getByRole("button",{name:/final import|commit batch|import saved/i}).filter({visible:true}).first().click();
  const dialog = page.getByRole("dialog",{name:"Confirm final import"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Confirm and import"})).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button",{name:"Confirm and import"})).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
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
  const header = dialog.getByRole("spinbutton",{name:"Header row"});
  await expect(header).toHaveValue("1");
  expect(contentType).toContain("multipart/form-data; boundary=");
  await header.fill("50");
  await expect(dialog.getByRole("alert")).toContainText("selected header");
  await expect(dialog.getByRole("button",{name:/Import File$/})).toBeDisabled();
  await header.fill("1");
  await expect(dialog.getByRole("alert")).toBeHidden();
  await expect(dialog.getByRole("button",{name:/Import File$/})).toBeEnabled();
});

test("mobile row editing and unsaved-change confirmation stay usable", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await mockApp(page,review());
  await page.goto("/products/imports/test-batch");
  await page.getByRole("button",{name:"Review Test bucket",exact:true}).click();
  await page.getByRole("textbox",{name:"Product name",exact:true}).fill("Mobile correction");
  await page.getByRole("button",{name:"Back to products",exact:true}).click();
  const dialog = page.getByRole("dialog",{name:"Unsaved row changes"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Keep editing"})).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
