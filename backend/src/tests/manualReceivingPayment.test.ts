import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addPayment, listPayments } from "../modules/payments/service";
import prisma from "../db/prisma";

const VALID_ACCOUNT_ID = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
const VALID_ASSET_ID = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
const VALID_OP_KEY = "manual-op-key-123456789012";
const VALID_CHECKSUM =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type MockDbState = {
  invoices: Record<string, any>;
  payments: Record<string, any>;
  accounts: Record<string, any>;
  assets: Record<string, any>;
  users: Record<string, any>;
  audits: any[];
};

function createPaymentHarness(initial?: {
  invoices?: any[];
  payments?: any[];
  accounts?: any[];
  assets?: any[];
  users?: any[];
}) {
  let state: MockDbState = {
    invoices: Object.fromEntries(
      (initial?.invoices || []).map((inv) => [inv.id, structuredClone(inv)]),
    ),
    payments: Object.fromEntries(
      (initial?.payments || []).map((p) => [p.id, structuredClone(p)]),
    ),
    accounts: Object.fromEntries(
      (initial?.accounts || []).map((acc) => [acc.id, structuredClone(acc)]),
    ),
    assets: Object.fromEntries(
      (initial?.assets || []).map((asset) => [asset.id, structuredClone(asset)]),
    ),
    users: Object.fromEntries(
      (
        initial?.users || [
          { id: "cashier-1", name: "Cashier One", role: "CASHIER" },
          { id: "cashier-2", name: "Cashier Two", role: "CASHIER" },
        ]
      ).map((u) => [u.id, structuredClone(u)]),
    ),
    audits: [],
  };

  const originalTransaction = prisma.$transaction;
  const originalPaymentFindMany = prisma.payment.findMany;
  const originalPaymentFindUnique = prisma.payment.findUnique;

  const opLog: string[] = [];
  let failAudit = false;
  let failWithP2002Key: string | null = null;
  let p2002CollisionScenario: {
    key: string;
    committedPayment?: any;
    target?: string[];
  } | null = null;
  let failWithUnrelatedP2002 = false;
  let lastStaged: MockDbState | null = null;

  (prisma.payment as any).findMany = async ({ where, orderBy }: any) => {
    opLog.push(`GLOBAL_PAYMENT_FIND_MANY:${where?.invoiceId}`);
    const list = Object.values(state.payments).filter(
      (p) => !where?.invoiceId || p.invoiceId === where.invoiceId,
    );
    return structuredClone(list);
  };

  (prisma.payment as any).findUnique = async ({ where }: any) => {
    opLog.push(`GLOBAL_PAYMENT_FIND_UNIQUE:${where.manualOperationKey || where.id}`);
    if (where.manualOperationKey) {
      const match = Object.values(state.payments).find(
        (p) => p.manualOperationKey === where.manualOperationKey,
      );
      if (!match) return null;
      return structuredClone({
        ...match,
        createdBy: state.users[match.createdById] || { id: match.createdById, name: "Unknown" },
      });
    }
    const match = state.payments[where.id];
    if (!match) return null;
    return structuredClone({
      ...match,
      createdBy: state.users[match.createdById] || { id: match.createdById, name: "Unknown" },
    });
  };

  (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
    const staged: MockDbState = structuredClone(state);

    const tx: any = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        if (sql.includes("Invoice") && sql.includes("FOR UPDATE")) {
          const invId = values[0];
          opLog.push(`LOCK_INVOICE:${invId}`);
          const inv = staged.invoices[invId];
          return inv ? [structuredClone(inv)] : [];
        }
        if (sql.includes("PaymentReceivingAccount") && sql.includes("FOR UPDATE")) {
          const accId = values[0];
          opLog.push(`LOCK_ACCOUNT:${accId}`);
          const acc = staged.accounts[accId];
          return acc ? [structuredClone(acc)] : [];
        }
        if (sql.includes("PaymentReceivingQrAsset") && (sql.includes("FOR SHARE") || sql.includes("LOCK IN SHARE MODE"))) {
          const assetId = values[0];
          opLog.push(`LOCK_ASSET:${assetId}`);
          const asset = staged.assets[assetId];
          return asset ? [structuredClone(asset)] : [];
        }
        return [];
      },
      invoice: {
        findUnique: async ({ where }: any) => {
          opLog.push(`ORM_FIND_INVOICE:${where.id}`);
          const inv = staged.invoices[where.id];
          if (!inv) return null;
          const invoicePayments = Object.values(staged.payments).filter(
            (p) => p.invoiceId === where.id,
          );
          return structuredClone({
            ...inv,
            payments: invoicePayments,
          });
        },
        update: async ({ where, data }: any) => {
          opLog.push(`ORM_UPDATE_INVOICE:${where.id}`);
          const inv = staged.invoices[where.id];
          if (!inv) throw new Error("Invoice not found");
          Object.assign(inv, data, { updatedAt: new Date() });
          return structuredClone(inv);
        },
      },
      payment: {
        findUnique: async ({ where }: any) => {
          opLog.push(`ORM_FIND_PAYMENT:${where.manualOperationKey || where.id}`);
          if (where.manualOperationKey) {
            if (
              p2002CollisionScenario &&
              where.manualOperationKey === p2002CollisionScenario.key
            ) {
              return null; // Key was not committed when transaction started
            }
            const match = Object.values(staged.payments).find(
              (p) => p.manualOperationKey === where.manualOperationKey,
            );
            if (!match) return null;
            return structuredClone({
              ...match,
              createdBy: staged.users[match.createdById] || {
                id: match.createdById,
                name: "Unknown",
              },
            });
          }
          const match = staged.payments[where.id];
          if (!match) return null;
          return structuredClone({
            ...match,
            createdBy: staged.users[match.createdById] || {
              id: match.createdById,
              name: "Unknown",
            },
          });
        },
        create: async ({ data }: any) => {
          opLog.push(`ORM_CREATE_PAYMENT:${data.invoiceId}:${data.amount}`);
          if (
            p2002CollisionScenario &&
            data.manualOperationKey === p2002CollisionScenario.key
          ) {
            opLog.push(`ORM_CREATE_PAYMENT_THREW_P2002:${data.manualOperationKey}`);
            if (p2002CollisionScenario.committedPayment) {
              state.payments[p2002CollisionScenario.committedPayment.id] =
                structuredClone(p2002CollisionScenario.committedPayment);
            }
            const target = p2002CollisionScenario.target || ["manualOperationKey"];
            const err: any = new Error(
              "Unique constraint failed on " + target.join(","),
            );
            err.code = "P2002";
            err.meta = { target };
            throw err;
          }
          if (failWithUnrelatedP2002) {
            opLog.push(`ORM_CREATE_PAYMENT_THREW_UNRELATED_P2002`);
            const err: any = new Error("Unique constraint failed on otherUniqueField");
            err.code = "P2002";
            err.meta = { target: ["otherUniqueField"] };
            throw err;
          }
          if (failWithP2002Key && data.manualOperationKey === failWithP2002Key) {
            const err: any = new Error("Unique constraint failed on manualOperationKey");
            err.code = "P2002";
            err.meta = { target: ["manualOperationKey"] };
            throw err;
          }
          const id = data.id || `payment-${Object.keys(staged.payments).length + 1}`;
          const created = {
            ...data,
            id,
            createdAt: new Date(),
          };
          staged.payments[id] = structuredClone(created);
          return structuredClone({
            ...created,
            createdBy: staged.users[data.createdById] || {
              id: data.createdById,
              name: "Unknown",
            },
          });
        },
      },
      user: {
        findUnique: async ({ where }: any) => {
          opLog.push(`ORM_FIND_USER:${where.id}`);
          const u = staged.users[where.id];
          return u ? structuredClone(u) : null;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          opLog.push(`ORM_CREATE_AUDIT:${data.action}`);
          if (failAudit) {
            throw new Error("Simulated audit creation failure");
          }
          const audit = {
            ...data,
            id: `audit-${staged.audits.length + 1}`,
            createdAt: new Date(),
          };
          staged.audits.push(structuredClone(audit));
          return structuredClone(audit);
        },
      },
    };

    try {
      const result = await work(tx);
      state = staged;
      return result;
    } finally {
      lastStaged = structuredClone(staged);
    }
  };

  return {
    getState: () => state,
    getLastStaged: () => lastStaged,
    getOpLog: () => opLog,
    clearOpLog: () => {
      opLog.length = 0;
    },
    setFailAudit: (val: boolean) => {
      failAudit = val;
    },
    setFailWithP2002Key: (val: string | null) => {
      failWithP2002Key = val;
    },
    setP2002CollisionScenario: (
      scenario: {
        key: string;
        committedPayment?: any;
        target?: string[];
      } | null,
    ) => {
      p2002CollisionScenario = scenario;
    },
    setFailWithUnrelatedP2002: (val: boolean) => {
      failWithUnrelatedP2002 = val;
    },
    restore: () => {
      (prisma as any).$transaction = originalTransaction;
      (prisma.payment as any).findMany = originalPaymentFindMany;
      (prisma.payment as any).findUnique = originalPaymentFindUnique;
    },
  };
}

