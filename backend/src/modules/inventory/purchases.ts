import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import {
    parseDecimalString,
    validateSupplierInput,
    validatePartialSupplierInput,
    validateScalarId,
    validateDocumentIds,
    validatePurchaseActorRole,
    validateBillDate,
    validateUnitConversion,
    validatePurchaseReceiptLines,
    validatePayableReconciliation,
    buildNormalizedPurchaseReceiptPayload,
    hashPurchaseReceiptPayload,
    validateInstallmentInput,
    buildNormalizedInstallmentPayload,
    hashInstallmentPayload,
    validateVoidPaymentInput,
    ValidatedPurchaseLine,
    PurchaseDecimal,
} from "./purchaseValidation";

import { ReviewClaim, validateReviewClaim, recordReviewResolution } from "./purchaseReviewClaim";

const Decimal = PurchaseDecimal;

export class FinancialPurchaseConflictError extends Error {
    readonly code = "FINANCIAL_PURCHASE_CONFLICT";

    constructor(message: string) {
        super(message);
        this.name = "FinancialPurchaseConflictError";
    }
}

export type FinancialPurchaseLineInput = {
    productId: string;
    inputUnit: string;
    inputQty: string | number;
    conversionFactor?: string | number;
    unitAcquisitionCost: string | number;
    lineAmount?: string | number;
};

export type FinancialPurchaseReceiptInput = {
    supplierId: string;
    billNumber?: string | null;
    billDate?: string | Date | null;
    remarks?: string | null;
    reason?: string | null;
    payable: string | number;
    operationKey: string;
    lines: FinancialPurchaseLineInput[];
    documentIds?: string[];
};

export type PurchaseInstallmentInput = {
    amount: string | number;
    method: "CASH" | "BANK_TRANSFER" | "OTHER";
    reference?: string | null;
    paidAt: string | Date;
    operationKey: string;
};

// Helper to determine if an error is a transaction lock/deadlock conflict
function isTransactionConflictError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { code?: unknown; message?: unknown };
    const code = String(candidate.code || "").toUpperCase();
    if (["P2034", "1213", "1205", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code)) {
        return true;
    }
    const message = String(candidate.message || "");
    return /deadlock found|lock wait timeout|transaction conflict/i.test(message);
}

// Helper to execute financial transaction with bounded retries and explicit ReadCommitted
async function runWithTransactionRetry<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    maxAttempts = 2
): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await prisma.$transaction(work, {
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            });
        } catch (error) {
            if (isTransactionConflictError(error) && attempt < maxAttempts) {
                continue;
            }
            throw error;
        }
    }
    throw new FinancialPurchaseConflictError("Transaction failed after retry due to lock conflict");
}

/* =========================================================================
   1. SUPPLIER CRUD & LISTING
   ========================================================================= */

export async function createSupplier(input: any, actorId: string) {
    const validated = validateSupplierInput(input);

    const supplier = await prisma.$transaction(async (tx: any) => {
        const created = await tx.supplier.create({
            data: {
                name: validated.name,
                contact: validated.contact,
                phone: validated.phone,
                panNo: validated.panNo,
                address: validated.address,
                isActive: validated.isActive,
            },
        });

        await tx.auditLog.create({
            data: {
                actorId,
                action: "PURCHASE_SUPPLIER_CREATED",
                entityType: "Supplier",
                entityId: created.id,
                meta: {
                    name: created.name,
                    phone: created.phone,
                    panNo: created.panNo,
                },
            },
        });

        return created;
    });

    return supplier;
}

