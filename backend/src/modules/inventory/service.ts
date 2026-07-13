import prisma from "../../db/prisma";
import {
    applyBusinessThresholds,
    getBusinessSettings,
} from "../settings/service";

export type ReceiveStockLineInput = {
    productId: string;
    qty: number;
};

export type ReceiveStockBatchInput = {
    supplierName: string;
    billNumber?: string;
    billDate?: string;
    billAmount?: number;
    remarks?: string;
    reason?: string;
    lines: ReceiveStockLineInput[];
};

type ProductLookup = {
    id: string;
    name: string;
    sku: string;
    stock: number;
};

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
export async function receiveStockBatch(input: ReceiveStockBatchInput, userId: string) {
    const supplierName = input.supplierName.trim();
    if (!supplierName) throw new Error("Supplier name is required");

    const lines = input.lines
        .map((line) => ({
            productId: String(line.productId || "").trim(),
            qty: Number(line.qty),
        }))
        .filter((line) => line.productId && Number.isFinite(line.qty) && line.qty > 0);

    if (lines.length === 0) {
        throw new Error("At least one received product quantity is required");
    }

    const productIds = [...new Set(lines.map((line) => line.productId))];
    const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, sku: true, stock: true },
    });
    const productsById = new Map<string, ProductLookup>(
        products.map((product) => [product.id, product]),
    );
    const missingProductId = productIds.find((id) => !productsById.has(id));

    if (missingProductId) {
        throw new Error(`Product not found: ${missingProductId}`);
    }

    const batch = await prisma.$transaction(async (tx) => {
        const createdBatch = await tx.stockReceiveBatch.create({
            data: {
                supplierName,
                billNumber: input.billNumber?.trim() || null,
                billDate: input.billDate ? new Date(input.billDate) : null,
                billAmount:
                    input.billAmount !== undefined && Number.isFinite(Number(input.billAmount))
                        ? Number(input.billAmount)
                        : null,
                remarks: input.remarks?.trim() || null,
                createdById: userId,
            },
        });

        const receivedItems: Array<{
            productId: string;
            productName: string;
            sku: string;
            qty: number;
            previousStock: number;
            nextStock: number;
        }> = [];

        for (const line of lines) {
            const product = productsById.get(line.productId)!;
            const previousStock = Number(product.stock || 0);
            const nextStock = previousStock + line.qty;
            await tx.product.update({
                where: { id: line.productId },
                data: { stock: { increment: line.qty } },
            });
            product.stock = nextStock;
            receivedItems.push({
                productId: line.productId,
                productName: product.name,
                sku: product.sku,
                qty: line.qty,
                previousStock,
                nextStock,
            });

            await tx.stockTransaction.create({
                data: {
                    productId: line.productId,
                    type: "RESTOCK",
                    qtyDelta: line.qty,
                    reason: input.reason?.trim() || `Received from ${supplierName}`,
                    createdById: userId,
                    stockReceiveBatchId: createdBatch.id,
                },
            });

            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    action: "PRODUCT_RESTOCKED",
                    entityType: "Product",
                    entityId: line.productId,
                    meta: {
                        productName: product.name,
                        sku: product.sku,
                        qty: line.qty,
                        supplierName,
                        stockReceiveBatchId: createdBatch.id,
                        reason: input.reason,
                    },
                },
            });
        }

        await tx.auditLog.create({
            data: {
                actorId: userId,
                action: "STOCK_RECEIVE_BATCH_CREATED",
                entityType: "StockReceiveBatch",
                entityId: createdBatch.id,
                meta: {
                    supplierName,
                    billNumber: input.billNumber,
                    billDate: input.billDate,
                    billAmount: input.billAmount,
                    lineCount: lines.length,
                    totalQty: lines.reduce((sum, line) => sum + line.qty, 0),
                    items: receivedItems,
                },
            },
        });

        return createdBatch;
    });

    return prisma.stockReceiveBatch.findUnique({
        where: { id: batch.id },
        include: {
            createdBy: { select: { id: true, name: true } },
            transactions: {
                include: {
                    product: { select: { id: true, name: true, sku: true } },
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });
}

export async function getStockReceiveBatchById(id: string) {
    const [batch, auditLog] = await Promise.all([
        prisma.stockReceiveBatch.findUnique({
            where: { id },
            include: {
                createdBy: { select: { id: true, name: true } },
                transactions: {
                    include: {
                        product: { select: { id: true, name: true, sku: true, stock: true } },
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
        }),
        prisma.auditLog.findFirst({
            where: {
                action: "STOCK_RECEIVE_BATCH_CREATED",
                entityType: "StockReceiveBatch",
                entityId: id,
            },
            orderBy: { createdAt: "desc" },
        }),
    ]);

    if (!batch) throw new Error("Stock receive batch not found");
    const historyItems = Array.isArray((auditLog?.meta as any)?.items)
        ? (auditLog?.meta as any).items
        : [];
    return { ...batch, historyItems };
}

export async function recordStockReceiveBillUploadFailure(input: {
    batchId?: string | null;
    actorId: string;
    actorRole?: string;
    supplierName?: string;
    fileCount?: number;
    error?: unknown;
}) {
    const actorRole = String(input.actorRole || "").toUpperCase();
    if (actorRole === "ADMIN") return;

    await prisma.auditLog.create({
        data: {
            actorId: input.actorId,
            action: "STOCK_RECEIVE_BILL_UPLOAD_FAILED",
            entityType: "StockReceiveBatch",
            entityId: input.batchId || "unknown",
            meta: {
                actorRole,
                supplierName: input.supplierName || null,
                fileCount: input.fileCount || 0,
                error: input.error instanceof Error ? input.error.message : String(input.error || ""),
            },
        },
    }).catch(() => undefined);
}

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
        const updated = await tx.product.update({
            where: { id: productId },
            data: { stock: { increment: qtyDelta } },
            select: { stock: true },
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
                meta: {
                    productName: product.name,
                    qtyDelta,
                    previousStock: product.stock,
                    nextStock: updated.stock,
                    reason,
                },
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
            stockReceiveBatch: { select: { id: true, supplierName: true, billNumber: true, billDate: true } },
        },
        orderBy: { createdAt: "desc" }, // newest transactions first
        take: limit,
    });
}

export async function getStockReceiveBatches(filters?: {
    limit?: number;
    page?: number;
    pageSize?: number;
    supplierName?: string;
    billNumber?: string;
    from?: string;
    to?: string;
}) {
    const page = Math.max(1, filters?.page || 1);
    const pageSize = Math.max(1, Math.min(100, filters?.pageSize || filters?.limit || 50));
    const where: any = {};
    if (filters?.supplierName) where.supplierName = { contains: filters.supplierName };
    if (filters?.billNumber) where.billNumber = { contains: filters.billNumber };
    if (filters?.from || filters?.to) {
        where.createdAt = {};
        if (filters.from) where.createdAt.gte = new Date(filters.from);
        if (filters.to) where.createdAt.lte = new Date(filters.to + "T23:59:59.999Z");
    }

    const [batches, total] = await Promise.all([
        prisma.stockReceiveBatch.findMany({
            where,
            include: {
                createdBy: { select: { id: true, name: true } },
                transactions: {
                    include: {
                        product: { select: { id: true, name: true, sku: true } },
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.stockReceiveBatch.count({ where }),
    ]);

    return {
        batches,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

// finding the most recent RESTOCK transaction for a product created by a specific user
// used to link uploaded bill documents to the correct stock transaction after restocking
export async function getRecentRestockTransaction(productId: string, userId: string) {
    return prisma.stockTransaction.findFirst({
        where: {
            productId,
            type: "RESTOCK",
            createdById: userId,
        },
        orderBy: { createdAt: "desc" },
    });
}
