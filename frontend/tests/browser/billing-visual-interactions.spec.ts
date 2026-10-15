import {test,expect,type Page} from "@playwright/test";
async function setup(page:Page,role="manager") {
 const user={id:"operator",name:"Operator",role};
 const customer={id:"buyer",name:"Ram Traders",phone:"9841000000",address:"Kathmandu",loyaltyPercent:0,wholesalePercent:0};
 const products=Array.from({length:20},(_,i)=>({id:`product-${i}`,name:`Product ${i+1}`,sku:`SKU-${i}`,retailPrice:100,wholesalePrice:80,stock:200,isActive:true,quantityStep:2,wholesaleEligible:true,wholesaleQtyThreshold:4,saleUnit:"PIECE"}));
 let settings={businessName:"Existing Shop",businessAddress:"Kathmandu",businessPhone:"9841000000",defaultWholesaleQtyThreshold:4};
 let saves=0;
 await page.addInitScript(({user,products})=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));localStorage.setItem("khatasathi_billing_cart",JSON.stringify({cart:products.map(p=>({productId:p.id,qty:2})),savedAt:new Date().toISOString()}));},{user,products});
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;
  const send=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
  if(path.endsWith("/auth/me"))return send({user});
  if(path.endsWith("/capabilities"))return send({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true});
  if(path.endsWith("/settings/business")){if(route.request().method()==="PUT"){saves++;if(saves===1)return send({error:"Save failed"},503);settings={...settings,...route.request().postDataJSON()};}return send(settings);}
  if(path.includes("/products"))return send({products,total:20});
  if(path.endsWith("/customers/lookup"))return send({items:[customer],total:1,page:1,pageSize:20});
  if(path.endsWith("/customers"))return send([customer]);
  if(path.endsWith("/users")||path.endsWith("/brands")||path.endsWith("/categories"))return send([]);
  if(path.endsWith("/receivables-summary"))return send({state:"NONE",hasDue:false,totalDue:0,currency:"NPR"});
  return send({});
 });
 return {products,customer,getSettings:()=>settings,getSaves:()=>saves,setRole:(role:string)=>{user.role=role;}};
}
test("keyboard selection, quantity focus and wholesale threshold retain one applied rate",async({page})=>{
 await setup(page);await page.goto("/billing");
 const rows=page.locator(".billing-cart-row");await expect(rows).toHaveCount(20);
 await rows.first().click();await page.keyboard.press("Alt+ArrowDown");await expect(rows.nth(1)).toHaveAttribute("aria-selected","true");
 await page.keyboard.press("Alt+Shift+Q");await expect(page.locator("#qty-input-product-1")).toBeFocused();
 await page.getByRole("button",{name:"Increase quantity of Product 2",exact:true}).click();
 await expect(rows.nth(1)).toContainText("Wholesale");await expect(rows.nth(1)).toContainText("रु 80.00");
 await page.getByRole("button",{name:"Decrease quantity of Product 2",exact:true}).click();await expect(rows.nth(1)).not.toContainText("Wholesale");
 await expect(rows.first()).not.toContainText("SKU-");await expect(page.getByText(/WS:/)).toHaveCount(0);
 await page.keyboard.press("F8");await expect(page.getByRole("dialog",{name:/price override/i})).toBeVisible();await page.keyboard.press("Escape");
 await page.keyboard.press("F7");await expect(page.getByRole("dialog",{name:"Choose customer"})).toBeVisible();
 await expect(page.getByRole("dialog",{name:"Choose customer"}).getByPlaceholder("Find by name, phone, or 9-digit PAN...")).toBeFocused();
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await expect(page.getByRole("button",{name:"Select Ram Traders",exact:true})).toBeFocused();await page.keyboard.press("Enter");
 await expect(page.getByRole("dialog",{name:"Choose customer"})).not.toBeVisible();
 await page.getByRole("button",{name:/^Worksheet/}).click();await page.keyboard.press("F7");await expect(page.getByRole("dialog",{name:"Choose customer"})).toBeVisible();await page.keyboard.press("Escape");
 await page.getByRole("button",{name:/^Worksheet/}).click();await page.keyboard.press("F2");await expect(page.getByPlaceholder("Search product name, SKU or brand...")).toBeFocused();
});
test("cash draft survives Worksheet and Other exception requires details",async({page})=>{
 await setup(page);await page.goto("/billing");await page.getByLabel("Cash received",{exact:true}).fill("4500");
 await expect(page.getByText("रु 500.00",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:/Review in Worksheet/}).click();await expect(page.getByText("Cash received · draft")).toBeVisible();
 await page.getByRole("switch",{name:"Physical bill reference unavailable"}).click();await page.getByRole("button",{name:"Continue to Payment",exact:true}).click();await expect(page.getByRole("dialog",{name:"Confirm Payment",exact:true})).toHaveCount(0);
 await page.getByRole("combobox",{name:"Exception reason"}).click();await page.getByRole("option",{name:"Other",exact:true}).click();await page.getByRole("button",{name:"Continue to Payment",exact:true}).click();await expect(page.getByRole("dialog",{name:"Confirm Payment",exact:true})).toHaveCount(0);
 await page.getByLabel("Exception details").fill("Bill number unreadable");await expect(page.getByRole("button",{name:"Continue to Payment",exact:true})).toBeEnabled();
 await page.getByRole("switch",{name:"Physical bill reference unavailable"}).click();await page.getByLabel("Manual Bill No.",{exact:true}).fill("TEST-PAPER-1");
 await page.keyboard.press("Shift+Enter");
 await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByRole("dialog").getByLabel("Payment cash received")).toHaveValue("4500");
 const dialog=page.getByRole("dialog");await dialog.getByRole("combobox").last().click();await page.keyboard.press("Escape");await expect(dialog).toBeVisible();
 await page.keyboard.press("Alt+2");await expect(dialog).toContainText("Fonepay");await expect(dialog.getByLabel("Payment cash received")).toHaveCount(0);
 await page.keyboard.press("Alt+1");await expect(dialog.getByLabel("Payment cash received")).toHaveValue("4500");
});
test("admin shop settings retains failed input and saves shared shop identity",async({page})=>{
 const fixture=await setup(page,"admin");await page.goto("/profile");
 const section=page.getByRole("region",{name:"Shop information"});await expect(section.getByLabel("Shop name")).toHaveValue("Existing Shop");
 await section.getByLabel("Shop name").fill("Updated Shop");await section.getByRole("button",{name:"Save shop information"}).click();await expect(section.getByRole("alert")).toContainText("Save failed");await expect(section.getByLabel("Shop name")).toHaveValue("Updated Shop");
 await section.getByRole("button",{name:"Save shop information"}).click();await expect(section.getByRole("status")).toContainText("saved");expect(fixture.getSettings().businessName).toBe("Updated Shop");
 fixture.setRole("manager");await page.addInitScript(()=>{const user=JSON.parse(localStorage.getItem("khatasathi_auth_user")!);user.role="manager";localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));});
 await page.goto("/billing");await page.getByRole("button",{name:/Worksheet \(20\)/}).click();await expect(page.getByRole("heading",{name:"Updated Shop"})).toBeVisible();
});

test("worksheet exposes the existing rounding adjustment for fractional discounted totals",async({page})=>{
 const fixture=await setup(page);fixture.products[0].retailPrice=100.05;fixture.customer.loyaltyPercent=10;
 await page.goto("/billing");await page.getByRole("button",{name:"Select",exact:true}).click();await page.getByRole("button",{name:"Select Ram Traders",exact:true}).click();
 await expect(page.getByText("Rounding adjustment",{exact:true})).toBeVisible();await expect(page.getByText("−रु 0.09",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:/^Worksheet/}).click();
 const totals=page.locator(".billing-document-totals");await expect(totals).toContainText("Rounding");await expect(totals).toContainText("−रु 0.09");await expect(totals).toContainText("रु 3,600.00");
});
