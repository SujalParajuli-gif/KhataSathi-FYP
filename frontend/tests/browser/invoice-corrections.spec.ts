import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role="manager") {
  const actor={id:"correction-actor",name:"Return actor",role};
  await page.addInitScript(actor=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(actor));localStorage.setItem("khatasathi_token","test-session");},actor);
  const invoice={id:"original",invoiceNo:"ORIGINAL-1",status:"FINALIZED",paymentStatus:"PARTIALLY_PAID",createdAt:"2026-10-10T10:00:00Z",finalizedAt:"2026-10-10T10:00:00Z",netTotal:1000,subTotal:1000,paidTotal:400,returnAdjustment:0,customer:{id:"customer",name:"Original customer"},cashier:actor,
    items:[{id:"original-line",productId:"item",qty:10,appliedUnitPrice:100,lineTotal:1000,remainingReturnableQty:10,displayProduct:{name:"Original item",sku:"ORIGINAL-SKU",source:"CAPTURED"}}],payments:[{id:"charge",method:"CASH",kind:"CHARGE",status:"SUCCESS",amount:400}]};
  const state={posts:[] as any[],lost:false,reject:false,failRead:false,rows:[] as any[],reads:0,replacement:null as any};
  await page.route(u=>u.pathname.startsWith("/api/"),async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    const reply=(data:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(data)});
    if(p.endsWith("/auth/me"))return reply({user:actor});
    if(p.endsWith("/capabilities"))return reply({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true,staffDraftRequestsEnabled:true});
    if(p.endsWith("/customers/receivables")){
      state.reads++;if(state.failRead)return reply({error:"Unavailable"},503);
      return reply({items:[{id:"customer",name:"Original customer",isActive:true,due:300,retainedCredit:200,supportedDue:300,supportedCredit:200,unresolvedCount:0,invoices:[{invoiceId:"original",invoiceNo:"ORIGINAL-1",basis:"ORIGINAL_SALE_DEBT_FIRST",reason:null,originalPayable:1000,returnAdjustment:300,recordedReceipts:400,due:300,retainedCredit:0}]},{id:"legacy",name:"Legacy customer",isActive:false,due:null,retainedCredit:null,supportedDue:0,supportedCredit:0,unresolvedCount:1,invoices:[{invoiceId:"legacy-sale",invoiceNo:"LEGACY-1",reason:"Legacy refund is unresolved"}]}],total:2,totalPages:1});
    }
    if(p==="/api/invoices")return reply({invoices:[invoice],total:1});
    if(p==="/api/invoices/original")return reply(invoice);
    if(p==="/api/invoices/replacement")return reply(state.replacement);
    if(p==="/api/invoices/original/modify" || p==="/api/invoices/original/cancel"){
      const body=req.postDataJSON();state.posts.push(body);
      if(state.reject){state.reject=false;return reply({error:"Invoice correction requires settlement review"},409);}
      state.replacement ||= {...invoice,id:"replacement",invoiceNo:"REPLACEMENT-1",netTotal:700,subTotal:700,paidTotal:0,correctionCredit:400,returnAdjustment:0,payments:[]};
      if(state.lost){state.lost=false;return route.abort("failed");}
      return reply(p.endsWith("/modify")?{creditNote:{creditedAmount:400},replacementInvoice:state.replacement}:{...invoice,paymentStatus:"CANCELLED"},p.endsWith("/modify")?201:200);
    }
    if(p.includes("/manual-bills/"))return reply({record:null,proofs:[],history:[]});
    if(p.includes("/returns")){
      if(req.method()==="PATCH"){
        const body=req.postDataJSON();state.posts.push(body);
        const row=state.rows[0];row.status=p.endsWith("/reject")?"REJECTED":"APPROVED";
        row.settlement={version:2,approvedReturnValue:800,debtReduction:600,retainedCredit:200};
        if(state.lost){state.lost=false;return route.abort("failed");}return reply(row);
      }
      if(req.method()==="POST"){
        const body=req.postDataJSON();state.posts.push(body);
        const row={id:"return-one",invoiceId:invoice.id,invoice,status:"PENDING",reason:"CUSTOMER_REQUEST",items:[],settlement:{version:2,approvedReturnValue:0,debtReduction:0,retainedCredit:0},createdAt:new Date().toISOString()};
        if(!state.rows.length)state.rows.push(row);
        if(state.lost){state.lost=false;return route.abort("failed");}return reply(row,201);
      }return reply({requests:state.rows});
    }
    if(p.endsWith("/products"))return reply({products:[],total:0});
    if(p.endsWith("/customers")||p.endsWith("/users"))return reply([]);
    return reply({});
  });return state;
}

