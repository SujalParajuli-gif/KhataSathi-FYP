import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import {
    parseDecimalString,
    validateSupplierInput,
    validateUnitConversion,
    validatePurchaseReceiptLines,
    validatePayableReconciliation,
    buildNormalizedPurchaseReceiptPayload,
    hashPurchaseReceiptPayload,
    validateInstallmentInput,
    buildNormalizedInstallmentPayload,
    hashInstallmentPayload,
    validateVoidPaymentInput,
} from "../modules/inventory/purchaseValidation";
import {
    createSupplier,
    updateSupplier,
    deactivateSupplier,
    getSupplierById,
    listSuppliers,
    postFinancialPurchaseReceipt,
    attachDocumentsToPurchaseReceipt,
    recordPurchaseInstallment,
    voidPurchaseInstallment,
    getFinancialPurchaseReceiptById,
    FinancialPurchaseConflictError,
} from "../modules/inventory/purchases";
import { receiveStockBatch } from "../modules/inventory/service";

const Decimal = Prisma.Decimal;

/* =========================================================================
   1. VALIDATION & PRECISION TESTS
   ========================================================================= */

test("parseDecimalString enforces strict numeric rules, precision limits, and rejects scientific notation", () => {
    // Valid positive decimal strings
    const valid1 = parseDecimalString("100.50", "Test amount", { maxDecimals: 2 });
    assert.equal(valid1.toString(), "100.5");
    assert.equal(valid1.toFixed(2), "100.50");

    const valid2 = parseDecimalString("0.005", "Test qty", { maxDecimals: 3 });
    assert.equal(valid2.toString(), "0.005");

    // Scientific notation must be rejected
    assert.throws(
        () => parseDecimalString("1e5", "Scientific notation", { maxDecimals: 2 }),
        /invalid numeric format/i
    );
    assert.throws(
        () => parseDecimalString("1.5e-2", "Scientific notation", { maxDecimals: 4 }),
        /invalid numeric format/i
    );

    // Hex and non-numeric junk rejected
    assert.throws(
        () => parseDecimalString("0x10", "Hex value", { maxDecimals: 2 }),
        /invalid numeric format/i
    );
    assert.throws(
        () => parseDecimalString("100abc", "Junk", { maxDecimals: 2 }),
        /invalid numeric format/i
    );

    // Overprecision rejected
    assert.throws(
        () => parseDecimalString("10.123", "Two decimals allowed", { maxDecimals: 2 }),
        /maximum allowed precision/i
    );

    // Negative numbers rejected when min is 0
    assert.throws(
        () => parseDecimalString("-5.00", "Negative amount", { maxDecimals: 2, min: new Decimal(0) }),
        /cannot be less than 0/i
    );

    // Zero rejected when allowZero = false
    assert.throws(
        () => parseDecimalString("0", "Non-zero quantity", { maxDecimals: 3, allowZero: false }),
        /must be greater than zero/i
    );
});

test("validateUnitConversion validates sale unit factor 1 and package unit conversion", () => {
    const product = {
        id: "prod_1",
        name: "Wai Wai Noodles",
        sku: "WW-01",
        saleUnit: "PIECE",
        packageUnit: "BOX",
        packageQuantity: 30,
    };

    // Sale unit with factor 1 is valid
    assert.doesNotThrow(() => {
        validateUnitConversion(product, "PIECE", new Decimal(1));
    });

    // Sale unit with factor != 1 is rejected
    assert.throws(
        () => validateUnitConversion(product, "PIECE", new Decimal(2)),
        /conversion factor for sale unit "PIECE" .* must be 1/i
    );

    // Package unit matching packageQuantity is valid
    assert.doesNotThrow(() => {
        validateUnitConversion(product, "BOX", new Decimal(30));
    });

    // Package unit mismatching packageQuantity is rejected
    assert.throws(
        () => validateUnitConversion(product, "BOX", new Decimal(25)),
        /does not match product "Wai Wai Noodles" configured package quantity/i
    );

    // Unsupported unit rejected
    assert.throws(
        () => validateUnitConversion(product, "CARTON", new Decimal(10)),
        /Unsupported input unit "CARTON"/i
    );

    // Product without valid package quantity cannot use package unit
    const productNoPkg = {
        id: "prod_2",
        name: "Loose Sugar",
        sku: "SUG-01",
        saleUnit: "KG",
        packageUnit: "BAG",
        packageQuantity: null,
    };
    assert.throws(
        () => validateUnitConversion(productNoPkg, "BAG", new Decimal(50)),
        /does not have a positive package quantity configured/i
    );
});

