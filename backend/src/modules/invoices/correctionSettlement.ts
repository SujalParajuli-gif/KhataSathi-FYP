import { applicationReleaseReason, parseApplicationReleases, discoverApplicationSources, assertApplicationSourcesTx } from "../customers/applicationSettlement";
import { createHash } from "node:crypto";
import prisma from "../../db/prisma";
import { lockInvoiceForUpdate, runFinancialTransaction } from "../../lib/transactionLocks";
import { getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";

export function restoredInheritedCredit(row: any, target: any): number | null {
  if (!target || row.targetInvoiceId !== target.id) return row.action === "CANCEL" ? 0 : null;
  const released = Number(target.correctionCreditReleased || 0);
  if (!Number.isFinite(released) || released < 0 || roundCurrency(released) !== released || released > row.transferredCredit) return null;
  const payments = target.payments || [];
  const charges = payments.filter((p: any) => p.status === "SUCCESS" && p.kind === "CHARGE");
  const paid = roundCurrency(charges.reduce((n: number, p: any) => n + Number(p.amount), 0));
  if (charges.some((p: any) => !Number.isFinite(p.amount) || p.amount < 0 || roundCurrency(p.amount) !== p.amount || p.voidedAt)
      || payments.some((p: any) => p.kind === "REFUND") || !Number.isFinite(target.paidTotal) || roundCurrency(target.paidTotal) !== paid
      || paid + row.transferredCredit > getInvoicePaymentTargetTotal(target.netTotal)) return null;
  const approved = (target.returnRequests || []).filter((r: any) => r.status === "APPROVED");
  const mixed = approved.some((r: any) => r.settlement?.version === 5) || target.correctionAsSource?.inheritedFunding?.version === 3;
  if (mixed && applicationReleaseReason({ ...target, correctionAsTarget: { ...target.correctionAsTarget, ...row } })) return null;
  let sum = 0;
  let adjustment = 0, order = 0;
  const ordered = approved.map((r: any) => ({ r, s: parseReturnSettlement(r.settlement) })).sort((a: any, b: any) => (a.s?.approvalOrder || 0) - (b.s?.approvalOrder || 0));
  for (const { s } of ordered) {
    if (!s || ![3,5].includes(s.version) || s.inheritedCorrectionId !== row.id || s.inheritedCredit !== row.transferredCredit
        || s.approvalOrder <= order || s.recordedReceipts! > paid || s.originalCustomerId !== row.originalCustomerId || s.originalPayable !== getInvoicePaymentTargetTotal(target.netTotal)) return null;
    if (s.version === 5) {
      adjustment += s.approvedReturnValue; order = s.approvalOrder;
      sum = roundCurrency(sum + s.restoredCredit!);
      continue;
    }
    const debt = roundCurrency(Math.min(s.approvedReturnValue, Math.max(0, s.originalPayable - adjustment - s.recordedReceipts! - (row.transferredCredit - sum))));
    const restored = roundCurrency(Math.min(s.approvedReturnValue - debt, row.transferredCredit - sum));
    if (s.debtReduction !== debt || s.restoredCredit !== restored) return null;
    adjustment += s.approvedReturnValue; order = s.approvalOrder;
    sum = roundCurrency(sum + s.restoredCredit!);
  }
  if (adjustment !== Number(target.returnAdjustment || 0) || adjustment > getInvoicePaymentTargetTotal(target.netTotal)) return null;
  if (target.paymentStatus === "CANCELLED") {
    const own = target.correctionAsSource;
    const funding = own?.inheritedFunding;
    if ((target.returnRequests || []).some((r: any) => ["APPROVED", "REVERSED"].includes(r.status)) || !own || own.action !== "CANCEL" || own.sourceInvoiceId !== target.id
        || !funding || ![1,3].includes(funding.version) || funding.sourceCorrectionId !== row.id
        || funding.originalCustomerId !== row.originalCustomerId || funding.inheritedCredit !== row.transferredCredit) return null;
    const receipts = (target.payments || []).filter((p: any) => p.status === "SUCCESS" && p.kind === "CHARGE");
    const actual = receipts.map((p: any) => ({ id: p.id, amount: p.amount, method: p.method })).sort((a: any, b: any) => a.id.localeCompare(b.id));
    const paid = roundCurrency(receipts.reduce((n: number, p: any) => n + p.amount, 0));
    if (!target.cancelledAt || own.targetInvoiceId || own.transferredCredit !== 0 || own.recordedReceipts !== paid || own.retainedCredit !== paid
        || own.originalCustomerId !== row.originalCustomerId || own.originalPayable !== getInvoicePaymentTargetTotal(target.netTotal)
        || !Array.isArray(own.receipts) || own.receipts.length !== actual.length || own.receipts.some((p: any, n: number) => p.id !== actual[n]?.id || p.amount !== actual[n]?.amount || p.method !== actual[n]?.method)) return null;
    sum = row.transferredCredit;
  } else if (target.correctionAsSource) return null;
  return sum === released ? sum : null;
}

export class CorrectionSettlementConflict extends Error {}

export function captureCorrectionBasis(invoice: any) {
  const rows = (invoice.payments || []).filter((p: any) => p.status === "SUCCESS" && p.kind === "CHARGE");
  const paid = roundCurrency(rows.reduce((n: number, p: any) => n + Number(p.amount), 0));
  const target = getInvoicePaymentTargetTotal(invoice.netTotal);
  if (invoice.status !== "FINALIZED" || invoice.paymentStatus === "CANCELLED" || invoice.cancelledAt || invoice.deletedAt
      || !Number.isFinite(invoice.netTotal) || invoice.netTotal < 0 || target > 2147483647
      || !Number.isFinite(invoice.paidTotal) || roundCurrency(invoice.paidTotal) !== paid || paid > target
      || rows.some((p: any) => !Number.isFinite(p.amount) || p.amount < 0 || roundCurrency(p.amount) !== p.amount || p.voidedAt)
      || (invoice.payments || []).some((p: any) => p.kind === "REFUND" || (p.method === "ESEWA" && p.status === "PENDING" && !p.voidedAt))
      || (invoice.creditNotesAsOriginal || []).length || invoice.creditNoteAsReplacement || invoice.correctionAsSource || invoice.correctionAsTarget
      || Number(invoice.returnAdjustment || 0) || Number(invoice.creditApplied || 0) || Number(invoice.correctionCredit || 0) || Number(invoice.correctionCreditReleased || 0)
      || (invoice.returnRequests || []).some((r: any) => ["APPROVED", "REVERSED"].includes(r.status))) {
    throw new CorrectionSettlementConflict("Invoice correction requires a reconciled original-sale receipt basis; legacy, returned or credit-funded corrections require settlement review");
  }
  return { originalCustomerId: invoice.customerId || null, originalPayable: target, recordedReceipts: paid,
    receipts: rows.map((p: any) => ({ id: p.id, amount: p.amount, method: p.method })).sort((a: any, b: any) => a.id.localeCompare(b.id)) };
}

export function allocateCorrectionCredit(paid: number, target: number, originalCustomerId: string | null, targetCustomerId: string | null) {
  const transferredCredit = originalCustomerId && originalCustomerId === targetCustomerId
    ? roundCurrency(Math.min(paid, getInvoicePaymentTargetTotal(target))) : 0;
  return { transferredCredit, retainedCredit: roundCurrency(paid - transferredCredit) };
}

export function correctionRecordReason(row: any, source: any, target?: any, verifyRestoration = true): string | null {
  const fail = "Correction receipt allocation or original ownership does not reconcile";
  const inherited = row?.inheritedFunding;
  const parent = source?.correctionAsTarget;
  const applicationValid = inherited?.version === 2 && row.action === "CANCEL" && !parent && source.customerId === inherited.originalCustomerId && parseApplicationReleases(inherited.applications) && !applicationReleaseReason({...source,correctionAsSource:row});
  const inheritedValid = applicationValid || inherited && [1,3].includes(inherited.version) && row.action === "CANCEL" && parent
    && inherited.sourceCorrectionId === parent.id && inherited.originalCustomerId === source.customerId
    && inherited.inheritedCredit === parent.transferredCredit && source.customerId
    && parent.originalCustomerId === source.customerId && parent.sourceInvoice
    && !parent.sourceInvoice.correctionAsTarget
    && !correctionRecordReason(parent, parent.sourceInvoice, { ...source, correctionAsSource: row });
  if (inherited != null && !inheritedValid) return fail;
  if (!row || !source || row.sourceInvoiceId !== source.id || row.originalCustomerId !== (source.customerId || null)
      || source.status !== "FINALIZED" || source.paymentStatus !== "CANCELLED" || !source.cancelledAt
      || (!inheritedValid && (Number(source.correctionCredit || 0) || Number(source.correctionCreditReleased || 0))) || Number(source.creditApplied || 0) || Number(source.returnAdjustment || 0)
      || (source.returnRequests || []).some((r: any) => ["APPROVED", "REVERSED"].includes(r.status))) return fail;
  const rows = (source.payments || []).filter((p: any) => p.status === "SUCCESS" && p.kind === "CHARGE");
  const actual = rows.map((p: any) => ({ id: p.id, amount: p.amount, method: p.method })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const recorded = row.receipts;
  if (!Array.isArray(recorded) || recorded.length !== actual.length || recorded.some((p: any, n: number) =>
    p.id !== actual[n]?.id || p.amount !== actual[n]?.amount || p.method !== actual[n]?.method
    || !Number.isFinite(p.amount) || p.amount < 0 || roundCurrency(p.amount) !== p.amount)
    || rows.some((p: any) => p.voidedAt)
    || (source.payments || []).some((p: any) => p.kind === "REFUND" || (p.status === "PENDING" && p.method === "ESEWA" && !p.voidedAt))) return fail;
  const paid = roundCurrency(actual.reduce((n: number, p: any) => n + p.amount, 0));
  if (!Number.isFinite(source.netTotal) || source.netTotal < 0 || row.originalPayable !== getInvoicePaymentTargetTotal(source.netTotal)
      || !Number.isFinite(source.paidTotal) || paid !== roundCurrency(source.paidTotal) || paid !== row.recordedReceipts || paid > row.originalPayable
      || !Number.isFinite(row.transferredCredit) || !Number.isFinite(row.retainedCredit)
      || row.transferredCredit < 0 || row.retainedCredit < 0 || roundCurrency(row.transferredCredit) !== row.transferredCredit
      || roundCurrency(row.retainedCredit) !== row.retainedCredit || roundCurrency(row.transferredCredit + row.retainedCredit) !== paid) return fail;
  const notes = source.creditNotesAsOriginal || [];
  if (source.creditNoteAsReplacement && !inheritedValid) return fail;
  if (row.action === "CANCEL") {
    if (row.targetInvoiceId || row.transferredCredit !== 0 || notes.length) return fail;
  } else if (row.action === "REPLACE") {
    if (!target || row.targetInvoiceId !== target.id || target.id === source.id || notes.length !== 1
        || notes[0].replacementInvoiceId !== target.id || notes[0].creditedAmount !== row.transferredCredit
        || notes[0].originalPaidTotal !== paid || notes[0].originalNetTotal !== source.netTotal
        || notes[0].replacementNetTotal !== target.netTotal || Number(target.correctionCredit || 0) !== row.transferredCredit
        || row.transferredCredit !== allocateCorrectionCredit(paid, target.netTotal, row.originalCustomerId, target.customerId || null).transferredCredit) return fail;
    if (verifyRestoration && restoredInheritedCredit(row, target) === null) return fail;
  } else return fail;
  return null;
}

export async function runCorrectionOperation(input: { action: "REPLACE" | "CANCEL"; actorId: string; invoiceId: string; operationKey?: string; content: unknown },
  work: (tx: any) => Promise<{ response: any; settlement: any }>) {
  if (typeof input.operationKey !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(input.operationKey)) {
    throw new CorrectionSettlementConflict("Invoice correction operation key is required; retry with its original operation identity");
  }
  const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { role: true, isActive: true } });
  if (!actor?.isActive || !["ADMIN", "MANAGER", "CASHIER"].includes(actor.role)) throw new CorrectionSettlementConflict("Invoice correction requires an active authorized actor");
  const payloadHash = createHash("sha256").update(JSON.stringify({ ...input, operationKey: undefined })).digest("hex");
  const replay = (row: any) => {
    if (row.payloadHash !== payloadHash) throw new CorrectionSettlementConflict("Invoice correction conflicts with its original actor, action or payload");
    return row.responseJson;
  };
  const prior = await prisma.invoiceCorrectionSettlement.findUnique({ where: { operationKey: input.operationKey } });
  if (prior) return replay(prior);
  const applicationSources = await discoverApplicationSources(input.invoiceId);
  const parent = await prisma.invoiceCorrectionSettlement.findUnique({ where: { targetInvoiceId: input.invoiceId } });
  try {
    return await runFinancialTransaction(prisma, async tx => {
      for (const id of [...new Set([input.invoiceId, ...applicationSources, ...(parent ? [parent.sourceInvoiceId] : [])])].sort()) await lockInvoiceForUpdate(tx, id);
      const existing = await tx.invoiceCorrectionSettlement.findUnique({ where: { operationKey: input.operationKey } });
      if (existing) return replay(existing);
      await assertApplicationSourcesTx(tx,input.invoiceId,applicationSources);
      const result = await work(tx);
      const responseJson = JSON.parse(JSON.stringify(result.response));
      const settlement = await tx.invoiceCorrectionSettlement.create({ data: { ...result.settlement,
        action: input.action, actorId: input.actorId, sourceInvoiceId: input.invoiceId,
        operationKey: input.operationKey!, payloadHash, responseJson } });
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "CUSTOMER_CREDIT_CORRECTION_RECORDED", entityType: "InvoiceCorrectionSettlement",
        entityId: settlement.id, meta: { sourceInvoiceId: input.invoiceId, targetInvoiceId: settlement.targetInvoiceId,
          originalCustomerId: settlement.originalCustomerId, recordedReceipts: settlement.recordedReceipts,
          transferredCredit: settlement.transferredCredit, retainedCredit: settlement.retainedCredit, reason: settlement.reason } } });
      return responseJson;
    });
  } catch (error) {
    if ((error as any)?.code === "P2002") {
      const winner = await prisma.invoiceCorrectionSettlement.findUnique({ where: { operationKey: input.operationKey } });
      if (winner) return replay(winner);
    }
    throw error;
  }
}