const SEED_ACCOUNT = {
  id: VALID_ACCOUNT_ID,
  providerLabel: "Fonepay Primary",
  accountHolder: "Store Main",
  accountIdentifier: "9800112233",
  settlementMethod: "FONEPAY",
  confirmationMode: "MANUAL_RECEIPT",
  enabled: 1,
  sortOrder: 0,
  version: 2,
  creationPayloadHash: "hash-acc",
  activeQrAssetId: VALID_ASSET_ID,
};

const SEED_ASSET = {
  id: VALID_ASSET_ID,
  accountId: VALID_ACCOUNT_ID,
  publicationExpectedVersion: 2,
  storedPath: "payment-accounts/qr.png",
  fileName: "qr.png",
  thumbnailFileName: "qr-thumb.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  thumbnailSizeBytes: 512,
  width: 600,
  height: 600,
  checksum: VALID_CHECKSUM,
  sourceChecksum: VALID_CHECKSUM,
  createdById: "admin-1",
  createdAt: new Date(),
};

const SEED_INVOICE = {
  id: "inv-1",
  invoiceNo: "INV-2026-001",
  status: "FINALIZED",
  paymentStatus: "UNPAID",
  netTotal: 5000,
  paidTotal: 0,
};

test("AC-3: valid fresh destination-linked addPayment creates snapshot, updates invoice, audits, and projects safe DTO", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    harness.clearOpLog();
    const payment = await addPayment(
      "inv-1",
      "FONEPAY",
      2000,
      "SUCCESS",
      "cashier-1",
      "REF-FP-12345",
      {
        manualOperationKey: VALID_OP_KEY,
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    // 1. Assert projected public payment DTO allowlist
    assert.equal(payment.invoiceId, "inv-1");
    assert.equal(payment.method, "FONEPAY");
    assert.equal(payment.amount, 2000);
    assert.equal(payment.status, "SUCCESS");
    assert.equal(payment.reference, "REF-FP-12345");
    assert.equal(payment.receivingAccountId, VALID_ACCOUNT_ID);
    assert.ok(payment.receivingDestinationSnapshot);
    assert.equal(payment.receivingDestinationSnapshot.accountId, VALID_ACCOUNT_ID);
    assert.equal(payment.receivingDestinationSnapshot.accountVersion, 2);
    assert.equal(payment.receivingDestinationSnapshot.qrChecksum, VALID_CHECKSUM);
    assert.equal(payment.receivingDestinationSnapshot.confirmedById, "cashier-1");

    // Assert internal fields stripped from response
    assert.equal((payment as any).manualOperationKey, undefined);
    assert.equal((payment as any).manualPayloadHash, undefined);

    // 2. Assert locking order and operations
    const log = harness.getOpLog();
    const lockInvIdx = log.indexOf("LOCK_INVOICE:inv-1");
    const lockAccIdx = log.indexOf(`LOCK_ACCOUNT:${VALID_ACCOUNT_ID}`);
    const lockAssetIdx = log.indexOf(`LOCK_ASSET:${VALID_ASSET_ID}`);
    const createPmtIdx = log.findIndex((e) => e.startsWith("ORM_CREATE_PAYMENT:"));
    const createAuditIdx = log.indexOf("ORM_CREATE_AUDIT:INVOICE_PAYMENT_UPDATED");

    assert.ok(lockInvIdx !== -1, "Invoice lock must be acquired");
    assert.ok(lockAccIdx !== -1, "Account lock must be acquired");
    assert.ok(lockAssetIdx !== -1, "Asset lock must be acquired");
    assert.ok(lockInvIdx < lockAccIdx, "Invoice lock must precede account lock");
    assert.ok(lockAccIdx < lockAssetIdx, "Account lock must precede asset lock");
    assert.ok(lockAssetIdx < createPmtIdx, "Locks must precede payment creation");
    assert.ok(createPmtIdx < createAuditIdx, "Payment creation must precede audit log");

    // 3. Assert committed state
    const state = harness.getState();
    assert.equal(state.invoices["inv-1"].paidTotal, 2000);
    assert.equal(state.invoices["inv-1"].paymentStatus, "PARTIALLY_PAID");
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].meta.amountAdded, 2000);
    assert.equal(state.audits[0].meta.receivingAccountId, VALID_ACCOUNT_ID);
    assert.equal((state.audits[0].meta as any).manualOperationKey, undefined, "Key must not be in audit meta");
  } finally {
    harness.restore();
  }
});