test("validatePurchaseReceiptLines computes ROUND_HALF_UP line amounts and prevents derived stock overprecision", () => {
    // Exact rounding check: 3 * 33.333 = 99.999 -> rounds to 100.00
    const lines = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "3",
            conversionFactor: "1",
            unitAcquisitionCost: "33.333",
        },
        {
            productId: "prod_2",
            inputUnit: "BOX",
            inputQty: "2.5",
            conversionFactor: "10",
            unitAcquisitionCost: "150.00",
        },
    ]);

    assert.equal(lines.length, 2);
    assert.equal(lines[0].lineOrder, 1);
    assert.equal(lines[0].lineAmount.toFixed(2), "100.00");
    assert.equal(lines[0].stockQty.toFixed(3), "3.000");

    assert.equal(lines[1].lineOrder, 2);
    assert.equal(lines[1].lineAmount.toFixed(2), "375.00");
    assert.equal(lines[1].stockQty.toFixed(3), "25.000");

    // Derived stock qty exceeding 3 decimals must be rejected (not silently truncated)
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "KG",
                inputQty: "1.123",
                conversionFactor: "0.333333", // 1.123 * 0.333333 has > 3 decimals
                unitAcquisitionCost: "50",
            },
        ]);
    }, /exceeds maximum 3 decimal places/i);

    // Mismatched user-supplied lineAmount rejected
    assert.throws(() => {
        validatePurchaseReceiptLines([
            {
                productId: "prod_1",
                inputUnit: "PIECE",
                inputQty: "2",
                conversionFactor: "1",
                unitAcquisitionCost: "50.00",
                lineAmount: "105.00", // should be 100.00
            },
        ]);
    }, /does not match computed quantity \* cost/i);
});

test("validatePayableReconciliation validates reviewed payable against line sums exactly", () => {
    const lines = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "2",
            conversionFactor: "1",
            unitAcquisitionCost: "25.50",
        },
        {
            productId: "prod_2",
            inputUnit: "PIECE",
            inputQty: "1",
            conversionFactor: "1",
            unitAcquisitionCost: "49.00",
        },
    ]);
    // 2 * 25.50 = 51.00; 1 * 49.00 = 49.00; Total = 100.00

    const payable = validatePayableReconciliation(lines, "100.00");
    assert.equal(payable.toFixed(2), "100.00");

    // Mismatch by 1 paisa must throw reconciliation error
    assert.throws(() => {
        validatePayableReconciliation(lines, "100.01");
    }, /Reconciliation error: sum of line amounts \(100.00\) does not match reviewed payable \(100.01\)/i);
});

test("buildNormalizedPurchaseReceiptPayload and hashPurchaseReceiptPayload produce stable SHA-256 hashes", () => {
    const lines = validatePurchaseReceiptLines([
        {
            productId: "prod_1",
            inputUnit: "PIECE",
            inputQty: "1",
            conversionFactor: "1",
            unitAcquisitionCost: "100",
        },
    ]);

    const payload1 = buildNormalizedPurchaseReceiptPayload({
        actorId: "user_admin",
        supplierId: "supp_1",
        billNumber: "INV-999",
        billDate: "2026-10-09",
        remarks: "First delivery",
        payable: new Decimal("100.00"),
        lines,
        documentIds: ["doc_b", "doc_a"], // unsorted
    });

    const payload2 = buildNormalizedPurchaseReceiptPayload({
        actorId: "user_admin",
        supplierId: "supp_1",
        billNumber: "INV-999",
        billDate: "2026-10-09",
        remarks: "First delivery",
        payable: new Decimal("100.00"),
        lines,
        documentIds: ["doc_a", "doc_b"], // sorted differently
    });

    const hash1 = hashPurchaseReceiptPayload(payload1);
    const hash2 = hashPurchaseReceiptPayload(payload2);

    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2, "Sorted document IDs ensure deterministic hash parity");

    // Changing payload changes hash
    const payloadChanged = { ...payload1, payable: "100.01" };
    const hashChanged = hashPurchaseReceiptPayload(payloadChanged);
    assert.notEqual(hash1, hashChanged);
});

test("validateInstallmentInput enforces payment rules and manual references", () => {
    // CASH does not require reference
    const cash = validateInstallmentInput({
        amount: "500.00",
        method: "CASH",
        paidAt: "2026-10-09",
        operationKey: "op_pay_cash",
    });
    assert.equal(cash.method, "CASH");
    assert.equal(cash.amount.toFixed(2), "500.00");
    assert.equal(cash.reference, null);

    // Non-cash requires reference
    assert.throws(() => {
        validateInstallmentInput({
            amount: "500.00",
            method: "BANK_TRANSFER",
            paidAt: "2026-10-09",
            operationKey: "op_pay_bank",
        });
    }, /Payment reference is required for BANK_TRANSFER/i);

    const bank = validateInstallmentInput({
        amount: "500.00",
        method: "BANK_TRANSFER",
        reference: "TXN-123456",
        paidAt: "2026-10-09",
        operationKey: "op_pay_bank",
    });
    assert.equal(bank.method, "BANK_TRANSFER");
    assert.equal(bank.reference, "TXN-123456");

    // Invalid method
    assert.throws(() => {
        validateInstallmentInput({
            amount: "500.00",
            method: "CREDIT_CARD",
            paidAt: "2026-10-09",
            operationKey: "op_pay_invalid",
        });
    }, /Invalid payment method "CREDIT_CARD"/i);
});

