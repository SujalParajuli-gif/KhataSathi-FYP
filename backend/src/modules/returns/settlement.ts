import { ApplicationRelease, parseApplicationReleases, applicationReturnBasisTx, discoverApplicationSources, assertApplicationSourcesTx } from "../customers/applicationSettlement";
import { receivableInclude, projectReceivableInvoice } from "../customers/receivables";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { runFinancialTransaction, lockInvoiceForUpdate } from "../../lib/transactionLocks";
import { effectiveCorrectionCredit, getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";

export class ReturnSettlementConflict extends Error {
  readonly code = "RETURN_SETTLEMENT_CONFLICT";
}
export type ReturnSettlement = {
  version: 2 | 3 | 4; originalCustomerId: string | null; originalPayable: number;
  approvedReturnValue: number; debtReduction: number; retainedCredit: number; approvalOrder: number;
  inheritedCorrectionId?: string; inheritedCredit?: number; restoredCredit?: number;
  recordedReceipts?: number;
  applications?: ApplicationRelease[];
};
export function parseReturnSettlement(value: unknown): ReturnSettlement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as ReturnSettlement;
  if (![2, 3, 4].includes(s.version) || !(s.originalCustomerId === null || (typeof s.originalCustomerId === "string" && s.originalCustomerId.length > 0))) return null;
  if (![s.originalPayable, s.approvedReturnValue, s.approvalOrder].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  if (![s.debtReduction, s.retainedCredit].every(n => Number.isFinite(n) && n >= 0 && roundCurrency(n) === n)) return null;
  if (s.version === 3 && (!s.originalCustomerId || typeof s.inheritedCorrectionId !== "string" || !s.inheritedCorrectionId
      || ![s.inheritedCredit, s.restoredCredit, s.recordedReceipts].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && roundCurrency(n) === n)
      || s.restoredCredit! > s.inheritedCredit!)) return null;
  if (s.version === 4 && (!s.originalCustomerId || !parseApplicationReleases(s.applications) || !Number.isFinite(s.recordedReceipts) || s.recordedReceipts! < 0 || roundCurrency(s.recordedReceipts!) !== s.recordedReceipts)) return null;
  if (s.approvedReturnValue > s.originalPayable || roundCurrency(s.debtReduction + s.retainedCredit + (s.version === 3 ? s.restoredCredit! : s.version === 4 ? roundCurrency(s.applications!.reduce((n,a)=>n+a.released,0)) : 0)) !== s.approvedReturnValue) return null;
  return s.version === 4 ? {...s,applications:parseApplicationReleases(s.applications)!} : s;
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
export async function updateReturnedInvoiceTx(tx: any, invoice: any, adjustment: number, released = Number(invoice.correctionCreditReleased || 0), applied = Number(invoice.creditApplied || 0)) {
  const payments = await tx.payment.findMany({ where: { invoiceId: invoice.id, kind: "CHARGE", status: "SUCCESS" }, select: { amount: true } });
  const paidTotal = roundCurrency(payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
  const credit = effectiveCorrectionCredit({ ...invoice, correctionCreditReleased: released });
  const target = getInvoicePaymentTargetTotal(invoice.netTotal, adjustment, applied, credit);
  return tx.invoice.update({ where: { id: invoice.id }, data: { returnAdjustment: adjustment, paidTotal, creditApplied: applied, ...(invoice.correctionCredit ? { correctionCreditReleased: released } : {}),
    paymentStatus: paidTotal >= target ? "PAID" : paidTotal + credit + applied > 0 ? "PARTIALLY_PAID" : "UNPAID" } });
}

export async function assertOriginalReturnBasisTx(tx: any, invoice: any): Promise<any> {
  if (Number(invoice.creditApplied || 0) > 0 || (await tx.returnRequest.findMany({where:{invoiceId:invoice.id,status:"APPROVED"},select:{settlement:true}})).some((r:any)=>r.settlement?.version === 4)) return { application: await applicationReturnBasisTx(tx, invoice) };
  const parent = await tx.invoiceCorrectionSettlement.findUnique({ where: { targetInvoiceId: invoice.id } });
  if (parent) {
    const full = await tx.invoice.findUnique({ where: { id: invoice.id }, include: receivableInclude });
    const projection = projectReceivableInvoice(full);
    if (!invoice.customerId || parent.originalCustomerId !== invoice.customerId || projection.reason
        || (full.creditApplicationsTo || []).some((a: any) => !a.reversedAt)
        || (full.creditApplicationsFrom || []).some((a: any) => !a.reversedAt)
        || full.correctionAsSource || parent.sourceInvoiceId === invoice.id) throw new ReturnSettlementConflict(projection.reason || "Replacement requires a reconciled single original credit source");
    return { id: parent.id, inheritedCredit: parent.transferredCredit };
  }
  if (!Number.isFinite(invoice.netTotal) || invoice.netTotal < 0 || getInvoicePaymentTargetTotal(invoice.netTotal) > 2147483647) throw new ReturnSettlementConflict("Return invoice exceeds the supported settlement amount");
  const links = await tx.creditNote.count({ where: { OR: [{ originalInvoiceId: invoice.id }, { replacementInvoiceId: invoice.id }] } });
  const refunds = await tx.payment.count({ where: { invoiceId: invoice.id, kind: "REFUND" } });
  const returns = await tx.returnRequest.findMany({ where: { invoiceId: invoice.id, status: { in: ["APPROVED", "REVERSED"] } }, select: { status: true, settlement: true } });
  if (links || refunds || returns.some((r: any) => parseReturnSettlement(r.settlement)?.version !== 2 && !(r.status === "REVERSED" && parseReturnSettlement(r.settlement)?.version === 4))) {
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
  const applicationSources = await discoverApplicationSources(input.invoiceId);
  const parent = await prisma.invoiceCorrectionSettlement.findUnique({ where: { targetInvoiceId: input.invoiceId } });
  try {
    return await runFinancialTransaction(prisma, async (tx: any) => {
      for (const id of [...new Set([input.invoiceId, ...applicationSources, ...(parent ? [parent.sourceInvoiceId] : [])])].sort()) await lockInvoiceForUpdate(tx, id);
      const existing = await tx.returnOperation.findUnique({ where: { operationKey: key } });
      if (existing) return replay(existing);
      await assertApplicationSourcesTx(tx,input.invoiceId,applicationSources);
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
