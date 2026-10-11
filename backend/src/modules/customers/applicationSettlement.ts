import prisma from "../../db/prisma";
import { roundCurrency, getInvoicePaymentTargetTotal } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";
import { receivableInclude, projectReceivableInvoice } from "./receivables";
import { correctionRecordReason } from "../invoices/correctionSettlement";

export class ApplicationSettlementConflict extends Error { readonly code = "APPLICATION_SETTLEMENT_CONFLICT"; }

export type ApplicationRelease = { applicationId: string; sourceInvoiceId: string; sourceReturnId: string | null; sourceCorrectionId: string | null;
  originalCustomerId: string; originalAmount: number; createdAt: string; released: number };
const cents = (n: any) => typeof n === "number" && Number.isFinite(n) && n >= 0 && roundCurrency(n) === n;
export function effectiveApplicationAmount(a: any) { return roundCurrency(Number(a.amount) - Number(a.amountReleased || 0)); }
export function parseApplicationReleases(value: unknown): ApplicationRelease[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const ids = new Set<string>();
  for (const a of value) {
    if (!a || typeof a !== "object" || ![a.applicationId,a.sourceInvoiceId,a.originalCustomerId,a.createdAt].every(n => typeof n === "string" && n.length)
      || !Number.isFinite(Date.parse(a.createdAt)) || !(a.sourceReturnId === null || typeof a.sourceReturnId === "string" && a.sourceReturnId.length)
      || !(a.sourceCorrectionId === null || typeof a.sourceCorrectionId === "string" && a.sourceCorrectionId.length)
      || Boolean(a.sourceReturnId) === Boolean(a.sourceCorrectionId) || !cents(a.originalAmount) || a.originalAmount <= 0
      || !cents(a.released) || a.released > a.originalAmount || ids.has(a.applicationId)) return null;
    ids.add(a.applicationId);
  }
  return value.map(a => ({applicationId:a.applicationId,sourceInvoiceId:a.sourceInvoiceId,sourceReturnId:a.sourceReturnId,sourceCorrectionId:a.sourceCorrectionId,
    originalCustomerId:a.originalCustomerId,originalAmount:a.originalAmount,createdAt:a.createdAt,released:a.released}));
}
export function captureApplications(rows: any[]): ApplicationRelease[] {
  return rows.filter(a => !a.reversedAt).sort((a,b) => new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime() || b.id.localeCompare(a.id))
    .map(a => ({ applicationId:a.id,sourceInvoiceId:a.sourceInvoiceId,sourceReturnId:a.sourceReturnId || null,sourceCorrectionId:a.sourceCorrectionId || null,
      originalCustomerId:a.originalCustomerId,originalAmount:a.amount,createdAt:new Date(a.createdAt).toISOString(),released:0 }));
}
export function sameApplicationBasis(left: ApplicationRelease[], right: ApplicationRelease[]) {
  const a=parseApplicationReleases(left),b=parseApplicationReleases(right);
  return Boolean(a && b && JSON.stringify(a.map(r=>({...r,released:0}))) === JSON.stringify(b.map(r=>({...r,released:0}))));
}
export function allocateApplicationRelease(rows: any[], amount: number): ApplicationRelease[] {
  let rest = roundCurrency(amount);
  return captureApplications(rows).map(a => {
    const row=rows.find(r=>r.id===a.applicationId); const released=roundCurrency(Math.min(rest,effectiveApplicationAmount(row)));
    rest=roundCurrency(rest-released);return {...a,released};
  });
}
export function applicationReleaseReason(invoice: any): string | null {
  const fail="Application credit release or original funding does not reconcile";
  if (!invoice) return fail;
  const rows=invoice.creditApplicationsTo || [];
  if (rows.some((a:any)=>!cents(a.amountReleased ?? 0) || Number(a.amountReleased ?? 0)>a.amount || (a.reversedAt && Number(a.amountReleased ?? 0)))) return fail;
  const expected=new Map<string,number>(rows.map((a:any)=>[a.id,0]));
  const active=rows.filter((a:any)=>!a.reversedAt);
  const approved=(invoice.returnRequests || []).filter((r:any)=>r.status==="APPROVED");
  const parent=invoice.correctionAsTarget;
  let adjustment=0,order=0,parentReleased=0;
  for (const r of [...approved].sort((a,b)=>(a.settlement?.approvalOrder || 0)-(b.settlement?.approvalOrder || 0))) {
    const s=parseReturnSettlement(r.settlement);
    if (![4,5].includes(s?.version || 0)) { if (rows.some((a:any)=>Number(a.amountReleased || 0))) return fail; continue; }
    if (!s || s.version === 5 && (!parent || parent.id !== s.inheritedCorrectionId || parent.originalCustomerId !== invoice.customerId || parent.transferredCredit !== s.inheritedCredit || invoice.correctionCredit !== s.inheritedCredit)) return fail;
    if (s.version === 4 && parent) return fail;
    if (s.originalCustomerId!==invoice.customerId || s.originalPayable!==getInvoicePaymentTargetTotal(invoice.netTotal) || s.approvalOrder<=order
      || s.recordedReceipts!>Number(invoice.paidTotal) || !sameApplicationBasis(s.applications!,captureApplications(active))) return fail;
    const remaining=active.map((a:any)=>({...a,amountReleased:expected.get(a.id) || 0}));
    const total=roundCurrency(remaining.reduce((n:number,a:any)=>n+effectiveApplicationAmount(a),0));
    const inherited=s.version === 5 ? s.inheritedCredit! - parentReleased : 0;
    const debt=roundCurrency(Math.min(s.approvedReturnValue,Math.max(0,s.originalPayable-adjustment-s.recordedReceipts!-total-inherited)));
    const vector=allocateApplicationRelease(remaining,Math.min(total,s.approvedReturnValue-debt));
    if (s.debtReduction!==debt || JSON.stringify(vector)!==JSON.stringify(s.applications)) return fail;
    if (s.version === 5) {
      const restored=roundCurrency(Math.min(inherited,s.approvedReturnValue-debt-vector.reduce((n,a)=>n+a.released,0)));
      if (s.restoredCredit !== restored) return fail;
      parentReleased=roundCurrency(parentReleased+restored);
    }
    for (const a of vector) expected.set(a.applicationId,roundCurrency((expected.get(a.applicationId) || 0)+a.released));
    adjustment+=s.approvedReturnValue;order=s.approvalOrder;
  }
  const mixed=approved.some((r:any)=>r.settlement?.version === 5);
  const releasedReturns=approved.some((r:any)=>[4,5].includes(r.settlement?.version));
  if (releasedReturns && (approved.some((r:any)=>r.settlement?.version !== (mixed ? 5 : 4)) || adjustment !== Number(invoice.returnAdjustment || 0))) return fail;
  const funding=invoice.correctionAsSource?.inheritedFunding;
  if ((mixed || funding?.version === 3) && (!parent?.sourceInvoice || parent.sourceInvoice.correctionAsTarget && parent.inheritedFunding?.version !== 4 || correctionRecordReason(parent,parent.sourceInvoice,invoice,false))) return fail;
  if (releasedReturns || rows.some((a:any)=>Number(a.amountReleased || 0)) || [2,3].includes(funding?.version)) {
    const charges=(invoice.payments || []).filter((p:any)=>p.kind === "CHARGE" && p.status === "SUCCESS");
    const paid=roundCurrency(charges.reduce((n:number,p:any)=>n+Number(p.amount),0));
    const applied=roundCurrency(active.reduce((n:number,a:any)=>n+effectiveApplicationAmount(a),0));
    if (invoice.status !== "FINALIZED" || !invoice.customerId || !cents(invoice.paidTotal) || invoice.paidTotal !== paid
      || charges.some((p:any)=>!cents(p.amount) || p.voidedAt) || (invoice.payments || []).some((p:any)=>p.kind === "REFUND" || p.method === "ESEWA" && p.status === "PENDING" && !p.voidedAt)
      || applied !== Number(invoice.creditApplied || 0) || applied > Math.max(0,getInvoicePaymentTargetTotal(invoice.netTotal)-Number(invoice.returnAdjustment || 0)-paid-Number(invoice.correctionCredit || 0)+Number(invoice.correctionCreditReleased || 0))
      || active.some((a:any)=>a.targetInvoiceId !== invoice.id || a.originalCustomerId !== invoice.customerId)) return fail;
  }
  if ([2,3].includes(funding?.version)) {
    const vector=parseApplicationReleases(funding.applications);
    if (invoice.paymentStatus!=="CANCELLED" || approved.length || (invoice.returnRequests || []).some((r:any)=>r.status==="REVERSED")
      || !vector || funding.originalCustomerId!==invoice.customerId || !sameApplicationBasis(vector,captureApplications(active))
      || vector.some(a=>a.released!==a.originalAmount)) return fail;
    if (funding.version === 3) {
      if (!parent || parent.id !== funding.sourceCorrectionId || parent.originalCustomerId !== invoice.customerId || parent.transferredCredit !== funding.inheritedCredit || invoice.correctionCredit !== funding.inheritedCredit) return fail;
      parentReleased=funding.inheritedCredit;
    } else if (parent) return fail;
    for (const a of vector) expected.set(a.applicationId,a.released);
  }
  return rows.some((a:any)=>Number(a.amountReleased || 0)!==expected.get(a.id)) || (mixed || funding?.version === 3) && Number(invoice.correctionCreditReleased || 0)!==parentReleased ? fail : null;
}
export async function applicationReturnBasisTx(tx: any, invoice: any) {
  const full=await tx.invoice.findUnique({where:{id:invoice.id},include:receivableInclude});
  const rows=full.creditApplicationsTo.filter((a:any)=>!a.reversedAt);
  const parent=full.correctionAsTarget;
  const projection=projectReceivableInvoice(full);
  if (!rows.length || projection.reason || !full.customerId || full.correctionAsSource || (!parent && full.creditNoteAsReplacement)
    || (parent && (parent.originalCustomerId !== full.customerId || !parent.sourceInvoice || parent.sourceInvoice.correctionAsTarget && parent.inheritedFunding?.version !== 4 || Number(parent.sourceInvoice.creditApplied || 0)>0))
    || full.creditNotesAsOriginal.length || full.payments.some((p:any)=>p.kind==="REFUND")
    || rows.some((a:any)=>a.originalCustomerId!==full.customerId || a.sourceInvoice.customerId!==full.customerId || a.sourceInvoice.correctionAsTarget && a.sourceInvoice.correctionAsSource?.inheritedFunding?.version !== 4
      || Number(a.sourceInvoice.creditApplied || 0)>0 || a.sourceInvoice.correctionAsSource?.inheritedFunding && a.sourceInvoice.correctionAsSource?.inheritedFunding?.version !== 4
      || (a.sourceReturnId && parseReturnSettlement(a.sourceReturn?.settlement)?.version!==2))) throw new ApplicationSettlementConflict(projection.reason || "Application-funded returns require reconciled original credit sources");
  return { rows, applications:captureApplications(rows), applied:projection.appliedCredit, parent };
}
export async function setApplicationReleasesTx(tx:any, rows: any[], vector: ApplicationRelease[], sign: 1 | -1) {
  for (const a of vector) {
    const row=rows.find(r=>r.id===a.applicationId);
    const next=roundCurrency(Number(row.amountReleased || 0)+sign*a.released);
    if (next<0 || next>row.amount || row.reversedAt) throw new ApplicationSettlementConflict("Application release changed; retry the original operation");
    await tx.customerCreditApplication.update({where:{id:row.id},data:{amountReleased:next}});
    row.amountReleased=next;
  }
  return roundCurrency(rows.reduce((n,a)=>n+effectiveApplicationAmount(a),0));
}
export async function assertApplicationRestoreTx(tx:any, vector:Pick<ApplicationRelease,"sourceInvoiceId"|"sourceReturnId"|"sourceCorrectionId"|"originalCustomerId"|"released">[]) {
  const grouped=new Map<string,typeof vector[number]>();
  for (const a of vector.filter(a=>a.released>0)) {
    const key=JSON.stringify([a.sourceInvoiceId,a.sourceReturnId,a.sourceCorrectionId]);
    const prior=grouped.get(key);grouped.set(key,{...a,released:roundCurrency(a.released+(prior?.released || 0))});
  }
  for (const a of grouped.values()) {
    const source=await tx.invoice.findUnique({where:{id:a.sourceInvoiceId},include:receivableInclude});
    const p=source && projectReceivableInvoice(source);
    const budget=p?.creditSources.find((s:any)=>a.sourceReturnId ? s.returnId===a.sourceReturnId : s.correctionId===a.sourceCorrectionId);
    if (!p || p.reason || source.customerId!==a.originalCustomerId || !budget || budget.availableCredit<a.released) throw new ApplicationSettlementConflict("Reverse uses or recover payouts at every original credit source before reversing this return");
  }
}
export async function discoverApplicationSources(invoiceId:string): Promise<string[]> {
  const rows=await prisma.customerCreditApplication.findMany({where:{targetInvoiceId:invoiceId,reversedAt:null},select:{sourceInvoiceId:true}});
  return [...new Set<string>(rows.map(a=>String(a.sourceInvoiceId)))].sort();
}
export async function assertApplicationSourcesTx(tx:any,invoiceId:string,ids:string[]) {
  const rows=await tx.customerCreditApplication.findMany({where:{targetInvoiceId:invoiceId,reversedAt:null},select:{sourceInvoiceId:true}});
  if (JSON.stringify([...new Set(rows.map((a:any)=>a.sourceInvoiceId))].sort())!==JSON.stringify(ids)) throw new ApplicationSettlementConflict("Credit funding changed; retry the original operation");
}
