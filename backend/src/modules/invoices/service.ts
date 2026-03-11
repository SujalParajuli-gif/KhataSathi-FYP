// src/modules/invoices/service.ts — Invoice business logic (core of billing)
import prisma from "../../db/prisma";

/**
 * Generate unique invoice number: INV-YYYYMMDD-XXXX
 */
async function generateInvoiceNo(): Promise<string> {
    const today = new Date();
    const dateStr =
        today.getFullYear().toString() +
        String(today.getMonth() + 1).padStart(2, "0") +
        String(today.getDate()).padStart(2, "0");

    const prefix = `INV-${dateStr}-`;

    // Count today's invoices to get the next sequence number
    const count = await prisma.invoice.count({
        where: { invoiceNo: { startsWith: prefix } },
    });

    return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

// ─── Create Draft ─────────────────────────────────────
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

// ─── List Invoices ────────────────────────────────────
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
        if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z");
    }

    const skip = (page - 1) * pageSize;

    const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where,
            include: {
                cashier: { select: { id: true, name: true } },
                customer: { select: { id: true, name: true, loyaltyPercent: true } },
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

// ─── Get Invoice Detail ──────────────────────────────
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
            },
            cashier: { select: { id: true, name: true } },
            customer: { select: { id: true, name: true, loyaltyPercent: true } },
        },
    });
}

// ─── Add Item (with dual pricing) ────────────────────
export async function addItem(invoiceId: string, productId: string, qty: number) {
    // Check invoice is DRAFT
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    // Get product for pricing
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");
    if (!product.isActive) throw new Error("Product is inactive");

    // Dual pricing: use wholesale if qty >= threshold
    const appliedUnitPrice =
        qty >= product.wholesaleQtyThreshold ? product.wholesalePrice : product.retailPrice;
    const lineTotal = appliedUnitPrice * qty;

    // Check if this product already exists in the invoice
    const existing = await prisma.invoiceItem.findFirst({
        where: { invoiceId, productId },
    });

    let item;
    if (existing) {
        // Update existing item
        const newQty = existing.qty + qty;
        const newUnitPrice =
            newQty >= product.wholesaleQtyThreshold ? product.wholesalePrice : product.retailPrice;
        const newLineTotal = newUnitPrice * newQty;

        item = await prisma.invoiceItem.update({
            where: { id: existing.id },
            data: { qty: newQty, appliedUnitPrice: newUnitPrice, lineTotal: newLineTotal },
        });
    } else {
        item = await prisma.invoiceItem.create({
            data: { invoiceId, productId, qty, appliedUnitPrice, lineTotal },
        });
    }

    // Recompute invoice subtotal
    await recomputeSubtotal(invoiceId);

    return item;
}

// ─── Update Item ─────────────────────────────────────
export async function updateItem(invoiceId: string, itemId: string, qty: number) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    const item = await prisma.invoiceItem.findUnique({
        where: { id: itemId },
        include: { product: true },
    });
    if (!item) throw new Error("Item not found");

    // Recompute price based on new qty
    const product = item.product;
    const appliedUnitPrice =
        qty >= product.wholesaleQtyThreshold ? product.wholesalePrice : product.retailPrice;
    const lineTotal = appliedUnitPrice * qty;

    const updated = await prisma.invoiceItem.update({
        where: { id: itemId },
        data: { qty, appliedUnitPrice, lineTotal },
    });

    await recomputeSubtotal(invoiceId);
    return updated;
}

// ─── Remove Item ─────────────────────────────────────
export async function removeItem(invoiceId: string, itemId: string) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    await prisma.invoiceItem.delete({ where: { id: itemId } });
    await recomputeSubtotal(invoiceId);
}

// ─── Recompute Subtotal ──────────────────────────────
async function recomputeSubtotal(invoiceId: string) {
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId } });
    const subTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);

    await prisma.invoice.update({
        where: { id: invoiceId },
        data: { subTotal },
    });
}

// ─── Finalize Invoice ────────────────────────────────
export async function finalizeInvoice(invoiceId: string, userId: string) {
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

    // Compute subtotal from items
    const subTotal = invoice.items.reduce((sum, i) => sum + i.lineTotal, 0);

    // Apply customer loyalty discount on the bill total
    const loyaltyPercent = invoice.customer?.loyaltyPercent || 0;
    const loyaltyDiscountAmount = Math.round((subTotal * loyaltyPercent) / 100 * 100) / 100;
    const netTotal = Math.round((subTotal - loyaltyDiscountAmount) * 100) / 100;

    // Check stock availability for all items
    for (const item of invoice.items) {
        if (item.product.stock < item.qty) {
            throw new Error(`Insufficient stock for "${item.product.name}". Available: ${item.product.stock}, Requested: ${item.qty}`);
        }
    }

    // Use a transaction for atomicity
    await prisma.$transaction(async (tx) => {
        // 1. Deduct stock for each item and create StockTransaction
        for (const item of invoice.items) {
            await tx.product.update({
                where: { id: item.productId },
                data: { stock: { decrement: item.qty } },
            });

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

        // 2. Lock the invoice (finalize)
        await tx.invoice.update({
            where: { id: invoiceId },
            data: {
                status: "FINALIZED",
                subTotal,
                loyaltyDiscountPercent: loyaltyPercent,
                loyaltyDiscountAmount,
                netTotal,
                finalizedAt: new Date(),
            },
        });

        // 3. Write audit log
        await tx.auditLog.create({
            data: {
                actorId: userId,
                action: "INVOICE_FINALIZED",
                entityType: "Invoice",
                entityId: invoiceId,
                meta: {
                    invoiceNo: invoice.invoiceNo,
                    subTotal,
                    loyaltyPercent,
                    loyaltyDiscountAmount,
                    netTotal,
                    itemCount: invoice.items.length,
                },
            },
        });
    });

    // Return the finalized invoice
    return getInvoice(invoiceId);
}
