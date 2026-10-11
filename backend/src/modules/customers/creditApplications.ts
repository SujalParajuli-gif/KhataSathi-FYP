import { effectiveApplicationAmount } from "./applicationSettlement";
import { effectiveCorrectionCredit } from "../../lib/money";
import { createHash } from "node:crypto";
import { z } from "zod";
import prisma from "../../db/prisma";
import { lockInvoiceForUpdate, runFinancialTransaction } from "../../lib/transactionLocks";
import { getInvoicePaymentTargetTotal, roundCurrency } from "../../lib/money";
import { parseReturnSettlement } from "../returns/settlement";
import { projectReceivableInvoice, receivableInclude } from "./receivables";

export class CreditApplicationConflict extends Error {}
const key = z.string().regex(/^[A-Za-z0-9_-]{16,120}$/);
const reason = z.string().trim().min(1).max(500);
const applySchema = z.object({ sourceReturnId: z.string().min(1).max(100).optional(), sourceCorrectionId: z.string().min(1).max(100).optional(), targetInvoiceId: z.string().min(1).max(100),
  amount: z.number().finite().positive().max(2147483647).refine(n => roundCurrency(n) === n), reason, operationKey: key }).strict().refine(d => Boolean(d.sourceReturnId) !== Boolean(d.sourceCorrectionId), { message: "Exactly one return or correction source is required" });
const reverseSchema = z.object({ reason, operationKey: key }).strict();

