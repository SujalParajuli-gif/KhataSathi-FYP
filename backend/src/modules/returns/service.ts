import { receivableInclude, projectReceivableInvoice } from "../customers/receivables";
import prisma from "../../db/prisma";
import { effectiveCorrectionCredit, getInvoicePaymentTargetTotal } from "../../lib/money";
import { allocateReturn, assertOriginalReturnBasisTx, parseReturnSettlement, ReturnSettlementConflict, runReturnOperation, updateReturnedInvoiceTx } from "./settlement";
import {
  lockInvoiceForUpdate,
  lockProductsForUpdate,
  lockReturnItemsForUpdate,
  lockReturnRequestForUpdate,
  runFinancialTransaction,
} from "../../lib/transactionLocks";
import { resolveDisplayProduct } from "../invoices/service";

type ReturnReasonInput =
  | "DAMAGED"
  | "WRONG_ITEM"
  | "CUSTOMER_REQUEST"
  | "EXCHANGE"
  | "OTHER";

type ReturnStatusInput = "PENDING" | "APPROVED" | "REJECTED" | "REVERSED";
type RefundMethodInput = "CASH" | "ESEWA";

type CreateReturnItemInput = {
  invoiceItemId: string;
  qty: number;
};

type CreateReturnRequestInput = {
  invoiceId: string;
  operationKey?: string;
  reason: string;
  note?: string | null;
  refundMethod?: string | null;
  items: CreateReturnItemInput[];
};

const RETURN_REASONS: ReturnReasonInput[] = [
  "DAMAGED",
  "WRONG_ITEM",
  "CUSTOMER_REQUEST",
  "EXCHANGE",
  "OTHER",
];

const REFUND_METHODS: RefundMethodInput[] = ["CASH", "ESEWA"];
const ACTIVE_RETURN_STATUSES: ReturnStatusInput[] = ["PENDING", "APPROVED"];
const RETURN_STATUSES: ReturnStatusInput[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REVERSED",
];

const returnRequestInclude = {
  invoice: {
    include: {
      customer: true,
      cashier: { select: { id: true, name: true } },
    },
  },
  createdBy: { select: { id: true, name: true, role: true } },
  reviewedBy: { select: { id: true, name: true, role: true } },
  refundPayments: {
    include: { createdBy: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "desc" },
  },
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true, barcode: true } },
      invoiceItem: {
        select: {
          id: true,
          qty: true,
          appliedUnitPrice: true,
          productNameSnapshot: true,
          productSkuSnapshot: true,
          snapshotCapturedAt: true,
          product: { select: { id: true, name: true, sku: true } },
        },
      },
    },
  },
};

export function mapReturnRequestDisplayIdentity<
  T extends {
    items?: any[];
    [key: string]: any;
  },
>(request: T): T & { items: Array<any> } {
  if (!request || !Array.isArray(request.items)) {
    return {
      ...request,
      items: [],
    };
  }

  const items = request.items.map((item: any) => {
    const rawInvoiceItem = item.invoiceItem;
    // Resolve display product using the linked original invoiceItem's snapshots and marker
    // Returns only reference finalized invoices
    const displayProduct = rawInvoiceItem
      ? resolveDisplayProduct(rawInvoiceItem, "FINALIZED")
      : resolveDisplayProduct(
          {
            product: item.product,
          },
          "FINALIZED",
        );

    // Sanitize invoiceItem so raw snapshot fields remain internal and are not exposed on the wire
    const sanitizedInvoiceItem = rawInvoiceItem
      ? {
          id: rawInvoiceItem.id,
          qty: rawInvoiceItem.qty,
          appliedUnitPrice: rawInvoiceItem.appliedUnitPrice,
        }
      : rawInvoiceItem;

    return {
      ...item,
      displayProduct,
      invoiceItem: sanitizedInvoiceItem,
    };
  });

  return {
    ...request,
    items,
  };
}