test("AC-5: staged audit failure rolls back payment and invoice recomputation completely", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    harness.setFailAudit(true);
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          2000,
          "SUCCESS",
          "cashier-1",
          "REF-FP-FAIL",
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      /Simulated audit creation failure/,
    );
    harness.setFailAudit(false);

    // Assert zero writes escaped to state
    const state = harness.getState();
    assert.equal(Object.keys(state.payments).length, 0, "No payment must be committed");
    assert.equal(state.invoices["inv-1"].paidTotal, 0, "Invoice paidTotal remains 0");
    assert.equal(state.invoices["inv-1"].paymentStatus, "UNPAID", "Invoice paymentStatus remains UNPAID");
    assert.equal(state.audits.length, 0);
  } finally {
    harness.restore();
  }
});

test("AC-3 & AC-4: exact retry returns committed snapshot even after invoice is fully paid, voided, or account is disabled/replaced", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    // 1. First successful submission
    const initialPayment = await addPayment(
      "inv-1",
      "FONEPAY",
      5000,
      "SUCCESS",
      "cashier-1",
      "REF-FP-EXACT",
      {
        manualOperationKey: VALID_OP_KEY,
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );
    assert.equal(initialPayment.amount, 5000);

    // Invoice is now PAID
    const state = harness.getState();
    assert.equal(state.invoices["inv-1"].paymentStatus, "PAID");

    // 2. Disable receiving account and bump its version in live settings
    state.accounts[VALID_ACCOUNT_ID].enabled = 0;
    state.accounts[VALID_ACCOUNT_ID].version = 99;

    // 3. Retry with exact same key and parameters
    harness.clearOpLog();
    const replayPayment = await addPayment(
      "inv-1",
      "FONEPAY",
      5000,
      "SUCCESS",
      "cashier-1",
      "REF-FP-EXACT",
      {
        manualOperationKey: VALID_OP_KEY,
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    // Assert replay returns the exact committed payment DTO
    assert.equal(replayPayment.id, initialPayment.id);
    assert.equal(replayPayment.amount, 5000);
    assert.equal(replayPayment.receivingDestinationSnapshot?.accountVersion, 2);

    // Assert no account lock, no new payment create, no invoice recompute, and no new audit
    const log = harness.getOpLog();
    assert.equal(log.indexOf(`LOCK_ACCOUNT:${VALID_ACCOUNT_ID}`), -1, "Replay must NOT lock account");
    assert.equal(log.findIndex((e) => e.startsWith("ORM_CREATE_PAYMENT:")), -1, "Replay must NOT create payment");
    assert.equal(log.indexOf("ORM_CREATE_AUDIT:INVOICE_PAYMENT_UPDATED"), -1, "Replay must NOT create audit");
    assert.equal(state.audits.length, 1, "Audits count remains 1");
  } finally {
    harness.restore();
  }
});

test("AC-4: same key with mismatched parameters or different actor/invoice rejects with 409 MANUAL_OPERATION_KEY_CONFLICT", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE, { ...SEED_INVOICE, id: "inv-2", invoiceNo: "INV-2026-002" }],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    await addPayment(
      "inv-1",
      "FONEPAY",
      2000,
      "SUCCESS",
      "cashier-1",
      "REF-FP-ORIGINAL",
      {
        manualOperationKey: VALID_OP_KEY,
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    // 1. Different actor on same key -> 409
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          2000,
          "SUCCESS",
          "cashier-2",
          "REF-FP-ORIGINAL",
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "MANUAL_OPERATION_KEY_CONFLICT" && err.statusCode === 409,
    );

    // 2. Different invoice on same key -> 409
    await assert.rejects(
      () =>
        addPayment(
          "inv-2",
          "FONEPAY",
          2000,
          "SUCCESS",
          "cashier-1",
          "REF-FP-ORIGINAL",
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "MANUAL_OPERATION_KEY_CONFLICT" && err.statusCode === 409,
    );

    // 3. Changed amount on same key -> 409
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          3000,
          "SUCCESS",
          "cashier-1",
          "REF-FP-ORIGINAL",
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "MANUAL_OPERATION_KEY_CONFLICT" && err.statusCode === 409,
    );

    // 4. Changed reference on same key -> 409
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          2000,
          "SUCCESS",
          "cashier-1",
          "REF-FP-CHANGED",
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "MANUAL_OPERATION_KEY_CONFLICT" && err.statusCode === 409,
    );
  } finally {
    harness.restore();
  }
});