test("validateVoidPaymentInput enforces minimum reason length", () => {
    assert.throws(() => {
        validateVoidPaymentInput({ voidReason: "no" });
    }, /Void reason must be at least 3 characters/i);

    const valid = validateVoidPaymentInput({ voidReason: "Duplicate cheque entry" });
    assert.equal(valid.voidReason, "Duplicate cheque entry");
});

/* =========================================================================
   2. SUPPLIER SERVICE TESTS (AC-1)
   ========================================================================= */

test("Supplier CRUD: create, update, deactivate, and query with audit logs (AC-1)", async () => {
    // Regression reference: node --test backend/dist/tests/purchaseFoundation.test.js 11 PASS / 2 FAIL
    // Failure 1: deactivateSupplier passes only isActive to updateSupplier which validates required name before current-row merge
    const suppliersDb = new Map<string, any>();
    const auditsDb: any[] = [];

    const originalTransaction = prisma.$transaction;
    const originalSupplier = (prisma as any).supplier;

    try {
        (prisma as any).$transaction = async (fn: any, options: any) => {
            const mockTx = {
                $queryRaw: async () => [],
                supplier: {
                    findUnique: async ({ where }: any) => suppliersDb.get(where.id) || null,
                    create: async ({ data }: any) => {
                        const rec = { id: `supp_${suppliersDb.size + 1}`, ...data };
                        suppliersDb.set(rec.id, rec);
                        return rec;
                    },
                    update: async ({ where, data }: any) => {
                        const existing = suppliersDb.get(where.id);
                        if (!existing) throw new Error("Supplier not found");
                        const updated = { ...existing, ...data };
                        suppliersDb.set(where.id, updated);
                        return updated;
                    },
                },
                auditLog: {
                    create: async ({ data }: any) => {
                        auditsDb.push(data);
                        return { id: `audit_${auditsDb.length}`, ...data };
                    },
                },
            };
            return fn(mockTx);
        };

        (prisma as any).supplier = {
            findUnique: async ({ where }: any) => suppliersDb.get(where.id) || null,
            findMany: async ({ where, skip, take }: any) => {
                let list = Array.from(suppliersDb.values());
                if (where?.isActive !== undefined) {
                    list = list.filter((s) => s.isActive === where.isActive);
                }
                return list.slice(skip || 0, (skip || 0) + (take || list.length));
            },
            count: async () => suppliersDb.size,
        };

        // Create supplier
        const created = await createSupplier(
            {
                name: "Himalayan Wholesale Traders",
                phone: "9841000000",
                panNo: "300456789",
                contact: "Ram Shrestha",
                address: "Ason, Kathmandu",
            },
            "user_admin"
        );

        assert.equal(created.name, "Himalayan Wholesale Traders");
        assert.equal(created.isActive, true);
        assert.equal(auditsDb.length, 1);
        assert.equal(auditsDb[0].action, "PURCHASE_SUPPLIER_CREATED");

        // Partial update: updating only contact and address preserves name, phone, panNo
        const partialUpdated = await updateSupplier(
            created.id,
            {
                contact: "Hari Prasad",
                address: "Patan, Lalitpur",
            },
            "user_admin"
        );
        assert.equal(partialUpdated.name, "Himalayan Wholesale Traders");
        assert.equal(partialUpdated.phone, "9841000000");
        assert.equal(partialUpdated.panNo, "300456789");
        assert.equal(partialUpdated.contact, "Hari Prasad");
        assert.equal(partialUpdated.address, "Patan, Lalitpur");

        // Full update supplier
        const updated = await updateSupplier(
            created.id,
            {
                name: "Himalayan Wholesale Traders Pvt Ltd",
                phone: "9841000000",
                panNo: "300456789",
                contact: "Ram Shrestha",
                address: "Koteshwor, Kathmandu",
            },
            "user_admin"
        );

        assert.equal(updated.name, "Himalayan Wholesale Traders Pvt Ltd");
        assert.equal(auditsDb.length, 3);
        assert.equal(auditsDb[2].action, "PURCHASE_SUPPLIER_UPDATED");

        // Deactivate supplier (passes only isActive: false, merges existing name under lock)
        const deactivated = await deactivateSupplier(created.id, "user_admin");
        assert.equal(deactivated.isActive, false);
        assert.equal(deactivated.name, "Himalayan Wholesale Traders Pvt Ltd");
        assert.equal(deactivated.phone, "9841000000");
        assert.equal(deactivated.panNo, "300456789");
        assert.equal(deactivated.contact, "Ram Shrestha");
        assert.equal(deactivated.address, "Koteshwor, Kathmandu");
        assert.equal(auditsDb.length, 4);

        // Referenced row is preserved in store
        const queried = await getSupplierById(created.id);
        assert.equal(queried.id, created.id);
        assert.equal(queried.isActive, false);
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma as any).supplier = originalSupplier;
    }
});