function normalizeReason(value: string): ReturnReasonInput {
  const normalized = String(value || "").trim().toUpperCase();
  if (RETURN_REASONS.includes(normalized as ReturnReasonInput)) {
    return normalized as ReturnReasonInput;
  }
  throw new Error("Return reason is required.");
}

function normalizeRefundMethod(value?: string | null): RefundMethodInput | null {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  if (REFUND_METHODS.includes(normalized as RefundMethodInput)) {
    return normalized as RefundMethodInput;
  }
  throw new Error("Unsupported refund method.");
}

function normalizeNote(value?: string | null) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function roundCurrency(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeReturnItems(items: unknown): CreateReturnItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Select at least one item to return.");
  }

  const merged = new Map<string, number>();

  for (const item of items) {
    const raw = item as any;
    const invoiceItemId = String(raw?.invoiceItemId || raw?.id || "").trim();
    const qty = Number(raw?.qty ?? raw?.quantity ?? 0);

    if (!invoiceItemId) {
      throw new Error("Every return item needs an invoiceItemId.");
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("Return quantity must be greater than 0.");
    }

    merged.set(invoiceItemId, (merged.get(invoiceItemId) || 0) + Math.round(qty * 1000) / 1000);
  }

  return Array.from(merged.entries()).map(([invoiceItemId, qty]) => ({
    invoiceItemId,
    qty,
  }));
}

function sumRefundAmount(requests: Array<{ refundAmount: number }>) {
  return requests.reduce(
    (sum, request) => sum + Number(request.refundAmount || 0),
    0,
  );
}

function isRefundPayment(payment: {
  kind?: string | null;
  status?: string | null;
}) {
  return (
    String(payment.kind || "CHARGE").toUpperCase() === "REFUND" &&
    String(payment.status || "").toUpperCase() === "SUCCESS"
  );
}

export function calculateRefundReversalAmount(
  payments: Array<{ amount: number; kind?: string | null; status?: string | null }>,
  fallbackRefundAmount: number,
) {
  const successfulRefundLedger = roundCurrency(
    payments
      .filter(isRefundPayment)
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
  );

  if (successfulRefundLedger < 0) {
    return roundCurrency(Math.abs(successfulRefundLedger));
  }

  return roundCurrency(Math.abs(Number(fallbackRefundAmount || 0)));
}

export function buildReturnReversalStockMessage(
  productName: string,
  availableStock: number,
  qtyToRemove: number,
) {
  return `Cannot reverse return because "${productName}" has only ${availableStock} unit(s) in stock; ${qtyToRemove} unit(s) must be removed.`;
}

export function calculateRemainingReturnQty(
  soldQty: number,
  alreadyReservedQty: number,
) {
  return Math.max(0, Number(soldQty || 0) - Number(alreadyReservedQty || 0));
}

export function calculateRefundAmount(
  paidTotal: number,
  reservedRefundAmount: number,
  rawRefundAmount: number,
) {
  const remainingRefundable = Math.max(
    0,
    Number(paidTotal || 0) - Number(reservedRefundAmount || 0),
  );
  return Math.min(Number(rawRefundAmount || 0), remainingRefundable);
}

export function calculateDiscountAdjustedReturnAmount(
  invoiceSubTotal: number,
  invoiceNetTotal: number,
  rawReturnLineTotal: number,
) {
  const subTotal = roundCurrency(Number(invoiceSubTotal || 0));
  const netTotal = roundCurrency(Number(invoiceNetTotal || 0));
  const returnLineTotal = roundCurrency(Number(rawReturnLineTotal || 0));

  if (subTotal <= 0 || returnLineTotal <= 0) return 0;

  return roundCurrency(returnLineTotal * (netTotal / subTotal));
}