test("AC-3 & AC-6: invalid inputs reject before transaction, direct ESEWA prohibited, pending gateway and duplicate receipt guards", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    // 1. Direct ESEWA prohibited -> 400 MANUAL_ESEWA_PROHIBITED
    harness.clearOpLog();
    await assert.rejects(
      () => addPayment("inv-1", "ESEWA", 1000, "SUCCESS", "cashier-1"),
      (err: any) => err.code === "MANUAL_ESEWA_PROHIBITED" && err.statusCode === 400,
    );
    assert.equal(harness.getOpLog().length, 0, "No locks or queries on direct ESEWA rejection");

    // 2. Destination on CASH prohibited -> 400
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "CASH",
          1000,
          "SUCCESS",
          "cashier-1",
          undefined,
          {
            manualOperationKey: VALID_OP_KEY,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "INVALID_PAYMENT_METHOD_FOR_DESTINATION" && err.statusCode === 400,
    );
    assert.equal(harness.getOpLog().length, 0, "No locks or queries on invalid method destination");

    // 3. Non-positive amount -> 400
    await assert.rejects(
      () => addPayment("inv-1", "FONEPAY", 0, "SUCCESS", "cashier-1"),
      (err: any) => err.code === "INVALID_PAYMENT_AMOUNT" && err.statusCode === 400,
    );

    // 4. Missing key when destination fields present -> 400
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          1000,
          "SUCCESS",
          "cashier-1",
          "REF-1",
          {
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "INVALID_MANUAL_OPERATION_KEY" && err.statusCode === 400,
    );

    // 5. Pending gateway guard: invoice has pending eSewa payment
    const state = harness.getState();
    state.payments["esewa-pending-1"] = {
      id: "esewa-pending-1",
      invoiceId: "inv-1",
      method: "ESEWA",
      amount: 1500,
      status: "PENDING",
      kind: "CHARGE",
      createdById: "cashier-1",
      createdAt: new Date(),
    };

    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          1000,
          "SUCCESS",
          "cashier-1",
          "REF-1234",
          {
            manualOperationKey: "fresh-key-123456789012",
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "GATEWAY_OUTCOME_UNRESOLVED" && err.statusCode === 409,
    );

    // Clear pending gateway payment
    delete state.payments["esewa-pending-1"];

    // 6. Record first valid payment
    await addPayment(
      "inv-1",
      "FONEPAY",
      1000,
      "SUCCESS",
      "cashier-1",
      "REF-DUPLICATE-CHECK",
      {
        manualOperationKey: "fresh-key-111111111111",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    // Duplicate receipt with DIFFERENT manual operation key -> 409 PAYMENT_ALREADY_RECORDED
    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          1000,
          "SUCCESS",
          "cashier-1",
          "REF-DUPLICATE-CHECK",
          {
            manualOperationKey: "different-key-222222222222",
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) => err.code === "PAYMENT_ALREADY_RECORDED" && err.statusCode === 409,
    );
  } finally {
    harness.restore();
  }
});