async function assertActor(actorId: string) {
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
  if (!actor?.isActive || !["ADMIN", "MANAGER"].includes(actor.role)) throw new CreditApplicationConflict("Credit applications require administrator or manager access");
}
async function operation(actorId: string, action: "APPLY" | "REVERSE", operationKey: string, content: unknown,
  invoiceIds: string[], work: (tx: any) => Promise<any>) {
  const payloadHash = createHash("sha256").update(JSON.stringify({ actorId, action, content })).digest("hex");
  const replay = (row: any) => {
    if (row.payloadHash !== payloadHash) throw new CreditApplicationConflict("Credit operation conflicts with its original actor, action or payload");
    return row.responseJson;
  };
  const prior = await prisma.customerCreditOperation.findUnique({ where: { operationKey } });
  if (prior) return replay(prior);
  try {
    return await runFinancialTransaction(prisma, async tx => {
      for (const id of [...new Set(invoiceIds)].sort()) await lockInvoiceForUpdate(tx, id);
      const existing = await tx.customerCreditOperation.findUnique({ where: { operationKey } });
      if (existing) return replay(existing);
      const result = await work(tx);
      const response = JSON.parse(JSON.stringify(result));
      await tx.customerCreditOperation.create({ data: { actorId, action, operationKey, payloadHash, applicationId: result.id, responseJson: response } });
      return response;
    });
  } catch (error) {
    if ((error as any)?.code === "P2002") {
      const winner = await prisma.customerCreditOperation.findUnique({ where: { operationKey } });
      if (winner) return replay(winner);
    }
    throw error;
  }
}
async function supportedInvoice(tx: any, id: string) {
  const invoice = await tx.invoice.findUnique({ where: { id }, include: receivableInclude });
  if (!invoice) throw new CreditApplicationConflict("Credit application sale was not found");
  const projection = projectReceivableInvoice(invoice);
  if (projection.reason) throw new CreditApplicationConflict(projection.reason);
  return { invoice, projection };
}
async function recomputeTarget(tx: any, invoice: any) {
  const rows = await tx.customerCreditApplication.findMany({ where: { targetInvoiceId: invoice.id, reversedAt: null }, select: { amount: true, amountReleased:true } });
  const creditApplied = roundCurrency(rows.reduce((sum: number, a: any) => sum + effectiveApplicationAmount(a), 0));
  const target = getInvoicePaymentTargetTotal(invoice.netTotal, invoice.returnAdjustment, creditApplied, effectiveCorrectionCredit(invoice));
  const paid = roundCurrency(invoice.paidTotal);
  await tx.invoice.update({ where: { id: invoice.id }, data: { creditApplied,
    paymentStatus: paid >= target ? "PAID" : paid + creditApplied + Number(effectiveCorrectionCredit(invoice)) > 0 ? "PARTIALLY_PAID" : "UNPAID" } });
}
export async function applyCustomerCredit(actorId: string, input: unknown) {
  const data = applySchema.parse(input);
  await assertActor(actorId);
  const source = data.sourceReturnId
    ? await prisma.returnRequest.findUnique({ where: { id: data.sourceReturnId }, select: { invoiceId: true } })
    : await prisma.invoiceCorrectionSettlement.findUnique({ where: { id: data.sourceCorrectionId! }, select: { sourceInvoiceId: true } }).then(r => r && { invoiceId: r.sourceInvoiceId });
  if (!source) throw new CreditApplicationConflict("Credit source was not found");
  const { operationKey, ...content } = data;
  return operation(actorId, "APPLY", operationKey, content, [source.invoiceId, data.targetInvoiceId], async tx => {
    const from = await supportedInvoice(tx, source.invoiceId), to = await supportedInvoice(tx, data.targetInvoiceId);
    const settlement = data.sourceReturnId ? from.invoice.returnRequests.find((r: any) => r.id === data.sourceReturnId && r.status === "APPROVED") : null;
    const basis = data.sourceReturnId ? parseReturnSettlement(settlement?.settlement)
      : from.invoice.correctionAsSource?.id === data.sourceCorrectionId ? from.invoice.correctionAsSource : null;
    if ([4,5].includes(basis?.version) || [2,3].includes((basis as any)?.inheritedFunding?.version)) throw new CreditApplicationConflict("Nested application-funded credit requires separate settlement review");
    if (!basis || !basis.originalCustomerId || basis.originalCustomerId !== from.invoice.customerId || to.invoice.customerId !== basis.originalCustomerId
      || from.invoice.id === to.invoice.id) throw new CreditApplicationConflict("Credit must belong to the same named customer on a different supported sale");
    if (to.invoice.returnRequests.some((r: any) => r.status === "APPROVED")) throw new CreditApplicationConflict("Return-adjusted target sales require separate credit settlement review");
    const available = from.projection.creditSources.find((s: any) => data.sourceReturnId ? s.returnId === data.sourceReturnId : s.correctionId === data.sourceCorrectionId)?.availableCredit || 0;
    if (data.amount > available) throw new CreditApplicationConflict("Application exceeds this source's available credit");
    if (data.amount > to.projection.due!) throw new CreditApplicationConflict("Application exceeds the target sale's remaining due");
    const result = await tx.customerCreditApplication.create({ data: { sourceInvoiceId: source.invoiceId, targetInvoiceId: data.targetInvoiceId,
      sourceReturnId: data.sourceReturnId ?? null, sourceCorrectionId: data.sourceCorrectionId ?? null, amount: data.amount, originalCustomerId: basis.originalCustomerId, reason: data.reason, actorId } });
    await recomputeTarget(tx, to.invoice);
    await tx.auditLog.create({ data: { actorId, action: "CUSTOMER_CREDIT_APPLIED", entityType: "CustomerCreditApplication", entityId: result.id,
      meta: { sourceInvoiceId: source.invoiceId, targetInvoiceId: data.targetInvoiceId, sourceReturnId: data.sourceReturnId ?? null, sourceCorrectionId: data.sourceCorrectionId ?? null, amount: data.amount, reason: data.reason, originalCustomerId: basis.originalCustomerId } } });
    return result;
  });
}
export async function reverseCustomerCredit(actorId: string, applicationId: string, input: unknown) {
  const data = reverseSchema.parse(input);
  await assertActor(actorId);
  const identity = await prisma.customerCreditApplication.findUnique({ where: { id: applicationId }, select: { sourceInvoiceId: true, targetInvoiceId: true } });
  if (!identity) throw new CreditApplicationConflict("Credit application was not found");
  return operation(actorId, "REVERSE", data.operationKey, { applicationId, reason: data.reason }, [identity.sourceInvoiceId, identity.targetInvoiceId], async tx => {
    await supportedInvoice(tx, identity.sourceInvoiceId);
    const to = await supportedInvoice(tx, identity.targetInvoiceId);
    const current = await tx.customerCreditApplication.findUnique({ where: { id: applicationId } });
    if (!current || current.reversedAt) throw new CreditApplicationConflict("Credit application is already reversed");
    if (Number(current.amountReleased || 0) || to.invoice.returnRequests.some((r:any)=>r.status === "APPROVED" && [4,5].includes((r.settlement as any)?.version))) throw new CreditApplicationConflict("Reverse application-funded returns before reversing this application");
    const result = await tx.customerCreditApplication.update({ where: { id: applicationId }, data: { reversedAt: new Date(), reversedById: actorId, reversalReason: data.reason } });
    await recomputeTarget(tx, to.invoice);
    await tx.auditLog.create({ data: { actorId, action: "CUSTOMER_CREDIT_REVERSED", entityType: "CustomerCreditApplication", entityId: applicationId,
      meta: { sourceInvoiceId: identity.sourceInvoiceId, targetInvoiceId: identity.targetInvoiceId, sourceReturnId: current.sourceReturnId, sourceCorrectionId: current.sourceCorrectionId, originalCustomerId: current.originalCustomerId, amount: current.amount, reason: data.reason } } });
    return result;
  });
}
