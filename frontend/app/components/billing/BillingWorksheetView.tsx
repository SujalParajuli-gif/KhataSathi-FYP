import Switch from "~/components/ui/Switch";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { formatBillingMoney, PAPER_EXCEPTION_REASONS, BILLING_NOTE_MAX_LENGTH } from "~/lib/billingWorkspace";
import React, { useState, useRef, useEffect } from "react";
import Icon from "~/components/ui/Icon";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { type PrintBusinessIdentity } from "~/lib/invoices";
import { paperReviewIssue, shopToday } from "~/lib/billingWorkspace";
import type { ExternalDocumentType } from "~/lib/api/manualBills";
import type { CartTableItem } from "./BillingCartTable";
import type { CustomerOption } from "./BillingCustomerSummary";

export interface BillingWorksheetViewProps {
  cart: CartTableItem[]; customer: CustomerOption | null;
  discountLabel?: string; subTotal: number; discountPercent: number; discountAmount: number; payableTotal: number;
  cashReceived?: string; onChooseCustomer?: () => void;
  cashierName?: string | null; business: PrintBusinessIdentity;
  note: string; onChangeNote: (value: string) => void;
  paperDocumentType: ExternalDocumentType; onChangePaperDocumentType: (value: ExternalDocumentType) => void;
  paperBillNo: string; onChangePaperBillNo: (value: string) => void;
  paperBillDate: string; onChangePaperBillDate: (value: string) => void;
  isPaperException: boolean; onTogglePaperException: (value: boolean) => void;
  paperExceptionReason: string; onChangePaperExceptionReason: (value: string) => void;
  onUpdateQty: (productId: string, qty: number) => void; onRemoveItem: (productId: string) => void;
  onBackToBilling: () => void; onContinueToPayment: () => void; onOpenOcrComparison: () => void;
}
const DOCUMENT_TYPES: Array<[ExternalDocumentType, string]> = [
  ["OTHER_MANUAL_SALES_DOCUMENT", "Rough / other manual bill"], ["PAN_INVOICE", "PAN bill"],
  ["VAT_TAX_INVOICE", "External VAT tax invoice"], ["ABBREVIATED_TAX_INVOICE", "External abbreviated tax invoice"],
];
const DOCUMENT_PAGE_SIZE = 10;
const EDIT_PAGE_SIZE = 10;
function WorksheetPager({label,page,size,total,onChange}:{label:string;page:number;size:number;total:number;onChange:(page:number)=>void}) {
 const pages=Math.max(1,Math.ceil(total/size));
 return <nav className="billing-worksheet-pagination" aria-label={label}><span>Showing {total?(page-1)*size+1:0}–{Math.min(page*size,total)} of {total}</span><div><button type="button" aria-label={`Previous ${label} page`} disabled={page<=1} onClick={()=>onChange(page-1)}><Icon name="chevron_left" sizePx={18}/></button><span>{page} / {pages}</span><button type="button" aria-label={`Next ${label} page`} disabled={page>=pages} onClick={()=>onChange(page+1)}><Icon name="chevron_right" sizePx={18}/></button></div></nav>;
}
export default function BillingWorksheetView(p: BillingWorksheetViewProps) {
 const [search,setSearch]=useState("");
 const [documentPage,setDocumentPage]=useState(1);
 const [editPage,setEditPage]=useState(1);
 const documentListRef=useRef<HTMLDivElement>(null);
 const editListRef=useRef<HTMLDivElement>(null);
 const [attempted,setAttempted]=useState(false);
 useEffect(()=>{setEditPage(1);},[search]);
 useEffect(()=>{if(editListRef.current) editListRef.current.scrollTop=0;},[search,editPage]);
 useEffect(()=>{if(documentListRef.current) documentListRef.current.scrollTop=0;},[documentPage]);
 const [otherMode,setOtherMode]=useState(Boolean(p.paperExceptionReason && !PAPER_EXCEPTION_REASONS.some(reason=>reason===p.paperExceptionReason)));
 const knownReason=PAPER_EXCEPTION_REASONS.find(reason=>reason===p.paperExceptionReason);
 const issue=paperReviewIssue(p.isPaperException?{kind:"EXCEPTION",reason:p.paperExceptionReason}:{kind:"REFERENCE",billNo:p.paperBillNo,billDate:p.paperBillDate,documentType:p.paperDocumentType});
 const missingBillNumber=!p.isPaperException&&!p.paperBillNo.trim();
 const invalidBillDate=!p.isPaperException&&Boolean(p.paperBillNo.trim())&&Boolean(issue);
 const referenceMessage=attempted&&issue&&p.cart.length>0?<p id="worksheet-reference-error" className={`billing-field-error ${attempted?"is-invalid":""}`} role={attempted?"alert":"status"}>{!p.isPaperException&&!p.paperBillNo.trim()?"Bill number required.":p.isPaperException?"Select an exception reason.":"Enter a valid bill date."}</p>:null;
 const filtered=p.cart.filter(item=>item.name.toLowerCase().includes(search.toLowerCase()));
 const documentPages=Math.max(1,Math.ceil(p.cart.length/DOCUMENT_PAGE_SIZE));
 const editPages=Math.max(1,Math.ceil(filtered.length/EDIT_PAGE_SIZE));
 const activeDocumentPage=Math.min(documentPage,documentPages);
 const activeEditPage=Math.min(editPage,editPages);
 useEffect(()=>{setDocumentPage(current=>Math.min(current,documentPages));},[documentPages]);
 useEffect(()=>{setEditPage(current=>Math.min(current,editPages));},[editPages]);
 const documentOffset=(activeDocumentPage-1)*DOCUMENT_PAGE_SIZE;
 const editOffset=(activeEditPage-1)*EDIT_PAGE_SIZE;
 const received=Number(p.cashReceived||0);
 const rounding=Math.round((p.payableTotal-Math.max(0,p.subTotal-p.discountAmount))*100)/100;
 return <section data-paper-exception={p.isPaperException} className="billing-sheet" aria-label="Sales Worksheet">
  <header className="billing-sheet-heading"><Icon name="shopping_cart" sizePx={32}/><div><h1>Sales Worksheet</h1><p>Review items and record manual bill details before final payment</p></div></header>
  <div className="billing-provisional"><Icon name="warning" sizePx={24}/><span>Provisional internal reference · not a tax invoice</span></div>
  <div className="billing-sheet-columns">
   <article className="billing-sheet-card billing-sheet-document">
    <div className="billing-shop-header">
     <div className="billing-shop-symbol"><Icon name="storefront" sizePx={42}/></div>
     <div className="billing-shop-details"><h3>{p.business.displayName}</h3>{p.business.legalName&&<p>{p.business.legalName}</p>}{p.business.address&&<p><Icon name="location_on" sizePx={16}/>{p.business.address}</p>}{p.business.phone&&<p><Icon name="call" sizePx={16}/>Phone: {p.business.phone}</p>}{p.business.panNo&&<p><Icon name="description" sizePx={16}/>PAN: {p.business.panNo}</p>}</div>
     <dl className="billing-document-reference"><div><dt>Date</dt><dd><Icon name="calendar_month" sizePx={16}/>{p.paperBillDate||shopToday()}</dd></div><div><dt>Customer</dt><dd><button type="button" onClick={p.onChooseCustomer} className="billing-customer-choice"><Icon name="person" sizePx={18}/><span>{p.customer?.name||"Walk-in customer"}</span><Icon name="expand_more" sizePx={16}/></button></dd></div><div><dt>Prepared by</dt><dd>{p.cashierName||"Current operator"}</dd></div><div><dt>Reference</dt><dd>{p.isPaperException?"Unavailable · exception selected":p.paperBillNo.trim()?`${p.paperBillNo} · not verified`:"Not entered"}</dd></div></dl>
    </div>
    <div ref={documentListRef} className="billing-sheet-lines"><table className="billing-document-table"><thead><tr><th>S.N.</th><th>Product Name</th><th>Brand</th><th>Qty</th><th>Unit</th><th>Rate (रु)</th><th>Amount (रु)</th></tr></thead><tbody>{p.cart.slice(documentOffset,documentOffset+DOCUMENT_PAGE_SIZE).map((item,i)=><tr key={item.productId}><td>{documentOffset+i+1}</td><td>{item.name}</td><td>{item.brand||"—"}</td><td>{item.qty}</td><td>{item.saleUnit||"—"}</td><td>{formatBillingMoney(item.appliedUnitPrice)}{item.priceType==="Wholesale"&&item.overrideUnitPrice===undefined&&<span className="billing-rate-badge">Wholesale</span>}</td><td>{formatBillingMoney(item.lineTotal)}</td></tr>)}</tbody></table>{!p.cart.length&&<p className="p-8 text-center">Add products in Billing to prepare a worksheet.</p>}</div>
    <WorksheetPager label="Worksheet items" page={activeDocumentPage} size={DOCUMENT_PAGE_SIZE} total={p.cart.length} onChange={setDocumentPage}/>
    <div className="billing-document-bottom"><div><p className="billing-document-notice" lang="ne"><Icon name="info" sizePx={20}/>यो मूल्य सूची आन्तरिक प्रयोगका लागि मात्र हो । यो कर बिल होइन ।</p><h3 className="flex items-center gap-2"><Icon name="description" sizePx={22}/>Remarks:</h3><textarea aria-label="Worksheet Remarks" className="billing-remarks" rows={2} maxLength={BILLING_NOTE_MAX_LENGTH} value={p.note} onChange={e=>p.onChangeNote(e.target.value)} placeholder="उदाहरण: डेलिभरी नोट, विशेष छुट, वा कागजी बिल सम्बन्धी टिप्पणी"/><p className="billing-note-count">{p.note.length}/{BILLING_NOTE_MAX_LENGTH}</p></div><div className="billing-document-totals"><dl><div><dt>Subtotal</dt><dd>{formatBillingMoney(p.subTotal)}</dd></div><div><dt>{p.discountLabel||"Discount"}</dt><dd>{formatBillingMoney(p.discountAmount)}</dd></div>{rounding !== 0 && <div><dt title="Automatic adjustment to the nearest whole rupee after discount">Rounding adjustment</dt><dd>{rounding > 0 ? "+" : "−"}{formatBillingMoney(Math.abs(rounding))}</dd></div>}<div className={!p.cashReceived?"billing-balance":"billing-grand-total"}><dt>Total payable</dt><dd>{formatBillingMoney(p.payableTotal)}</dd></div>{p.cashReceived&&<div><dt>Cash received · draft</dt><dd>{Number.isFinite(received)?formatBillingMoney(received):"Invalid amount"}</dd></div>}</dl>{p.cashReceived&&<div className="billing-balance"><span>{p.cashReceived && Number.isFinite(received) && received >= 0 ? received > p.payableTotal ? "Change · draft" : "Balance due · draft" : "Sale payable"}</span><strong>{formatBillingMoney(p.cashReceived && Number.isFinite(received) && received >= 0 ? Math.abs(p.payableTotal-received) : p.payableTotal)}</strong></div>}</div></div>
   </article>
   <div className="billing-sheet-right">
    <section className="billing-sheet-card billing-paper-card"><h2 className="flex items-center gap-2"><span className="billing-blue-icon"><Icon name="receipt_long" sizePx={22}/></span>Manual Bill Recording</h2><p>Enter the details from the physical manual bill you are writing</p><p className="billing-reference-status" role="status">{p.isPaperException?"Reference unavailable · exception selected":p.paperBillNo.trim()?"Reference entered · not verified":"Paper reference not entered"}</p>
     <div className="grid grid-cols-2 gap-2 mt-3"><label className="billing-sheet-field col-span-2">Document type<ProjectSelect aria-label="Document type" value={p.paperDocumentType} onChange={e=>p.onChangePaperDocumentType(e.target.value as ExternalDocumentType)}>{DOCUMENT_TYPES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</ProjectSelect></label><label className="billing-sheet-field">Manual Bill No.<input aria-label="Manual Bill No." id="worksheet-bill-number" aria-invalid={attempted&&missingBillNumber} aria-describedby={attempted&&missingBillNumber?"worksheet-reference-error":undefined} value={p.paperBillNo} disabled={p.isPaperException} onChange={e=>p.onChangePaperBillNo(e.target.value)} placeholder="Number on paper bill"/>{missingBillNumber&&referenceMessage}</label><label className="billing-sheet-field">Bill Date<ProjectDateInput aria-label="Bill date" aria-describedby={attempted&&invalidBillDate?"worksheet-reference-error":undefined} className={attempted&&invalidBillDate?"billing-date-invalid":undefined} value={p.paperBillDate} onChange={e=>p.onChangePaperBillDate(e.target.value)}/>{invalidBillDate&&referenceMessage}</label><label className="billing-sheet-field col-span-2">Notes (optional)<textarea rows={2} maxLength={BILLING_NOTE_MAX_LENGTH} value={p.note} onChange={e=>p.onChangeNote(e.target.value)} placeholder="Internal note or delivery instruction"/></label></div>
     <div className="billing-paper-exception"><Switch ariaLabel="Physical bill reference unavailable" checked={p.isPaperException} onChange={p.onTogglePaperException}/><span>Physical bill reference unavailable<small>Operator, time and reason are audited.</small></span></div>
     {p.isPaperException&&<><label className="billing-sheet-field mt-3">Exception reason<ProjectSelect id="worksheet-exception-reason" aria-label="Exception reason" value={otherMode?"OTHER":knownReason||""} onChange={e=>{setOtherMode(e.target.value==="OTHER");p.onChangePaperExceptionReason(e.target.value==="OTHER"?"":e.target.value);}}><option value="" disabled>Select a reason</option>{PAPER_EXCEPTION_REASONS.map(reason=><option key={reason} value={reason}>{reason}</option>)}<option value="OTHER">Other</option></ProjectSelect></label>{otherMode&&<label className="billing-sheet-field mt-2">Exception details<textarea id="worksheet-exception-details" aria-label="Exception details" aria-invalid={attempted&&Boolean(issue)} rows={2} maxLength={490} value={p.paperExceptionReason.replace(/^Other: /,"")} onChange={e=>p.onChangePaperExceptionReason(e.target.value.trim()?`Other: ${e.target.value}`:"")} placeholder="Explain why the physical reference is unavailable"/></label>}</>}
     {p.isPaperException&&referenceMessage}{p.isPaperException&&p.paperBillNo.trim()&&<p className="billing-retained-reference">Retained draft number: {p.paperBillNo}. It is not verified. The current save flow may still record this reference; review it in payment confirmation.</p>}
    </section>
    <section className="billing-sheet-card billing-quick-edits"><h2 className="flex items-center gap-2"><span className="billing-blue-icon"><Icon name="edit_square" sizePx={22}/></span>Quick Edit Items</h2><p>Adjust quantities or remove worksheet items</p><label className="billing-sheet-field my-2"><span className="sr-only">Search worksheet items</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search worksheet items…"/></label><div ref={editListRef} className="billing-sheet-edits"><table><thead><tr><th>S.N.</th><th>Product Name</th><th>Qty</th><th>Action</th></tr></thead><tbody>{filtered.slice(editOffset,editOffset+EDIT_PAGE_SIZE).map((item,i)=><tr key={item.productId}><td>{editOffset+i+1}</td><td title={item.name}>{item.name}</td><td><div className="billing-edit-stepper"><button type="button" aria-label={`Decrease ${item.name}`} onClick={()=>p.onUpdateQty(item.productId,Math.max(item.quantityStep||1,item.qty-(item.quantityStep||1)))}>−</button><span>{item.qty}</span><button type="button" aria-label={`Increase ${item.name}`} onClick={()=>p.onUpdateQty(item.productId,item.qty+(item.quantityStep||1))}>+</button></div></td><td><button type="button" aria-label={`Remove ${item.name}`} onClick={()=>p.onRemoveItem(item.productId)} className="text-rose-600"><Icon name="delete" sizePx={18}/></button></td></tr>)}</tbody></table>{!filtered.length&&<p className="billing-edit-empty">{p.cart.length?"No items match this search.":"Add items in Billing to begin."}</p>}</div><WorksheetPager label="Quick Edit items" page={activeEditPage} size={EDIT_PAGE_SIZE} total={filtered.length} onChange={setEditPage}/><button type="button" className="billing-add-items" onClick={p.onBackToBilling}><Icon name="add" sizePx={20}/>Add Item to Worksheet</button></section>
   </div>
  </div>
  <footer className="billing-sheet-footer"><button type="button" onClick={p.onBackToBilling}>← Back to Billing</button><div><button type="button" onClick={p.onOpenOcrComparison}>Insert Manual Bill & Compare</button><button type="button" className="billing-primary" aria-label="Continue to Payment" disabled={!p.cart.length} onClick={()=>{setAttempted(true);if(issue){const selector=p.isPaperException?(otherMode?"#worksheet-exception-details":"#worksheet-exception-reason"):p.paperBillNo.trim()?'[aria-label="Bill date"]':"#worksheet-bill-number";const field=document.querySelector<HTMLElement>(selector);field?.focus();field?.scrollIntoView({block:"nearest"});return;}p.onContinueToPayment();}}>Continue to Payment →</button></div></footer>
 </section>;
}