/* =========================================================================
   3. FINANCIAL RECEIPT SERVICE TESTS (AC-2, AC-3)
   ========================================================================= */

test("postFinancialPurchaseReceipt: posts duplicate lines distinctly, aggregates stock, and claims staged documents (AC-2)", async () => {
    // In-memory doubles
    const batchesDb = new Map<string, any>();
    const itemsDb: any[] = [];
    const stockTransactionsDb: any[] = [];
    const auditsDb: any[] = [];
    const productsDb = new Map<string, any>([
        [
            "prod_1",
            {
                id: "prod_1",
                name: "Wai Wai Quick",
                sku: "WWQ-01",
                saleUnit: "PIECE",
                packageUnit: "BOX",
                packageQuantity: 30,
                isActive: true,
                stock: 10,
            },
        ],
    ]);
    const suppliersDb = new Map<string, any>([
        [
            "supp_1",
            {
                id: "supp_1",
                name: "Chaudhary Group Dist",
                isActive: true,
            },
        ],
    ]);
    const documentsDb = new Map<string, any>([
        [
            "doc_1",
            {
                id: "doc_1",
                title: "Vendor Bill",
                fileName: "bill_oct9.pdf",
                mimeType: "application/pdf",
                fileSize: 1024,
                documentType: "STOCK_BILL",
                visibility: "ALL_AUTHENTICATED",
                linkedEntityType: null,
                linkedEntityId: null,
                deletedAt: null,
                createdAt: new Date(),
            },
        ],
    ]);

    const originalTransaction = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDocument = (prisma as any).document;

    try {
        const mockTx = {
            $queryRaw: async () => [],
            supplier: {
                findUnique: async ({ where }: any) => suppliersDb.get(where.id) || null,
            },
            product: {
                findMany: async ({ where }: any) => {
                    const ids: string[] = where.id.in;
                    return ids.map((id) => productsDb.get(id)).filter(Boolean);
                },
                update: async ({ where, data }: any) => {
                    const prod = productsDb.get(where.id);
                    prod.stock += data.stock.increment;
                    return prod;
                },
            },
            document: {
                findMany: async ({ where }: any) => {
                    const ids: string[] = where.id.in;
                    return ids.map((id) => documentsDb.get(id)).filter(Boolean);
                },
                update: async ({ where, data }: any) => {
                    const doc = documentsDb.get(where.id);
                    Object.assign(doc, data);
                    return doc;
                },
                updateMany: async ({ where, data }: any) => {
                    const doc = documentsDb.get(where.id);
                    if (!doc) return { count: 0 };
                    Object.assign(doc, data);
                    return { count: 1 };
                },
            },
            stockReceiveBatch: {
                findUnique: async ({ where }: any) => {
                    if (where.operationKey) {
                        return (
                            Array.from(batchesDb.values()).find(
                                (b) => b.operationKey === where.operationKey
                            ) || null
                        );
                    }
                    return batchesDb.get(where.id) || null;
                },
                create: async ({ data }: any) => {
                    const batch = {
                        id: `batch_${batchesDb.size + 1}`,
                        ...data,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    };
                    batchesDb.set(batch.id, batch);
                    return batch;
                },
            },
            stockReceiveBatchItem: {
                create: async ({ data }: any) => {
                    const item = { id: `item_${itemsDb.length + 1}`, ...data };
                    itemsDb.push(item);
                    return item;
                },
            },
            stockTransaction: {
                create: async ({ data }: any) => {
                    // Regression reference: node --test 11 PASS / 2 FAIL
                    // Failure 2: receipt mock StockTransaction lacks createdAt used by detail DTO
                    const tx = {
                        id: `stx_${stockTransactionsDb.length + 1}`,
                        ...data,
                        createdAt: data?.createdAt instanceof Date ? data.createdAt : new Date(),
                    };
                    stockTransactionsDb.push(tx);
                    return tx;
                },
            },
            auditLog: {
                create: async ({ data }: any) => {
                    const a = { id: `audit_${auditsDb.length + 1}`, ...data };
                    auditsDb.push(a);
                    return a;
                },
            },
        };

        (prisma as any).$transaction = async (fn: any, options: any) => fn(mockTx);
        (prisma as any).stockReceiveBatch = {
            findUnique: async ({ where }: any) => {
                if (where.operationKey) {
                    return (
                        Array.from(batchesDb.values()).find(
                            (b) => b.operationKey === where.operationKey
                        ) || null
                    );
                }
                const b = batchesDb.get(where.id);
                if (!b) return null;
                return {
                    ...b,
                    createdBy: { id: b.createdById, name: "Admin" },
                    supplier: suppliersDb.get(b.supplierId),
                    items: itemsDb.filter((i) => i.batchId === b.id),
                    payments: [],
                    transactions: stockTransactionsDb
                        .filter((t) => t.stockReceiveBatchId === b.id)
                        .map((t) => ({ ...t, product: productsDb.get(t.productId) })),
                };
            },
        };
        (prisma as any).document = {
            findMany: async ({ where }: any) => {
                return Array.from(documentsDb.values()).filter(
                    (d) =>
                        d.linkedEntityType === where.linkedEntityType &&
                        d.linkedEntityId === where.linkedEntityId &&
                        d.deletedAt === null
                );
            },
        };

        // Post financial receipt with DUPLICATE lines of the same product at different costs:
        // Line 1: 5 PIECES @ 20.00 = 100.00
        // Line 2: 1 BOX (30 PIECES) @ 540.00 = 540.00
        // Total Payable = 640.00
        // Expected product stock increment: 5 + 30 = 35 pieces
        const receipt = await postFinancialPurchaseReceipt(
            {
                supplierId: "supp_1",
                billNumber: "BILL-2026-001",
                billDate: "2026-10-09",
                payable: "640.00",
                operationKey: "op_receipt_001",
                lines: [
                    {
                        productId: "prod_1",
                        inputUnit: "PIECE",
                        inputQty: "5",
                        conversionFactor: "1",
                        unitAcquisitionCost: "20.00",
                        lineAmount: "100.00",
                    },
                    {
                        productId: "prod_1",
                        inputUnit: "BOX",
                        inputQty: "1",
                        conversionFactor: "30",
                        unitAcquisitionCost: "540.00",
                        lineAmount: "540.00",
                    },
                ],
                documentIds: ["doc_1"],
            },
            "user_admin",
            "ADMIN"
        );

        // Verification of receipt output and stored state
        assert.equal(receipt.isFinancial, true);
        assert.equal(receipt.payable, "640.00");
        assert.equal(receipt.paymentStatus, "UNPAID");
        assert.equal(receipt.items.length, 2, "Duplicate lines preserved as 2 distinct items");
        assert.equal(receipt.items[0].lineOrder, 1);
        assert.equal(receipt.items[0].stockQty, "5.000");
        assert.equal(receipt.items[1].lineOrder, 2);
        assert.equal(receipt.items[1].stockQty, "30.000");

        // Product stock aggregated once: 10 initial + 35 delta = 45
        assert.equal(productsDb.get("prod_1").stock, 45);

        // One stock transaction aggregated for prod_1
        assert.equal(stockTransactionsDb.length, 1);
        assert.equal(stockTransactionsDb[0].qtyDelta, 35);
        assert.equal(stockTransactionsDb[0].type, "RESTOCK");

        // Staged document claimed and restricted
        const claimedDoc = documentsDb.get("doc_1");
        assert.equal(claimedDoc.linkedEntityType, "StockReceiveBatch");
        assert.equal(claimedDoc.linkedEntityId, receipt.id);
        assert.equal(claimedDoc.documentType, "PURCHASE_BILL");
        assert.equal(claimedDoc.visibility, "ADMIN_MANAGER");

        // Audit log created for receipt
        const receiptAudit = auditsDb.find((a) => a.action === "PURCHASE_RECEIPT_POSTED");
        assert.ok(receiptAudit, "PURCHASE_RECEIPT_POSTED audit log must exist");
        assert.equal(receiptAudit.meta.payable, "640.00");

        const stockAudit = auditsDb.find((a) => a.action === "PURCHASE_STOCK_POSTED");
        assert.ok(stockAudit, "PURCHASE_STOCK_POSTED audit log must exist");

        /* =====================================================================
           Replay test (AC-3): same key & same payload returns existing receipt
           without changing stock or adding transactions.
           ===================================================================== */
        const initialStock = productsDb.get("prod_1").stock;
        const initialTxCount = stockTransactionsDb.length;

        const replayReceipt = await postFinancialPurchaseReceipt(
            {
                supplierId: "supp_1",
                billNumber: "BILL-2026-001",
                billDate: "2026-10-09",
                payable: "640.00",
                operationKey: "op_receipt_001",
                lines: [
                    {
                        productId: "prod_1",
                        inputUnit: "PIECE",
                        inputQty: "5",
                        conversionFactor: "1",
                        unitAcquisitionCost: "20.00",
                        lineAmount: "100.00",
                    },
                    {
                        productId: "prod_1",
                        inputUnit: "BOX",
                        inputQty: "1",
                        conversionFactor: "30",
                        unitAcquisitionCost: "540.00",
                        lineAmount: "540.00",
                    },
                ],
                documentIds: ["doc_1"],
            },
            "user_admin",
            "ADMIN"
        );

        assert.equal(replayReceipt.id, receipt.id);
        assert.equal(productsDb.get("prod_1").stock, initialStock, "Stock must NOT increment on replay");
        assert.equal(stockTransactionsDb.length, initialTxCount, "No duplicate transactions on replay");

        /* =====================================================================
           Conflict test (AC-3): same key with different payload throws conflict
           ===================================================================== */
        await assert.rejects(
            async () => {
                await postFinancialPurchaseReceipt(
                    {
                        supplierId: "supp_1",
                        billNumber: "BILL-2026-001",
                        billDate: "2026-10-09",
                        payable: "100.00", // different payable!
                        operationKey: "op_receipt_001",
                        lines: [
                            {
                                productId: "prod_1",
                                inputUnit: "PIECE",
                                inputQty: "5",
                                conversionFactor: "1",
                                unitAcquisitionCost: "20.00",
                            },
                        ],
                    },
                    "user_admin",
                    "ADMIN"
                );
            },
            (err: any) => {
                assert.ok(err instanceof FinancialPurchaseConflictError);
                assert.match(err.message, /Operation key conflict/i);
                return true;
            }
        );
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDocument;
    }
});

