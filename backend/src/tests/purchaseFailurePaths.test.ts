import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import {
    postFinancialPurchaseReceipt,
    recordPurchaseInstallment,
    voidPurchaseInstallment,
    FinancialPurchaseConflictError,
} from "../modules/inventory/purchases";
import {
    validatePurchaseReceiptLines,
    validatePayableReconciliation,
    buildNormalizedPurchaseReceiptPayload,
    hashPurchaseReceiptPayload,
    buildNormalizedInstallmentPayload,
    hashInstallmentPayload,
    validateBillDate,
    PurchaseDecimal,
    MAX_QTY,
    MAX_CONVERSION_FACTOR,
    MAX_ACQUISITION_COST,
    MAX_MONEY_DECIMAL,
} from "../modules/inventory/purchaseValidation";

const Decimal = PurchaseDecimal;

/* =========================================================================
   1. PURE VALIDATION TESTS (missingcost, overflow, large mul, fullpaidAt,
      reasonchangedhash, date)
   ========================================================================= */

test("pure: missing unit acquisition cost is rejected; explicit zero is allowed", () => {
    // Missing / undefined / null / empty unitAcquisitionCost throws
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "5",
                conversionFactor: "1",
                // unitAcquisitionCost missing
            },
        ]);
    }, /Line 1 unit acquisition cost is required/i);

    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "5",
                conversionFactor: "1",
                unitAcquisitionCost: "",
            },
        ]);
    }, /Line 1 unit acquisition cost is required/i);

    // Explicit zero cost is permitted (allowZero: true)
    const lines = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "10",
            conversionFactor: "1",
            unitAcquisitionCost: "0.000000",
        },
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].unitAcquisitionCost.toFixed(6), "0.000000");
    assert.equal(lines[0].lineAmount.toFixed(2), "0.00");
});

test("pure: overflow against database Decimal bounds is rejected", () => {
    // inputQty exceeding MAX_QTY
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "1000000000000000.000", // > MAX_QTY
                conversionFactor: "1",
                unitAcquisitionCost: "10",
            },
        ]);
    }, /cannot exceed 999999999999999\.999/i);

    // conversionFactor exceeding MAX_CONVERSION_FACTOR
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "1",
                conversionFactor: "1000000000000.000000", // > MAX_CONVERSION_FACTOR
                unitAcquisitionCost: "10",
            },
        ]);
    }, /cannot exceed 999999999999\.999999/i);

    // unitAcquisitionCost exceeding MAX_ACQUISITION_COST
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "1",
                conversionFactor: "1",
                unitAcquisitionCost: "100000000000000.000000", // > MAX_ACQUISITION_COST
            },
        ]);
    }, /cannot exceed 99999999999999\.999999/i);

    // Derived stockQty exceeding MAX_QTY
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "BOX",
                inputQty: "999999999999999.000",
                conversionFactor: "2", // derived stockQty = 1999999999999998.000 > MAX_QTY
                unitAcquisitionCost: "10",
            },
        ]);
    }, /Stock quantity derived from conversion .* exceeds maximum allowable bound/i);
});

test("pure: large line multiplication near half-cent computes exact string without double-rounding (CORE-3)", () => {
    // 24-digit multiplication testing ROUND_HALF_UP boundary:
    // Case 1: 100000000000000.001 * 4.999999 = 499999900000000.004999999
    // Fraction .004999999 is strictly < 0.005 -> rounds HALF_UP to .00
    const lines1 = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "100000000000000.001",
            conversionFactor: "1",
            unitAcquisitionCost: "4.999999",
        },
    ]);
    assert.equal(lines1[0].lineAmount.toFixed(2), "499999900000000.00");

    // Case 2: 100000000000000.001 * 5.000001 = 500000100000000.005001001
    // Fraction .005001001 is strictly > 0.005 -> rounds HALF_UP to .01
    const lines2 = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "100000000000000.001",
            conversionFactor: "1",
            unitAcquisitionCost: "5.000001",
        },
    ]);
    assert.equal(lines2[0].lineAmount.toFixed(2), "500000100000000.01");
});

