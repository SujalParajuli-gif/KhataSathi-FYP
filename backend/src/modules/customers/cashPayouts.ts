import { createHash } from "node:crypto";
import { z } from "zod";
import prisma from "../../db/prisma";
import { lockInvoiceForUpdate, lockCashDrawerForUpdate, runFinancialTransaction } from "../../lib/transactionLocks";
import { roundCurrency } from "../../lib/money";
import { summarizeDrawerTx } from "../cash-drawers/service";
import { receivableInclude, payoutInclude, projectPayout, projectReceivableInvoice } from "./receivables";

export class CashPayoutConflict extends Error {}
const key = z.string().regex(/^[A-Za-z0-9_-]{16,120}$/);
const id = z.string().min(1).max(100);
const reason = z.string().trim().min(1).max(500);
const payoutSchema = z.object({ sourceReturnId: id.optional(), sourceCorrectionId: id.optional(), drawerId: id,
  amount: z.number().finite().positive().max(2147483647).refine(n => roundCurrency(n) === n), reason, operationKey: key,
  cashConfirmed: z.literal(true), newPayoutConfirmed: z.literal(true) }).strict()
  .refine(d => Boolean(d.sourceReturnId) !== Boolean(d.sourceCorrectionId), { message: "Exactly one credit source is required" });
const recoverySchema = z.object({ drawerId: id, reason, operationKey: key, cashReceivedConfirmed: z.literal(true) }).strict();

