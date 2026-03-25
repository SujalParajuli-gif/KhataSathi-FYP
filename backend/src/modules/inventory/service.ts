import prisma from "../../db/prisma";

/**
 * Restock a product (add stock).
 */
export async function restockProduct(
    productId: string,
    qty: number,
    reason: string,
    userId: string
) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");

    await prisma.$transaction(async (tx) => {
        await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: qty } },
        });

        await tx.stockTransaction.create({
            data: {
                productId,
                type: "RESTOCK",
                qtyDelta: qty,
                reason: reason || "Manual restock",
                createdById: userId,
            },
        });

        await tx.auditLog.create({
            data: {
                actorId: userId,
                action: "PRODUCT_RESTOCKED",
                entityType: "Product",
                entityId: productId,
                meta: { productName: product.name, qty, reason },
            },
        });
    });

    return prisma.product.findUnique({ where: { id: productId } });
}

/**
 * Adjust stock (can be positive or negative).
 */
export async function adjustStock(
    productId: string,
    qtyDelta: number,
    reason: string,
    userId: string
) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");

    // Don't allow stock to go below zero
    if (product.stock + qtyDelta < 0) {
        throw new Error(`Adjustment would result in negative stock. Current: ${product.stock}, delta: ${qtyDelta}`);
    }

    await prisma.$transaction(async (tx) => {
        await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: qtyDelta } },
        });

        await tx.stockTransaction.create({
            data: {
                productId,
                type: "ADJUSTMENT",
                qtyDelta,
                reason: reason || "Manual adjustment",
                createdById: userId,
            },
        });

        await tx.auditLog.create({
            data: {
                actorId: userId,
                action: "STOCK_ADJUSTED",
                entityType: "Product",
                entityId: productId,
                meta: { productName: product.name, qtyDelta, reason },
            },
        });
    });

    return prisma.product.findUnique({ where: { id: productId } });
}

/**
 * Get low-stock products.
 */
export async function getLowStockProducts() {
    // Prisma doesn't let us compare two columns (stock <= lowStockThreshold),
    // so we fetch active products and filter in JS.
    const products = await prisma.product.findMany({
        where: { isActive: true },
        include: { brand: { select: { id: true, name: true } } },
        orderBy: { stock: "asc" },
    });

    return products.filter((p) => p.stock <= p.lowStockThreshold);
}

/**
 * Get stock transactions for a product.
 */
export async function getStockTransactions(productId?: string, limit = 50) {
    const where = productId ? { productId } : {};
    return prisma.stockTransaction.findMany({
        where,
        include: {
            product: { select: { id: true, name: true, sku: true } },
            createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
    });
}
