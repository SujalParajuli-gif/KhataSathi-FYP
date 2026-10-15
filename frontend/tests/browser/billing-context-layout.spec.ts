import {test,expect,type Page} from "@playwright/test";
async function setup(page:Page,count=7,pricing?:{wholesalePercent:number;loyaltyPercent:number}) {
 const user={id:"fixture-operator",name:"Fixture operator",role:"cashier"};
 const customer={id:"buyer",name:"Ram Traders",phone:"9841000000",address:"Kathmandu",loyaltyPercent:pricing?.loyaltyPercent??10,wholesalePercent:pricing?.wholesalePercent??0};
 const otherCustomer={...customer,id:"buyer-2",name:"Sita Traders"};
 const products=Array.from({length:count},(_,i)=>({id:`fixture-${i}`,name:`Product ${i+1}`,sku:`SKU-${i}`,retailPrice:pricing?100:i===0?7526:1,wholesalePrice:80,wholesaleQtyThreshold:10,stock:200,quantityStep:1,isActive:true,wholesaleEligible:!!pricing,saleUnit:"PIECE",brand:{name:"Fixture Brand"},imageUrl:"/assets/fixture-product.svg"}));
 await page.addInitScript(({user,customer,products})=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));localStorage.setItem("khatasathi_billing_cart",JSON.stringify({cart:products.map(p=>({productId:p.id,qty:1})),selectedCustomerId:customer.id,savedAt:new Date().toISOString()}));},{user,customer,products});
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;const send=(body:unknown)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  if(path.endsWith("/auth/me"))return send({user});
  if(path.endsWith("/capabilities"))return send({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true});
  if(path.endsWith("/business"))return send({businessName:"Fixture Shop"});
  if(path.includes("/products"))return send({products,total:products.length});
  if(path.endsWith("/customers/lookup"))return send({items:[customer,otherCustomer],total:2,page:1,pageSize:20});
  if(path.endsWith("/customers"))return send([customer,otherCustomer]);
  if(path.endsWith("/payment-accounts/enabled")||path.endsWith("/brands")||path.endsWith("/categories"))return send([]);
  if(path.endsWith("/product-history"))return send({history:[{id:"past-1",productId:"fixture-0",productName:"Product 1",invoiceId:"past-invoice",invoiceNo:"INV-PAST",invoiceDate:"2026-10-14",qty:1,appliedUnitPrice:100}]});
  if(path.startsWith("/api/invoices/")&&!path.endsWith("/parked"))return send({invoice:{id:"past-invoice",invoiceNo:"INV-PAST",createdAt:"2026-10-14T05:00:00Z",items:[],payments:[],total:100,subtotal:100,paidAmount:100,dueAmount:0,paymentStatus:"PAID",status:"COMPLETED"}});
  if(path.endsWith("/receivables-summary"))return send({state:"EXISTS",hasDue:true,totalDue:1000,currency:"NPR"});
  if(path.endsWith("/invoice-events")){const query=new URL(route.request().url());const pageNo=Number(query.searchParams.get("page")||1);const size=Number(query.searchParams.get("pageSize")||15);return send({events:Array.from({length:Math.min(size,Math.max(0,17-(pageNo-1)*size))},(_,i)=>({id:`event-${pageNo}-${i}`,invoiceId:`invoice-${i}`,invoiceNo:`INV-${i+1}`,eventType:"PURCHASE",date:"2026-10-14T05:00:00Z",itemCount:13,itemPreviews:Array.from({length:13},(_,j)=>({productId:`fixture-${j}`,name:`Historical product ${j+1}`,qty:j+1,unitPrice:100+j})),totalAmount:4000,paidAmount:0,dueAmount:4000,paymentStatus:"UNPAID",paymentMethods:[],notes:null})),total:17,totalPages:Math.ceil(17/size),page:pageNo,pageSize:size,summary:{totalEvents:17,uniqueProducts:13,latestPurchaseDate:"2026-10-14"}});}
  if(path.includes("/checkout"))throw new Error("This visual fixture must never post a sale");
  return send({});
 });
 await page.route("**/fixture-product.svg",route=>route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#83abc9"/></svg>'}));
 await page.goto("/billing");await expect(page.locator(".billing-cart-row")).toHaveCount(count);
}