async function assertActor(db: any, actorId: string) {
  const actor = await db.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
  if (!actor?.isActive || !["ADMIN", "MANAGER"].includes(actor.role)) throw new CashPayoutConflict("Cash payouts require administrator or manager access");
  const settings = await db.businessSettings.findUnique({ where: { id: 1 }, select: { businessMode: true } });
  if (settings?.businessMode !== "FULL_POS") throw new CashPayoutConflict("Cash payouts require POS capability");
}
async function operation(actorId: string, action: "PAYOUT" | "RECOVER", operationKey: string, content: unknown,
  sourceInvoiceId: string, drawerId: string, work: (tx: any, drawer: any) => Promise<any>) {
  await assertActor(prisma, actorId);
  const payloadHash = createHash("sha256").update(JSON.stringify({ actorId, action, content })).digest("hex");
  const replay = (row: any) => {
    if (row.payloadHash !== payloadHash) throw new CashPayoutConflict("Payout operation conflicts with its original actor, action or payload");
    return row.responseJson;
  };
  const prior = await prisma.customerCreditPayoutOperation.findUnique({ where: { operationKey } });
  if (prior) return replay(prior);
  try {
    return await runFinancialTransaction(prisma, async tx => {
      await lockInvoiceForUpdate(tx, sourceInvoiceId);
      await lockCashDrawerForUpdate(tx, drawerId);
      await assertActor(tx, actorId);
      const existing = await tx.customerCreditPayoutOperation.findUnique({ where: { operationKey } });
      if (existing) return replay(existing);
      const drawer = await tx.cashDrawer.findUnique({ where: { id: drawerId } });
      if (!drawer || drawer.status !== "OPEN" || drawer.cashierId !== actorId) throw new CashPayoutConflict("Select your own open cash drawer");
      const result = await work(tx, drawer);
      await summarizeDrawerTx(tx, drawer);
      const response = JSON.parse(JSON.stringify(projectPayout(result)));
      await tx.customerCreditPayoutOperation.create({ data: { operationKey, payloadHash, actorId, action, payoutId: result.id, responseJson: response } });
      return response;
    });
  } catch (error) {
    if ((error as any)?.code === "P2002") {
      const winner = await prisma.customerCreditPayoutOperation.findUnique({ where: { operationKey } });
      if (winner) return replay(winner);
    }
    throw error;
  }
}
async function supportedSource(tx: any, sourceInvoiceId: string) {
  const invoice = await tx.invoice.findUnique({ where: { id: sourceInvoiceId }, include: receivableInclude });
  if (!invoice) throw new CashPayoutConflict("Credit source sale was not found");
  const projection = projectReceivableInvoice(invoice);
  if (projection.reason) throw new CashPayoutConflict(projection.reason);
  if (!invoice.customerId) throw new CashPayoutConflict("Payout requires a reconciled named original customer");
  return { invoice, projection };
}
export async function confirmCustomerCreditPayout(actorId: string, input: unknown) {
  const data = payoutSchema.parse(input);
  await assertActor(prisma, actorId);
  const source = data.sourceReturnId
    ? await prisma.returnRequest.findUnique({ where: { id: data.sourceReturnId }, select: { invoiceId: true } })
    : await prisma.invoiceCorrectionSettlement.findUnique({ where: { id: data.sourceCorrectionId! }, select: { sourceInvoiceId: true } }).then(r => r && { invoiceId: r.sourceInvoiceId });
  if (!source) throw new CashPayoutConflict("Credit source was not found");
  const { operationKey, ...content } = data;
  return operation(actorId, "PAYOUT", operationKey, content, source.invoiceId, data.drawerId, async (tx, drawer) => {
    const { invoice, projection } = await supportedSource(tx, source.invoiceId);
    const budget = projection.creditSources.find((s: any) => data.sourceReturnId ? s.returnId === data.sourceReturnId : s.correctionId === data.sourceCorrectionId);
    if (!budget || data.amount > budget.availableCredit) throw new CashPayoutConflict("Payout exceeds this source's available credit");
    const event = await tx.cashDrawerEvent.create({ data: { drawerId: drawer.id, type: "CASH_OUT", amount: data.amount, note: data.reason, createdById: actorId } });
    const payout = await tx.customerCreditPayout.create({ data: { sourceInvoiceId: source.invoiceId, originalCustomerId: invoice.customerId,
      sourceReturnId: data.sourceReturnId ?? null, sourceCorrectionId: data.sourceCorrectionId ?? null, amount: data.amount, reason: data.reason, actorId, payoutEventId: event.id }, include: payoutInclude });
    await tx.auditLog.create({ data: { actorId, action: "CUSTOMER_CREDIT_PAYOUT_CONFIRMED", entityType: "CustomerCreditPayout", entityId: payout.id,
      meta: { sourceInvoiceId: source.invoiceId, originalCustomerId: invoice.customerId, sourceReturnId: data.sourceReturnId ?? null, sourceCorrectionId: data.sourceCorrectionId ?? null, amount: data.amount, drawerId: drawer.id, eventId: event.id, reason: data.reason } } });
    return payout;
  });
}
export async function confirmCustomerCreditRecovery(actorId: string, payoutId: string, input: unknown) {
  const data = recoverySchema.parse(input);
  await assertActor(prisma, actorId);
  const identity = await prisma.customerCreditPayout.findUnique({ where: { id: payoutId }, select: { sourceInvoiceId: true } });
  if (!identity) throw new CashPayoutConflict("Payout was not found");
  const { operationKey, ...content } = data;
  return operation(actorId, "RECOVER", operationKey, { payoutId, ...content }, identity.sourceInvoiceId, data.drawerId, async (tx, drawer) => {
    await supportedSource(tx, identity.sourceInvoiceId);
    const current = await tx.customerCreditPayout.findUniqueOrThrow({ where: { id: payoutId } });
    if (current.recoveredAt) throw new CashPayoutConflict("Payout cash has already been recovered");
    const event = await tx.cashDrawerEvent.create({ data: { drawerId: drawer.id, type: "CASH_IN", amount: current.amount, note: data.reason, createdById: actorId } });
    const payout = await tx.customerCreditPayout.update({ where: { id: payoutId }, data: { recoveredAt: new Date(), recoveredById: actorId,
      recoveryReason: data.reason, recoveryEventId: event.id }, include: payoutInclude });
    await tx.auditLog.create({ data: { actorId, action: "CUSTOMER_CREDIT_PAYOUT_RECOVERED", entityType: "CustomerCreditPayout", entityId: payout.id,
      meta: { sourceInvoiceId: identity.sourceInvoiceId, originalCustomerId: current.originalCustomerId, amount: current.amount, drawerId: drawer.id, eventId: event.id, reason: data.reason } } });
    return payout;
  });
}
