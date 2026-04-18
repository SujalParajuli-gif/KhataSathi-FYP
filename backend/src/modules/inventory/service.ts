import prisma from "../../db/prisma";
import {
    applyBusinessThresholds,
    getBusinessSettings,
} from "../settings/service";

// adding stock to a product — used when new inventory arrives
// we wrap this in a transaction because the stock update, stock transaction log, and audit log
// all need to succeed together or fail together
export async function restockProduct(
    productId: string,
    qty: number,
    reason: string,
    userId: string
) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");

    await prisma.$transaction(async (tx) => {
        // increasing the product's stock by the given quantity
        await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: qty } },
        });

        // recording the stock change as a RESTOCK transaction so we can track it in history
        await tx.stockTransaction.create({
            data: {
                productId,
                type: "RESTOCK",
                qtyDelta: qty, // positive value because stock is being added
                reason: reason || "Manual restock",
                createdById: userId,
            },
        });

        // creating an audit log entry so the admin can see who restocked which product and when
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

    // fetching the updated product and applying business thresholds before returning
    const updatedProduct = await prisma.product.findUnique({ where: { id: productId } });
    if (!updatedProduct) return updatedProduct;

    const settings = await getBusinessSettings();
    return applyBusinessThresholds(updatedProduct, settings);
}

// manually adjusting stock — the delta can be positive (adding) or negative (removing)
// we use this for corrections like damaged goods, counting errors, or manual fixes
export async function adjustStock(
    productId: string,
    qtyDelta: number,
    reason: string,
    userId: string
) {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");

    // checking that the adjustment will not make stock go below 0
    // we do not allow negative stock values in the system
    if (product.stock + qtyDelta < 0) {
        throw new Error(`Adjustment would result in negative stock. Current: ${product.stock}, delta: ${qtyDelta}`);
    }

    await prisma.$transaction(async (tx) => {
        // applying the stock adjustment (increment works for both positive and negative values)
        await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: qtyDelta } },
        });

        // recording the adjustment as an ADJUSTMENT type stock transaction
        await tx.stockTransaction.create({
            data: {
                productId,
                type: "ADJUSTMENT",
                qtyDelta, // can be positive or negative
                reason: reason || "Manual adjustment",
                createdById: userId,
            },
        });

        // creating an audit log entry for the manual adjustment
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

    const updatedProduct = await prisma.product.findUnique({ where: { id: productId } });
    if (!updatedProduct) return updatedProduct;

    const settings = await getBusinessSettings();
    return applyBusinessThresholds(updatedProduct, settings);
}

// fetching all active products that have stock at or below their resolved low stock threshold
// we fetch all active products first, resolve each product's effective threshold (custom or default),
// then filter to only include those that are at or below the threshold
export async function getLowStockProducts() {
    const [products, settings] = await Promise.all([
        prisma.product.findMany({
        where: { isActive: true },
        include: { brand: { select: { id: true, name: true } } },
        orderBy: { stock: "asc" }, // lowest stock first
        }),
        getBusinessSettings(),
    ]);

    // applying resolved thresholds and filtering to products at or below their threshold
    return products
        .map((product) => applyBusinessThresholds(product, settings))
        .filter((p) => p.stock <= p.lowStockThreshold);
}

// fetching recent stock transactions, optionally filtered by product ID
// each transaction shows the type (SALE, RESTOCK, ADJUSTMENT), quantity change, reason, and who did it
export async function getStockTransactions(productId?: string, limit = 50) {
    const where = productId ? { productId } : {}; // if no product ID is given, return transactions for all products
    return prisma.stockTransaction.findMany({
        where,
        include: {
            product: { select: { id: true, name: true, sku: true } },
            createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" }, // newest transactions first
        take: limit,
    });
}
