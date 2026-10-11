import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, role="manager") {
  const actor={id:"return-actor",name:"Return actor",role};
  await page.addInitScript(actor=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(actor));localStorage.setItem("khatasathi_token","test-session");},actor);
  const invoice={id:"original",invoiceNo:"ORIGINAL-1",status:"FINALIZED",paymentStatus:"PARTIALLY_PAID",createdAt:"2026-10-10T10:00:00Z",finalizedAt:"2026-10-10T10:00:00Z",netTotal:1000,subTotal:1000,paidTotal:400,returnAdjustment:0,customer:{id:"customer",name:"Original customer"},cashier:actor,
    items:[{id:"original-line",productId:"item",qty:10,appliedUnitPrice:100,lineTotal:1000,remainingReturnableQty:10,displayProduct:{name:"Original item",sku:"ORIGINAL-SKU",source:"CAPTURED"}}],payments:[{id:"charge",method:"CASH",kind:"CHARGE",status:"SUCCESS",amount:400}]};
  const state={posts:[] as any[],lost:false,failRead:false,failReturns:false,rejectReview:false,rows:[] as any[],reads:0,returnReads:0,adminReads:[] as string[],reviewPaths:[] as string[]};
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
    if(p.includes("/manual-bills/"))return reply({record:null,proofs:[],history:[]});
    if(p.includes("/returns")){
      if(req.method()==="PATCH"){
        const body=req.postDataJSON();state.posts.push(body);state.reviewPaths.push(p);
        if(state.rejectReview){state.rejectReview=false;return reply({error:"Return settlement requires reconciliation"},409);}
        const row=state.rows.find(row=>p.includes("/"+row.id+"/"));row.status=p.endsWith("/reject")?"REJECTED":p.endsWith("/reverse")?"REVERSED":"APPROVED";
        row.settlement={version:2,approvedReturnValue:800,debtReduction:600,retainedCredit:200};
        if(state.lost){state.lost=false;return route.abort("failed");}return reply(row);
      }
      if(req.method()==="POST"){
        const body=req.postDataJSON();state.posts.push(body);
        const row={id:"return-one",invoiceId:invoice.id,invoice,status:"PENDING",reason:"CUSTOMER_REQUEST",items:[],settlement:{version:2,approvedReturnValue:0,debtReduction:0,retainedCredit:0},createdAt:new Date().toISOString()};
        if(!state.rows.length)state.rows.push(row);
        if(state.lost){state.lost=false;return route.abort("failed");}return reply(row,201);
      }state.returnReads++;if(state.failReturns)return reply({error:"Return list unavailable"},503);
      return reply({requests:state.rows.filter(row=>!url.searchParams.get("status")||row.status===url.searchParams.get("status"))});
    }
    if(p.endsWith("/products"))return reply({products:[],total:0});
    if(p.endsWith("/users")||p.endsWith("/invoices/parked"))state.adminReads.push(p);
    if(p.endsWith("/customers")||p.endsWith("/users"))return reply([]);
    return reply({});
  });return state;
}

