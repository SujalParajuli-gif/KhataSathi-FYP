import {test,expect,type Page} from "@playwright/test";
async function setup(page:Page,role="manager",count=20) {
 const user={id:"operator",name:"Operator",role};
 const customer={id:"buyer",name:"Ram Traders",phone:"9841000000",address:"Kathmandu",loyaltyPercent:0,wholesalePercent:0};
 const products=Array.from({length:count},(_,i)=>({id:`product-${i}`,name:`Product ${i+1}`,sku:`SKU-${i}`,retailPrice:100,wholesalePrice:80,stock:200,isActive:true,quantityStep:2,wholesaleEligible:true,wholesaleQtyThreshold:4,saleUnit:"PIECE"}));
 let settings={businessName:"Existing Shop",businessAddress:"Kathmandu",businessPhone:"9841000000",defaultWholesaleQtyThreshold:4};
 let saves=0;
 await page.addInitScript(({user,products})=>{localStorage.setItem("khatasathi_auth_user",JSON.stringify(user));localStorage.setItem("khatasathi_billing_cart",JSON.stringify({cart:products.map(p=>({productId:p.id,qty:2})),savedAt:new Date().toISOString()}));},{user,products});
 await page.route(url=>url.pathname.startsWith("/api/"),async route=>{
  const path=new URL(route.request().url()).pathname;
  const send=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
  if(path.endsWith("/auth/me"))return send({user});
  if(path.endsWith("/capabilities"))return send({businessMode:"FULL_POS",catalogEnabled:true,inventoryEnabled:true,posEnabled:true,stockTracked:true});
  if(path.endsWith("/settings/business")){if(route.request().method()==="PUT"){saves++;if(saves===1)return send({error:"Save failed"},503);settings={...settings,...route.request().postDataJSON()};}return send(settings);}
  if(path.endsWith("/payment-accounts/enabled"))return send([]);
  if(path.includes("/products"))return send({products,total:count});
  if(path.endsWith("/customers/lookup"))return send({items:[customer],total:1,page:1,pageSize:20});
  if(path.endsWith("/customers"))return send([customer]);
  if(path.endsWith("/users")||path.endsWith("/brands")||path.endsWith("/categories"))return send([]);
  if(path.endsWith("/receivables-summary"))return send({state:"NONE",hasDue:false,totalDue:0,currency:"NPR"});
  return send({});
 });
 return {products,customer,getSettings:()=>settings,getSaves:()=>saves,setRole:(role:string)=>{user.role=role;}};
}