export async function listReturnRequests(filters: {
  status?: string;
  userId: string;
  role: string;
}) {
  const normalizedStatus = String(filters.status || "").trim().toUpperCase();
  const status = RETURN_STATUSES.includes(normalizedStatus as ReturnStatusInput)
    ? normalizedStatus
    : undefined;
  const canSeeAllReturns = filters.role === "ADMIN" || filters.role === "MANAGER";
  const where: any = {
    ...(status ? { status } : {}),
    ...(canSeeAllReturns ? {} : { createdById: filters.userId }),
  };

  const records = await prisma.returnRequest.findMany({
    where,
    include: returnRequestInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return records.map(mapReturnRequestDisplayIdentity);
}

export async function createReturnRequest(
  createdById: string,
  input: CreateReturnRequestInput,
) {
  const invoiceId = String(input.invoiceId || "").trim();
  if (!invoiceId) throw new Error("Invoice is required.");

  const reason = normalizeReason(input.reason);
  // New requests retain excess credit; no cash refund is initiated.
  const refundMethod = null;
  const note = normalizeNote(input.note);
  const requestedItems = normalizeReturnItems(input.items).sort((a, b) => a.invoiceItemId.localeCompare(b.invoiceItemId));
  const requestedIds = requestedItems.map((item) => item.invoiceItemId);

  return runReturnOperation({ action: "CREATE", actorId: createdById, invoiceId, operationKey: input.operationKey, content: { reason, note, items: requestedItems } }, async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM InvoiceItem WHERE invoiceId = ${invoiceId} FOR UPDATE`;

    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true } },
          },
        },
        customer: true,
      },
    });

    if (!invoice) throw new Error("Invoice not found.");
    if (invoice.status !== "FINALIZED") {
      throw new Error("Only finalized invoices can be returned.");
    }
    if (invoice.paymentStatus === "CANCELLED") {
      throw new Error("Cancelled invoices cannot be returned.");
    }
    const inherited = await assertOriginalReturnBasisTx(tx, invoice);
    const itemSubtotal = roundCurrency(invoice.items.reduce((sum: number, item: any) => sum + Number(item.lineTotal || 0), 0));
    if (itemSubtotal !== roundCurrency(invoice.subTotal) || invoice.items.some((item: any) => !Number.isFinite(item.qty) || item.qty <= 0 || !Number.isFinite(item.appliedUnitPrice) || item.appliedUnitPrice < 0 || roundCurrency(item.qty * item.appliedUnitPrice) !== roundCurrency(item.lineTotal))) {
      throw new ReturnSettlementConflict("Return invoice original price basis is inconsistent");
    }

    const invoiceItemsById = new Map<string, any>(
      invoice.items.map((item: any) => [item.id, item]),
    );

    for (const requested of requestedItems) {
      if (!invoiceItemsById.has(requested.invoiceItemId)) {
        throw new Error("Selected return item does not belong to this invoice.");
      }
    }

    const existingReturnItems = await tx.returnItem.findMany({
      where: {
        invoiceItemId: { in: requestedIds },
        returnRequest: {
          invoiceId,
          status: { in: ACTIVE_RETURN_STATUSES },
        },
      },
      select: { invoiceItemId: true, qtyReturned: true },
    });

    const alreadyReturnedByItem = new Map<string, number>();
    for (const item of existingReturnItems) {
      alreadyReturnedByItem.set(
        item.invoiceItemId,
        (alreadyReturnedByItem.get(item.invoiceItemId) || 0) +
          Number(item.qtyReturned || 0),
      );
    }

    const returnLines = requestedItems.map((requested): {
      invoiceItem: any;
      qtyReturned: number;
      unitPrice: number;
      lineTotal: number;
    } => {
      const invoiceItem = invoiceItemsById.get(requested.invoiceItemId);
      const alreadyReturned =
        alreadyReturnedByItem.get(requested.invoiceItemId) || 0;
      const remainingQty = calculateRemainingReturnQty(
        invoiceItem.qty,
        alreadyReturned,
      );

      const display = resolveDisplayProduct(invoiceItem, "FINALIZED");
      const itemName = display.name || invoiceItem.product?.name || "Item";

      if (requested.qty > remainingQty) {
        throw new Error(
          `${itemName} only has ${remainingQty} unit(s) available to return.`,
        );
      }

      const unitPrice = Number(invoiceItem.appliedUnitPrice || 0);
      const lineTotal = unitPrice * requested.qty;

      return {
        invoiceItem,
        qtyReturned: requested.qty,
        unitPrice,
        lineTotal,
      };
    });

    const refundAmount = 0;
    const settlement = { version: inherited ? 3 : 2, ...(inherited ? { inheritedCorrectionId: inherited.id, inheritedCredit: inherited.inheritedCredit, restoredCredit: 0, recordedReceipts: 0 } : {}), originalCustomerId: invoice.customerId || null,
      originalPayable: getInvoicePaymentTargetTotal(invoice.netTotal), approvedReturnValue: 0,
      debtReduction: 0, retainedCredit: 0, approvalOrder: 0 };

    const request = await tx.returnRequest.create({
      data: {
        invoiceId,
        reason,
        note,
        refundAmount,
        refundMethod,
        settlement,
        createdById,
        items: {
          create: returnLines.map((line) => ({
            invoiceItemId: line.invoiceItem.id,
            productId: line.invoiceItem.productId,
            qtyReturned: line.qtyReturned,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        },
      },
      include: returnRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: createdById,
        action: "RETURN_REQUEST_CREATED",
        entityType: "ReturnRequest",
        entityId: request.id,
        meta: {
          invoiceId,
          invoiceNo: invoice.invoiceNo,
          reason,
          refundAmount,
          grossReturnAmount: roundCurrency(returnLines.reduce((sum, line) => sum + line.lineTotal, 0)),
          settlement,
          itemCount: returnLines.length,
        },
      },
    });

    return mapReturnRequestDisplayIdentity(request);
  });
}

export async function approveReturnRequest(id: string, reviewedById: string, operationKey?: string) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");
  const requestIdentity = await prisma.returnRequest.findUnique({
    where: { id: requestId },
    select: { invoiceId: true },
  });
  if (!requestIdentity) throw new Error("Return request not found.");

  return runReturnOperation({ action: "APPROVE", actorId: reviewedById, invoiceId: requestIdentity.invoiceId, requestId, operationKey, content: {} }, async (tx: any) => {
    await lockReturnRequestForUpdate(tx, requestId);
    const productIds = await lockReturnItemsForUpdate(tx, requestId);
    await lockProductsForUpdate(tx, productIds);
    const request = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    if (!request) throw new Error("Return request not found.");
    if (request.status !== "PENDING") {
      throw new Error("Only pending return requests can be approved.");
    }

    const pendingSettlement = parseReturnSettlement(request.settlement);
    let settled: any = null;
    if (request.settlement != null && !pendingSettlement) throw new ReturnSettlementConflict("Return settlement basis is malformed");
    if (pendingSettlement) {
      const inherited = await assertOriginalReturnBasisTx(tx, request.invoice);
      if (Boolean(inherited) !== (pendingSettlement.version === 3) || (inherited && (pendingSettlement.inheritedCorrectionId !== inherited.id || pendingSettlement.inheritedCredit !== inherited.inheritedCredit))) throw new ReturnSettlementConflict("Inherited return source changed");
      if (pendingSettlement.originalCustomerId !== (request.invoice.customerId || null) || pendingSettlement.originalPayable !== getInvoicePaymentTargetTotal(request.invoice.netTotal)) throw new ReturnSettlementConflict("Return invoice owner or payable changed");
      const payments = await tx.payment.findMany({ where: { invoiceId: request.invoiceId } });
      if (payments.some((p: any) => p.kind === "CHARGE" && p.status === "PENDING" && p.method === "ESEWA" && !p.voidedAt)) throw new ReturnSettlementConflict("Return approval requires resolving the pending gateway payment first");
      const approved = await tx.returnRequest.findMany({ where: { invoiceId: request.invoiceId, status: "APPROVED" }, include: { items: true } });
      const paid = roundCurrency(payments.filter((p: any) => p.kind === "CHARGE" && p.status === "SUCCESS").reduce((sum: number, p: any) => sum + Number(p.amount), 0));
      if (payments.some((p: any) => p.kind === "CHARGE" && p.status === "SUCCESS" && (!Number.isFinite(p.amount) || p.amount < 0 || p.voidedAt)) || paid !== roundCurrency(request.invoice.paidTotal) || paid > getInvoicePaymentTargetTotal(request.invoice.netTotal)) throw new ReturnSettlementConflict("Return invoice successful charge projection is inconsistent");
      const heldCredit = roundCurrency(approved.reduce((sum: number, r: any) => sum + parseReturnSettlement(r.settlement)!.retainedCredit, 0));
      if (heldCredit !== roundCurrency(Math.max(0, paid - getInvoicePaymentTargetTotal(request.invoice.netTotal, request.invoice.returnAdjustment || 0, 0, effectiveCorrectionCredit(request.invoice))))) throw new ReturnSettlementConflict("Return invoice retained credit allocation is inconsistent");
      const allocation = allocateReturn({ netTotal: request.invoice.netTotal, subTotal: request.invoice.subTotal,
        approvedGross: approved.reduce((sum: number, r: any) => sum + r.items.reduce((n: number, i: any) => n + Number(i.lineTotal), 0), 0),
        nextGross: request.items.reduce((sum: number, i: any) => sum + Number(i.lineTotal), 0), previousAdjustment: request.invoice.returnAdjustment || 0, paid: roundCurrency(paid + effectiveCorrectionCredit(request.invoice)) });
      const approvalOrder = 1 + approved.reduce((max: number, r: any) => Math.max(max, parseReturnSettlement(r.settlement)!.approvalOrder), 0);
      const restoredCredit = inherited ? roundCurrency(Math.min(allocation.retainedCredit, effectiveCorrectionCredit(request.invoice))) : 0;
      settled = { ...pendingSettlement, approvedReturnValue: allocation.approvedReturnValue, debtReduction: allocation.debtReduction, retainedCredit: roundCurrency(allocation.retainedCredit - restoredCredit), ...(inherited ? { restoredCredit, recordedReceipts: paid } : {}), approvalOrder };
      await updateReturnedInvoiceTx(tx, request.invoice, allocation.adjustment, roundCurrency(Number(request.invoice.correctionCreditReleased || 0) + restoredCredit));
    }

    const claimed = await tx.returnRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewedById,
        reviewedAt: new Date(),
        ...(settled ? { settlement: settled } : {}),
      },
    });

    if (claimed.count !== 1) {
      throw new Error("Return request has already been reviewed.");
    }

    for (const item of request.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.qtyReturned } },
      });

      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "RESTOCK",
          qtyDelta: item.qtyReturned,
          reason: `Return approved for ${request.invoice.invoiceNo}`,
          refInvoiceId: request.invoiceId,
          createdById: reviewedById,
        },
      });
    }

    const refundAmount = settled ? 0 : roundCurrency(Math.abs(Number(request.refundAmount || 0)));
    const refundPayment =
      refundAmount > 0
        ? await tx.payment.create({
            data: {
              invoiceId: request.invoiceId,
              method: request.refundMethod || "CASH",
              amount: -refundAmount,
              kind: "REFUND",
              status: "SUCCESS",
              reference: `Return refund ${request.invoice.invoiceNo}`,
              returnRequestId: request.id,
              createdById: reviewedById,
            },
          })
        : null;

    await tx.auditLog.create({
      data: {
        actorId: reviewedById,
        action: "RETURN_REQUEST_APPROVED",
        entityType: "ReturnRequest",
        entityId: requestId,
        meta: {
          invoiceId: request.invoiceId,
          invoiceNo: request.invoice.invoiceNo,
          refundAmount: request.refundAmount,
          refundMethod: request.refundMethod,
          refundPaymentId: refundPayment?.id || null,
          settlement: settled,
          itemCount: request.items.length,
        },
      },
    });

    const updated = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    return updated ? mapReturnRequestDisplayIdentity(updated) : null;
  });
}

export async function reverseApprovedReturnRequest(
  id: string,
  reversedById: string,
  note?: string | null,
  operationKey?: string,
) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");
  const reversalNote = normalizeNote(note);
  const requestIdentity = await prisma.returnRequest.findUnique({
    where: { id: requestId },
    select: { invoiceId: true },
  });
  if (!requestIdentity) throw new Error("Return request not found.");

  return runReturnOperation({ action: "REVERSE", actorId: reversedById, invoiceId: requestIdentity.invoiceId, requestId, operationKey, content: { note: reversalNote } }, async (tx: any) => {
    await lockReturnRequestForUpdate(tx, requestId);
    const productIds = await lockReturnItemsForUpdate(tx, requestId);
    await lockProductsForUpdate(tx, productIds);

    const request = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    if (!request) throw new Error("Return request not found.");
    if (request.status === "REVERSED") {
      throw new Error("Return request is already reversed.");
    }
    if (request.status !== "APPROVED") {
      throw new Error("Only approved return requests can be reversed.");
    }

    if (await tx.customerCreditApplication.count({ where: { sourceReturnId: requestId, reversedAt: null } })) throw new ReturnSettlementConflict("Reverse active credit applications before reversing this source return");
    if (await tx.customerCreditPayout.count({ where: { sourceReturnId: requestId, recoveredAt: null } })) throw new ReturnSettlementConflict("Recover paid-out credit before reversing this source return");
    const settlement = parseReturnSettlement(request.settlement);
    if (request.settlement != null && !settlement) throw new ReturnSettlementConflict("Return settlement basis is malformed");
    if (settlement) {
      await assertOriginalReturnBasisTx(tx, request.invoice);
      const approved = await tx.returnRequest.findMany({ where: { invoiceId: request.invoiceId, status: "APPROVED" }, select: { id: true, settlement: true } });
      if (approved.some((r: any) => parseReturnSettlement(r.settlement)!.approvalOrder > settlement.approvalOrder)) throw new ReturnSettlementConflict("Return reversal must reverse later approved returns first");
      if (settlement.version === 3) {
        const parent = await tx.invoiceCorrectionSettlement.findUnique({ where: { id: settlement.inheritedCorrectionId! } });
        const origin = parent && await tx.invoice.findUnique({ where: { id: parent.sourceInvoiceId }, include: receivableInclude });
        const projection = origin && projectReceivableInvoice(origin);
        if (!projection || projection.reason || projection.retainedCredit! < settlement.restoredCredit!) throw new ReturnSettlementConflict("Reverse uses or recover payouts of restored original credit before reversing this return");
      }
      await updateReturnedInvoiceTx(tx, request.invoice, Number(request.invoice.returnAdjustment) - settlement.approvedReturnValue,
        roundCurrency(Number(request.invoice.correctionCreditReleased || 0) - (settlement.restoredCredit || 0)));
    }

    const claimed = await tx.returnRequest.updateMany({
      where: { id: requestId, status: "APPROVED" },
      data: {
        status: "REVERSED",
        note: request.note
          ? `${request.note}\n\nReversal: ${
              reversalNote || "Approved return reversed by admin."
            }`
          : `Reversal: ${reversalNote || "Approved return reversed by admin."}`,
      },
    });

    if (claimed.count !== 1) {
      throw new Error("Return request has already been reviewed.");
    }

    for (const item of request.items) {
      const updated = await tx.product.updateMany({
        where: {
          id: item.productId,
          stock: { gte: item.qtyReturned },
        },
        data: { stock: { decrement: item.qtyReturned } },
      });

      if (updated.count !== 1) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { name: true, stock: true },
        });

        throw new Error(
          buildReturnReversalStockMessage(
            product?.name || item.product?.name || "Returned item",
            Number(product?.stock || 0),
            item.qtyReturned,
          ),
        );
      }

      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "ADJUSTMENT",
          qtyDelta: -item.qtyReturned,
          reason: `Return reversal for ${request.invoice.invoiceNo}`,
          refInvoiceId: request.invoiceId,
          createdById: reversedById,
        },
      });
    }

    const reversalAmount = settlement ? 0 : calculateRefundReversalAmount(
      request.refundPayments,
      request.refundAmount,
    );
    const refundCorrectionPayment =
      reversalAmount > 0
        ? await tx.payment.create({
            data: {
              invoiceId: request.invoiceId,
              method: request.refundMethod || "CASH",
              amount: reversalAmount,
              kind: "REFUND",
              status: "SUCCESS",
              reference: `Return refund reversal ${request.invoice.invoiceNo}`,
              returnRequestId: request.id,
              createdById: reversedById,
            },
          })
        : null;

    await tx.auditLog.create({
      data: {
        actorId: reversedById,
        action: "RETURN_REQUEST_REVERSED",
        entityType: "ReturnRequest",
        entityId: requestId,
        meta: {
          invoiceId: request.invoiceId,
          invoiceNo: request.invoice.invoiceNo,
          refundAmount: request.refundAmount,
          refundReversalAmount: reversalAmount,
          settlement,
          refundCorrectionPaymentId: refundCorrectionPayment?.id || null,
          itemCount: request.items.length,
          note: reversalNote,
          reversedItems: request.items.map((item: any) => ({
            productId: item.productId,
            productName: item.product?.name || null,
            sku: item.product?.sku || null,
            qty: item.qtyReturned,
          })),
        },
      },
    });

    const updated = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    return updated ? mapReturnRequestDisplayIdentity(updated) : null;
  });
}

export async function rejectReturnRequest(
  id: string,
  reviewedById: string,
  note?: string | null,
  operationKey?: string,
) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");
  const rejectionNote = normalizeNote(note);
  const requestIdentity = await prisma.returnRequest.findUnique({
    where: { id: requestId },
    select: { invoiceId: true },
  });
  if (!requestIdentity) throw new Error("Return request not found.");

  return runReturnOperation({ action: "REJECT", actorId: reviewedById, invoiceId: requestIdentity.invoiceId, requestId, operationKey, content: { note: rejectionNote } }, async (tx: any) => {
    await lockReturnRequestForUpdate(tx, requestId);
    const request = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: {
        invoice: { select: { id: true, invoiceNo: true } },
        items: true,
      },
    });

    if (!request) throw new Error("Return request not found.");
    if (request.status !== "PENDING") {
      throw new Error("Only pending return requests can be rejected.");
    }

    const claimed = await tx.returnRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "REJECTED",
        reviewedById,
        reviewedAt: new Date(),
        ...(rejectionNote
          ? {
              note: request.note
                ? `${request.note}\n\nRejection: ${rejectionNote}`
                : `Rejection: ${rejectionNote}`,
            }
          : {}),
      },
    });

    if (claimed.count !== 1) {
      throw new Error("Return request has already been reviewed.");
    }

    await tx.auditLog.create({
      data: {
        actorId: reviewedById,
        action: "RETURN_REQUEST_REJECTED",
        entityType: "ReturnRequest",
        entityId: requestId,
        meta: {
          invoiceId: request.invoiceId,
          invoiceNo: request.invoice.invoiceNo,
          itemCount: request.items.length,
          note: rejectionNote,
        },
      },
    });

    const updated = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    return updated ? mapReturnRequestDisplayIdentity(updated) : null;
  });
}
