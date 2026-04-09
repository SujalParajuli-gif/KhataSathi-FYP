import { Prisma } from "@prisma/client";
import {
  buildBusinessDateRange,
  toBusinessClock,
} from "../../lib/businessDate";
import prisma from "../../db/prisma";
import {
  getBusinessSettings,
  resolveWholesaleQtyThreshold,
} from "../settings/service";

const MAX_CREATE_DRAFT_RETRIES = 5;

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function clampPercent(value?: number | null) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) return 0;
  if (normalized < 0) return 0;
  if (normalized > 100) return 100;
  return normalized;
}

function normalizePositiveInteger(value: number, label: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a whole number greater than 0`);
  }
  return normalized;
}

function normalizeDiscountAmount(
  discountAmount: number | undefined,
  subTotal: number,
  fallbackDiscount: number,
) {
  if (discountAmount === undefined) {
    return fallbackDiscount;
  }

  const normalized = Number(discountAmount);
  if (!Number.isFinite(normalized)) {
    throw new Error("Discount amount must be a valid number");
  }

  if (normalized < 0) {
    throw new Error("Discount amount cannot be negative");
  }

  return Math.min(subTotal, roundCurrency(normalized));
}

function buildInsufficientStockMessage(
  productName: string,
  availableStock: number,
  requestedQty: number,
) {
  return `Insufficient stock for "${productName}". Available: ${availableStock}, Requested: ${requestedQty}`;
}

function isInvoiceNoConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false;
  }

  const target = Array.isArray(error.meta?.target)
    ? error.meta?.target
    : typeof error.meta?.target === "string"
      ? [error.meta.target]
      : [];

  return (
    target.includes("invoiceNo") ||
    target.some((value) => String(value).includes("invoiceNo")) ||
    error.message.includes("invoiceNo")
  );
}

function resolveSubtotalDiscountPercent(customer?: {
  loyaltyPercent?: number | null;
  wholesalePercent?: number | null;
} | null) {
  const wholesalePercent = clampPercent(customer?.wholesalePercent);
  if (wholesalePercent > 0) {
    return {
      percent: wholesalePercent,
      source: "CUSTOMER_WHOLESALE" as const,
    };
  }

  const loyaltyPercent = clampPercent(customer?.loyaltyPercent);
  if (loyaltyPercent > 0) {
    return {
      percent: loyaltyPercent,
      source: "LOYALTY" as const,
    };
  }

  return {
    percent: 0,
    source: "NONE" as const,
  };
}

function shouldUseQuantityWholesalePrice(
  customer: { wholesalePercent?: number | null } | null | undefined,
  qty: number,
  threshold?: number | null,
) {
  if (clampPercent(customer?.wholesalePercent) > 0) {
    return false;
  }

  return qty >= Math.max(1, Number(threshold || 1));
}

async function generateInvoiceNo() {
  const now = toBusinessClock(new Date());
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");

  const prefix = `INV-${dateStr}-`;
  const count = await prisma.invoice.count({
    where: { invoiceNo: { startsWith: prefix } },
  });

  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

async function recomputeSubtotal(invoiceId: string) {
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId } });
  const subTotal = roundCurrency(
    items.reduce((sum, item) => sum + item.lineTotal, 0),
  );

  await prisma.invoice.update({ where: { id: invoiceId }, data: { subTotal } });
}

export async function createDraft(cashierId: string, customerId?: string) {
  for (let attempt = 0; attempt < MAX_CREATE_DRAFT_RETRIES; attempt += 1) {
    const invoiceNo = await generateInvoiceNo();

    try {
      return await prisma.invoice.create({
        data: {
          invoiceNo,
          status: "DRAFT",
          cashierId,
          customerId: customerId || null,
        },
        include: {
          items: { include: { product: true } },
          payments: true,
          customer: true,
        },
      });
    } catch (error) {
      if (isInvoiceNoConflict(error) && attempt < MAX_CREATE_DRAFT_RETRIES - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Could not create a unique invoice number. Please try again.");
}

interface InvoiceFilters {
  status?: string;
  cashierId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listInvoices(filters: InvoiceFilters) {
  const safePage =
    Number.isInteger(filters.page) && Number(filters.page) > 0
      ? Number(filters.page)
      : 1;
  const safePageSize =
    Number.isInteger(filters.pageSize) && Number(filters.pageSize) > 0
      ? Number(filters.pageSize)
      : 20;

  const where: Prisma.InvoiceWhereInput = {};

  if (filters.status) where.status = filters.status as any;
  if (filters.cashierId) where.cashierId = filters.cashierId;

  const createdAt = buildBusinessDateRange({
    from: filters.from,
    to: filters.to,
  });
  if (createdAt) {
    where.createdAt = createdAt;
  }

  const skip = (safePage - 1) * safePageSize;
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        cashier: { select: { id: true, name: true, email: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        },
        cancelledBy: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
        items: {
          select: {
            id: true,
            qty: true,
            appliedUnitPrice: true,
            lineTotal: true,
            product: {
              select: { id: true, name: true, sku: true, barcode: true },
            },
          },
        },
        payments: {
          select: {
            id: true,
            method: true,
            status: true,
            amount: true,
            reference: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
        _count: { select: { items: true, payments: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: safePageSize,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { invoices, total, page: safePage, pageSize: safePageSize };
}

export async function getInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, barcode: true } },
        },
      },
      payments: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
      cashier: { select: { id: true, name: true, email: true } },
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          loyaltyPercent: true,
          wholesalePercent: true,
        },
      },
      cancelledBy: {
        select: {
          id: true,
          name: true,
          role: true,
        },
      },
    },
  });
}

export async function addItem(invoiceId: string, productId: string, qty: number) {
  const normalizedQty = normalizePositiveInteger(qty, "qty");
  const settings = await getBusinessSettings();

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: {
        select: { id: true, loyaltyPercent: true, wholesalePercent: true },
      },
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("Product not found");
  if (!product.isActive) throw new Error("Product is inactive");
  if (product.stock <= 0) throw new Error("Product is out of stock");

  const existing = await prisma.invoiceItem.findFirst({ where: { invoiceId, productId } });

  if (existing) {
    const newQty = existing.qty + normalizedQty;
    if (newQty > product.stock) {
      throw new Error(
        buildInsufficientStockMessage(product.name, product.stock, newQty),
      );
    }

    const recalculatedUnitPrice = shouldUseQuantityWholesalePrice(
      invoice.customer,
      newQty,
      resolveWholesaleQtyThreshold(product, settings),
    )
      ? product.wholesalePrice
      : product.retailPrice;
    const newLineTotal = roundCurrency(recalculatedUnitPrice * newQty);

    const item = await prisma.invoiceItem.update({
      where: { id: existing.id },
      data: {
        qty: newQty,
        appliedUnitPrice: recalculatedUnitPrice,
        lineTotal: newLineTotal,
      },
    });

    await recomputeSubtotal(invoiceId);
    return item;
  }

  if (normalizedQty > product.stock) {
    throw new Error(
      buildInsufficientStockMessage(product.name, product.stock, normalizedQty),
    );
  }

  const appliedUnitPrice = shouldUseQuantityWholesalePrice(
    invoice.customer,
    normalizedQty,
    resolveWholesaleQtyThreshold(product, settings),
  )
    ? product.wholesalePrice
    : product.retailPrice;
  const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

  const item = await prisma.invoiceItem.create({
    data: {
      invoiceId,
      productId,
      qty: normalizedQty,
      appliedUnitPrice,
      lineTotal,
    },
  });

  await recomputeSubtotal(invoiceId);
  return item;
}

export async function updateItem(invoiceId: string, itemId: string, qty: number) {
  const normalizedQty = normalizePositiveInteger(qty, "qty");
  const settings = await getBusinessSettings();

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: {
        select: { id: true, loyaltyPercent: true, wholesalePercent: true },
      },
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const item = await prisma.invoiceItem.findUnique({
    where: { id: itemId },
    include: { product: true },
  });

  if (!item) throw new Error("Item not found");
  if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");
  if (normalizedQty > item.product.stock) {
    throw new Error(
      buildInsufficientStockMessage(
        item.product.name,
        item.product.stock,
        normalizedQty,
      ),
    );
  }

  const appliedUnitPrice = shouldUseQuantityWholesalePrice(
    invoice.customer,
    normalizedQty,
    resolveWholesaleQtyThreshold(item.product, settings),
  )
    ? item.product.wholesalePrice
    : item.product.retailPrice;
  const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

  const updated = await prisma.invoiceItem.update({
    where: { id: itemId },
    data: { qty: normalizedQty, appliedUnitPrice, lineTotal },
  });

  await recomputeSubtotal(invoiceId);
  return updated;
}

export async function removeItem(invoiceId: string, itemId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const item = await prisma.invoiceItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Item not found");
  if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");

  await prisma.invoiceItem.delete({ where: { id: itemId } });
  await recomputeSubtotal(invoiceId);
}

export async function finalizeInvoice(
  invoiceId: string,
  userId: string,
  discountAmount?: number,
) {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: { include: { product: true } },
        customer: true,
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Invoice is already finalized");
    if (invoice.items.length === 0) throw new Error("Cannot finalize an empty invoice");

    const subTotal = roundCurrency(
      invoice.items.reduce((sum, item) => sum + item.lineTotal, 0),
    );
    const resolvedDiscount = resolveSubtotalDiscountPercent(invoice.customer);
    const computedDiscount = roundCurrency(
      (subTotal * resolvedDiscount.percent) / 100,
    );
    const normalizedDiscount = normalizeDiscountAmount(
      discountAmount,
      subTotal,
      computedDiscount,
    );
    const appliedDiscountPercent =
      subTotal > 0 ? roundCurrency((normalizedDiscount / subTotal) * 100) : 0;
    const netTotal = roundCurrency(subTotal - normalizedDiscount);

    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    for (const item of invoice.items) {
      const updated = await tx.product.updateMany({
        where: {
          id: item.productId,
          stock: { gte: item.qty },
        },
        data: { stock: { decrement: item.qty } },
      });

      if (updated.count === 0) {
        const latestProduct = await tx.product.findUnique({
          where: { id: item.productId },
          select: { name: true, stock: true },
        });

        throw new Error(
          buildInsufficientStockMessage(
            latestProduct?.name || item.product.name,
            latestProduct?.stock ?? 0,
            item.qty,
          ),
        );
      }

      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "SALE",
          qtyDelta: -item.qty,
          reason: `Sale via invoice ${invoice.invoiceNo}`,
          refInvoiceId: invoiceId,
          createdById: userId,
        },
      });
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "FINALIZED",
        subTotal,
        loyaltyDiscountPercent: appliedDiscountPercent,
        loyaltyDiscountAmount: normalizedDiscount,
        netTotal,
        paidTotal: 0,
        paymentStatus: netTotal <= 0 ? "PAID" : "UNPAID",
        finalizedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_FINALIZED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          subTotal,
          discountAmount: normalizedDiscount,
          discountPercent: appliedDiscountPercent,
          discountSource: resolvedDiscount.source,
          netTotal,
          itemCount: invoice.items.length,
          autoMarkedPaid: netTotal <= 0,
        },
      },
    });
  });

  return getInvoice(invoiceId);
}

export async function cancelInvoice(invoiceId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true },
            },
          },
        },
        payments: true,
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "FINALIZED") {
      throw new Error("Only finalized invoices can be cancelled");
    }
    if (invoice.paymentStatus === "CANCELLED") {
      throw new Error("Invoice is already cancelled");
    }

    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });
    const successfulPaymentCount = invoice.payments.filter(
      (payment) => payment.status === "SUCCESS",
    ).length;
    const pendingPaymentCount = invoice.payments.filter(
      (payment) => payment.status === "PENDING",
    ).length;
    const restoredItems = invoice.items.map((item) => ({
      productId: item.productId,
      productName: item.product.name,
      sku: item.product.sku,
      qty: item.qty,
    }));

    for (const item of invoice.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.qty } },
      });

      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "RESTOCK",
          qtyDelta: item.qty,
          reason: `INVOICE_CANCEL_REVERSE for ${invoice.invoiceNo}`,
          refInvoiceId: invoiceId,
          createdById: userId,
        },
      });
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: userId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_CANCELLED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          previousStatus: invoice.paymentStatus,
          paidTotal: invoice.paidTotal,
          netTotal: invoice.netTotal,
          successfulPaymentCount,
          pendingPaymentCount,
          paymentHistoryPreserved: true,
          restoredItems,
        },
      },
    });
  });

  return getInvoice(invoiceId);
}