for (const selected of [false,true]) test(`summary keeps natural spacing for every payment method (${selected?"selected":"walk-in"})`,async({page})=>{
 await page.setViewportSize({width:1920,height:1080}); await setup(page,3);
 if(!selected)await page.getByRole("button",{name:"Deselect customer",exact:true}).click();
 for(const method of ["Cash","Fonepay","Bank"]){
  await page.getByRole("button",{name:method,exact:true}).click();
  const panel=page.locator(".billing-payment-section"), content=page.locator(".billing-summary-content"), action=page.locator(".billing-review-action");
  const metrics=await panel.evaluate(el=>{const nodes=[...el.children].filter(e=>e.getBoundingClientRect().height>0);return nodes.slice(1).map((node,i)=>node.getBoundingClientRect().top-nodes[i].getBoundingClientRect().bottom)});
  expect(Math.max(...metrics)).toBeLessThanOrEqual(26);
  const c=await content.boundingBox(), a=await action.boundingBox(); expect(a!.y-c!.y-c!.height).toBeGreaterThanOrEqual(8); expect(a!.y-c!.y-c!.height).toBeLessThanOrEqual(16);
  await expect(page.getByRole("button",{name:/^Review in Worksheet/})).toBeInViewport();
 }
 await page.setViewportSize({width:1280,height:640});
 await page.getByRole("button",{name:/^Review in Worksheet/}).scrollIntoViewIfNeeded();
 await expect(page.getByRole("button",{name:/^Review in Worksheet/})).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test("Worksheet customer picker cancels, selects and nests create without leaving Worksheet",async({page})=>{
 await setup(page,3);await page.getByRole("button",{name:"Worksheet (3)",exact:true}).click();
 const opener=page.locator(".billing-customer-choice");await opener.click();
 const picker=page.getByRole("dialog",{name:"Choose customer",exact:true});await expect(picker).toBeVisible();
 await expect(page.getByRole("heading",{name:"Sales Worksheet",exact:true})).toBeVisible();
 await page.keyboard.press("Escape");await expect(picker).toHaveCount(0);await expect(opener).toBeFocused();
 await opener.click();await picker.getByRole("button",{name:"+ Add a customer",exact:true}).click();
 const create=page.getByRole("dialog",{name:"Create customer",exact:true});await expect(create).toBeVisible();await create.getByRole("button",{name:"Close dialog",exact:true}).click();
 await expect(picker).toBeVisible();await picker.getByRole("button",{name:"Select Sita Traders",exact:true}).click();
 await expect(picker).toHaveCount(0);await expect(opener).toContainText("Sita Traders");await expect(opener).toBeFocused();
 await expect(page.getByRole("heading",{name:"Sales Worksheet",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("khatasathi_billing_cart")||"{}").cart.length)).toBe(3);
});

test("cart history invoice closes to Billing and history invoice keeps its own filters",async({page})=>{
 await setup(page,3);const opener=page.locator(".billing-compact-history").getByRole("button",{name:"INV-PAST",exact:true});await opener.click();
 await expect(page.getByRole("dialog")).toContainText("INV-PAST");await expect(page.locator(".billing-customer-section")).toBeVisible();
 await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);await expect(opener).toBeFocused();await expect(page.getByRole("region",{name:"Purchase History",exact:true})).not.toBeVisible();
 await page.getByRole("button",{name:"Purchase History",exact:true}).click();const history=page.getByRole("region",{name:"Purchase History",exact:true});
 await history.getByRole("button",{name:"Returns",exact:true}).click();const invoice=history.locator(".billing-invoice-link").first();await invoice.click();
 await expect(page.getByRole("dialog")).toContainText("INV-PAST");await page.keyboard.press("Escape");await expect(history).toBeVisible();await expect(invoice).toBeFocused();
 await expect(history.getByRole("button",{name:"Returns",exact:true})).toHaveClass(/is-active/);
});

test("invoice loading and failure dismissal stay in Billing and ignore a closed response",async({page})=>{
 await setup(page,3);let release:(()=>void)|undefined;let requests=0;
 await page.route("**/api/invoices/past-invoice",async route=>{requests++;if(requests===1)await new Promise<void>(resolve=>{release=resolve;});return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Fixture invoice unavailable"})});});
 const opener=page.locator(".billing-compact-history").getByRole("button",{name:"INV-PAST",exact:true});await opener.click();await expect(page.getByRole("dialog",{name:"Loading invoice details",exact:true})).toBeVisible();
 await expect.poll(()=>requests).toBe(1);await page.keyboard.press("Escape");release?.();await expect(opener).toBeFocused();await expect(page.getByRole("dialog")).toHaveCount(0);
 await opener.click();await expect(page.getByRole("dialog",{name:"Invoice load error",exact:true})).toContainText("Unable to load invoice");await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
 await expect(page.getByRole("dialog")).toHaveCount(0);await expect(opener).toBeFocused();await expect(page.locator(".billing-customer-section")).toBeVisible();
});


test("History customer picker closes back to History",async({page})=>{
 await setup(page,3);await page.getByRole("button",{name:"Purchase History",exact:true}).click();
 const history=page.getByRole("region",{name:"Purchase History",exact:true}), opener=history.getByRole("button",{name:"Change customer",exact:true});
 await opener.click();await expect(page.getByRole("dialog",{name:"Choose customer",exact:true})).toBeVisible();await page.keyboard.press("Escape");
 await expect(history).toBeVisible();await expect(opener).toBeFocused();
});
