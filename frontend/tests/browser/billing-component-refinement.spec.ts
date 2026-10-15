import {test,expect,type Page} from "@playwright/test";
async function setup(page:Page,count=4) {
 const user={id:"fixture-operator",name:"Fixture operator",role:"cashier"};
 const customer={id:"buyer",name:"Ram Traders",phone:"9841000000",address:"Kathmandu",loyaltyPercent:10};
 const products=Array.from({length:count},(_,i)=>({id:`fixture-${i}`,name:`Product ${i+1}`,sku:`SKU-${i}`,retailPrice:i===0?7526:1,stock:200,quantityStep:1,isActive:true,wholesaleEligible:false,saleUnit:"PIECE"}));
 await page.addInitScript(({user,customer,products})=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));localStorage.setItem("khatasathi_billing_cart",JSON.stringify({cart:products.map(p=>({productId:p.id,qty:1})),selectedCustomerId:customer.id,savedAt:new Date().toISOString()}));},{user,customer,products});
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;const send=(body:unknown)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  if(path.endsWith("/auth/me"))return send({user});
  if(path.endsWith("/capabilities"))return send({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true});
  if(path.endsWith("/business"))return send({businessName:"Fixture Shop"});
  if(path.includes("/products"))return send({products,total:products.length});
  if(path.endsWith("/customers/lookup"))return send({items:[customer],total:1,page:1,pageSize:20});
  if(path.endsWith("/customers"))return send([customer]);
  if(path.endsWith("/payment-accounts/enabled")||path.endsWith("/brands")||path.endsWith("/categories"))return send([]);
  if(path.endsWith("/receivables-summary"))return send({state:"EXISTS",hasDue:true,totalDue:1000,currency:"NPR"});
  if(path.endsWith("/invoice-events"))return send({events:[],total:0,totalPages:1,page:1,pageSize:15,summary:{totalEvents:0,uniqueProducts:0,latestPurchaseDate:null}});
  if(path.includes("/checkout"))throw new Error("This visual fixture must never post a sale");
  return send({});
 });
 await page.goto("/billing");await expect(page.locator(".billing-cart-row")).toHaveCount(count);
}
async function payment(page:Page) {
 await page.getByRole("button",{name:/^Worksheet/}).click();await page.getByLabel("Manual Bill No.",{exact:true}).fill("PAPER-121");await page.getByRole("button",{name:"Continue to Payment",exact:true}).click();return page.getByRole("dialog",{name:"Confirm Payment",exact:true});
}
for(const method of ["Cash","Fonepay","Bank Transfer"]){for(const status of ["Paid","Partial","Unpaid"]){
 test(`${method} ${status} keeps collection fields and settlement consistent`,async({page})=>{
  await setup(page);await expect(page.locator(".billing-summary-content")).toContainText("रु 6,776.00");const dialog=await payment(page);
  await dialog.getByRole("button",{name:new RegExp(`^${method.replace(" ","\\s*")}$`)}).first().click();if(status!=="Paid")await dialog.getByRole("button",{name:status,exact:true}).click();
  const settlement=dialog.locator("article").filter({hasText:"Settlement Summary"});await expect(settlement).toContainText("रु 6,776.00");await expect(settlement).toContainText("−रु 0.10");await expect(dialog.getByText("QR Merchant verified",{exact:true})).toHaveCount(0);
  if(status==="Unpaid") {await expect(settlement).toContainText("Collected nowरु 0.00");await expect(dialog.getByLabel("Payment amount paid")).toHaveCount(0);await expect(dialog.locator('#fonepay-verify')).toHaveCount(0);await expect(dialog).toContainText("Outstanding balance");}
  if(status==="Partial") {await dialog.getByLabel("Payment amount paid").fill("100");await expect(settlement).toContainText("रु 6,676.00");}
  if(method==="Fonepay"&&status!=="Unpaid"){await expect(dialog).toContainText("Manual payment confirmation required");await dialog.getByRole("button",{name:/CONFIRM FONEPAY|SAVE PARTIAL PAYMENT/}).click();await expect(dialog.getByRole("alert")).toContainText("Enter the Fonepay reference");}
  await expect(dialog.locator('input[placeholder="e.g. PB-2080-001"]')).toHaveValue("PAPER-121");
 });
}}
test("worksheet reference switch retains metadata and invalid continue focuses the relevant input",async({page})=>{
 await setup(page);await page.getByRole("button",{name:/^Worksheet/}).click();const tab=page.locator("#billing-worksheet-trigger");const before=await tab.boundingBox();
 await page.getByRole("button",{name:"Continue to Payment",exact:true}).click();await expect(page.getByLabel("Manual Bill No.",{exact:true})).toBeFocused();await expect(page.locator("#worksheet-reference-error")).toHaveAttribute("role","alert");
 await page.getByLabel("Manual Bill No.",{exact:true}).fill("PAPER-121");expect(await tab.boundingBox()).toEqual(before);await page.getByLabel("Notes (optional)").fill("Delivery note");
 const toggle=page.getByRole("switch",{name:"Physical bill reference unavailable"});await toggle.click();await page.getByRole("combobox",{name:"Exception reason"}).click();await page.getByRole("option",{name:"Other",exact:true}).click();await page.getByLabel("Exception details").fill("Paper unreadable");await toggle.click();await expect(page.getByLabel("Manual Bill No.",{exact:true})).toHaveValue("PAPER-121");await expect(page.getByLabel("Notes (optional)")).toHaveValue("Delivery note");await toggle.click();await expect(page.getByLabel("Exception details")).toHaveValue("Paper unreadable");await expect(page.locator(".billing-document-notice")).toContainText("यो मूल्य सूची आन्तरिक प्रयोगका लागि मात्र हो । यो कर बिल होइन ।");await page.getByRole("button",{name:"Continue to Payment",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Confirm Payment",exact:true});await expect(dialog).toContainText("Previously entered details are retained below");await expect(dialog.locator('input[placeholder="e.g. PB-2080-001"]')).toHaveValue("PAPER-121");await expect(dialog.getByLabel("Record immediately on save")).toBeChecked();
});
test("compact mobile payment contains its actions and unpaid layout is content-sized",async({page})=>{
 await setup(page);await page.setViewportSize({width:390,height:844});const dialog=await payment(page);await dialog.getByRole("button",{name:"Unpaid",exact:true}).click();const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);await expect(dialog.getByRole("button",{name:/CREATE UNPAID/})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("OCR remains advisory and reference edits invalidate comparison confirmation",async({page})=>{
 await setup(page);await page.getByRole("button",{name:/^Worksheet/}).click();await page.getByLabel("Manual Bill No.",{exact:true}).fill("PAPER-121");
 await page.route("**/manual-bills/scan-preview",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({observations:{billNumber:"203",billDate:"2024-07-03",total:"9999",lines:[{name:"Unknown product",code:null,unit:null,quantity:null,unitPrice:null}]},model:"fixture"})}));
 await page.getByRole("button",{name:"Insert Manual Bill & Compare",exact:true}).click();const dialog=page.getByRole("dialog",{name:"Compare manual bill with Worksheet"});
 await dialog.locator('input[type="file"]').setInputFiles({name:"fixture.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFoQAAAAASUVORK5CYII=","base64")});
 await expect(dialog.getByText("Extracted vs Entered Details")).toBeVisible();await expect(dialog).toContainText("No unique match");await expect(dialog.getByRole("button",{name:"Confirm & Continue"})).toBeDisabled();
 await dialog.getByRole("checkbox",{name:/I compared the original/}).check();await expect(dialog.getByRole("button",{name:"Confirm & Continue"})).toBeEnabled();await dialog.getByRole("button",{name:"Use extracted reference fields"}).click();await expect(dialog.getByRole("button",{name:"Confirm & Continue"})).toBeDisabled();await expect(page.locator(".billing-document-totals")).toContainText("रु 6,776.00");await dialog.getByRole("checkbox",{name:/I compared the original/}).check();await dialog.getByRole("button",{name:"Confirm & Continue"}).click();await expect(page.getByLabel("Manual Bill No.",{exact:true})).toHaveValue("203");await page.getByRole("button",{name:"Insert Manual Bill & Compare",exact:true}).click();await dialog.locator('input[type="file"]').setInputFiles({name:"fixture.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.4\n%%EOF")});await expect(dialog.locator('iframe[title="Original paper bill"]')).toBeVisible();await expect(dialog.getByRole("button",{name:"Zoom in original bill"})).toHaveCount(0);await expect(dialog).toContainText("Use the PDF viewer controls to zoom.");
});
test("scratchpad calculation and clear cancellation preserve the sale",async({page})=>{
 await setup(page);await page.getByRole("button",{name:"Tools",exact:true}).click();await page.getByRole("menuitem",{name:"Calculator"}).click();await page.getByLabel("Calculator input").fill("12*3");await page.keyboard.press("Enter");await expect(page.getByRole("dialog",{name:"Scratchpad Calculator"})).toContainText("36");await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Tools",exact:true})).toBeFocused();await page.getByRole("button",{name:"Clear (F9)",exact:true}).click();await page.getByRole("dialog",{name:"Clear this cart?"}).getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.locator(".billing-cart-row")).toHaveCount(4);await expect(page.locator(".billing-summary-content")).toContainText("रु 6,776.00");
});

test("previous due opens the existing outstanding-payment history filter",async({page})=>{
 await setup(page);await page.getByRole("button",{name:"View Invoices →",exact:true}).click();await expect(page.getByRole("combobox",{name:"Payment filter"})).toContainText("Outstanding due");
});

test("create-customer initial focus and cancellation return to the parent picker",async({page})=>{
 await setup(page);await page.getByRole("button",{name:"Change",exact:true}).click();await page.getByRole("button",{name:"+ Add a customer",exact:true}).click();const create=page.getByRole("dialog",{name:"Create customer",exact:true});await expect(create.getByRole("textbox",{name:"Full Name"})).toBeFocused();await create.getByRole("textbox",{name:"Full Name"}).fill("Retained draft");await page.keyboard.press("Escape");await expect(page.getByRole("dialog",{name:"Choose customer",exact:true}).getByPlaceholder("Find by name, phone, or 9-digit PAN...")).toBeFocused();await page.getByRole("button",{name:"+ Add a customer",exact:true}).click();await expect(create.getByRole("textbox",{name:"Full Name"})).toHaveValue("Retained draft");
});