test("postFinancialPurchaseReceipt: rejects posting for inactive supplier or inactive product", async () => {
    const productsDb = new Map<string, any>([
        [
            "prod_inactive",
            {
                id: "prod_inactive",
                name: "Discontinued Soda",
                sku: "DISC-01",
                saleUnit: "PIECE",
                packageUnit: "PIECE",
                packageQuantity: 1,
                isActive: false, // inactive!
                stock: 0,
            },
        ],
    ]);
    const suppliersDb = new Map<string, any>([
        [
            "supp_inactive",
            {
                id: "supp_inactive",
                name: "Defunct Supplier",
                isActive: false, // inactive!
            },
        ],
        [
            "supp_active",
            {
                id: "supp_active",
                name: "Active Supplier",
                isActive: true,
            },
        ],
    ]);

    const originalTransaction = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;

    try {
        const mockTx = {
            $queryRaw: async () => [],
            supplier: {
                findUnique: async ({ where }: any) => suppliersDb.get(where.id) || null,
            },
            product: {
                findMany: async ({ where }: any) => {
                    const ids: string[] = where.id.in;
                    return ids.map((id) => productsDb.get(id)).filter(Boolean);
                },
            },
            stockReceiveBatch: {
                findUnique: async () => null,
            },
        };

        (prisma as any).$transaction = async (fn: any) => fn(mockTx);
        (prisma as any).stockReceiveBatch = { findUnique: async () => null };

        // Test inactive supplier
        await assert.rejects(async () => {
            await postFinancialPurchaseReceipt(
                {
                    supplierId: "supp_inactive",
                    payable: "50.00",
                    operationKey: "op_inactive_supp",
                    lines: [
                        {
                            productId: "prod_inactive",
                            inputUnit: "PIECE",
                            inputQty: "1",
                            conversionFactor: "1",
                            unitAcquisitionCost: "50.00",
                        },
                    ],
                },
                "user_admin",
                "ADMIN"
            );
        }, /Cannot post purchase receipt for inactive supplier/i);

        // Test inactive product
        await assert.rejects(async () => {
            await postFinancialPurchaseReceipt(
                {
                    supplierId: "supp_active",
                    payable: "50.00",
                    operationKey: "op_inactive_prod",
                    lines: [
                        {
                            productId: "prod_inactive",
                            inputUnit: "PIECE",
                            inputQty: "1",
                            conversionFactor: "1",
                            unitAcquisitionCost: "50.00",
                        },
                    ],
                },
                "user_admin",
                "ADMIN"
            );
        }, /Cannot post purchase receipt for inactive product/i);
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma as any).stockReceiveBatch = originalBatch;
    }
});

