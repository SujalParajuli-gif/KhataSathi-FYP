import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../db/prisma";
import { getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";

export function projectReceivableInvoice(i: any) {
  let reason: string | null = null;
  const target = getInvoicePaymentTargetTotal(Number(i.netTotal));
  const payments = i.payments || [];
  const chargeRows = payments.filter((p: any) => p.kind === "CHARGE" && p.status === "SUCCESS");
  const paid = roundCurrency(chargeRows.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
  const adjustment = Number(i.returnAdjustment || 0);
  const returns = i.returnRequests || [];
  const financialReturns = returns.filter((r: any) => ["APPROVED", "REVERSED"].includes(r.status));
  const approved = returns.filter((r: any) => r.status === "APPROVED");
  if (i.status !== "FINALIZED" || i.paymentStatus === "CANCELLED" || i.cancelledAt || i.deletedAt) reason = "Cancelled, deleted or unfinalized sale requires separate settlement review";
  if ((i.creditNotesAsOriginal || []).length || i.creditNoteAsReplacement) reason = "Replacement or transferred credit requires source allocation review";
  if (payments.some((p: any) => p.kind === "REFUND") || financialReturns.some((r: any) => !parseReturnSettlement(r.settlement))) reason = "Legacy refund or return settlement is unresolved";
  if (payments.some((p: any) => p.kind === "CHARGE" && p.status === "PENDING" && p.method === "ESEWA" && !p.voidedAt)) reason = "Online payment outcome is pending verification";
  if (!Number.isFinite(Number(i.netTotal)) || Number(i.netTotal) < 0 || !Number.isSafeInteger(target) || !Number.isSafeInteger(adjustment) || adjustment < 0 || adjustment > target
      || chargeRows.some((p: any) => !Number.isFinite(Number(p.amount)) || Number(p.amount) < 0 || p.voidedAt)
      || !Number.isFinite(Number(i.paidTotal)) || roundCurrency(Number(i.paidTotal)) !== paid) reason = "Invoice or charge projection does not reconcile";
  const allocation = approved.map((r: any) => parseReturnSettlement(r.settlement));
  if (allocation.some((s: any) => !s || s.originalCustomerId !== (i.customerId || null) || s.originalPayable !== target || s.approvalOrder < 1)
      || allocation.reduce((sum: number, s: any) => sum + Number(s?.approvedReturnValue || 0), 0) !== adjustment) reason = "Return adjustment or original credit ownership does not reconcile";
  const credit = roundCurrency(Math.max(0, paid - (target - adjustment)));
  if (!reason && roundCurrency(allocation.reduce((sum: number, s: any) => sum + s.retainedCredit, 0)) !== credit) reason = "Retained credit requires an audited allocation review";
  return { invoiceId: i.id, invoiceNo: i.invoiceNo, basis: reason ? "UNRESOLVED" : "ORIGINAL_SALE_DEBT_FIRST", reason,
    originalPayable: target, returnAdjustment: adjustment, recordedReceipts: paid,
    due: reason ? null : roundCurrency(Math.max(0, target - adjustment - paid)), retainedCredit: reason ? null : credit };
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
        select: { id: true, invoiceNo: true, status: true, paymentStatus: true, netTotal: true, paidTotal: true, returnAdjustment: true, customerId: true, cancelledAt: true, deletedAt: true,
          payments: { select: { id: true, amount: true, kind: true, status: true, method: true, voidedAt: true } },
          returnRequests: { select: { status: true, settlement: true } },
          creditNotesAsOriginal: { select: { id: true } }, creditNoteAsReplacement: { select: { id: true } } } } } });
    const total = await tx.customer.count({ where });
    return { items: customers.map(summarizeReceivableCustomer), total, page, pageSize, totalPages: Math.ceil(total / pageSize),
      basis: "Recorded original-sale obligations and successful receipts; due and retained credit are separate, unknown settlement is withheld" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