test("pure: installment payload hash preserves full ISO string of paidAt with time component", () => {
    const payload1 = buildNormalizedInstallmentPayload({
        actorId: "user_admin",
        batchId: "batch_1",
        amount: new Decimal("250.00"),
        method: "CASH",
        reference: null,
        paidAt: new Date("2026-10-09T08:00:00.000Z"),
    });

    const payload2 = buildNormalizedInstallmentPayload({
        actorId: "user_admin",
        batchId: "batch_1",
        amount: new Decimal("250.00"),
        method: "CASH",
        reference: null,
        paidAt: new Date("2026-10-09T14:30:00.000Z"),
    });

    assert.equal(payload1.paidAt, "2026-10-09T08:00:00.000Z");
    assert.equal(payload2.paidAt, "2026-10-09T14:30:00.000Z");

    const hash1 = hashInstallmentPayload(payload1);
    const hash2 = hashInstallmentPayload(payload2);
    assert.notEqual(hash1, hash2, "Distinct time on paidAt produces distinct deterministic payload hashes");
});

test("pure: changing reason or remarks alters deterministic payload hash", () => {
    const baseLines = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "2",
            conversionFactor: "1",
            unitAcquisitionCost: "50",
        },
    ]);

    const basePayload = buildNormalizedPurchaseReceiptPayload({
        actorId: "user_admin",
        supplierId: "supp_1",
        billNumber: "INV-1",
        billDate: "2026-10-09",
        remarks: "Remark A",
        reason: "Reason A",
        payable: new Decimal("100.00"),
        lines: baseLines,
    });
    const baseHash = hashPurchaseReceiptPayload(basePayload);

    // Changing reason changes hash
    const changedReason = buildNormalizedPurchaseReceiptPayload({
        ...basePayload,
        payable: new Decimal(basePayload.payable),
        lines: baseLines,
        reason: "Reason B",
    });
    assert.notEqual(baseHash, hashPurchaseReceiptPayload(changedReason));

    // Changing remarks changes hash
    const changedRemarks = buildNormalizedPurchaseReceiptPayload({
        ...basePayload,
        payable: new Decimal(basePayload.payable),
        lines: baseLines,
        remarks: "Remark B",
    });
    assert.notEqual(baseHash, hashPurchaseReceiptPayload(changedRemarks));
});

test("pure: validateBillDate rejects invalid calendar dates and malformed strings", () => {
    assert.throws(() => validateBillDate("2026-02-30"), /Invalid real calendar date "2026-02-30"/i);
    assert.throws(() => validateBillDate("2026-13-01"), /Invalid real calendar date "2026-13-01"/i);
    assert.throws(() => validateBillDate("2026/10/09"), /Invalid bill date format/i);
    assert.throws(() => validateBillDate("invalid-date"), /Invalid bill date format/i);
    assert.equal(validateBillDate("2026-10-09"), "2026-10-09");
    assert.equal(validateBillDate(new Date("2026-10-09T00:00:00Z")), "2026-10-09");
});

/* =========================================================================
   2. CONTROLLED ROLLBACK / LOCK / FAILURE PATH TESTS (TX-LOCAL DOUBLES)
   ========================================================================= */

function setupTxMockStore() {
    const db = {
        suppliers: new Map<string, any>([
            [
                "supp_1",
                {
                    id: "supp_1",
                    name: "Apex Distributors",
                    phone: "9841111111",
                    panNo: "300123456",
                    contact: "Hari",
                    address: "Kathmandu",
                    isActive: true,
                },
            ],
        ]),
        products: new Map<string, any>([
            [
                "prod_z",
                {
                    id: "prod_z",
                    name: "Product Z",
                    sku: "SKU-Z",
                    saleUnit: "PIECE",
                    packageUnit: "PIECE",
                    packageQuantity: 1,
                    isActive: true,
                    stock: 20,
                },
            ],
            [
                "prod_a",
                {
                    id: "prod_a",
                    name: "Product A",
                    sku: "SKU-A",
                    saleUnit: "PIECE",
                    packageUnit: "PIECE",
                    packageQuantity: 1,
                    isActive: true,
                    stock: 10,
                },
            ],
        ]),
        documents: new Map<string, any>([
            [
                "doc_1",
                {
                    id: "doc_1",
                    title: "Bill 1",
                    fileName: "bill_1.pdf",
                    documentType: "PURCHASE_BILL",
                    visibility: "ADMIN_MANAGER",
                    linkedEntityType: null,
                    linkedEntityId: null,
                    deletedAt: null,
                },
            ],
            [
                "doc_admin",
                {
                    id: "doc_admin",
                    title: "Confidential Bill",
                    fileName: "bill_admin.pdf",
                    documentType: "PURCHASE_BILL",
                    visibility: "ADMIN_ONLY",
                    linkedEntityType: null,
                    linkedEntityId: null,
                    deletedAt: null,
                },
            ],
        ]),
        batches: new Map<string, any>(),
        batchItems: [] as any[],
        stockTransactions: [] as any[],
        audits: [] as any[],
        payments: new Map<string, any>(),
    };

    return db;
}