/* =========================================================================
   4. ATTACHMENT-ONLY RECOVERY TESTS (Independent of stock)
   ========================================================================= */

test("attachDocumentsToPurchaseReceipt: attaches files to existing receipt without reposting stock", async () => {
    const batchesDb = new Map<string, any>([
        [
            "batch_existing",
            {
                id: "batch_existing",
                supplierId: "supp_1",
                payable: new Decimal("500.00"),
                supplierName: "ABC Supplies",
                postedAt: new Date(),
            },
        ],
    ]);
    const documentsDb = new Map<string, any>([
        [
            "doc_recovery_1",
            {
                id: "doc_recovery_1",
                title: "Signed Bill",
                fileName: "bill_signed.pdf",
                documentType: "STOCK_BILL",
                visibility: "ALL_AUTHENTICATED",
                linkedEntityType: null,
                linkedEntityId: null,
                deletedAt: null,
                createdAt: new Date(),
            },
        ],
    ]);
    const auditsDb: any[] = [];
    let stockTouched = false;

    const originalTransaction = prisma.$transaction;
    const originalBatch = (prisma as any).stockReceiveBatch;
    const originalDocument = (prisma as any).document;

    try {
        const mockTx = {
            $queryRaw: async () => [],
            stockReceiveBatch: {
                findUnique: async ({ where }: any) => batchesDb.get(where.id) || null,
            },
            document: {
                findMany: async ({ where }: any) => {
                    const ids: string[] = where.id.in;
                    return ids.map((id) => documentsDb.get(id)).filter(Boolean);
                },
                update: async ({ where, data }: any) => {
                    const doc = documentsDb.get(where.id);
                    Object.assign(doc, data);
                    return doc;
                },
                updateMany: async ({ where, data }: any) => {
                    const doc = documentsDb.get(where.id);
                    if (!doc) return { count: 0 };
                    Object.assign(doc, data);
                    return { count: 1 };
                },
            },
            auditLog: {
                create: async ({ data }: any) => {
                    auditsDb.push(data);
                    return { id: `audit_${auditsDb.length}`, ...data };
                },
            },
            product: {
                update: () => {
                    stockTouched = true;
                },
            },
            stockTransaction: {
                create: () => {
                    stockTouched = true;
                },
            },
        };

        (prisma as any).$transaction = async (fn: any, options: any) => fn(mockTx);
        (prisma as any).stockReceiveBatch = {
            findUnique: async ({ where }: any) => {
                const b = batchesDb.get(where.id);
                if (!b) return null;
                return {
                    ...b,
                    createdBy: { id: "user_admin", name: "Admin" },
                    supplier: { id: b.supplierId, name: b.supplierName },
                    items: [],
                    payments: [],
                    transactions: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
            },
        };
        (prisma as any).document = {
            findMany: async () => [documentsDb.get("doc_recovery_1")],
        };

        const res = await attachDocumentsToPurchaseReceipt(
            "batch_existing",
            ["doc_recovery_1"],
            "user_admin",
            "ADMIN"
        );

        assert.equal(res.id, "batch_existing");
        assert.equal(stockTouched, false, "Stock must NEVER be touched during attachment recovery");

        const attachedDoc = documentsDb.get("doc_recovery_1");
        assert.equal(attachedDoc.linkedEntityType, "StockReceiveBatch");
        assert.equal(attachedDoc.linkedEntityId, "batch_existing");
        assert.equal(attachedDoc.documentType, "PURCHASE_BILL");
        assert.equal(attachedDoc.visibility, "ADMIN_MANAGER");

        const attachAudit = auditsDb.find((a) => a.action === "PURCHASE_DOCUMENT_ATTACHED");
        assert.ok(attachAudit, "PURCHASE_DOCUMENT_ATTACHED audit log recorded");
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma as any).stockReceiveBatch = originalBatch;
        (prisma as any).document = originalDocument;
    }
});

