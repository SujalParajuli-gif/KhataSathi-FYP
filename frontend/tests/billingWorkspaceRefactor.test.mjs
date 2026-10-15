import assert from "node:assert/strict";
import test from "node:test";
import { paperReviewIssue, validPaperDate, latestComparablePurchase, formatBillingMoney } from "../app/lib/billingWorkspace.ts";

test("production worksheet validation requires a real date/reference or explicit exception", () => {
  const reference = { kind: "REFERENCE", billNo: "M-123", billDate: "2026-10-13", documentType: "PAN_INVOICE" };
  assert.equal(paperReviewIssue(reference), null);
  assert.ok(paperReviewIssue({ ...reference, billNo: " " }));
  assert.ok(paperReviewIssue({ ...reference, billDate: "2026-02-31" }));
  assert.ok(paperReviewIssue({ kind: "EXCEPTION", reason: " " }));
  assert.equal(paperReviewIssue({ kind: "EXCEPTION", reason: "Register unavailable; supervisor notified" }), null);
});
test("paper dates reject JS calendar rollover and malformed strings", () => {
  assert.equal(validPaperDate("2024-02-29"), true);
  for (const date of ["2026-02-29", "2026-13-01", "2026-10-32", "10/13/2026", ""]) assert.equal(validPaperDate(date), false);
});
test("price baseline is latest compatible unit rather than any historical difference", () => {
  const past = [
    { appliedUnitPrice: 200, invoiceDate: "2026-09-01", saleUnit: "PIECE" },
    { appliedUnitPrice: 300, invoiceDate: "2026-10-01", saleUnit: "PIECE" },
    { appliedUnitPrice: 10, invoiceDate: "2026-10-12", saleUnit: "KG" },
  ];
  assert.equal(latestComparablePurchase(past, "PIECE")?.appliedUnitPrice, 300);
  assert.equal(latestComparablePurchase(past, "LITRE"), undefined);
  assert.equal(past[0].appliedUnitPrice, 200, "sorting must not mutate shared history");
});

import { compareBillLines } from "../app/lib/billComparison.ts";
test("OCR exact identity cannot hide quantity/rate mismatches or unreadable units", () => {
  const item={productId:"p",name:"Bucket",sku:"SKU-B",qty:2,appliedUnitPrice:350,saleUnit:"PIECE"};
  const base={billNumber:null,customerName:null,billDate:null,total:"700",lines:[]};
  const line={name:"Bucket",code:"SKU-B",quantity:"2",unitPrice:"350",unit:"pc"};
  assert.equal(compareBillLines({...base,lines:[line]},[item])[0].status,"MATCH");
  assert.equal(compareBillLines({...base,lines:[{...line,quantity:"1"}]},[item])[0].status,"DIFFER");
  assert.equal(compareBillLines({...base,lines:[{...line,unitPrice:null}]},[item])[0].status,"UNREADABLE");
  assert.equal(compareBillLines({...base,lines:[{...line,name:"Bucket large",code:null}]},[item])[0].status,"UNMATCHED");
  assert.equal(compareBillLines({...base,lines:[line]},[item,{...item,productId:"p2"}])[0].status,"UNMATCHED");
});

test("billing currency displays fractional discounts and signed returns without changing their values",()=>{
 assert.equal(formatBillingMoney(392.3),"रु 392.30");
 assert.equal(formatBillingMoney(-450),"रु -450.00");
 assert.equal(formatBillingMoney(NaN),"Unavailable");
});
