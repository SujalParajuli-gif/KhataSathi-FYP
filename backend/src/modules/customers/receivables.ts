import { correctionRecordReason } from "../invoices/correctionSettlement";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../db/prisma";
import { getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";

const correctionInclude = {
  correctionAsSource: { include: { targetInvoice: true } },
  correctionAsTarget: { include: { sourceInvoice: { include: { payments: true, returnRequests: true, creditNotesAsOriginal: true, creditNoteAsReplacement: true } } } },
} satisfies Prisma.InvoiceInclude;
export const receivableInclude = {
  ...correctionInclude,
  payments: true, returnRequests: true, creditNotesAsOriginal: true, creditNoteAsReplacement: true,
  creditApplicationsFrom: { include: { sourceReturn: true, targetInvoice: { select: { id: true, invoiceNo: true, customerId: true } } } },
  creditApplicationsTo: { include: { sourceReturn: true, sourceInvoice: { include: {
    ...correctionInclude, payments: true, returnRequests: true, creditNotesAsOriginal: true, creditNoteAsReplacement: true,
    creditApplicationsFrom: { include: { sourceReturn: true, targetInvoice: { select: { id: true, invoiceNo: true, customerId: true } } } },
  } } } },
} satisfies Prisma.InvoiceInclude;

export function projectReceivableInvoice(i: any) {
  let reason: string | null = null;
  const target = getInvoicePaymentTargetTotal(Number(i.netTotal));
  const payments = i.payments || [];
  const chargeRows = payments.filter((p: any) => p.kind === "CHARGE" && p.status === "SUCCESS");
  const paid = roundCurrency(chargeRows.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
  const adjustment = Number(i.returnAdjustment || 0);
  const returns = i.returnRequests || [];
  const sourceCorrection = i.correctionAsSource;
  const targetCorrection = i.correctionAsTarget;
  const correctionReason = sourceCorrection ? correctionRecordReason(sourceCorrection, i, sourceCorrection.targetInvoice)
    : targetCorrection ? correctionRecordReason(targetCorrection, targetCorrection.sourceInvoice, i) : null;
  const correctionCredit = Number(i.correctionCredit || 0);
  const correction = sourceCorrection || targetCorrection;
  const summary = correction ? { sourceInvoiceId: correction.sourceInvoiceId, targetInvoiceId: correction.targetInvoiceId,
    action: correction.action, originalCustomerId: correction.originalCustomerId, transferredCredit: correction.transferredCredit,
    retainedCredit: correction.retainedCredit, actorId: correction.actorId, reason: correction.reason, createdAt: correction.createdAt } : null;
  if (sourceCorrection) {
    return { invoiceId: i.id, invoiceNo: i.invoiceNo, basis: correctionReason ? "UNRESOLVED" : "CAPTURED_CORRECTION", reason: correctionReason,
      originalPayable: target, returnAdjustment: 0, recordedReceipts: paid, appliedCredit: 0, correctionCredit: 0,
      usedCredit: 0, creditSources: [], applications: [], correction: summary,
      due: correctionReason ? null : 0, retainedCredit: correctionReason ? null : sourceCorrection.retainedCredit };
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
    || i.creditNoteAsReplacement.creditedAmount !== correctionCredit || roundCurrency(paid + correctionCredit) > target || approved.length)) reason = correctionReason || "Replacement settlement does not reconcile";
  if (!Number.isFinite(correctionCredit) || correctionCredit < 0 || (!targetCorrection && correctionCredit !== 0)) reason = "Correction credit requires a captured source allocation";
  const credit = roundCurrency(Math.max(0, paid - (target - adjustment)));
  if (!reason && roundCurrency(allocation.reduce((sum: number, s: any) => sum + s.retainedCredit, 0)) !== credit) reason = "Retained credit requires an audited allocation review";
  const incoming = (i.creditApplicationsTo || []).filter((a: any) => !a.reversedAt);
  const outgoing = (i.creditApplicationsFrom || []).filter((a: any) => !a.reversedAt);
  const applied = roundCurrency(incoming.reduce((sum: number, a: any) => sum + Number(a.amount), 0));
  const used = roundCurrency(outgoing.reduce((sum: number, a: any) => sum + Number(a.amount), 0));
  const creditSources = approved.map((r: any) => ({ returnId: r.id, retainedCredit: parseReturnSettlement(r.settlement)?.retainedCredit || 0,
    availableCredit: roundCurrency((parseReturnSettlement(r.settlement)?.retainedCredit || 0) - outgoing.filter((a: any) => a.sourceReturnId === r.id).reduce((sum: number, a: any) => sum + Number(a.amount), 0)) }));
  if (!Number.isFinite(Number(i.creditApplied || 0)) || roundCurrency(Number(i.creditApplied || 0)) !== applied
      || [...incoming, ...outgoing].some((a: any) => !Number.isFinite(a.amount) || a.amount <= 0 || roundCurrency(a.amount) !== a.amount
        || !i.customerId || a.originalCustomerId !== i.customerId || a.sourceInvoiceId === a.targetInvoiceId
        || a.sourceReturn?.status !== "APPROVED" || parseReturnSettlement(a.sourceReturn?.settlement)?.originalCustomerId !== i.customerId)
      || incoming.some((a: any) => a.targetInvoiceId !== i.id || a.sourceReturn?.invoiceId !== a.sourceInvoiceId || a.sourceInvoice?.customerId !== i.customerId
        || a.sourceInvoice?.status !== "FINALIZED" || a.sourceInvoice?.paymentStatus === "CANCELLED" || a.sourceInvoice?.cancelledAt || a.sourceInvoice?.deletedAt
        || projectReceivableInvoice(a.sourceInvoice).reason)
      || outgoing.some((a: any) => a.sourceInvoiceId !== i.id || a.sourceReturn?.invoiceId !== i.id || a.targetInvoice?.customerId !== i.customerId)
      || used > credit || creditSources.some((s: any) => s.availableCredit < 0)
      || applied > Math.max(0, target - adjustment - paid - correctionCredit) || (applied > 0 && approved.length > 0)) reason = "Credit application projection or original ownership does not reconcile";
  return { invoiceId: i.id, invoiceNo: i.invoiceNo, basis: reason ? "UNRESOLVED" : targetCorrection ? "CAPTURED_CORRECTION" : "ORIGINAL_SALE_DEBT_FIRST", reason,
    originalPayable: target, returnAdjustment: adjustment, recordedReceipts: paid,
    correctionCredit, correction: summary, appliedCredit: applied, usedCredit: used, creditSources: reason ? [] : creditSources,
    applications: [...(i.creditApplicationsFrom || []), ...(i.creditApplicationsTo || [])].map((a: any) => ({ id: a.id, sourceInvoiceId: a.sourceInvoiceId,
      sourceInvoiceNo: a.sourceInvoice?.invoiceNo || i.invoiceNo, targetInvoiceId: a.targetInvoiceId, targetInvoiceNo: a.targetInvoice?.invoiceNo || i.invoiceNo,
      sourceReturnId: a.sourceReturnId, amount: a.amount, reason: a.reason, actorId: a.actorId, createdAt: a.createdAt, reversedAt: a.reversedAt, reversedById: a.reversedById, reversalReason: a.reversalReason })),
    due: reason ? null : roundCurrency(Math.max(0, target - adjustment - paid - applied - correctionCredit)), retainedCredit: reason ? null : roundCurrency(credit - used) };
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