for(const width of [1440,390])test(`receivables keep due, credit and unresolved sources separate at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:960});await setup(page);await page.goto("/receivables");
  await expect(page.getByRole("heading",{name:"Customer receivables",exact:true})).toBeVisible();
  await expect(page.locator("summary").first()).toContainText("NPR 300");await expect(page.locator("summary").first()).toContainText("NPR 200");
  await page.locator("summary").first().focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("link",{name:"ORIGINAL-1"})).toHaveAttribute("href","/invoices?invoiceId=original");
  await page.locator("summary").nth(1).click();await expect(page.getByText("Legacy refund is unresolved. Due and credit withheld.")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width===390)await expect(page.getByText("1–2 of 2",{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath(`receivables-${width}.png`),fullPage:true});
});
test("receivables loading failure retries",async({page})=>{
  const state=await setup(page);state.failRead=true;await page.goto("/receivables");await expect(page.getByRole("alert")).toContainText("could not be loaded");
  state.failRead=false;await page.getByRole("button",{name:"Retry balances"}).click();await expect(page.locator("summary")).toHaveCount(2);expect(state.reads).toBe(2);
});
test("cashier cannot query the manager receivables screen",async({page})=>{
  const state=await setup(page,"cashier");await page.goto("/receivables");await expect(page.getByRole("heading",{name:"Customer receivables",exact:true})).toHaveCount(0);expect(state.reads).toBe(0);
});
for(const hub of [false,true])test(`lost approval retains exact decision on ${hub?"requests hub":"invoice review"}`,async({page})=>{
  const state=await setup(page,"manager");state.rows.push({id:"return-one",status:"PENDING",reason:"CUSTOMER_REQUEST",invoice:{id:"original",invoiceNo:"ORIGINAL-1",customer:{name:"Original customer"}},items:[],settlement:{version:2,approvedReturnValue:0,debtReduction:0,retainedCredit:0}});
  await page.goto(hub?"/requests":"/invoices");if(!hub)await page.getByRole("button",{name:"Return requests",exact:true}).click();
  state.lost=true;await page.getByRole("button",{name:"Approve",exact:true}).click();
  if(!hub)await page.getByRole("button",{name:"Approve Return",exact:true}).click();
  await expect(page.getByText(/Outcome unconfirmed/).first()).toBeVisible();await page.keyboard.press("Escape");
  await page.getByRole("button",{name:hub?"Retry same approval":"Retry same decision",exact:true}).click();
  expect(state.posts).toHaveLength(2);expect(state.posts[0]).toEqual(state.posts[1]);
});
test("lost return creation blocks edit and Escape then retries the identical key and payload",async({page})=>{
  const state=await setup(page);await page.goto("/invoices?invoiceId=original");
  await page.getByRole("button",{name:"Return Items",exact:true}).click();
  const qty=page.getByRole("spinbutton",{name:"Return quantity for Original item"});await qty.fill("3");
  state.lost=true;await page.getByRole("button",{name:"Submit Return",exact:true}).click();
  await expect(page.getByRole("button",{name:"Retry same return"})).toBeVisible();await expect(qty).toBeDisabled();await page.keyboard.press("Escape");
  await expect(page.getByRole("button",{name:"Retry same return"})).toBeVisible();await page.getByRole("button",{name:"Retry same return"}).click();
  await expect(page.getByRole("button",{name:"Retry same return"})).toHaveCount(0);expect(state.posts).toHaveLength(2);expect(state.posts[0]).toEqual(state.posts[1]);expect(state.rows).toHaveLength(1);
});

function reviewRow(id: string) {
  return {id,status:"PENDING",reason:"CUSTOMER_REQUEST",createdAt:"2026-10-11T08:00:00Z",createdBy:{name:"Cashier"},invoice:{id:"original",invoiceNo:"ORIGINAL-1",customer:{name:"Original customer"},cashier:{name:"Cashier"}},items:[{id:"return-line",qtyReturned:8,unitPrice:100,lineTotal:800,displayProduct:{name:"Original item",sku:"ORIGINAL-SKU",source:"CAPTURED"}}],settlement:{version:2,approvedReturnValue:0,debtReduction:0,retainedCredit:0}};
}

for(const role of ["admin","manager"])for(const width of [1440,390])test(`${role} reviews returns without unrelated grants at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:960});const state=await setup(page,role);state.rows.push(reviewRow("approve-one"),reviewRow("reject-one"));await page.goto("/invoices");
  await expect.poll(()=>state.returnReads).toBeGreaterThan(0);
  if(role==="manager")expect(state.adminReads).toEqual([]);
  const open=page.getByRole("button",{name:"Return requests",exact:true});await open.focus();await page.keyboard.press("Enter");
  await expect(page.getByText("Pending requests",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Approve",exact:true}).first().click();await page.getByRole("button",{name:"Approve Return",exact:true}).click();
  await expect.poll(()=>state.rows[0].status).toBe("APPROVED");await expect(page.getByRole("button",{name:"Approve",exact:true})).toHaveCount(1);
  await page.getByRole("button",{name:"Reject",exact:true}).click();await page.getByRole("button",{name:"Reject Return",exact:true}).click();
  await expect(page.getByText("No pending return requests.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Approved",exact:true}).click();await expect(page.getByText(/Debt first; no payout/)).toContainText("held credit NPR 200");
  await page.screenshot({path:info.outputPath(`${role}-return-review-${width}.png`),fullPage:true});
  await page.getByRole("button",{name:"Reverse",exact:true}).click();await page.getByRole("button",{name:"Reverse Return",exact:true}).click();
  await expect(page.getByText("No approved return requests.",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Reversed",exact:true}).click();await expect(page.getByText(/held credit NPR 200 \(withdrawn\)/)).toBeVisible();
  expect(state.reviewPaths).toEqual(["/api/returns/approve-one/approve","/api/returns/reject-one/reject","/api/returns/approve-one/reverse"]);
  expect(new Set(state.posts.map(p=>p.operationKey)).size).toBe(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>document.fonts.ready);expect(await page.locator(".material-symbols-rounded").first().evaluate(el=>getComputedStyle(el).fontFamily)).toContain("Material Symbols");
});

for(const role of ["cashier","staff"])test(`${role} cannot open or load invoice return review`,async({page})=>{
  const state=await setup(page,role);state.rows.push(reviewRow("restricted"));await page.goto("/invoices");await page.waitForTimeout(350);
  await expect(page.getByRole("button",{name:"Return requests",exact:true})).toHaveCount(0);expect(state.returnReads).toBe(0);expect(state.reviewPaths).toEqual([]);
});

test("manager refreshes failed review loading and retries known rejection with a new identity",async({page})=>{
  const state=await setup(page);state.rows.push(reviewRow("retry-one"));state.failReturns=true;await page.goto("/invoices");await page.getByRole("button",{name:"Return requests",exact:true}).click();await expect(page.getByText("Return list unavailable",{exact:true})).toBeVisible();
  state.failReturns=false;await page.getByRole("button",{name:"Refresh",exact:true}).click();await expect(page.getByRole("button",{name:"Approve",exact:true})).toBeVisible();
  state.rejectReview=true;await page.getByRole("button",{name:"Approve",exact:true}).click();await page.getByRole("button",{name:"Approve Return",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Return settlement requires reconciliation");
  await page.getByRole("button",{name:"Approve Return",exact:true}).click();await expect(page.getByText("No pending return requests.",{exact:true})).toBeVisible();expect(state.posts).toHaveLength(2);expect(state.posts[0].operationKey).not.toBe(state.posts[1].operationKey);
});