test("failure-paths: verifies ReadCommitted isolation and strict lock ordering (Supplier -> sorted Products -> Documents)", async () => {
    const db = setupTxMockStore();
    const lockLog: string[] = [];
    let capturedIsolationLevel: string | undefined;

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDoc = (prisma as any).document;

    try {
        (prisma as any).$transaction = async (fn: any, options?: any) => {
            capturedIsolationLevel = options?.isolationLevel;

            // Clone to tx-local state
            const txSuppliers = new Map<string, any>(JSON.parse(JSON.stringify(Array.from(db.suppliers.entries()))));
            const txProducts = new Map<string, any>(JSON.parse(JSON.stringify(Array.from(db.products.entries()))));
            const txDocuments = new Map<string, any>(JSON.parse(JSON.stringify(Array.from(db.documents.entries()))));
            const txBatches = new Map<string, any>(JSON.parse(JSON.stringify(Array.from(db.batches.entries()))));
            const txItems = JSON.parse(JSON.stringify(db.batchItems));
            const txStockTx = JSON.parse(JSON.stringify(db.stockTransactions));
            const txAudits = JSON.parse(JSON.stringify(db.audits));

            const mockTx = {
                $queryRaw: async (parts: TemplateStringsArray, ...vals: any[]) => {
                    const str = parts.join("?");
                    lockLog.push(`${str.trim()}:${vals.join(",")}`);
                    return [];
                },
                supplier: {
                    findUnique: async ({ where }: any) => txSuppliers.get(where.id) || null,
                },
                product: {
                    findMany: async ({ where }: any) => where.id.in.map((id: string) => txProducts.get(id)).filter(Boolean),
                    update: async ({ where, data }: any) => {
                        const p = txProducts.get(where.id);
                        p.stock += data.stock.increment;
                        return p;
                    },
                },
                document: {
                    findMany: async ({ where }: any) => where.id.in.map((id: string) => txDocuments.get(id)).filter(Boolean),
                    updateMany: async ({ where, data }: any) => {
                        const d = txDocuments.get(where.id);
                        if (!d || d.linkedEntityId !== null) return { count: 0 };
                        Object.assign(d, data);
                        return { count: 1 };
                    },
                },
                stockReceiveBatch: {
                    findUnique: async ({ where }: any) => {
                        if (where.operationKey) {
                            return Array.from(txBatches.values()).find((b: any) => b.operationKey === where.operationKey) || null;
                        }
                        return txBatches.get(where.id) || null;
                    },
                    create: async ({ data }: any) => {
                        const b = { id: `batch_${txBatches.size + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
                        txBatches.set(b.id, b);
                        return b;
                    },
                },
                stockReceiveBatchItem: {
                    create: async ({ data }: any) => {
                        const it = { id: `item_${txItems.length + 1}`, ...data };
                        txItems.push(it);
                        return it;
                    },
                },
                stockTransaction: {
                    create: async ({ data }: any) => {
                        const st = { id: `stx_${txStockTx.length + 1}`, ...data, createdAt: new Date() };
                        txStockTx.push(st);
                        return st;
                    },
                },
                auditLog: {
                    create: async ({ data }: any) => {
                        const a = { id: `audit_${txAudits.length + 1}`, ...data };
                        txAudits.push(a);
                        return a;
                    },
                },
            };

            const res = await fn(mockTx);

            // Commit only on success
            db.suppliers = txSuppliers;
            db.products = txProducts;
            db.documents = txDocuments;
            db.batches = txBatches;
            db.batchItems = txItems;
            db.stockTransactions = txStockTx;
            db.audits = txAudits;

            return res;
        };

        (prisma as any).stockReceiveBatch = {
            findUnique: async ({ where }: any) => {
                if (where.operationKey) {
                    return Array.from(db.batches.values()).find((b: any) => b.operationKey === where.operationKey) || null;
                }
                const b = db.batches.get(where.id);
                if (!b) return null;
                return {
                    ...b,
                    createdBy: { id: "user_admin", name: "Admin" },
                    supplier: db.suppliers.get(b.supplierId),
                    items: db.batchItems.filter((i) => i.batchId === b.id),
                    payments: [],
                    transactions: db.stockTransactions.filter((t) => t.stockReceiveBatchId === b.id),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
            },
        };
        (prisma as any).document = {
            findMany: async () => [],
        };

        // Lines passed with prod_z before prod_a: must sort locks strictly
        const receipt = await postFinancialPurchaseReceipt(
            {
                supplierId: "supp_1",
                payable: "150.00",
                operationKey: "op_lock_test",
                lines: [
                    { productId: "prod_z", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "100.00" },
                    { productId: "prod_a", inputUnit: "PIECE", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "50.00" },
                ],
                documentIds: ["doc_1"],
            },
            "user_admin",
            "ADMIN"
        );

        assert.equal(receipt.isFinancial, true);
        assert.equal(capturedIsolationLevel, Prisma.TransactionIsolationLevel.ReadCommitted, "Explicit ReadCommitted required");

        // Verify lock sequence:
        // 1. Supplier lock
        // 2. Product locks in sorted order: prod_a, then prod_z
        // 3. Document lock: doc_1
        assert.ok(lockLog[0].includes("FROM Supplier WHERE id = ? FOR UPDATE:supp_1"), "Supplier locked first");
        assert.ok(lockLog[1].includes("FROM Product WHERE id = ? FOR UPDATE:prod_a"), "Product A locked first in sorted order");
        assert.ok(lockLog[2].includes("FROM Product WHERE id = ? FOR UPDATE:prod_z"), "Product Z locked second in sorted order");
        assert.ok(lockLog[3].includes("FROM Document WHERE id = ? FOR UPDATE:doc_1"), "Document locked third");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDoc;
    }
});

function setupTransactionalHarness(
    db: ReturnType<typeof setupTxMockStore>,
    options?: {
        failOnAuditAction?: string;
        failDocClaim?: boolean;
        onBeforeAuditFailure?: (staged: {
            txBatches: Map<string, any>;
            txItems: any[];
            txProducts: Map<string, any>;
            txStockTx: any[];
            txAudits: any[];
        }) => void;
        onBeforeDocClaimFailure?: (staged: {
            txBatches: Map<string, any>;
            txItems: any[];
            txProducts: Map<string, any>;
            txStockTx: any[];
            txAudits: any[];
        }) => void;
    }
) {
    (prisma as any).$transaction = async (fn: any) => {
        // Clone mutable maps/arrays to tx-local state
        const txProducts = new Map<string, any>(
            JSON.parse(JSON.stringify(Array.from(db.products.entries())))
        );
        const txDocuments = new Map<string, any>(
            JSON.parse(JSON.stringify(Array.from(db.documents.entries())))
        );
        const txBatches = new Map<string, any>(
            JSON.parse(JSON.stringify(Array.from(db.batches.entries())))
        );
        const txItems: any[] = JSON.parse(JSON.stringify(db.batchItems));
        const txStockTx: any[] = JSON.parse(JSON.stringify(db.stockTransactions));
        const txAudits: any[] = JSON.parse(JSON.stringify(db.audits));

        const mockTx = {
            $queryRaw: async () => [],
            supplier: {
                findUnique: async ({ where }: any) => db.suppliers.get(where.id) || null,
            },
            product: {
                findMany: async ({ where }: any) =>
                    where.id.in.map((id: string) => txProducts.get(id)).filter(Boolean),
                update: async ({ where, data }: any) => {
                    const p = txProducts.get(where.id);
                    p.stock += data.stock.increment;
                    return p;
                },
            },
            document: {
                findMany: async ({ where }: any) => {
                    if (where?.id?.in) {
                        return where.id.in.map((id: string) => txDocuments.get(id)).filter(Boolean);
                    }
                    return Array.from(txDocuments.values());
                },
                updateMany: async ({ where, data }: any) => {
                    if (options?.failDocClaim) {
                        if (options.onBeforeDocClaimFailure) {
                            options.onBeforeDocClaimFailure({
                                txBatches,
                                txItems,
                                txProducts,
                                txStockTx,
                                txAudits,
                            });
                        }
                        return { count: 0 };
                    }
                    const d = txDocuments.get(where.id);
                    if (!d || d.linkedEntityId !== null) return { count: 0 };
                    Object.assign(d, data);
                    return { count: 1 };
                },
            },
            stockReceiveBatch: {
                findUnique: async ({ where }: any) => {
                    if (where.operationKey) {
                        return (
                            Array.from(txBatches.values()).find(
                                (b: any) => b.operationKey === where.operationKey
                            ) || null
                        );
                    }
                    return txBatches.get(where.id) || null;
                },
                create: async ({ data }: any) => {
                    const now = new Date();
                    const b = {
                        id: `batch_mock_${txBatches.size + 1}`,
                        ...data,
                        createdAt: now,
                        updatedAt: now,
                        postedAt: data.postedAt || now,
                    };
                    txBatches.set(b.id, b);
                    return b;
                },
            },
            stockReceiveBatchItem: {
                create: async ({ data }: any) => {
                    const it = { id: `item_${txItems.length + 1}`, ...data };
                    txItems.push(it);
                    return it;
                },
            },
            stockTransaction: {
                create: async ({ data }: any) => {
                    const st = { id: `stx_${txStockTx.length + 1}`, ...data, createdAt: new Date() };
                    txStockTx.push(st);
                    return st;
                },
            },
            auditLog: {
                create: async ({ data }: any) => {
                    if (options?.failOnAuditAction && data.action === options.failOnAuditAction) {
                        if (options.onBeforeAuditFailure) {
                            options.onBeforeAuditFailure({
                                txBatches,
                                txItems,
                                txProducts,
                                txStockTx,
                                txAudits,
                            });
                        }
                        throw new Error("Simulated audit disk failure AFTER stock write");
                    }
                    const a = { id: `audit_${txAudits.length + 1}`, ...data, createdAt: new Date() };
                    txAudits.push(a);
                    return a;
                },
            },
        };

        const res = await fn(mockTx);

        // Commit to base store ONLY after success
        for (const [k, v] of txProducts.entries()) db.products.set(k, v);
        for (const [k, v] of txDocuments.entries()) db.documents.set(k, v);
        for (const [k, v] of txBatches.entries()) db.batches.set(k, v);
        db.batchItems = [...txItems];
        db.stockTransactions = [...txStockTx];
        db.audits = [...txAudits];

        return res;
    };

    (prisma as any).stockReceiveBatch = {
        findUnique: async ({ where }: any) => {
            if (where.operationKey) {
                return (
                    Array.from(db.batches.values()).find(
                        (b: any) => b.operationKey === where.operationKey
                    ) || null
                );
            }
            const b = db.batches.get(where.id);
            if (!b) return null;
            return {
                ...b,
                createdBy: { id: "user_admin", name: "Admin" },
                supplier: db.suppliers.get(b.supplierId) || null,
                items: db.batchItems.filter((i) => i.batchId === b.id),
                payments: [],
                transactions: db.stockTransactions
                    .filter((t) => t.stockReceiveBatchId === b.id)
                    .map((t) => ({
                        ...t,
                        product: db.products.get(t.productId)
                            ? {
                                  id: db.products.get(t.productId).id,
                                  name: db.products.get(t.productId).name,
                                  sku: db.products.get(t.productId).sku,
                              }
                            : null,
                    })),
                createdAt: b.createdAt instanceof Date ? b.createdAt : new Date(),
                updatedAt: b.updatedAt instanceof Date ? b.updatedAt : new Date(),
                postedAt: b.postedAt instanceof Date ? b.postedAt : new Date(),
                billDate:
                    b.billDate instanceof Date
                        ? b.billDate
                        : b.billDate
                        ? new Date(b.billDate)
                        : null,
            };
        },
    };

    (prisma as any).document = {
        findMany: async ({ where }: any) => {
            const docs = Array.from(db.documents.values());
            if (where?.linkedEntityId) {
                return docs
                    .filter((d) => d.linkedEntityId === where.linkedEntityId && !d.deletedAt)
                    .map((d) => ({
                        id: d.id,
                        title: d.title || "Bill",
                        fileName: d.fileName || "bill.pdf",
                        mimeType: d.mimeType || "application/pdf",
                        fileSize: d.fileSize || 1024,
                        documentType: d.documentType,
                        visibility: d.visibility,
                        createdAt: d.createdAt instanceof Date ? d.createdAt : new Date(),
                    }));
            }
            if (where?.id?.in) {
                return where.id.in.map((id: string) => db.documents.get(id)).filter(Boolean);
            }
            return [];
        },
    };
}

test("failure-paths: positive control commits stock, batch, items, movements, audits and documents when failure injection is disabled", async () => {
    const db = setupTxMockStore();

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDoc = (prisma as any).document;

    try {
        setupTransactionalHarness(db);

        const receipt = await postFinancialPurchaseReceipt(
            {
                supplierId: "supp_1",
                payable: "50.00",
                operationKey: "op_success_control",
                lines: [
                    {
                        productId: "prod_a",
                        inputUnit: "PIECE",
                        inputQty: "2",
                        conversionFactor: "1",
                        unitAcquisitionCost: "25.00",
                    },
                ],
                documentIds: ["doc_1"],
            },
            "user_admin",
            "ADMIN"
        );

        assert.equal(receipt.isFinancial, true);
        assert.equal(receipt.payable, "50.00");
        assert.equal(receipt.items.length, 1);
        assert.equal(receipt.documents.length, 1);
        assert.equal(receipt.paymentStatus, "UNPAID");

        // Verify base store actually committed:
        assert.equal(db.batches.size, 1, "Batch committed to base store on success");
        assert.equal(db.batchItems.length, 1, "Batch items committed to base store on success");
        assert.equal(db.products.get("prod_a").stock, 12, "Product stock incremented in base store on success (10 + 2)");
        assert.equal(db.stockTransactions.length, 1, "Stock movement committed to base store on success");
        assert.ok(db.audits.length >= 2, "Audits committed to base store on success");
        assert.equal(db.documents.get("doc_1").linkedEntityId, receipt.id, "Document linked in base store on success");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDoc;
    }
});

test("failure-paths: rollback leaves zero leaked records when auditLog fails AFTER stock write", async () => {
    const db = setupTxMockStore();
    let branchEntered = false;

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDoc = (prisma as any).document;

    try {
        setupTransactionalHarness(db, {
            failOnAuditAction: "PURCHASE_RECEIPT_POSTED",
            onBeforeAuditFailure: (staged) => {
                branchEntered = true;
                // Assert before injection that writes were actually staged in tx-local state:
                assert.equal(staged.txBatches.size, 1, "Batch was staged before audit failure");
                assert.equal(staged.txItems.length, 1, "Batch items were staged before audit failure");
                assert.equal(staged.txProducts.get("prod_a").stock, 12, "Product stock was staged before audit failure");
                assert.equal(staged.txStockTx.length, 1, "Stock transaction was staged before audit failure");
            },
        });

        await assert.rejects(
            async () => {
                await postFinancialPurchaseReceipt(
                    {
                        supplierId: "supp_1",
                        payable: "50.00",
                        operationKey: "op_audit_fail",
                        lines: [
                            {
                                productId: "prod_a",
                                inputUnit: "PIECE",
                                inputQty: "2",
                                conversionFactor: "1",
                                unitAcquisitionCost: "25.00",
                            },
                        ],
                    },
                    "user_admin",
                    "ADMIN"
                );
            },
            /Simulated audit disk failure AFTER stock write/i
        );

        assert.equal(branchEntered, true, "Execution branch entered stock write before audit failure");

        // Verify base database is completely unmutated (no leaks):
        assert.equal(db.batches.size, 0, "No batch leaked on rollback");
        assert.equal(db.batchItems.length, 0, "No batch items leaked on rollback");
        assert.equal(db.products.get("prod_a").stock, 10, "Stock was not mutated or leaked on rollback");
        assert.equal(db.stockTransactions.length, 0, "No stock transaction movements leaked on rollback");
        assert.equal(db.audits.length, 0, "No audit logs leaked on rollback");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDoc;
    }
});

test("failure-paths: rollback leaves zero leaks when conditional document claim returns 0", async () => {
    const db = setupTxMockStore();
    let conditionalClaimAttempted = false;

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDoc = (prisma as any).document;

    try {
        setupTransactionalHarness(db, {
            failDocClaim: true,
            onBeforeDocClaimFailure: (staged) => {
                conditionalClaimAttempted = true;
                // Assert before injection that writes were actually staged in tx-local state:
                assert.equal(staged.txBatches.size, 1, "Batch was staged before doc claim failure");
                assert.equal(staged.txItems.length, 1, "Batch items were staged before doc claim failure");
                assert.equal(staged.txProducts.get("prod_a").stock, 12, "Product stock was staged before doc claim failure");
                assert.equal(staged.txStockTx.length, 1, "Stock transaction was staged before doc claim failure");
            },
        });

        await assert.rejects(
            async () => {
                await postFinancialPurchaseReceipt(
                    {
                        supplierId: "supp_1",
                        payable: "50.00",
                        operationKey: "op_doc_conflict",
                        lines: [
                            {
                                productId: "prod_a",
                                inputUnit: "PIECE",
                                inputQty: "2",
                                conversionFactor: "1",
                                unitAcquisitionCost: "25.00",
                            },
                        ],
                        documentIds: ["doc_1"],
                    },
                    "user_admin",
                    "ADMIN"
                );
            },
            /Failed to claim document doc_1: document was modified, deleted, or claimed concurrently/i
        );

        assert.equal(conditionalClaimAttempted, true);

        // Verify base database is completely unmutated:
        assert.equal(db.batches.size, 0, "No batch leaked");
        assert.equal(db.batchItems.length, 0, "No items leaked");
        assert.equal(db.products.get("prod_a").stock, 10, "Stock remained untouched");
        assert.equal(db.stockTransactions.length, 0, "No movements leaked");
        assert.equal(db.audits.length, 0, "No audits leaked");
        assert.equal(db.documents.get("doc_1").linkedEntityType, null, "Document remains unlinked");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDoc;
    }
});

test("failure-paths: manager denied on ADMIN_ONLY document before any database effects", async () => {
    const db = setupTxMockStore();

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;

    try {
        (prisma as any).$transaction = async (fn: any) => {
            const mockTx = {
                $queryRaw: async () => [],
                supplier: {
                    findUnique: async ({ where }: any) => db.suppliers.get(where.id) || null,
                },
                product: {
                    findMany: async ({ where }: any) => where.id.in.map((id: string) => db.products.get(id)).filter(Boolean),
                },
                document: {
                    findMany: async ({ where }: any) => where.id.in.map((id: string) => db.documents.get(id)).filter(Boolean),
                },
                stockReceiveBatch: {
                    findUnique: async () => null,
                    create: async () => {
                        throw new Error("Effects MUST NOT be executed when validation fails");
                    },
                },
            };
            return fn(mockTx);
        };

        (prisma as any).stockReceiveBatch = { findUnique: async () => null };

        await assert.rejects(
            async () => {
                await postFinancialPurchaseReceipt(
                    {
                        supplierId: "supp_1",
                        payable: "50.00",
                        operationKey: "op_mgr_doc_deny",
                        lines: [
                            { productId: "prod_a", inputUnit: "PIECE", inputQty: "2", conversionFactor: "1", unitAcquisitionCost: "25.00" },
                        ],
                        documentIds: ["doc_admin"], // visibility: ADMIN_ONLY
                    },
                    "user_mgr",
                    "MANAGER" // MANAGER role attempting to claim ADMIN_ONLY doc
                );
            },
            /Document doc_admin visibility is restricted to ADMIN only and cannot be claimed by MANAGER/i
        );

        assert.equal(db.batches.size, 0);
        assert.equal(db.batchItems.length, 0);
        assert.equal(db.products.get("prod_a").stock, 10);
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
    }
});

test("failure-paths: void reread sees already-void payment after receipt lock and yields no extra audit", async () => {
    const db = setupTxMockStore();
    // Setup batch and initially active payment
    db.batches.set("batch_payable_100", {
        id: "batch_payable_100",
        payable: new Decimal("100.00"),
        supplierId: "supp_1",
        postedAt: new Date(),
    });
    db.payments.set("pay_already_void", {
        id: "pay_already_void",
        batchId: "batch_payable_100",
        amount: new Decimal("50.00"),
        method: "CASH",
        reference: null,
        paidAt: new Date(),
        createdById: "user_admin",
        createdAt: new Date(),
        voidedAt: null, // First read returns nonvoid snapshot
        voidedById: null,
        voidReason: null,
    });

    let paymentReadCount = 0;
    let paymentUpdateCount = 0;
    let receiptLockEntered = false;

    const originalTx = prisma.$transaction;
    const originalPayment = (prisma as any).supplierPayment;

    try {
        (prisma as any).$transaction = async (fn: any) => {
            const mockTx = {
                $queryRaw: async (parts: TemplateStringsArray, ...vals: any[]) => {
                    const str = parts.join("?");
                    if (str.includes("StockReceiveBatch") && str.includes("FOR UPDATE")) {
                        receiptLockEntered = true;
                        // Receipt tagged lock commits simulated competing void into store
                        db.payments.set("pay_already_void", {
                            ...db.payments.get("pay_already_void"),
                            voidedAt: new Date("2026-10-09T08:00:00Z"),
                            voidedById: "user_competing",
                            voidReason: "Competing concurrent void",
                        });
                    }
                    return [];
                },
                stockReceiveBatch: {
                    findUnique: async ({ where }: any) => db.batches.get(where.id) || null,
                },
                supplierPayment: {
                    findUnique: async ({ where }: any) => {
                        paymentReadCount++;
                        const p = db.payments.get(where.id);
                        return p ? { ...p } : null;
                    },
                    update: async () => {
                        paymentUpdateCount++;
                        throw new Error("Payment update MUST NOT occur on already-void reread");
                    },
                },
                auditLog: {
                    create: async ({ data }: any) => {
                        db.audits.push(data);
                        return data;
                    },
                },
            };
            return fn(mockTx);
        };

        const res = await voidPurchaseInstallment(
            "pay_already_void",
            { voidReason: "Subsequent redundant void attempt" },
            "user_admin"
        );

        assert.equal(paymentReadCount, 2, "Payment was read exactly twice: initial read and post-lock reread");
        assert.equal(receiptLockEntered, true, "Receipt batch lock was acquired before reread");
        assert.equal(paymentUpdateCount, 0, "No payment update performed on competing void");
        assert.equal(db.audits.length, 0, "No extra audit log recorded for idempotent void reread");
        assert.equal(res.isVoided, true);
        assert.equal(res.voidReason, "Competing concurrent void", "Original competing void reason preserved");
        assert.equal(res.voidedById, "user_competing", "Original competing voidedById preserved");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).supplierPayment = originalPayment;
    }
});

test("failure-paths: rejects unrepresentable stock delta / resulting stock before effects (CORE-3)", async () => {
    const db = setupTxMockStore();

    const originalTx = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;

    try {
        (prisma as any).$transaction = async (fn: any) => {
            const mockTx = {
                $queryRaw: async () => [],
                stockReceiveBatch: {
                    findUnique: async () => null,
                    create: async () => {
                        throw new Error("Effects MUST NOT be executed when stock Float conversion loses precision");
                    },
                },
                supplier: {
                    findUnique: async ({ where }: any) => db.suppliers.get(where.id) || null,
                },
                product: {
                    findMany: async ({ where }: any) => [
                        {
                            id: "prod_huge",
                            name: "Bulk Grain",
                            sku: "GRAIN-01",
                            saleUnit: "KG",
                            packageUnit: "KG",
                            packageQuantity: 1,
                            isActive: true,
                            stock: 9007199254740992, // Exceeds safe float precision for odd increments
                        },
                    ],
                },
                document: {
                    findMany: async () => [],
                },
            };
            return fn(mockTx);
        };

        (prisma as any).stockReceiveBatch = { findUnique: async () => null };

        await assert.rejects(
            async () => {
                await postFinancialPurchaseReceipt(
                    {
                        supplierId: "supp_1",
                        payable: "10.00",
                        operationKey: "op_float_precision_loss",
                        lines: [
                            { productId: "prod_huge", inputUnit: "KG", inputQty: "1", conversionFactor: "1", unitAcquisitionCost: "10.00" },
                        ],
                    },
                    "user_admin",
                    "ADMIN"
                );
            },
            /cannot be represented accurately in stock storage/i
        );

        assert.equal(db.batches.size, 0, "No effects executed on precision loss rejection");
    } finally {
        prisma.$transaction = originalTx;
        (prisma as any).stockReceiveBatch = originalBatch;
    }
});
