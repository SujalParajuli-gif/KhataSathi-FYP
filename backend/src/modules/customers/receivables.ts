import { effectiveApplicationAmount, applicationReleaseReason } from "./applicationSettlement";
import { correctionRecordReason, restoredInheritedCredit } from "../invoices/correctionSettlement";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../db/prisma";
import { effectiveCorrectionCredit, getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";

const originalSourceInclude = { payments:true,returnRequests:true,creditNotesAsOriginal:true,creditNoteAsReplacement:true,correctionAsTarget:true } satisfies Prisma.InvoiceInclude;
const forwardingTargetInclude = { payments:true,returnRequests:true,creditApplicationsTo:true,correctionAsSource:true,correctionAsTarget:true } satisfies Prisma.InvoiceInclude;
const originalParentInclude = { sourceInvoice: { include: {
  ...originalSourceInclude, creditApplicationsTo:true,
  correctionAsTarget:{include:{sourceInvoice:{include:originalSourceInclude}}},
  correctionAsSource:{include:{targetInvoice:{include:forwardingTargetInclude}}},
} } } satisfies Prisma.InvoiceCorrectionSettlementInclude;
const applicationTargetInclude = { payments:true,returnRequests:true,creditNotesAsOriginal:true,creditNoteAsReplacement:true,correctionAsSource:{include:{targetInvoice:{include:forwardingTargetInclude}}},correctionAsTarget:{include:originalParentInclude},creditApplicationsTo:true } satisfies Prisma.InvoiceInclude;
const correctionInclude = {
  correctionAsSource: { include: { targetInvoice: { include: applicationTargetInclude } } },
  correctionAsTarget: { include: originalParentInclude },
} satisfies Prisma.InvoiceInclude;
export const payoutInclude = {
  sourceReturn: true, sourceCorrection: true,
  payoutEvent: { include: { drawer: { select: { id: true, cashierId: true } } } },
  recoveryEvent: { include: { drawer: { select: { id: true, cashierId: true } } } },
} satisfies Prisma.CustomerCreditPayoutInclude;

export function projectPayout(p: any) {
  return { id: p.id, sourceInvoiceId: p.sourceInvoiceId, sourceReturnId: p.sourceReturnId, sourceCorrectionId: p.sourceCorrectionId,
    amount: p.amount, reason: p.reason, actorId: p.actorId, createdAt: p.createdAt, payoutEventId: p.payoutEventId, drawerId: p.payoutEvent?.drawerId,
    recoveredAt: p.recoveredAt, recoveredById: p.recoveredById, recoveryReason: p.recoveryReason, recoveryEventId: p.recoveryEventId, recoveryDrawerId: p.recoveryEvent?.drawerId };
}

export const receivableInclude = {
  creditPayouts: { include: payoutInclude },
  ...correctionInclude,
  payments: true, returnRequests: true, creditNotesAsOriginal: true, creditNoteAsReplacement: true,
  creditApplicationsFrom: { include: { sourceReturn: true, sourceCorrection: true, targetInvoice: { include: applicationTargetInclude } } },
  creditApplicationsTo: { include: { sourceReturn: true, sourceCorrection: true, sourceInvoice: { include: {
    ...correctionInclude, payments: true, returnRequests: true, creditNotesAsOriginal: true, creditNoteAsReplacement: true, creditPayouts: { include: payoutInclude },
    creditApplicationsFrom: { include: { sourceReturn: true, sourceCorrection: true, targetInvoice: { include: applicationTargetInclude } } },
  } } } },
} satisfies Prisma.InvoiceInclude;

function applicationSourceMatches(a: any, customerId: string | null) {
  if (!customerId || a.originalCustomerId !== customerId || Boolean(a.sourceReturnId) === Boolean(a.sourceCorrectionId)) return false;
  return a.sourceCorrectionId
    ? a.sourceCorrection?.id === a.sourceCorrectionId && a.sourceCorrection?.sourceInvoiceId === a.sourceInvoiceId && a.sourceCorrection?.originalCustomerId === customerId
    : a.sourceReturn?.id === a.sourceReturnId && a.sourceReturn?.invoiceId === a.sourceInvoiceId && (a.sourceReturn?.status === "APPROVED" || ("amountReleased" in a && effectiveApplicationAmount(a) === 0 && a.sourceReturn?.status === "REVERSED"))
      && parseReturnSettlement(a.sourceReturn?.settlement)?.originalCustomerId === customerId;
}
function projectApplications(i: any) {
  return [...(i.creditApplicationsFrom || []), ...(i.creditApplicationsTo || [])].map((a: any) => ({ id: a.id, sourceInvoiceId: a.sourceInvoiceId,
    sourceInvoiceNo: a.sourceInvoice?.invoiceNo || i.invoiceNo, targetInvoiceId: a.targetInvoiceId, targetInvoiceNo: a.targetInvoice?.invoiceNo || i.invoiceNo,
    sourceReturnId: a.sourceReturnId, sourceCorrectionId: a.sourceCorrectionId, amount: a.amount, amountReleased: a.amountReleased || 0, remainingAmount: a.reversedAt ? 0 : effectiveApplicationAmount(a), reason: a.reason, actorId: a.actorId, createdAt: a.createdAt, reversedAt: a.reversedAt, reversedById: a.reversedById, reversalReason: a.reversalReason }));
}

export function projectReceivableInvoice(i: any) {
  let reason: string | null = null;
  const payouts = i.creditPayouts || [];
  const activePayouts = payouts.filter((p: any) => !p.recoveredAt);
  const paidOutCredit = roundCurrency(activePayouts.reduce((n: number, p: any) => n + Number(p.amount), 0));
  const payoutReason = payouts.some((p: any) => {
    const out = p.payoutEvent, received = p.recoveryEvent;
    const recoveryValid = p.recoveredAt ? p.recoveredById && p.recoveryReason && p.recoveryEventId && received?.id === p.recoveryEventId
      && received.type === "CASH_IN" && received.amount === p.amount && received.createdById === p.recoveredById
      && received.drawer?.cashierId === p.recoveredById && p.recoveryEventId !== p.payoutEventId
      : !p.recoveredById && !p.recoveryReason && !p.recoveryEventId && !received;
    return !Number.isFinite(p.amount) || p.amount <= 0 || roundCurrency(p.amount) !== p.amount || p.sourceInvoiceId !== i.id
      || !i.customerId || p.originalCustomerId !== i.customerId || Boolean(p.sourceReturnId) === Boolean(p.sourceCorrectionId)
      || out?.id !== p.payoutEventId || out?.type !== "CASH_OUT" || out?.amount !== p.amount || out?.createdById !== p.actorId
      || out?.drawer?.cashierId !== p.actorId || !recoveryValid
      || (!p.recoveredAt && (!applicationSourceMatches(p, i.customerId) || (i.correctionAsSource ? p.sourceCorrectionId !== i.correctionAsSource.id : !p.sourceReturnId)));
  }) ? "Payout cash attribution or original ownership does not reconcile" : null;
  const target = getInvoicePaymentTargetTotal(Number(i.netTotal));
  const payments = i.payments || [];
  const chargeRows = payments.filter((p: any) => p.kind === "CHARGE" && p.status === "SUCCESS");
  const paid = roundCurrency(chargeRows.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
  const adjustment = Number(i.returnAdjustment || 0);
  const returns = i.returnRequests || [];
  const sourceCorrection = i.correctionAsSource;
  const targetCorrection = i.correctionAsTarget;
  const releaseReason = applicationReleaseReason(i);
  const correctionReason = sourceCorrection ? correctionRecordReason(sourceCorrection, i, sourceCorrection.targetInvoice)
    : targetCorrection ? correctionRecordReason(targetCorrection, targetCorrection.sourceInvoice, i) : null;
  const capturedCorrectionCredit = Number(i.correctionCredit || 0);
  const correctionCreditReleased = Number(i.correctionCreditReleased || 0);
  const correctionCredit = effectiveCorrectionCredit(i);
  const correction = sourceCorrection || targetCorrection;
  const summary = correction ? { sourceInvoiceId: correction.sourceInvoiceId, targetInvoiceId: correction.targetInvoiceId,
    action: correction.action, originalCustomerId: correction.originalCustomerId, transferredCredit: correction.transferredCredit,
    retainedCredit: correction.retainedCredit, actorId: correction.actorId, reason: correction.reason, createdAt: correction.createdAt } : null;
  if (sourceCorrection) {
    const outgoing = (i.creditApplicationsFrom || []).filter((a: any) => !a.reversedAt);
    const used = roundCurrency(outgoing.reduce((n: number, a: any) => n + effectiveApplicationAmount(a), 0));
    const available = roundCurrency(sourceCorrection.retainedCredit + (restoredInheritedCredit(sourceCorrection, sourceCorrection.targetInvoice) || 0) - used - paidOutCredit);
    const invalid = releaseReason || correctionReason || payoutReason || ((i.creditApplicationsTo || []).some((a: any) => !a.reversedAt && effectiveApplicationAmount(a)>0)
      || outgoing.some((a: any) => !Number.isFinite(a.amount) || a.amount <= 0 || roundCurrency(a.amount) !== a.amount || effectiveApplicationAmount(a)<0 || (a.sourceInvoiceId === i.id && applicationReleaseReason(a.targetInvoice))
        || !applicationSourceMatches(a, i.customerId) || a.sourceCorrectionId !== sourceCorrection.id || a.sourceInvoiceId !== i.id
        || a.targetInvoiceId === i.id || a.targetInvoice?.id !== a.targetInvoiceId || a.targetInvoice?.customerId !== i.customerId)
      || available < 0 ? "Correction credit application or original ownership does not reconcile" : null);
    return { invoiceId: i.id, invoiceNo: i.invoiceNo, basis: invalid ? "UNRESOLVED" : "CAPTURED_CORRECTION", reason: invalid,
      originalPayable: target, returnAdjustment: 0, recordedReceipts: paid, appliedCredit: 0, correctionCredit: 0,
      capturedCorrectionCredit, correctionCreditReleased, restoredSourceCredit: restoredInheritedCredit(sourceCorrection, sourceCorrection.targetInvoice) || 0, usedCredit: used, creditSources: !invalid && sourceCorrection.originalCustomerId ? [{ correctionId: sourceCorrection.id, retainedCredit: roundCurrency(sourceCorrection.retainedCredit + (restoredInheritedCredit(sourceCorrection, sourceCorrection.targetInvoice) || 0)), availableCredit: available }] : [],
      applications: projectApplications(i), payouts: payouts.map(projectPayout), paidOutCredit, correction: summary,
      due: invalid ? null : 0, retainedCredit: invalid ? null : available };
  }
  const financialReturns = returns.filter((r: any) => ["APPROVED", "REVERSED"].includes(r.status));
  const approved = returns.filter((r: any) => r.status === "APPROVED");
  if (i.status !== "FINALIZED" || i.paymentStatus === "CANCELLED" || i.cancelledAt || i.deletedAt) reason = "Cancelled, deleted or unfinalized sale requires separate settlement review";
  if ((i.creditNotesAsOriginal || []).length || (i.creditNoteAsReplacement && !targetCorrection)) reason = "Replacement or transferred credit requires source allocation review";
  if (payments.some((p: any) => p.kind === "REFUND") || financialReturns.some((r: any) => !parseReturnSettlement(r.settlement))) reason = "Legacy refund or return settlement is unresolved";
  if (payments.some((p: any) => p.kind === "CHARGE" && p.status === "PENDING" && p.method === "ESEWA" && !p.voidedAt)) reason = "Online payment outcome is pending verification";
  if (!Number.isFinite(Number(i.netTotal)) || Number(i.netTotal) < 0 || !Number.isSafeInteger(target) || !Number.isSafeInteger(adjustment) || adjustment < 0 || adjustment > target
      || chargeRows.some((p: any) => !Number.isFinite(Number(p.amount)) || Number(p.amount) < 0 || p.voidedAt)
      || !Number.isFinite(Number(i.paidTotal)) || roundCurrency(Number(i.paidTotal)) !== paid) reason = "Invoice or charge projection does not reconcile";
  const allocation = approved.map((r: any) => parseReturnSettlement(r.settlement));
  if (allocation.some((s: any) => !s || s.originalCustomerId !== (i.customerId || null) || s.originalPayable !== target || s.approvalOrder < 1)
      || allocation.reduce((sum: number, s: any) => sum + Number(s?.approvedReturnValue || 0), 0) !== adjustment) reason = "Return adjustment or original credit ownership does not reconcile";
  if (targetCorrection && (correctionReason || !i.creditNoteAsReplacement || i.creditNoteAsReplacement.originalInvoiceId !== targetCorrection.sourceInvoiceId
    || i.creditNoteAsReplacement.creditedAmount !== capturedCorrectionCredit || (!approved.length && roundCurrency(paid + correctionCredit) > target)
    || (approved.length && allocation.some((s: any) => ![3,5].includes(s?.version) || s.inheritedCorrectionId !== targetCorrection.id || s.inheritedCredit !== capturedCorrectionCredit)))) reason = correctionReason || "Replacement settlement does not reconcile";
  if (!targetCorrection && allocation.some((s: any) => ![2,4].includes(s?.version))) reason = "Inherited return credit requires a captured original source";
  if (!Number.isFinite(correctionCredit) || correctionCredit < 0 || (!targetCorrection && (correctionCredit !== 0 || correctionCreditReleased !== 0))) reason = "Correction credit requires a captured source allocation";
  const credit = roundCurrency(Math.max(0, paid - (target - adjustment)));
  if (!reason && roundCurrency(allocation.reduce((sum: number, s: any) => sum + s.retainedCredit, 0)) !== credit) reason = "Retained credit requires an audited allocation review";
  const incoming = (i.creditApplicationsTo || []).filter((a: any) => !a.reversedAt);
  const outgoing = (i.creditApplicationsFrom || []).filter((a: any) => !a.reversedAt);
  const applied = roundCurrency(incoming.reduce((sum: number, a: any) => sum + effectiveApplicationAmount(a), 0));
  const used = roundCurrency(outgoing.reduce((sum: number, a: any) => sum + effectiveApplicationAmount(a), 0));
  const creditSources: { returnId?: string; correctionId?: string; retainedCredit: number; availableCredit: number }[] = approved.map((r: any) => ({ returnId: r.id, retainedCredit: parseReturnSettlement(r.settlement)?.retainedCredit || 0,
    availableCredit: roundCurrency((parseReturnSettlement(r.settlement)?.retainedCredit || 0) - outgoing.filter((a: any) => a.sourceReturnId === r.id).reduce((sum: number, a: any) => sum + effectiveApplicationAmount(a), 0) - activePayouts.filter((p: any) => p.sourceReturnId === r.id).reduce((n: number, p: any) => n + p.amount, 0)) }));
  if (!Number.isFinite(Number(i.creditApplied || 0)) || roundCurrency(Number(i.creditApplied || 0)) !== applied
      || [...incoming, ...outgoing].some((a: any) => !Number.isFinite(a.amount) || a.amount <= 0 || roundCurrency(a.amount) !== a.amount || effectiveApplicationAmount(a)<0 || (a.sourceInvoiceId === i.id && applicationReleaseReason(a.targetInvoice))
        || !i.customerId || a.originalCustomerId !== i.customerId || a.sourceInvoiceId === a.targetInvoiceId
        || !applicationSourceMatches(a, i.customerId))
      || incoming.some((a: any) => a.targetInvoiceId !== i.id || a.sourceInvoice?.customerId !== i.customerId
        || a.sourceInvoice?.status !== "FINALIZED"
        || (effectiveApplicationAmount(a)>0 && projectReceivableInvoice(a.sourceInvoice).reason))
      || outgoing.some((a: any) => a.sourceInvoiceId !== i.id || a.sourceReturn?.invoiceId !== i.id || a.targetInvoice?.customerId !== i.customerId)
      || used + paidOutCredit > credit || creditSources.some((s: any) => s.availableCredit < 0)
      || applied > Math.max(0, target - adjustment - paid - correctionCredit) || (applied > 0 && approved.length > 0 && allocation.some((s:any)=>![4,5].includes(s?.version)))) reason = "Credit application projection or original ownership does not reconcile";
  if (releaseReason) reason = releaseReason;
  if (payoutReason) reason = payoutReason;
  return { invoiceId: i.id, invoiceNo: i.invoiceNo, basis: reason ? "UNRESOLVED" : targetCorrection ? "CAPTURED_CORRECTION" : "ORIGINAL_SALE_DEBT_FIRST", reason,
    originalPayable: target, returnAdjustment: adjustment, recordedReceipts: paid,
    correctionCredit, capturedCorrectionCredit, correctionCreditReleased, correction: summary, appliedCredit: applied, usedCredit: used, creditSources: reason ? [] : creditSources,
    applications: projectApplications(i), payouts: payouts.map(projectPayout), paidOutCredit,
    due: reason ? null : roundCurrency(Math.max(0, target - adjustment - paid - applied - correctionCredit)), retainedCredit: reason ? null : roundCurrency(credit - used - paidOutCredit) };
}

export function summarizeReceivableCustomer(customer: any) {
  const invoices = customer.invoices.map(projectReceivableInvoice);
  const supported = invoices.filter((i: any) => i.basis !== "UNRESOLVED");
  const supportedDue = roundCurrency(supported.reduce((sum: number, i: any) => sum + i.due, 0));
  const supportedCredit = roundCurrency(supported.reduce((sum: number, i: any) => sum + i.retainedCredit, 0));
  const unresolvedCount = invoices.length - supported.length;
  return { id: customer.id, name: customer.name, isActive: customer.isActive, due: unresolvedCount ? null : supportedDue,
    retainedCredit: unresolvedCount ? null : supportedCredit, supportedDue, supportedCredit, unresolvedCount, invoices };
}

const listSchema = z.object({ q: z.string().trim().max(100).default(""), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export async function listCustomerReceivables(query: unknown, role: string) {
  if (!["ADMIN", "MANAGER"].includes(role)) throw new Error("Customer receivables require administrator or manager access");
  const { q, page, pageSize } = listSchema.parse(query);
  const where: Prisma.CustomerWhereInput = q ? { name: { contains: q } } : {};
  return prisma.$transaction(async tx => {
    const customers = await tx.customer.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], take: pageSize, skip: (page - 1) * pageSize,
      select: { id: true, name: true, isActive: true, invoices: { where: { status: "FINALIZED" }, orderBy: [{ finalizedAt: "desc" }, { id: "desc" }],
        include: receivableInclude } } });
    const total = await tx.customer.count({ where });
    return { items: customers.map(summarizeReceivableCustomer), total, page, pageSize, totalPages: Math.ceil(total / pageSize),
      basis: "Recorded original-sale and captured correction obligations and successful receipts; due and retained credit are separate, unknown settlement is withheld" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