for (const role of ["manager","cashier"]) {
 test(`floating navigation preserves bounds and sale state for ${role}`,async({page})=>{
  await setup(page,role);await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/billing");await expect(page.locator(".billing-cart-row")).toHaveCount(20);
  await page.getByLabel("Cash received",{exact:true}).fill("4500");
  const workspace=page.locator(".billing-workspace");const before=await workspace.boundingBox();
  await page.getByRole("button",{name:"Expand sidebar",exact:true}).click();await expect(page.locator('[data-floating-sidebar="true"]')).toBeVisible();
  expect(await workspace.boundingBox()).toEqual(before);expect(await page.locator("#app-sidebar").evaluate(e=>Math.max(...getComputedStyle(e).transitionDuration.split(",").map(value=>parseFloat(value))))).toBeLessThanOrEqual(0.001);await expect(page.getByRole('button',{name:'Close floating navigation'})).toBeFocused();
  await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Expand sidebar",exact:true})).toBeFocused();expect(await workspace.boundingBox()).toEqual(before);
  await page.getByRole("button",{name:"Expand sidebar",exact:true}).click();await page.getByRole("button",{name:"Close floating navigation"}).click();
  await expect(page.getByRole("button",{name:"Expand sidebar",exact:true})).toBeFocused();
  await page.getByRole("button",{name:"Expand sidebar",exact:true}).click();await page.locator('.billing-cart-row').first().click();
  await expect(page.locator('[data-floating-sidebar="true"]')).toHaveCount(0);await expect(page.getByLabel("Cash received",{exact:true})).toHaveValue("4500");await expect(page.locator('.billing-cart-row')).toHaveCount(20);
 });
}
test("toolbar tools and edge row actions remain keyboard accessible",async({page})=>{
 await setup(page);await page.goto("/billing");await expect(page.locator('.billing-cart-row')).toHaveCount(20);
 const tools=page.getByRole('button',{name:'Tools',exact:true});await tools.focus();await page.keyboard.press('ArrowDown');
 const menu=page.getByRole('menu',{name:'Billing tools'});await expect(menu.getByRole('menuitem',{name:'Calculator'})).toBeFocused();await expect(menu.getByRole('menuitem',{name:'Reprint Last'})).toBeDisabled();
 await page.keyboard.press('ArrowDown');await expect(menu.getByRole('menuitem',{name:'Keyboard Shortcuts'})).toBeFocused();await page.keyboard.press('Escape');await expect(tools).toBeFocused();
 await tools.click();await menu.getByRole('menuitem',{name:'Calculator'}).click();await expect(page.getByRole('dialog',{name:/calculator/i})).toBeVisible();await page.keyboard.press('Escape');await expect(tools).toBeFocused();
 await page.getByRole('button',{name:'Fonepay',exact:true}).click();await page.getByRole('button',{name:'View payment QRs'}).click();await expect(page.getByRole('dialog',{name:'Store Payment QRs Gallery'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Store Payment QRs Gallery'})).toHaveCount(0);await page.getByRole('button',{name:'Cash',exact:true}).click();await expect(page.getByRole('button',{name:'View payment QRs'})).toHaveCount(0);
 const last=page.locator('.billing-cart-row').last();await last.scrollIntoViewIfNeeded();await last.getByRole('button',{name:'Actions for Product 20'}).click();
 const actions=page.getByRole('menu',{name:'Actions for Product 20'});await expect(actions).toBeVisible();const bounds=await actions.boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(1000);await expect(actions.getByRole('menuitem',{name:'Price Override'})).toBeFocused();await page.keyboard.press('Escape');await expect(last.getByRole('button',{name:'Actions for Product 20'})).toBeFocused();await last.getByRole('button',{name:'Actions for Product 20'}).click();await actions.getByRole('menuitem',{name:'Price Override'}).click();await expect(page.getByRole('dialog',{name:/price override/i})).toBeVisible();await page.keyboard.press('Escape');await expect(last.getByRole('button',{name:'Actions for Product 20'})).toBeFocused();
});
test("large cart remains complete and keyboard selection clears sticky header",async({page})=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await setup(page,'cashier',55);await page.setViewportSize({width:1536,height:864});await page.goto('/billing');const rows=page.locator('.billing-cart-row');await expect(rows).toHaveCount(55);await rows.first().click();
 for(let i=0;i<54;i++)await page.keyboard.press('Alt+ArrowDown');await expect(rows.last()).toHaveAttribute('aria-selected','true');
 await expect.poll(async()=>{const last=await rows.last().boundingBox();const heading=await page.locator(".billing-cart-column thead").boundingBox();return last!.y-(heading!.y+heading!.height);}).toBeGreaterThanOrEqual(-1);
 await page.keyboard.press('Alt+Shift+Q');await expect(page.locator('#qty-input-product-54')).toBeFocused();await expect(page.getByRole('button',{name:/^Review in Worksheet/})).toBeVisible();expect(errors).toEqual([]);
});

test("narrow catalog keeps large prices and Add controls inside its panel",async({page})=>{
 const fixture=await setup(page,"cashier",5);fixture.products[0].name="Heavy Duty Plastic Water Storage Container 100 Litre — Blue";fixture.products[0].retailPrice=1234567.89;
 await page.setViewportSize({width:1440,height:900});await page.goto("/billing");await expect(page.locator(".billing-cart-row")).toHaveCount(5);
 const catalog=page.locator(".billing-catalog-slot");const row=catalog.locator("tbody tr").first();await expect(row).toContainText("रु 1,234,567.89");const add=row.getByRole("button");const bounds=await add.boundingBox();const parent=await catalog.boundingBox();expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(parent!.x+parent!.width);
 await expect.poll(()=>catalog.locator(".billing-list").evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThanOrEqual(1);
 await add.click();await expect(page.locator("#qty-input-product-0")).toHaveValue("4");
});
