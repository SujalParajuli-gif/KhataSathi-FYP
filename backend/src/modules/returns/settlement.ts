import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { runFinancialTransaction, lockInvoiceForUpdate } from "../../lib/transactionLocks";
import { getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";

export class ReturnSettlementConflict extends Error {
  readonly code = "RETURN_SETTLEMENT_CONFLICT";
}
export type ReturnSettlement = {
  version: 2; originalCustomerId: string | null; originalPayable: number;
  approvedReturnValue: number; debtReduction: number; retainedCredit: number; approvalOrder: number;
};
export function parseReturnSettlement(value: unknown): ReturnSettlement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as ReturnSettlement;
  if (s.version !== 2 || !(s.originalCustomerId === null || (typeof s.originalCustomerId === "string" && s.originalCustomerId.length > 0))) return null;
  if (![s.originalPayable, s.approvedReturnValue, s.approvalOrder].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  if (![s.debtReduction, s.retainedCredit].every(n => Number.isFinite(n) && n >= 0 && roundCurrency(n) === n)) return null;
  if (s.approvedReturnValue > s.originalPayable || roundCurrency(s.debtReduction + s.retainedCredit) !== s.approvedReturnValue) return null;
  return s;
}
export function allocateReturn(params: { netTotal: number; subTotal: number; approvedGross: number; nextGross: number; previousAdjustment: number; paid: number }) {
  const { netTotal, subTotal, approvedGross, nextGross, previousAdjustment, paid } = params;
  const target = getInvoicePaymentTargetTotal(netTotal);
  if (![netTotal, subTotal, approvedGross, nextGross, previousAdjustment, paid].every(n => Number.isFinite(n) && n >= 0)
    || !Number.isSafeInteger(target) || target > 2147483647 || !Number.isSafeInteger(previousAdjustment) || previousAdjustment > target
    || roundCurrency(approvedGross + nextGross) > roundCurrency(subTotal)) throw new ReturnSettlementConflict("Return invoice allocation basis is inconsistent");
  if (target > 0 && roundCurrency(subTotal) <= 0) throw new ReturnSettlementConflict("Return invoice subtotal basis is unavailable");
  const cumulative = target === 0 || subTotal === 0 ? 0 : Math.min(target, Math.round(target * roundCurrency(approvedGross + nextGross) / roundCurrency(subTotal)));
  const value = cumulative - previousAdjustment;
  if (value < 0) throw new ReturnSettlementConflict("Return invoice allocation changed; reload the original sale");
  const debtReduction = roundCurrency(Math.min(value, Math.max(0, target - previousAdjustment - paid)));
  return { adjustment: cumulative, approvedReturnValue: value, debtReduction, retainedCredit: roundCurrency(value - debtReduction) };
}
export async function updateReturnedInvoiceTx(tx: any, invoice: any, adjustment: number) {
  const payments = await tx.payment.findMany({ where: { invoiceId: invoice.id, kind: "CHARGE", status: "SUCCESS" }, select: { amount: true } });
  const paidTotal = roundCurrency(payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
  const target = getInvoicePaymentTargetTotal(invoice.netTotal, adjustment);
  return tx.invoice.update({ where: { id: invoice.id }, data: { returnAdjustment: adjustment, paidTotal,
    paymentStatus: paidTotal >= target ? "PAID" : paidTotal > 0 ? "PARTIALLY_PAID" : "UNPAID" } });
}

export async function assertOriginalReturnBasisTx(tx: any, invoice: any) {
  if (!Number.isFinite(invoice.netTotal) || invoice.netTotal < 0 || getInvoicePaymentTargetTotal(invoice.netTotal) > 2147483647) throw new ReturnSettlementConflict("Return invoice exceeds the supported settlement amount");
  const links = await tx.creditNote.count({ where: { OR: [{ originalInvoiceId: invoice.id }, { replacementInvoiceId: invoice.id }] } });
  const refunds = await tx.payment.count({ where: { invoiceId: invoice.id, kind: "REFUND" } });
  const returns = await tx.returnRequest.findMany({ where: { invoiceId: invoice.id, status: { in: ["APPROVED", "REVERSED"] } }, select: { status: true, settlement: true } });
  if (links || refunds || returns.some((r: any) => !parseReturnSettlement(r.settlement))) {
    throw new ReturnSettlementConflict("Return invoice has unresolved legacy refunds or replacement credit; settlement review is required");
  }
  const approved = returns.filter((r: any) => r.status === "APPROVED");
  const adjustment = approved.reduce((sum: number, r: any) => sum + parseReturnSettlement(r.settlement)!.approvedReturnValue, 0);
  if (adjustment !== Number(invoice.returnAdjustment || 0)
      || approved.some((r: any) => { const s = parseReturnSettlement(r.settlement)!; return s.approvalOrder < 1 || s.originalCustomerId !== (invoice.customerId || null) || s.originalPayable !== getInvoicePaymentTargetTotal(invoice.netTotal); })) {
    throw new ReturnSettlementConflict("Return invoice settlement projection or ownership is inconsistent");
  }
}

type Operation = { action: "CREATE" | "APPROVE" | "REJECT" | "REVERSE"; actorId: string; invoiceId: string; requestId?: string; operationKey?: string; content: unknown };
export async function runReturnOperation(input: Operation, work: (tx: any) => Promise<any>) {
  const key = input.operationKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(key)) throw new ReturnSettlementConflict("Return operation key is required; retry with the original operation identity");
  const hash = createHash("sha256").update(JSON.stringify({ action: input.action, actorId: input.actorId, invoiceId: input.invoiceId, requestId: input.requestId || null, content: input.content })).digest("hex");
  const replay = (row: any) => {
    if (row.payloadHash !== hash) throw new ReturnSettlementConflict("Return operation conflicts with its original actor, action or payload");
    return row.responseJson;
  };
  const prior = await prisma.returnOperation.findUnique({ where: { operationKey: key } });
  if (prior) return replay(prior);
  try {
    return await runFinancialTransaction(prisma, async (tx: any) => {
      await lockInvoiceForUpdate(tx, input.invoiceId);
      const existing = await tx.returnOperation.findUnique({ where: { operationKey: key } });
      if (existing) return replay(existing);
      const result = await work(tx);
      if (!result?.id) throw new Error("Return response missing its recorded request");
      const response = JSON.parse(JSON.stringify(result));
      await tx.returnOperation.create({ data: { operationKey: key, payloadHash: hash, actorId: input.actorId, returnRequestId: result.id, action: input.action, responseJson: response as Prisma.InputJsonValue } });
      return response;
    });
  } catch (error) {
    if (String((error as any)?.code) === "P2002") {
      const winner = await prisma.returnOperation.findUnique({ where: { operationKey: key } });
      if (winner) return replay(winner);
    }
    throw error;
  }
}