test("AC-3 & AC-4: P2002 unique constraint collision on manualOperationKey reconciles committed key", async () => {
  // 1. Concurrent collision with MATCHING parameters:
  // Transaction lookup sees missing key and proceeds to payment.create.
  // Concurrent committed global key appears just before create throws P2002.
  // Catch block catches P2002, calls global findUnique, reconciles and returns projected payment.
  const harness1 = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          invoiceId: "inv-1",
          method: "FONEPAY",
          amount: 1500,
          reference: "REF-P2002-MATCH",
          receivingAccountId: VALID_ACCOUNT_ID,
          receivingAccountVersion: 2,
          manualReceiptConfirmed: true,
        }),
      )
      .digest("hex");

    const committedPayment = {
      id: "payment-committed-1",
      invoiceId: "inv-1",
      method: "FONEPAY",
      amount: 1500,
      status: "SUCCESS",
      reference: "REF-P2002-MATCH",
      createdById: "cashier-1",
      receivingAccountId: VALID_ACCOUNT_ID,
      receivingDestinationSnapshot: {
        schemaVersion: 1,
        accountId: VALID_ACCOUNT_ID,
        accountVersion: 2,
        providerLabel: "Fonepay Primary",
        accountHolder: "Store Main",
        accountIdentifier: "9800112233",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        qrAssetId: VALID_ASSET_ID,
        qrChecksum: VALID_CHECKSUM,
        confirmedById: "cashier-1",
        confirmedAt: new Date().toISOString(),
      },
      manualOperationKey: VALID_OP_KEY,
      manualPayloadHash: payloadHash,
      createdAt: new Date(),
    };

    harness1.clearOpLog();
    harness1.setP2002CollisionScenario({
      key: VALID_OP_KEY,
      committedPayment,
    });

    const reconciled = await addPayment(
      "inv-1",
      "FONEPAY",
      1500,
      "SUCCESS",
      "cashier-1",
      "REF-P2002-MATCH",
      {
        manualOperationKey: VALID_OP_KEY,
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    assert.equal(reconciled.id, "payment-committed-1");
    assert.equal(reconciled.amount, 1500);
    assert.equal(reconciled.method, "FONEPAY");
    assert.equal(reconciled.receivingAccountId, VALID_ACCOUNT_ID);
    assert.ok(reconciled.receivingDestinationSnapshot);
    assert.equal(
      reconciled.receivingDestinationSnapshot.qrChecksum,
      VALID_CHECKSUM,
    );
    assert.equal((reconciled as any).manualOperationKey, undefined);
    assert.equal((reconciled as any).manualPayloadHash, undefined);

    const opLog = harness1.getOpLog();
    // Assert tx reached payment.create, threw P2002, catch block called global findUnique, and tx rolled back without secondary audit
    assert.ok(opLog.includes("ORM_CREATE_PAYMENT:inv-1:1500"));
    assert.ok(opLog.includes(`ORM_CREATE_PAYMENT_THREW_P2002:${VALID_OP_KEY}`));
    assert.ok(opLog.includes(`GLOBAL_PAYMENT_FIND_UNIQUE:${VALID_OP_KEY}`));
    assert.equal(
      opLog.filter((op) => op.startsWith("ORM_CREATE_AUDIT")).length,
      0,
    );
    assert.equal(harness1.getState().audits.length, 0);
  } finally {
    harness1.restore();
  }

  // 2. Concurrent collision with MISMATCHED parameters (cross-actor or different amount/hash):
  // Tx throws P2002, global findUnique returns committed payment with mismatched payloadHash -> throws 409
  const harness2 = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    const mismatchKey = "manual-op-key-mismatch-12345678";
    const differentPayloadCommitted = {
      id: "payment-committed-2",
      invoiceId: "inv-1",
      method: "FONEPAY",
      amount: 2500,
      status: "SUCCESS",
      reference: "REF-P2002-DIFF",
      createdById: "cashier-1",
      receivingAccountId: VALID_ACCOUNT_ID,
      receivingDestinationSnapshot: {
        schemaVersion: 1,
        accountId: VALID_ACCOUNT_ID,
        accountVersion: 2,
        providerLabel: "Fonepay Primary",
        accountHolder: "Store Main",
        accountIdentifier: "9800112233",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
        qrAssetId: VALID_ASSET_ID,
        qrChecksum: VALID_CHECKSUM,
        confirmedById: "cashier-1",
        confirmedAt: new Date().toISOString(),
      },
      manualOperationKey: mismatchKey,
      manualPayloadHash: "different-hash-value-12345",
      createdAt: new Date(),
    };

    harness2.clearOpLog();
    harness2.setP2002CollisionScenario({
      key: mismatchKey,
      committedPayment: differentPayloadCommitted,
    });

    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          1500,
          "SUCCESS",
          "cashier-1",
          "REF-P2002-TRY",
          {
            manualOperationKey: mismatchKey,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) =>
        err.code === "MANUAL_OPERATION_KEY_CONFLICT" && err.statusCode === 409,
    );

    const mismatchOpLog = harness2.getOpLog();
    assert.ok(mismatchOpLog.includes("ORM_CREATE_PAYMENT:inv-1:1500"));
    assert.ok(
      mismatchOpLog.includes(`ORM_CREATE_PAYMENT_THREW_P2002:${mismatchKey}`),
    );
    assert.ok(
      mismatchOpLog.includes(`GLOBAL_PAYMENT_FIND_UNIQUE:${mismatchKey}`),
    );
    assert.equal(
      mismatchOpLog.filter((op) => op.startsWith("ORM_CREATE_AUDIT")).length,
      0,
    );
    assert.equal(harness2.getState().audits.length, 0);
  } finally {
    harness2.restore();
  }

  // 3. Unrelated P2002 (e.g. unique collision on another field) must propagate and NOT reconcile
  const harness3 = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    const unrelatedKey = "manual-op-key-unrelated-88888888";
    harness3.clearOpLog();
    harness3.setP2002CollisionScenario(null);
    harness3.setFailWithUnrelatedP2002(true);

    await assert.rejects(
      () =>
        addPayment(
          "inv-1",
          "FONEPAY",
          1500,
          "SUCCESS",
          "cashier-1",
          "REF-P2002-UNRELATED",
          {
            manualOperationKey: unrelatedKey,
            receivingAccountId: VALID_ACCOUNT_ID,
            receivingAccountVersion: 2,
            manualReceiptConfirmed: true,
          },
        ),
      (err: any) =>
        err.code === "P2002" && err.meta?.target?.includes("otherUniqueField"),
    );

    const unrelatedOpLog = harness3.getOpLog();
    assert.ok(unrelatedOpLog.includes("ORM_CREATE_PAYMENT:inv-1:1500"));
    assert.ok(
      unrelatedOpLog.includes("ORM_CREATE_PAYMENT_THREW_UNRELATED_P2002"),
    );
    // Assert global findUnique was NOT called for unrelated P2002
    assert.equal(
      unrelatedOpLog.filter((op) =>
        op.startsWith("GLOBAL_PAYMENT_FIND_UNIQUE"),
      ).length,
      0,
    );
    assert.equal(harness3.getState().audits.length, 0);
  } finally {
    harness3.restore();
  }
});

test("AC-3: listPayments projects safe public payment DTOs without internal keys", async () => {
  const harness = createPaymentHarness({
    invoices: [SEED_INVOICE],
    accounts: [SEED_ACCOUNT],
    assets: [SEED_ASSET],
  });

  try {
    await addPayment(
      "inv-1",
      "FONEPAY",
      1000,
      "SUCCESS",
      "cashier-1",
      "REF-LIST-1",
      {
        manualOperationKey: "list-key-111111111111",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 2,
        manualReceiptConfirmed: true,
      },
    );

    const payments = await listPayments("inv-1");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].method, "FONEPAY");
    assert.equal(payments[0].amount, 1000);
    assert.equal(payments[0].receivingAccountId, VALID_ACCOUNT_ID);
    assert.ok(payments[0].receivingDestinationSnapshot);
    assert.equal(
      payments[0].receivingDestinationSnapshot.qrChecksum,
      VALID_CHECKSUM,
    );
    assert.equal((payments[0] as any).manualOperationKey, undefined);
    assert.equal((payments[0] as any).manualPayloadHash, undefined);
  } finally {
    harness.restore();
  }
});
