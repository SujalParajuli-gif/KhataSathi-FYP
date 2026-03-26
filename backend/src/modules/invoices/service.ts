import prisma from "../../db/prisma";

async function generateInvoiceNo(): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0");

  const prefix = `INV-${dateStr}-`;
  const count = await prisma.invoice.count({ where: { invoiceNo: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

export async function createDraft(cashierId: string, customerId?: string) {
  const invoiceNo = await generateInvoiceNo();
  return prisma.invoice.create({
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
  const { status, cashierId, from, to, page = 1, pageSize = 20 } = filters;
  const where: any = {};
  if (status) where.status = status;
  if (cashierId) where.cashierId = cashierId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(`${to}T23:59:59.999Z`);
  }

  const skip = (page - 1) * pageSize;
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        cashier: { select: { id: true, name: true, email: true } },
        customer: { select: { id: true, name: true, phone: true, loyaltyPercent: true, wholesalePercent: true } },
        items: {
          select: {
            id: true,
            qty: true,
            appliedUnitPrice: true,
            lineTotal: true,
            product: { select: { id: true, name: true, sku: true, barcode: true } },
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
      take: pageSize,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { invoices, total, page, pageSize };
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
      customer: { select: { id: true, name: true, phone: true, email: true, loyaltyPercent: true, wholesalePercent: true } },
    },
  });
}

export async function addItem(invoiceId: string, productId: string, qty: number) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("Product not found");
  if (!product.isActive) throw new Error("Product is inactive");
  if (product.stock <= 0) throw new Error("Product is out of stock");

  const computedUnitPrice = qty >= product.wholesaleQtyThreshold ? product.wholesalePrice : product.retailPrice;
  const appliedUnitPrice = computedUnitPrice;
  const lineTotal = appliedUnitPrice * qty;

  const existing = await prisma.invoiceItem.findFirst({ where: { invoiceId, productId } });

  if (existing) {
    const newQty = existing.qty + qty;
    if (newQty > product.stock) {
      throw new Error(`Insufficient stock for "${product.name}". Available: ${product.stock}, Requested: ${newQty}`);
    }
    const recalculatedUnitPrice = newQty >= product.wholesaleQtyThreshold
      ? product.wholesalePrice
      : product.retailPrice;
    const newLineTotal = recalculatedUnitPrice * newQty;

    const item = await prisma.invoiceItem.update({
      where: { id: existing.id },
      data: { qty: newQty, appliedUnitPrice: recalculatedUnitPrice, lineTotal: newLineTotal },
    });
    await recomputeSubtotal(invoiceId);
    return item;
  }

  if (qty > product.stock) {
    throw new Error(`Insufficient stock for "${product.name}". Available: ${product.stock}, Requested: ${qty}`);
  }

  const item = await prisma.invoiceItem.create({
    data: { invoiceId, productId, qty, appliedUnitPrice, lineTotal },
  });
  await recomputeSubtotal(invoiceId);
  return item;
}

export async function updateItem(invoiceId: string, itemId: string, qty: number) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const item = await prisma.invoiceItem.findUnique({ where: { id: itemId }, include: { product: true } });
  if (!item) throw new Error("Item not found");
  if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");
  if (qty > item.product.stock) {
    throw new Error(`Insufficient stock for "${item.product.name}". Available: ${item.product.stock}, Requested: ${qty}`);
  }

  const appliedUnitPrice = qty >= item.product.wholesaleQtyThreshold ? item.product.wholesalePrice : item.product.retailPrice;
  const lineTotal = appliedUnitPrice * qty;

  const updated = await prisma.invoiceItem.update({
    where: { id: itemId },
    data: { qty, appliedUnitPrice, lineTotal },
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

async function recomputeSubtotal(invoiceId: string) {
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId } });
  const subTotal = items.reduce((sum, item) => sum + item.lineTotal, 0);

  await prisma.invoice.update({ where: { id: invoiceId }, data: { subTotal } });
}

export async function finalizeInvoice(invoiceId: string, userId: string, discountAmount?: number) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: { include: { product: true } },
      customer: true,
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Invoice is already finalized");
  if (invoice.items.length === 0) throw new Error("Cannot finalize an empty invoice");

  const subTotal = invoice.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const computedLoyaltyPercent = invoice.customer?.loyaltyPercent || 0;
  const computedDiscount = Math.round((subTotal * computedLoyaltyPercent) / 100 * 100) / 100;
  const normalizedDiscount = typeof discountAmount === "number"
    ? Math.max(0, Math.min(subTotal, Math.round(discountAmount * 100) / 100))
    : computedDiscount;
  const appliedDiscountPercent = subTotal > 0 ? Math.round((normalizedDiscount / subTotal) * 10000) / 100 : 0;
  const netTotal = Math.round((subTotal - normalizedDiscount) * 100) / 100;

  for (const item of invoice.items) {
    if (item.product.stock < item.qty) {
      throw new Error(`Insufficient stock for "${item.product.name}". Available: ${item.product.stock}, Requested: ${item.qty}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const item of invoice.items) {
      await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
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
          subTotal,
          discountAmount: normalizedDiscount,
          discountPercent: appliedDiscountPercent,
          netTotal,
          itemCount: invoice.items.length,
        },
      },
    });
  });

  return getInvoice(invoiceId);
}

export async function cancelInvoice(invoiceId: string, userId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
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

  const remainingDue = Math.max(0, invoice.netTotal - invoice.paidTotal);

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus: "CANCELLED",
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
          previousStatus: invoice.paymentStatus,
          paidTotal: invoice.paidTotal,
          netTotal: invoice.netTotal,
          remainingDue,
        },
      },
    });
  });

  return getInvoice(invoiceId);
}