/* =========================================================================
   5. INSTALLMENT & VOID SERVICE TESTS (AC-4)
   ========================================================================= */

test("recordPurchaseInstallment: prevents overpayment, updates paid/due balances, supports replay and audited void (AC-4)", async () => {
    const batchesDb = new Map<string, any>([
        [
            "batch_payable_1000",
            {
                id: "batch_payable_1000",
                supplierId: "supp_1",
                payable: new Decimal("1000.00"),
                operationKey: "op_receipt_1000",
            },
        ],
    ]);
    const paymentsDb = new Map<string, any>();
    const auditsDb: any[] = [];

    const originalTransaction = prisma.$transaction;
    const originalPayment = (prisma as any).supplierPayment;
    const originalBatch = (prisma as any).stockReceiveBatch;

    try {
        const mockTx = {
            $queryRaw: async () => [],
            stockReceiveBatch: {
                findUnique: async ({ where }: any) => batchesDb.get(where.id) || null,
            },
            supplierPayment: {
                findUnique: async ({ where }: any) => {
                    if (where.operationKey) {
                        return (
                            Array.from(paymentsDb.values()).find(
                                (p) => p.operationKey === where.operationKey
                            ) || null
                        );
                    }
                    return paymentsDb.get(where.id) || null;
                },
                findMany: async ({ where }: any) => {
                    return Array.from(paymentsDb.values()).filter(
                        (p) => p.batchId === where.batchId
                    );
                },
                create: async ({ data }: any) => {
                    const payment = {
                        id: `pay_${paymentsDb.size + 1}`,
                        ...data,
                        createdAt: new Date(),
                        voidedAt: null,
                        voidedById: null,
                        voidReason: null,
                    };
                    paymentsDb.set(payment.id, payment);
                    return payment;
                },
                update: async ({ where, data }: any) => {
                    const payment = paymentsDb.get(where.id);
                    Object.assign(payment, data);
                    return payment;
                },
            },
            auditLog: {
                create: async ({ data }: any) => {
                    auditsDb.push(data);
                    return { id: `audit_${auditsDb.length}`, ...data };
                },
            },
        };

        (prisma as any).$transaction = async (fn: any) => fn(mockTx);
        (prisma as any).supplierPayment = {
            findUnique: async ({ where }: any) => {
                if (where.operationKey) {
                    return (
                        Array.from(paymentsDb.values()).find(
                            (p) => p.operationKey === where.operationKey
                        ) || null
                    );
                }
                return paymentsDb.get(where.id) || null;
            },
        };
        (prisma as any).stockReceiveBatch = {
            findUnique: async ({ where }: any) => {
                const b = batchesDb.get(where.id);
                if (!b) return null;
                return {
                    ...b,
                    createdBy: { id: "user_admin", name: "Admin" },
                    supplier: { id: b.supplierId, name: "ABC" },
                    items: [],
                    payments: Array.from(paymentsDb.values()).filter((p) => p.batchId === b.id),
                    transactions: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
            },
        };

        // 1. First partial payment: 400.00
        const pay1 = await recordPurchaseInstallment(
            "batch_payable_1000",
            {
                amount: "400.00",
                method: "BANK_TRANSFER",
                reference: "TXN-400",
                paidAt: "2026-10-09",
                operationKey: "op_pay_1",
            },
            "user_admin"
        );

        assert.equal(pay1.amount, "400.00");
        assert.equal(pay1.isVoided, false);

        // Check receipt status: PARTIAL, paid=400.00, due=600.00
        const r1 = await getFinancialPurchaseReceiptById("batch_payable_1000", "ADMIN");
        assert.equal(r1.paidTotal, "400.00");
        assert.equal(r1.dueAmount, "600.00");
        assert.equal(r1.paymentStatus, "PARTIAL");

        // 2. Overpayment attempt: 700.00 > remaining 600.00 due -> REJECTED
        await assert.rejects(
            async () => {
                await recordPurchaseInstallment(
                    "batch_payable_1000",
                    {
                        amount: "700.00",
                        method: "CASH",
                        paidAt: "2026-10-09",
                        operationKey: "op_pay_overpay",
                    },
                    "user_admin"
                );
            },
            /Payment amount \(700\.00\) exceeds balance due \(600\.00\)/i
        );

        // 3. Second payment completing balance: 600.00
        const pay2 = await recordPurchaseInstallment(
            "batch_payable_1000",
            {
                amount: "600.00",
                method: "CASH",
                paidAt: "2026-10-09",
                operationKey: "op_pay_2",
            },
            "user_admin"
        );

        assert.equal(pay2.amount, "600.00");

        // Check receipt status: PAID, paid=1000.00, due=0.00
        const r2 = await getFinancialPurchaseReceiptById("batch_payable_1000", "ADMIN");
        assert.equal(r2.paidTotal, "1000.00");
        assert.equal(r2.dueAmount, "0.00");
        assert.equal(r2.paymentStatus, "PAID");

        // 4. Voiding installment pay1 (400.00)
        const voided = await voidPurchaseInstallment(
            pay1.id,
            { voidReason: "Cheque bounced by bank" },
            "user_admin"
        );

        assert.equal(voided.isVoided, true);
        assert.equal(voided.voidReason, "Cheque bounced by bank");

        // Receipt status updates: paid=600.00, due=400.00, PARTIAL
        const r3 = await getFinancialPurchaseReceiptById("batch_payable_1000", "ADMIN");
        assert.equal(r3.paidTotal, "600.00");
        assert.equal(r3.dueAmount, "400.00");
        assert.equal(r3.paymentStatus, "PARTIAL");

        // 5. Repeated void is idempotent without resurrection or error
        const repeatVoid = await voidPurchaseInstallment(
            pay1.id,
            { voidReason: "Different reason" },
            "user_admin"
        );
        assert.equal(repeatVoid.isVoided, true);
        assert.equal(repeatVoid.voidReason, "Cheque bounced by bank", "Original void reason preserved");
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma as any).supplierPayment = originalPayment;
        (prisma as any).stockReceiveBatch = originalBatch;
    }
});

