import prisma from "../../db/prisma";

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
      invoiceItem: { select: { id: true, qty: true, appliedUnitPrice: true } },
    },
  },
};

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

  return prisma.returnRequest.findMany({
    where,
    include: returnRequestInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function createReturnRequest(
  createdById: string,
  input: CreateReturnRequestInput,
) {
  const invoiceId = String(input.invoiceId || "").trim();
  if (!invoiceId) throw new Error("Invoice is required.");

  const reason = normalizeReason(input.reason);
  const refundMethod = normalizeRefundMethod(input.refundMethod);
  const note = normalizeNote(input.note);
  const requestedItems = normalizeReturnItems(input.items);
  const requestedIds = requestedItems.map((item) => item.invoiceItemId);

  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM Invoice WHERE id = ${invoiceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM InvoiceItem WHERE invoiceId = ${invoiceId} FOR UPDATE`;

    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: { include: { product: true } },
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
    if (Number(invoice.paidTotal || 0) <= 0) {
      throw new Error("Only invoices with a recorded payment can be returned.");
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

      if (requested.qty > remainingQty) {
        throw new Error(
          `${invoiceItem.product?.name || "Item"} only has ${remainingQty} unit(s) available to return.`,
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

    const reservedRefunds = await tx.returnRequest.findMany({
      where: { invoiceId, status: { in: ACTIVE_RETURN_STATUSES } },
      select: { refundAmount: true },
    });
    const rawRefundAmount = returnLines.reduce(
      (sum, line) => sum + line.lineTotal,
      0,
    );
    const refundAmount = calculateRefundAmount(
      invoice.paidTotal,
      sumRefundAmount(reservedRefunds),
      rawRefundAmount,
    );

    if (refundAmount <= 0) {
      throw new Error("This invoice has no remaining refundable amount.");
    }

    const request = await tx.returnRequest.create({
      data: {
        invoiceId,
        reason,
        note,
        refundAmount,
        refundMethod,
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
          itemCount: returnLines.length,
        },
      },
    });

    return request;
  });
}

export async function approveReturnRequest(id: string, reviewedById: string) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");

  return prisma.$transaction(async (tx: any) => {
    const request = await tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });

    if (!request) throw new Error("Return request not found.");
    if (request.status !== "PENDING") {
      throw new Error("Only pending return requests can be approved.");
    }

    const claimed = await tx.returnRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewedById,
        reviewedAt: new Date(),
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

    const refundAmount = roundCurrency(Math.abs(Number(request.refundAmount || 0)));
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
          itemCount: request.items.length,
        },
      },
    });

    return tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });
  });
}

export async function reverseApprovedReturnRequest(
  id: string,
  reversedById: string,
  note?: string | null,
) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");
  const reversalNote = normalizeNote(note);

  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM ReturnRequest WHERE id = ${requestId} FOR UPDATE`;

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

    const reversalAmount = calculateRefundReversalAmount(
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

    return tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });
  });
}

export async function rejectReturnRequest(
  id: string,
  reviewedById: string,
  note?: string | null,
) {
  const requestId = String(id || "").trim();
  if (!requestId) throw new Error("Return request is required.");
  const rejectionNote = normalizeNote(note);

  return prisma.$transaction(async (tx: any) => {
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

    return tx.returnRequest.findUnique({
      where: { id: requestId },
      include: returnRequestInclude,
    });
  });
}