async function edit(page: Page) {
  await page.goto("/invoices");
  await page.getByRole("button", { name: "Edit invoice ORIGINAL-1", exact: true }).first().click();
}

for (const width of [1440,390]) test(`lost replacement freezes fields and safely retries original identity at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({width,height:960});
  const state = await setup(page, "admin"); await edit(page);
  await page.getByRole("button", { name: "Modify with Credit Note", exact: true }).click();
  const qty = page.getByRole("spinbutton", { name: "Quantity for Original item" }).first(); await qty.fill("7");
  await page.getByRole("button", { name: "Create Credit Note", exact: true }).click();
  state.lost = true; await page.getByRole("button", { name: "Create Credit Note", exact: true }).last().click();
  await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed"); await expect(qty).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Retry same correction", exact: true })).toHaveCount(2);
  await page.screenshot({path:info.outputPath(`replacement-unknown-${width}.png`),fullPage:true});
  await page.getByRole("button", { name: "Retry same correction", exact: true }).last().click();
  await expect(page.getByText(/Replacement settlement credit:/)).toContainText("NPR 400");
  expect(state.posts).toHaveLength(2); expect(state.posts[0]).toEqual(state.posts[1]);
});

test("lost cancellation retains its original key through Escape and retry", async ({ page }) => {
  const state = await setup(page, "admin"); await edit(page);
  await page.getByRole("button", { name: "Cancel Invoice", exact: true }).click(); state.lost = true;
  await page.getByRole("button", { name: "Cancel Invoice", exact: true }).last().click();
  await expect(page.getByRole("alert")).toContainText("Outcome unconfirmed"); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry same cancellation", exact: true }).click();
  expect(state.posts).toHaveLength(2); expect(state.posts[0]).toEqual(state.posts[1]);
});

test("known replacement rejection preserves inputs and releases identity", async ({ page }) => {
  const state = await setup(page, "admin"); await edit(page); await page.getByRole("button", { name: "Modify with Credit Note", exact: true }).click();
  const qty = page.getByRole("spinbutton", { name: "Quantity for Original item" }).first(); await qty.fill("7");
  await page.getByRole("button", { name: "Create Credit Note", exact: true }).click(); state.reject = true;
  await page.getByRole("button", { name: "Create Credit Note", exact: true }).last().click();
  await expect(page.getByText("Invoice correction requires settlement review", {exact:true})).toBeVisible(); await expect(qty).toBeEnabled(); await expect(qty).toHaveValue("7");
  await qty.fill("6"); await page.getByRole("button", { name: "Create Credit Note", exact: true }).click(); await page.getByRole("button", { name: "Create Credit Note", exact: true }).last().click();
  await expect(page.getByText(/Replacement settlement credit:/)).toBeVisible(); expect(state.posts[0].operationKey).not.toBe(state.posts[1].operationKey);
});

for (const width of [1440,390]) test(`captured correction credit is separate from receipts at ${width}px`, async ({ page },info) => {
  await page.setViewportSize({width,height:960}); await setup(page);
  await page.route("**/api/customers/receivables**",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({items:[{id:"customer",name:"Original customer",isActive:true,due:300,retainedCredit:400,supportedDue:300,supportedCredit:400,unresolvedCount:0,invoices:[{invoiceId:"original",invoiceNo:"ORIGINAL-1",basis:"CAPTURED_CORRECTION",reason:null,originalPayable:1000,returnAdjustment:0,recordedReceipts:1000,due:0,retainedCredit:400,correctionCredit:0,correction:{action:"REPLACE",sourceInvoiceId:"original",targetInvoiceId:"replacement",originalCustomerId:"customer",transferredCredit:600,retainedCredit:400,reason:"Original-sale correction",actorId:"manager",createdAt:"2026-10-10T15:00:00Z"}}]}],total:1,totalPages:1})}));
  await page.goto("/receivables"); await page.locator("summary").focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Successful recorded receipts: NPR 1,000",{exact:true})).toBeVisible(); await expect(page.getByText(/Confirmed payout remains unavailable/)).toBeVisible();
  await expect(page.getByRole("button",{name:/Apply credit/})).toHaveCount(0); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`correction-receivables-${width}.png`),fullPage:true});
});