/* =========================================================================
   6. INTEGRATION VIA receiveStockBatch (Service router)
   ========================================================================= */

test("receiveStockBatch: dispatches financial payload to postFinancialPurchaseReceipt and preserves legacy flow", async () => {
    let financialCalled = false;
    let legacyCalled = false;

    const originalTransaction = prisma.$transaction;
    const originalProductFindMany = (prisma.product as any).findMany;

    try {
        // Test 1: Financial branch dispatched
        const financialInput = {
            supplierId: "supp_1",
            payable: "100.00",
            operationKey: "op_dispatch_test",
            lines: [],
            isFinancial: true,
        };

        // Supplying missing role is independently rejected
        await assert.rejects(async () => {
            await receiveStockBatch(financialInput as any, "user_admin");
        }, /Explicit ADMIN or MANAGER actor role is required for financial purchase receipt/i);

        // Supplying empty lines with trusted role throws validation error from purchases service, proving dispatch
        await assert.rejects(async () => {
            await receiveStockBatch(financialInput as any, "user_admin", "ADMIN");
        }, /At least one purchase receipt line is required/i);

        // Test 2: Legacy stock-only receiving flow executed when not financial
        const legacyInput = {
            supplierName: "Legacy Supplier",
            lines: [
                {
                    productId: "prod_legacy",
                    qty: 5,
                },
            ],
        };

        // When legacy product is queried and missing, it throws "Product not found: prod_legacy" from legacy flow
        (prisma.product as any).findMany = async () => [];

        await assert.rejects(async () => {
            await receiveStockBatch(legacyInput, "user_admin");
        }, /Product not found: prod_legacy/i);
    } finally {
        prisma.$transaction = originalTransaction;
        (prisma.product as any).findMany = originalProductFindMany;
    }
});