export async function updateSupplier(id: string, input: any, actorId: string) {
    const normalizedId = validateScalarId(id, "Supplier ID");
    const validated = validatePartialSupplierInput(input);

    return runWithTransactionRetry(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM Supplier WHERE id = ${normalizedId} FOR UPDATE`;
        const existing = await tx.supplier.findUnique({
            where: { id: normalizedId },
        });
        if (!existing) {
            throw new Error("Supplier not found");
        }

        const mergedName = validated.name !== undefined ? validated.name : existing.name;
        const mergedContact =
            validated.contact !== undefined ? validated.contact : existing.contact;
        const mergedPhone =
            validated.phone !== undefined ? validated.phone : existing.phone;
        const mergedPanNo =
            validated.panNo !== undefined ? validated.panNo : existing.panNo;
        const mergedAddress =
            validated.address !== undefined ? validated.address : existing.address;
        const mergedIsActive =
            validated.isActive !== undefined ? validated.isActive : existing.isActive;

        const result = await tx.supplier.update({
            where: { id: normalizedId },
            data: {
                name: mergedName,
                contact: mergedContact,
                phone: mergedPhone,
                panNo: mergedPanNo,
                address: mergedAddress,
                isActive: mergedIsActive,
            },
        });

        await tx.auditLog.create({
            data: {
                actorId,
                action: "PURCHASE_SUPPLIER_UPDATED",
                entityType: "Supplier",
                entityId: normalizedId,
                meta: {
                    previous: {
                        name: existing.name,
                        phone: existing.phone,
                        panNo: existing.panNo,
                        isActive: existing.isActive,
                    },
                    next: {
                        name: result.name,
                        phone: result.phone,
                        panNo: result.panNo,
                        isActive: result.isActive,
                    },
                },
            },
        });

        return result;
    });
}

export async function deactivateSupplier(id: string, actorId: string) {
    return updateSupplier(id, { isActive: false }, actorId);
}

export async function getSupplierById(id: string) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) throw new Error("Supplier ID is required");

    const supplier = await (prisma as any).supplier.findUnique({
        where: { id: normalizedId },
    });
    if (!supplier) {
        throw new Error("Supplier not found");
    }
    return supplier;
}

/** All recorded supplier receipts, independent of receipt filters/pagination. */
export async function getSupplierBalance(id: string, actorRole: string) {
    validatePurchaseActorRole(actorRole);
    const supplierId = validateScalarId(id, "Supplier ID");
    // Aggregates can exceed a single Decimal(20,2) receipt's precision.
    const BalanceDecimal = Prisma.Decimal.clone({ precision: 50 });
    return prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({
            where: { id: supplierId },
            select: { id: true, name: true, isActive: true },
        });
        if (!supplier) throw new Error("Supplier not found");
        const financial = { supplierId, payable: { not: null }, postedAt: { not: null } };
        const receipts = await tx.stockReceiveBatch.aggregate({
            where: financial, _sum: { payable: true }, _count: { id: true },
        });
        const payments = await tx.supplierPayment.aggregate({
            where: { voidedAt: null, batch: financial }, _sum: { amount: true },
        });
        const unknownReceiptCount = await tx.stockReceiveBatch.count({
            where: { supplierId, OR: [{ payable: null }, { postedAt: null }] },
        });
        const payable = new BalanceDecimal(receipts._sum.payable?.toString() ?? "0");
        const paid = new BalanceDecimal(payments._sum.amount?.toString() ?? "0");
        const due = payable.sub(paid).toFixed(2);
        return {
            supplier,
            basis: "RECORDED_SUPPLIER_RECEIPTS" as const,
            postedReceiptCount: receipts._count.id,
            unknownReceiptCount,
            payable: payable.toFixed(2),
            paid: paid.toFixed(2),
            due,
            recordedBalance: unknownReceiptCount ? null : due,
        };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listSuppliers(params?: {
    q?: string;
    page?: number;
    pageSize?: number;
    includeInactive?: boolean;
}) {
    const page = Math.max(1, params?.page || 1);
    const pageSize = Math.max(1, Math.min(50, params?.pageSize || 20));
    const q = params?.q ? String(params.q).trim().slice(0, 160) : "";

    const where: any = {};
    if (!params?.includeInactive) {
        where.isActive = true;
    }
    if (q) {
        where.OR = [
            { name: { contains: q } },
            { phone: { contains: q } },
            { panNo: { contains: q } },
            { contact: { contains: q } },
        ];
    }

    const [suppliers, total] = await Promise.all([
        (prisma as any).supplier.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        (prisma as any).supplier.count({ where }),
    ]);

    return {
        suppliers,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

/* =========================================================================
   2. FINANCIAL PURCHASE RECEIPT POSTING (CORE SERVICE)
   ========================================================================= */

export async function postFinancialPurchaseReceipt(
    input: FinancialPurchaseReceiptInput,
    actorId: string,
    actorRole: string,
    reviewClaim?: ReviewClaim
) {
    const role = validatePurchaseActorRole(actorRole);
    const normalizedActorId = validateScalarId(actorId, "Actor ID");
    const operationKey = validateScalarId(input.operationKey, "Financial operation key");
    const supplierId = validateScalarId(input.supplierId, "Supplier ID");
    const cleanDocIds = validateDocumentIds(input.documentIds);

    // 1. Validate lines and reconcile payable
    const validatedLines = validatePurchaseReceiptLines(input.lines);
    const validatedPayable = validatePayableReconciliation(validatedLines, input.payable);

    // 2. Build canonical normalized payload and compute deterministic hash
    const normalizedPayload = buildNormalizedPurchaseReceiptPayload({
        actorId: normalizedActorId,
        supplierId,
        billNumber: input.billNumber,
        billDate: input.billDate,
        remarks: input.remarks,
        reason: input.reason,
        payable: validatedPayable,
        lines: validatedLines,
        documentIds: cleanDocIds,
    });
    const payloadHash = hashPurchaseReceiptPayload(normalizedPayload);

    // 3. Early Replay check BEFORE validation of current supplier/product states
    const existingBatch = await (prisma as any).stockReceiveBatch.findUnique({
        where: { operationKey },
    });
    if (existingBatch) {
        if (existingBatch.payloadHash === payloadHash) {
            // Safe replay of same operation
            return getFinancialPurchaseReceiptById(existingBatch.id, role);
        }
        throw new FinancialPurchaseConflictError(
            `Operation key conflict: operationKey "${operationKey}" was previously used with different parameters`
        );
    }

    // 4. Execute transactional confirmation
    let createdBatchId: string;
    try {
        createdBatchId = await runWithTransactionRetry(async (tx: any) => {
            // Lock supplier FOR UPDATE unconditionally
            await tx.$queryRaw`SELECT id FROM Supplier WHERE id = ${supplierId} FOR UPDATE`;

            // Re-check replay inside transaction immediately after supplier lock, before mutable validation
            const replayCheck = await tx.stockReceiveBatch.findUnique({
                where: { operationKey },
            });
            if (replayCheck) {
                if (replayCheck.payloadHash === payloadHash) {
                    return replayCheck.id;
                }
                throw new FinancialPurchaseConflictError(
                    `Operation key conflict: operationKey "${operationKey}" was previously used with different parameters`
                );
            }

            const supplier = await tx.supplier.findUnique({
                where: { id: supplierId },
            });
            if (!supplier) {
                throw new Error("Supplier not found");
            }
            if (!supplier.isActive) {
                throw new Error(
                    `Cannot post purchase receipt for inactive supplier "${supplier.name}"`
                );
            }

            // Sort product IDs to prevent deadlock and lock FOR UPDATE
            const sortedProductIds = [...new Set(validatedLines.map((l) => l.productId))].sort(
                (a, b) => a.localeCompare(b)
            );
            for (const pid of sortedProductIds) {
                await tx.$queryRaw`SELECT id FROM Product WHERE id = ${pid} FOR UPDATE`;
            }

            const products = await tx.product.findMany({
                where: { id: { in: sortedProductIds } },
            });
            const productsById = new Map<string, any>(products.map((p: any) => [p.id, p]));

            for (const pid of sortedProductIds) {
                const product = productsById.get(pid);
                if (!product) {
                    throw new Error(`Product not found: ${pid}`);
                }
                if (!product.isActive) {
                    throw new Error(
                        `Cannot post purchase receipt for inactive product "${product.name}" (${product.sku})`
                    );
                }
            }

            // Validate unit conversions against current product records
            for (const line of validatedLines) {
                const product = productsById.get(line.productId)!;
                validateUnitConversion(product, line.inputUnit, line.conversionFactor);
            }

            // Document locks & claim validations
            const documentsToClaim: any[] = [];
            if (cleanDocIds.length > 0) {
                for (const docId of cleanDocIds) {
                    await tx.$queryRaw`SELECT id FROM Document WHERE id = ${docId} FOR UPDATE`;
                }
                const docs = await tx.document.findMany({
                    where: { id: { in: cleanDocIds } },
                });
                const docsById = new Map<string, any>(docs.map((d: any) => [d.id, d]));

                for (const docId of cleanDocIds) {
                    const doc = docsById.get(docId);
                    if (!doc) {
                        throw new Error(`Document not found: ${docId}`);
                    }
                    if (role === "MANAGER" && doc.visibility === "ADMIN_ONLY") {
                        throw new Error(
                            `Document ${docId} visibility is restricted to ADMIN only and cannot be claimed by MANAGER`
                        );
                    }
                    if (doc.documentType !== "PURCHASE_BILL" && doc.documentType !== "STOCK_BILL") {
                        throw new Error(
                            `Document ${docId} has invalid type "${doc.documentType}". Allowed: PURCHASE_BILL or STOCK_BILL`
                        );
                    }
                    if (doc.deletedAt) {
                        throw new Error(`Document ${docId} has been deleted and cannot be attached`);
                    }
                    if (doc.linkedEntityType !== null || doc.linkedEntityId !== null) {
                        throw new Error(`Document ${docId} is already linked to another record`);
                    }
                    if (reviewClaim && reviewClaim.documentId === doc.id) validateReviewClaim(doc, reviewClaim, role);
                    documentsToClaim.push(doc);
                }
            }

            if (reviewClaim && !documentsToClaim.some(doc => doc.id === reviewClaim.documentId)) throw new Error("Reviewed source must be claimed with receipt");

            // Aggregate stock delta per distinct product and validate exact Float representation BEFORE effects
            const stockDeltaByProduct = new Map<string, InstanceType<typeof Decimal>>();
            for (const line of validatedLines) {
                const prev = stockDeltaByProduct.get(line.productId) || new Decimal(0);
                stockDeltaByProduct.set(line.productId, prev.add(line.stockQty));
            }

            for (const [productId, qtyDelta] of stockDeltaByProduct.entries()) {
                const product = productsById.get(productId)!;
                const deltaNum = qtyDelta.toNumber();
                if (!Number.isFinite(deltaNum) || !new Decimal(deltaNum).equals(qtyDelta)) {
                    throw new Error(
                        `Stock delta (${qtyDelta.toString()}) for product "${product.name}" (${product.sku}) cannot be represented accurately in stock storage`
                    );
                }

                const currentStockDec = new Decimal(product.stock ?? 0);
                const resultingStockDec = currentStockDec.add(qtyDelta);
                const resultingStockNum = resultingStockDec.toNumber();
                if (
                    !Number.isFinite(resultingStockNum) ||
                    !new Decimal(resultingStockNum).equals(resultingStockDec)
                ) {
                    throw new Error(
                        `Resulting stock (${resultingStockDec.toString()}) for product "${product.name}" (${product.sku}) cannot be represented accurately in stock storage`
                    );
                }
            }

            // Create StockReceiveBatch
            const batch = await tx.stockReceiveBatch.create({
                data: {
                    supplierId: supplier.id,
                    supplierName: supplier.name,
                    billNumber: input.billNumber ? String(input.billNumber).trim() : null,
                    billDate: normalizedPayload.billDate
                        ? new Date(normalizedPayload.billDate + "T00:00:00.000Z")
                        : null,
                    billAmount: validatedPayable.toNumber(), // legacy Float compatibility view
                    payable: validatedPayable,
                    postedAt: new Date(),
                    operationKey,
                    payloadHash,
                    remarks: input.remarks ? String(input.remarks).trim() : null,
                    createdById: normalizedActorId,
                },
            });

            // Create ordered StockReceiveBatchItems (preserves duplicates!)
            for (const line of validatedLines) {
                const product = productsById.get(line.productId)!;
                await tx.stockReceiveBatchItem.create({
                    data: {
                        batchId: batch.id,
                        productId: line.productId,
                        lineOrder: line.lineOrder,
                        productNameSnapshot: product.name,
                        productSkuSnapshot: product.sku,
                        saleUnitSnapshot: product.saleUnit,
                        inputUnit: line.inputUnit,
                        inputQty: line.inputQty,
                        conversionFactor: line.conversionFactor,
                        stockQty: line.stockQty,
                        unitAcquisitionCost: line.unitAcquisitionCost,
                        lineAmount: line.lineAmount,
                    },
                });
            }

            // Post inventory movements atomically
            for (const [productId, qtyDelta] of stockDeltaByProduct.entries()) {
                const product = productsById.get(productId)!;
                const deltaNum = qtyDelta.toNumber();

                await tx.product.update({
                    where: { id: productId },
                    data: { stock: { increment: deltaNum } },
                });

                await tx.stockTransaction.create({
                    data: {
                        productId,
                        type: "RESTOCK",
                        qtyDelta: deltaNum,
                        reason:
                            input.reason?.trim() ||
                            `Received from ${supplier.name} (Purchase ${batch.id})`,
                        createdById: normalizedActorId,
                        stockReceiveBatchId: batch.id,
                        createdAt: new Date(),
                    },
                });

                await tx.auditLog.create({
                    data: {
                        actorId: normalizedActorId,
                        action: "PURCHASE_STOCK_POSTED",
                        entityType: "Product",
                        entityId: productId,
                        meta: {
                            productName: product.name,
                            sku: product.sku,
                            qty: deltaNum,
                            supplierId: supplier.id,
                            supplierName: supplier.name,
                            stockReceiveBatchId: batch.id,
                            reason: input.reason,
                        },
                    },
                });
            }

            // Create PURCHASE_RECEIPT_POSTED audit log
            await tx.auditLog.create({
                data: {
                    actorId: normalizedActorId,
                    action: "PURCHASE_RECEIPT_POSTED",
                    entityType: "StockReceiveBatch",
                    entityId: batch.id,
                    meta: {
                        supplierId: supplier.id,
                        supplierName: supplier.name,
                        payable: validatedPayable.toFixed(2),
                        lineCount: validatedLines.length,
                        operationKey,
                        billNumber: input.billNumber || null,
                        billDate: input.billDate || null,
                        documentCount: documentsToClaim.length,
                    },
                },
            });

            // Claim staged documents atomically via conditional updateMany
            for (const doc of documentsToClaim) {
                const newVisibility =
                    doc.visibility === "ADMIN_ONLY" ? "ADMIN_ONLY" : "ADMIN_MANAGER";
                const updateRes = await tx.document.updateMany({
                    where: {
                        id: doc.id,
                        documentType: { in: ["PURCHASE_BILL", "STOCK_BILL"] },
                        visibility: doc.visibility,
                        deletedAt: null,
                        linkedEntityType: null,
                        linkedEntityId: null,
                    },
                    data: {
                        linkedEntityType: "StockReceiveBatch",
                        linkedEntityId: batch.id,
                        documentType: "PURCHASE_BILL",
                        visibility: newVisibility,
                    },
                });

                if (updateRes.count !== 1) {
                    throw new Error(
                        `Failed to claim document ${doc.id}: document was modified, deleted, or claimed concurrently`
                    );
                }

                await tx.auditLog.create({
                    data: {
                        actorId: normalizedActorId,
                        action: "PURCHASE_DOCUMENT_ATTACHED",
                        entityType: "StockReceiveBatch",
                        entityId: batch.id,
                        meta: {
                            documentId: doc.id,
                            previousType: doc.documentType,
                            visibility: newVisibility,
                        },
                    },
                });
            }

            if (reviewClaim) await recordReviewResolution(tx, documentsToClaim.find(doc => doc.id === reviewClaim.documentId), reviewClaim, batch.id);
            return batch.id;
        });
    } catch (error: any) {
        // Race condition handler for unique constraint on operationKey
        if (error?.code === "P2002") {
            const check = await (prisma as any).stockReceiveBatch.findUnique({
                where: { operationKey },
            });
            if (check && check.payloadHash === payloadHash) {
                return getFinancialPurchaseReceiptById(check.id, role);
            }
            throw new FinancialPurchaseConflictError(
                `Operation key conflict: operationKey "${operationKey}" was previously used with different parameters`
            );
        }
        throw error;
    }

    return getFinancialPurchaseReceiptById(createdBatchId, role);
}

/* =========================================================================
   3. ATTACHMENT-ONLY RECOVERY PRIMITIVES (INDEPENDENT OF STOCK)
   ========================================================================= */

export async function attachDocumentsToPurchaseReceipt(
    batchId: string,
    documentIds: string[],
    actorId: string,
    actorRole: string,
    reviewClaim?: ReviewClaim
) {
    const role = validatePurchaseActorRole(actorRole);
    const normalizedBatchId = validateScalarId(batchId, "Purchase receipt ID");
    const normalizedActorId = validateScalarId(actorId, "Actor ID");
    const cleanDocIds = validateDocumentIds(documentIds);

    if (cleanDocIds.length === 0) {
        throw new Error("At least one document ID is required to attach");
    }

    await runWithTransactionRetry(async (tx: any) => {
        // Lock batch FOR UPDATE unconditionally
        await tx.$queryRaw`SELECT id FROM StockReceiveBatch WHERE id = ${normalizedBatchId} FOR UPDATE`;
        const batch = await tx.stockReceiveBatch.findUnique({
            where: { id: normalizedBatchId },
        });
        if (!batch) {
            throw new Error("Purchase receipt not found");
        }
        if (batch.postedAt === null || batch.supplierId === null || batch.payable === null) {
            throw new Error("Cannot attach purchase documents to a non-financial legacy batch");
        }

        // Lock documents FOR UPDATE in sorted order
        for (const docId of cleanDocIds) {
            await tx.$queryRaw`SELECT id FROM Document WHERE id = ${docId} FOR UPDATE`;
        }
        const docs = await tx.document.findMany({
            where: { id: { in: cleanDocIds } },
        });
        const docsById = new Map<string, any>(docs.map((d: any) => [d.id, d]));

        for (const docId of cleanDocIds) {
            const doc = docsById.get(docId);
            if (!doc) {
                throw new Error(`Document not found: ${docId}`);
            }
            // Visibility check before claims or no-op
            if (role === "MANAGER" && doc.visibility === "ADMIN_ONLY") {
                throw new Error(
                    `Document ${docId} visibility is restricted to ADMIN only and cannot be accessed by MANAGER`
                );
            }
            // Valid PURCHASE proof required for attachment same-receipt no-op; reject arbitrary GENERAL forged link
            if (doc.documentType !== "PURCHASE_BILL" && doc.documentType !== "STOCK_BILL") {
                throw new Error(
                    `Document ${docId} has invalid type "${doc.documentType}". Allowed: PURCHASE_BILL or STOCK_BILL`
                );
            }
            if (doc.deletedAt) {
                throw new Error(`Document ${docId} has been deleted and cannot be attached`);
            }
            if (reviewClaim && reviewClaim.documentId === doc.id) validateReviewClaim(doc, reviewClaim, role);
            // Idempotent check: if already linked to this receipt, skip
            if (
                doc.linkedEntityType === "StockReceiveBatch" &&
                doc.linkedEntityId === normalizedBatchId
            ) {
                continue;
            }
            if (doc.linkedEntityType !== null || doc.linkedEntityId !== null) {
                throw new Error(`Document ${docId} is already linked to another record`);
            }

            const newVisibility =
                doc.visibility === "ADMIN_ONLY" ? "ADMIN_ONLY" : "ADMIN_MANAGER";

            const updateRes = await tx.document.updateMany({
                where: {
                    id: doc.id,
                    documentType: { in: ["PURCHASE_BILL", "STOCK_BILL"] },
                    visibility: doc.visibility,
                    deletedAt: null,
                    linkedEntityType: null,
                    linkedEntityId: null,
                },
                data: {
                    linkedEntityType: "StockReceiveBatch",
                    linkedEntityId: normalizedBatchId,
                    documentType: "PURCHASE_BILL",
                    visibility: newVisibility,
                },
            });

            if (updateRes.count !== 1) {
                throw new Error(
                    `Failed to claim document ${doc.id}: document was modified, deleted, or claimed concurrently`
                );
            }

            await tx.auditLog.create({
                data: {
                    actorId: normalizedActorId,
                    action: "PURCHASE_DOCUMENT_ATTACHED",
                    entityType: "StockReceiveBatch",
                    entityId: normalizedBatchId,
                    meta: {
                        documentId: doc.id,
                        previousType: doc.documentType,
                        visibility: newVisibility,
                    },
                },
            });
        }
        if (reviewClaim) {
            const reviewedDoc = docsById.get(reviewClaim.documentId);
            if (!reviewedDoc) throw new Error("Reviewed source must be attached with receipt");
            await recordReviewResolution(tx, reviewedDoc, reviewClaim, normalizedBatchId);
        }
    });

    return getFinancialPurchaseReceiptById(normalizedBatchId, role);
}

/* =========================================================================
   4. SUPPLIER PAYMENT INSTALLMENTS & VOIDS
   ========================================================================= */

export async function recordPurchaseInstallment(
    batchId: string,
    input: PurchaseInstallmentInput,
    actorId: string
) {
    const normalizedBatchId = validateScalarId(batchId, "Purchase receipt ID");
    const normalizedActorId = validateScalarId(actorId, "Actor ID");
    const validated = validateInstallmentInput(input);
    const normalizedPayload = buildNormalizedInstallmentPayload({
        actorId: normalizedActorId,
        batchId: normalizedBatchId,
        amount: validated.amount,
        method: validated.method,
        reference: validated.reference,
        paidAt: validated.paidAt,
    });
    const payloadHash = hashInstallmentPayload(normalizedPayload);

    // Early Replay check
    const existingPayment = await (prisma as any).supplierPayment.findUnique({
        where: { operationKey: validated.operationKey },
    });
    if (existingPayment) {
        if (existingPayment.payloadHash === payloadHash) {
            return formatSupplierPaymentDto(existingPayment);
        }
        throw new FinancialPurchaseConflictError(
            `Operation key conflict: payment operation "${validated.operationKey}" was previously recorded with different parameters`
        );
    }

    let createdPaymentId: string;
    try {
        createdPaymentId = await runWithTransactionRetry(async (tx: any) => {
            // Lock StockReceiveBatch FOR UPDATE unconditionally
            await tx.$queryRaw`SELECT id FROM StockReceiveBatch WHERE id = ${normalizedBatchId} FOR UPDATE`;

            // Re-check replay inside transaction immediately after receipt batch lock, before mutable validation
            const replayCheck = await tx.supplierPayment.findUnique({
                where: { operationKey: validated.operationKey },
            });
            if (replayCheck) {
                if (replayCheck.payloadHash === payloadHash) {
                    return replayCheck.id;
                }
                throw new FinancialPurchaseConflictError(
                    `Operation key conflict: payment operation "${validated.operationKey}" was previously recorded with different parameters`
                );
            }

            const batch = await tx.stockReceiveBatch.findUnique({
                where: { id: normalizedBatchId },
            });
            if (!batch) {
                throw new Error("Purchase receipt not found");
            }
            if (batch.postedAt === null || batch.payable === null || batch.supplierId === null) {
                throw new Error(
                    "Cannot record installment payment on a non-financial receipt without known payable"
                );
            }

            // Lock payments FOR UPDATE for this batch
            await tx.$queryRaw`SELECT id FROM SupplierPayment WHERE batchId = ${normalizedBatchId} FOR UPDATE`;

            const payable = new Decimal(batch.payable);
            const payments = await tx.supplierPayment.findMany({
                where: { batchId: normalizedBatchId },
            });

            const activePayments = payments.filter((p: any) => p.voidedAt === null);
            const paidSoFar = activePayments.reduce(
                (sum: any, p: any) => sum.add(new Decimal(p.amount)),
                new Decimal(0)
            );
            const due = payable.sub(paidSoFar);

            if (validated.amount.gt(due)) {
                throw new Error(
                    `Payment amount (${validated.amount.toFixed(2)}) exceeds balance due (${due.toFixed(2)})`
                );
            }

            const payment = await tx.supplierPayment.create({
                data: {
                    batchId: normalizedBatchId,
                    operationKey: validated.operationKey,
                    payloadHash,
                    amount: validated.amount,
                    method: validated.method,
                    reference: validated.reference,
                    paidAt: validated.paidAt,
                    createdById: normalizedActorId,
                },
            });

            await tx.auditLog.create({
                data: {
                    actorId: normalizedActorId,
                    action: "PURCHASE_SUPPLIER_PAYMENT_POSTED",
                    entityType: "SupplierPayment",
                    entityId: payment.id,
                    meta: {
                        batchId: normalizedBatchId,
                        amount: validated.amount.toFixed(2),
                        method: validated.method,
                        reference: validated.reference,
                        remainingDue: due.sub(validated.amount).toFixed(2),
                    },
                },
            });

            return payment.id;
        });
    } catch (error: any) {
        if (error?.code === "P2002") {
            const check = await (prisma as any).supplierPayment.findUnique({
                where: { operationKey: validated.operationKey },
            });
            if (check && check.payloadHash === payloadHash) {
                return formatSupplierPaymentDto(check);
            }
            throw new FinancialPurchaseConflictError(
                `Operation key conflict: payment operation "${validated.operationKey}" was previously recorded with different parameters`
            );
        }
        throw error;
    }

    const created = await (prisma as any).supplierPayment.findUnique({
        where: { id: createdPaymentId },
    });
    return formatSupplierPaymentDto(created);
}

export async function voidPurchaseInstallment(
    paymentId: string,
    input: any,
    actorId: string
) {
    const normalizedPaymentId = validateScalarId(paymentId, "Payment ID");
    const normalizedActorId = validateScalarId(actorId, "Actor ID");
    const { voidReason } = validateVoidPaymentInput(input);

    const voidedPayment = await runWithTransactionRetry(async (tx: any) => {
        // 1. Locate immutable batchId first
        const initialPayment = await tx.supplierPayment.findUnique({
            where: { id: normalizedPaymentId },
        });
        if (!initialPayment) {
            throw new Error("Supplier payment not found");
        }
        const batchId = initialPayment.batchId;

        // 2. Lock receipt batch FOR UPDATE to serialize balance mutations
        await tx.$queryRaw`SELECT id FROM StockReceiveBatch WHERE id = ${batchId} FOR UPDATE`;
        const batch = await tx.stockReceiveBatch.findUnique({
            where: { id: batchId },
        });
        if (!batch) {
            throw new Error("Purchase receipt not found");
        }
        if (batch.postedAt === null || batch.payable === null || batch.supplierId === null) {
            throw new Error("Cannot void payment on a non-financial legacy batch");
        }

        // 3. Lock and reread payment FOR UPDATE
        await tx.$queryRaw`SELECT id FROM SupplierPayment WHERE id = ${normalizedPaymentId} FOR UPDATE`;
        const payment = await tx.supplierPayment.findUnique({
            where: { id: normalizedPaymentId },
        });
        if (!payment) {
            throw new Error("Supplier payment not found");
        }

        // 4. Idempotent void check AFTER locking and rereading
        if (payment.voidedAt !== null) {
            return payment;
        }

        const updated = await tx.supplierPayment.update({
            where: { id: normalizedPaymentId },
            data: {
                voidedAt: new Date(),
                voidedById: normalizedActorId,
                voidReason,
            },
        });

        await tx.auditLog.create({
            data: {
                actorId: normalizedActorId,
                action: "PURCHASE_SUPPLIER_PAYMENT_VOIDED",
                entityType: "SupplierPayment",
                entityId: normalizedPaymentId,
                meta: {
                    batchId: payment.batchId,
                    amount: new Decimal(payment.amount).toFixed(2),
                    reason: voidReason,
                },
            },
        });

        return updated;
    });

    return formatSupplierPaymentDto(voidedPayment);
}

/* =========================================================================
   5. RECEIPT DETAIL & QUERY HELPERS
   ========================================================================= */

function formatSupplierPaymentDto(payment: any) {
    return {
        id: payment.id,
        batchId: payment.batchId,
        amount: new Decimal(payment.amount).toFixed(2),
        method: payment.method,
        reference: payment.reference || null,
        paidAt: payment.paidAt instanceof Date ? payment.paidAt.toISOString() : payment.paidAt,
        createdById: payment.createdById,
        createdAt:
            payment.createdAt instanceof Date
                ? payment.createdAt.toISOString()
                : payment.createdAt,
        isVoided: payment.voidedAt !== null,
        voidedAt:
            payment.voidedAt instanceof Date
                ? payment.voidedAt.toISOString()
                : payment.voidedAt || null,
        voidedById: payment.voidedById || null,
        voidReason: payment.voidReason || null,
    };
}

export async function getFinancialPurchaseReceiptById(id: string, actorRole: string) {
    const normalizedId = validateScalarId(id, "Receipt ID");
    const role = validatePurchaseActorRole(actorRole);

    const batch = await (prisma as any).stockReceiveBatch.findUnique({
        where: { id: normalizedId },
        include: {
            createdBy: { select: { id: true, name: true } },
            supplier: true,
            items: { orderBy: { lineOrder: "asc" } },
            payments: { orderBy: { createdAt: "asc" } },
            transactions: {
                include: {
                    product: { select: { id: true, name: true, sku: true } },
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });

    if (!batch) {
        throw new Error("Stock receive batch not found");
    }

    const isFinancial = batch.payable !== null && batch.supplierId !== null && batch.postedAt !== null;

    const docWhere: any = {
        linkedEntityType: "StockReceiveBatch",
        linkedEntityId: normalizedId,
        deletedAt: null,
    };
    if (role === "MANAGER") {
        docWhere.visibility = { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] };
    }
    if (isFinancial) {
        docWhere.documentType = "PURCHASE_BILL";
    } else {
        docWhere.documentType = { in: ["PURCHASE_BILL", "STOCK_BILL"] };
    }

    const linkedDocuments = await (prisma as any).document.findMany({
        where: docWhere,
        select: {
            id: true,
            title: true,
            fileName: true,
            mimeType: true,
            fileSize: true,
            documentType: true,
            visibility: true,
            createdAt: true,
        },
        orderBy: { createdAt: "asc" },
    });

    let payable: string | null = null;
    let paidTotal: string | null = null;
    let dueAmount: string | null = null;
    let paymentStatus: "LEGACY" | "UNPAID" | "PARTIAL" | "PAID" = "LEGACY";

    if (isFinancial) {
        const payableDec = new Decimal(batch.payable);
        payable = payableDec.toFixed(2);

        const activePayments = (batch.payments || []).filter((p: any) => p.voidedAt === null);
        const paidDec = activePayments.reduce(
            (sum: any, p: any) => sum.add(new Decimal(p.amount)),
            new Decimal(0)
        );
        paidTotal = paidDec.toFixed(2);

        const dueDec = payableDec.sub(paidDec);
        dueAmount = dueDec.toFixed(2);

        if (paidDec.gte(payableDec)) {
            paymentStatus = "PAID";
        } else if (paidDec.gt(new Decimal(0))) {
            paymentStatus = "PARTIAL";
        } else {
            paymentStatus = "UNPAID";
        }
    }

    return {
        id: batch.id,
        isFinancial,
        supplierName: batch.supplierName,
        supplierId: batch.supplierId || null,
        supplier: batch.supplier || null,
        billNumber: batch.billNumber || null,
        billDate: batch.billDate ? batch.billDate.toISOString().slice(0, 10) : null,
        billAmount: batch.billAmount !== null ? Number(batch.billAmount) : null,
        payable,
        paidTotal,
        dueAmount,
        paymentStatus,
        remarks: batch.remarks || null,
        operationKey: batch.operationKey || null,
        postedAt: batch.postedAt ? batch.postedAt.toISOString() : null,
        createdById: batch.createdById,
        createdBy: batch.createdBy,
        createdAt: batch.createdAt.toISOString(),
        updatedAt: batch.updatedAt.toISOString(),
        items: (batch.items || []).map((item: any) => ({
            id: item.id,
            lineOrder: item.lineOrder,
            productId: item.productId,
            productName: item.productNameSnapshot,
            sku: item.productSkuSnapshot,
            saleUnit: item.saleUnitSnapshot,
            inputUnit: item.inputUnit,
            inputQty: new Decimal(item.inputQty).toFixed(3),
            conversionFactor: new Decimal(item.conversionFactor).toFixed(6),
            stockQty: new Decimal(item.stockQty).toFixed(3),
            unitAcquisitionCost: new Decimal(item.unitAcquisitionCost).toFixed(6),
            lineAmount: new Decimal(item.lineAmount).toFixed(2),
        })),
        payments: (batch.payments || []).map(formatSupplierPaymentDto),
        documents: linkedDocuments.map((doc: any) => ({
            id: doc.id,
            title: doc.title,
            fileName: doc.fileName,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            documentType: doc.documentType,
            visibility: doc.visibility,
            createdAt: doc.createdAt.toISOString(),
        })),
        stockTransactions: (batch.transactions || []).map((tx: any) => ({
            id: tx.id,
            productId: tx.productId,
            productName: tx.product?.name,
            sku: tx.product?.sku,
            qtyDelta: tx.qtyDelta,
            reason: tx.reason,
            createdAt:
                tx.createdAt instanceof Date
                    ? tx.createdAt.toISOString()
                    : tx.createdAt
                    ? new Date(tx.createdAt).toISOString()
                    : null,
        })),
    };
}

export type ListFinancialPurchaseReceiptsParams = {
    supplierId?: string;
    q?: string;
    kind?: "ALL" | "FINANCIAL" | "LEGACY";
    page?: number;
    pageSize?: number;
};

export type FinancialPurchaseReceiptSummary = {
    id: string;
    supplierId: string | null;
    capturedSupplierName: string | null;
    billNumber: string | null;
    billDate: string | null;
    payable: string | null;
    postedAt: string | null;
    isFinancial: boolean;
    knownPayable: boolean;
    paid: string | null;
    due: string | null;
    paymentStatus: "LEGACY" | "UNPAID" | "PARTIAL" | "PAID";
    createdAt: string;
};

export type ListFinancialPurchaseReceiptsResult = {
    items: FinancialPurchaseReceiptSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
};

export async function listFinancialPurchaseReceipts(
    params?: ListFinancialPurchaseReceiptsParams
): Promise<ListFinancialPurchaseReceiptsResult> {
    const page = Math.max(1, Math.floor(Number(params?.page) || 1));
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(params?.pageSize) || 20)));
    const q = params?.q ? String(params.q).trim().slice(0, 160) : "";
    const supplierId = params?.supplierId ? String(params.supplierId).trim() : "";
    const rawKind = params?.kind ? String(params.kind).trim().toUpperCase() : "ALL";
    const kind = rawKind === "FINANCIAL" || rawKind === "LEGACY" ? rawKind : "ALL";

    const conditions: any[] = [];

    if (supplierId) {
        conditions.push({ supplierId });
    }

    if (kind === "FINANCIAL") {
        conditions.push({ payable: { not: null } });
        conditions.push({ supplierId: { not: null } });
        conditions.push({ postedAt: { not: null } });
    } else if (kind === "LEGACY") {
        conditions.push({
            OR: [{ payable: null }, { supplierId: null }, { postedAt: null }],
        });
    }

    if (q) {
        conditions.push({
            OR: [
                { billNumber: { contains: q } },
                { supplierName: { contains: q } },
                { supplier: { name: { contains: q } } },
            ],
        });
    }

    const where: any = conditions.length > 0 ? { AND: conditions } : {};

    const [batches, total] = await Promise.all([
        (prisma as any).stockReceiveBatch.findMany({
            where,
            include: {
                supplier: { select: { id: true, name: true } },
                payments: {
                    select: {
                        id: true,
                        amount: true,
                        voidedAt: true,
                    },
                },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        (prisma as any).stockReceiveBatch.count({ where }),
    ]);

    const items: FinancialPurchaseReceiptSummary[] = batches.map((batch: any) => {
        const isFinancial =
            batch.payable !== null && batch.supplierId !== null && batch.postedAt !== null;
        let payable: string | null = null;
        let paid: string | null = null;
        let due: string | null = null;
        let paymentStatus: "LEGACY" | "UNPAID" | "PARTIAL" | "PAID" = "LEGACY";
        const knownPayable = isFinancial;

        if (isFinancial) {
            const payableDec = new Decimal(batch.payable);
            payable = payableDec.toFixed(2);

            const activePayments = (batch.payments || []).filter(
                (p: any) => p.voidedAt === null
            );
            const paidDec = activePayments.reduce(
                (sum: InstanceType<typeof Decimal>, p: any) => sum.add(new Decimal(p.amount)),
                new Decimal(0)
            );
            paid = paidDec.toFixed(2);

            const dueDec = payableDec.sub(paidDec);
            due = dueDec.toFixed(2);

            if (paidDec.gte(payableDec)) {
                paymentStatus = "PAID";
            } else if (paidDec.gt(new Decimal(0))) {
                paymentStatus = "PARTIAL";
            } else {
                paymentStatus = "UNPAID";
            }
        }

        return {
            id: batch.id,
            supplierId: batch.supplierId || null,
            capturedSupplierName: batch.supplierName || batch.supplier?.name || null,
            billNumber: batch.billNumber || null,
            billDate: batch.billDate
                ? (batch.billDate instanceof Date
                      ? batch.billDate.toISOString().slice(0, 10)
                      : String(batch.billDate).slice(0, 10))
                : null,
            payable,
            postedAt: batch.postedAt
                ? (batch.postedAt instanceof Date
                      ? batch.postedAt.toISOString()
                      : String(batch.postedAt))
                : null,
            isFinancial,
            knownPayable,
            paid,
            due,
            paymentStatus,
            createdAt:
                batch.createdAt instanceof Date
                    ? batch.createdAt.toISOString()
                    : String(batch.createdAt),
        };
    });

    return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}
