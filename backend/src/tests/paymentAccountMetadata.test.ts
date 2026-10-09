import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

let originalDocRoot: string | undefined;
let originalUploadsRoot: string | undefined;
let testStorageRoot: string;

let prisma: typeof import("../db/prisma.js").default;
let listPaymentAccounts: typeof import("../modules/settings/paymentAccounts/service.js").listPaymentAccounts;
let createPaymentAccount: typeof import("../modules/settings/paymentAccounts/service.js").createPaymentAccount;
let patchPaymentAccount: typeof import("../modules/settings/paymentAccounts/service.js").patchPaymentAccount;
let reorderPaymentAccounts: typeof import("../modules/settings/paymentAccounts/service.js").reorderPaymentAccounts;
let calculateCreationPayloadHash: typeof import("../modules/settings/paymentAccounts/service.js").calculateCreationPayloadHash;
let PaymentAccountError: typeof import("../modules/settings/paymentAccounts/service.js").PaymentAccountError;

test.before(async () => {
  originalDocRoot = process.env.DOCUMENT_STORAGE_ROOT;
  originalUploadsRoot = process.env.UPLOADS_ROOT;
  testStorageRoot = path.join(os.tmpdir(), `ks-metadata-test-${crypto.randomUUID()}`);
  process.env.DOCUMENT_STORAGE_ROOT = testStorageRoot;
  process.env.UPLOADS_ROOT = path.join(testStorageRoot, "uploads");

  await fs.mkdir(testStorageRoot, { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "payment-accounts"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, ".temp"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "documents"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "import-sources"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "uploads"), { recursive: true });

  const prismaMod = await import("../db/prisma.js");
  const serviceMod = await import("../modules/settings/paymentAccounts/service.js");

  const rawPrisma = prismaMod.default as any;
  prisma = rawPrisma?.default?.$transaction ? rawPrisma.default : rawPrisma;
  listPaymentAccounts = serviceMod.listPaymentAccounts;
  createPaymentAccount = serviceMod.createPaymentAccount;
  patchPaymentAccount = serviceMod.patchPaymentAccount;
  reorderPaymentAccounts = serviceMod.reorderPaymentAccounts;
  calculateCreationPayloadHash = serviceMod.calculateCreationPayloadHash;
  PaymentAccountError = serviceMod.PaymentAccountError;
});

test.after(async () => {
  if (originalDocRoot !== undefined) {
    process.env.DOCUMENT_STORAGE_ROOT = originalDocRoot;
  } else {
    delete process.env.DOCUMENT_STORAGE_ROOT;
  }
  if (originalUploadsRoot !== undefined) {
    process.env.UPLOADS_ROOT = originalUploadsRoot;
  } else {
    delete process.env.UPLOADS_ROOT;
  }
  if (testStorageRoot) {
    await fs.rm(testStorageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

type MetadataState = {
  accounts: Record<string, any>;
  assets: Record<string, any>;
  payments: any[];
  audits: any[];
  users: Record<string, { id: string; name: string }>;
};

function createMetadataHarness(initialState?: {
  accounts?: any[];
  assets?: any[];
  payments?: any[];
  audits?: any[];
  users?: Record<string, { id: string; name: string }>;
}) {
  let state: MetadataState = {
    accounts: Object.fromEntries((initialState?.accounts || []).map((a) => [a.id, structuredClone(a)])),
    assets: Object.fromEntries((initialState?.assets || []).map((a) => [a.id, structuredClone(a)])),
    payments: structuredClone(initialState?.payments || []),
    audits: structuredClone(initialState?.audits || []),
    users: structuredClone(
      initialState?.users || {
        "admin-user-1": { id: "admin-user-1", name: "Admin One" },
        "admin-user-2": { id: "admin-user-2", name: "Admin Two" },
      },
    ),
  };

  const originalTransaction = prisma.$transaction;
  const originalAccountFindMany = prisma.paymentReceivingAccount.findMany;
  const originalAccountFindUnique = prisma.paymentReceivingAccount.findUnique;
  const originalAuditFindMany = prisma.auditLog.findMany;

  const opLog: string[] = [];
  let failAuditCreate = false;
  let failPrecommit = false;
  let lastStaged: MetadataState | null = null;

  function projectAccount(acc: any, assetsMap: Record<string, any>, usersMap: Record<string, any>, paymentsList: any[]) {
    const activeAsset = acc.activeQrAssetId ? assetsMap[acc.activeQrAssetId] : null;
    const creator = usersMap[acc.createdById] || { id: acc.createdById, name: "Unknown" };
    const updater = usersMap[acc.updatedById] || { id: acc.updatedById, name: "Unknown" };
    const totalAssets = Object.values(assetsMap).filter((a: any) => a.accountId === acc.id).length;
    const linkedPayments = paymentsList.filter((p: any) => p.receivingAccountId === acc.id).length;

    return {
      ...acc,
      activeQrAsset: activeAsset
        ? {
            id: activeAsset.id,
            width: activeAsset.width,
            height: activeAsset.height,
            sizeBytes: activeAsset.sizeBytes,
            thumbnailSizeBytes: activeAsset.thumbnailSizeBytes,
            mimeType: activeAsset.mimeType,
            checksum: activeAsset.checksum,
            createdAt: activeAsset.createdAt || new Date(),
          }
        : null,
      createdBy: creator,
      updatedBy: updater,
      _count: {
        assets: totalAssets,
        payments: linkedPayments,
      },
    };
  }

  (prisma.paymentReceivingAccount as any).findMany = async (args?: any) => {
    opLog.push("GLOBAL_ACCOUNT_FIND_MANY");
    const list = Object.values(state.accounts).map((acc) =>
      projectAccount(acc, state.assets, state.users, state.payments),
    );
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return structuredClone(list);
  };

  (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
    const staged: MetadataState = structuredClone(state);

    const tx: any = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const queryText = strings.join("?");
        if (queryText.includes("BusinessSettings") && queryText.includes("FOR UPDATE")) {
          opLog.push("LOCK_COLLECTION");
          return [{ id: 1 }];
        }
        if (queryText.includes("PaymentReceivingAccount") && queryText.includes("FOR UPDATE")) {
          const idOrIds = values[0];
          if (Array.isArray(idOrIds)) {
            opLog.push(`LOCK_ACCOUNTS:${idOrIds.join(",")}`);
            return idOrIds
              .map((id: string) => staged.accounts[id])
              .filter(Boolean)
              .map((acc: any) => structuredClone(acc));
          } else {
            opLog.push(`LOCK_ACCOUNT:${idOrIds}`);
            const acc = staged.accounts[idOrIds];
            return acc ? [structuredClone(acc)] : [];
          }
        }
        return [];
      },
      paymentReceivingAccount: {
        findUnique: async ({ where }: any) => {
          opLog.push(`ORM_FIND_UNIQUE:${where.id}`);
          const acc = staged.accounts[where.id];
          if (!acc) return null;
          return structuredClone(projectAccount(acc, staged.assets, staged.users, staged.payments));
        },
        findUniqueOrThrow: async ({ where }: any) => {
          opLog.push(`ORM_FIND_UNIQUE_OR_THROW:${where.id}`);
          const acc = staged.accounts[where.id];
          if (!acc) throw new Error("Account not found");
          return structuredClone(projectAccount(acc, staged.assets, staged.users, staged.payments));
        },
        findFirst: async (args?: any) => {
          opLog.push("ORM_FIND_FIRST");
          const list = Object.values(staged.accounts);
          if (args?.orderBy?.sortOrder === "desc") {
            list.sort((a, b) => b.sortOrder - a.sortOrder);
          }
          return list.length > 0 ? structuredClone(list[0]) : null;
        },
        findMany: async (args?: any) => {
          opLog.push("TX_ACCOUNT_FIND_MANY");
          const list = Object.values(staged.accounts).map((acc) =>
            projectAccount(acc, staged.assets, staged.users, staged.payments),
          );
          list.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
          return structuredClone(list);
        },
        count: async () => {
          opLog.push("ORM_COUNT_ACCOUNTS");
          return Object.keys(staged.accounts).length;
        },
        create: async ({ data }: any) => {
          opLog.push(`ORM_CREATE_ACCOUNT:${data.id}`);
          const created = {
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          staged.accounts[created.id] = structuredClone(created);
          return structuredClone(projectAccount(created, staged.assets, staged.users, staged.payments));
        },
        update: async ({ where, data }: any) => {
          opLog.push(`ORM_UPDATE_ACCOUNT:${where.id}`);
          const acc = staged.accounts[where.id];
          if (!acc) throw new Error("Account not found");
          Object.assign(acc, data, { updatedAt: new Date() });
          return structuredClone(projectAccount(acc, staged.assets, staged.users, staged.payments));
        },
      },
      paymentReceivingQrAsset: {
        findUnique: async ({ where }: any) => {
          opLog.push(`ORM_FIND_ASSET:${where.id}`);
          const asset = staged.assets[where.id];
          return asset ? structuredClone(asset) : null;
        },
      },
      payment: {
        count: async ({ where }: any) => {
          opLog.push(`ORM_PAYMENT_COUNT:${where?.receivingAccountId || "all"}`);
          if (where?.receivingAccountId) {
            return staged.payments.filter((p) => p.receivingAccountId === where.receivingAccountId).length;
          }
          return staged.payments.length;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          opLog.push(`ORM_CREATE_AUDIT:${data.action}`);
          if (failAuditCreate) {
            throw new Error("Simulated audit creation database error");
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
      if (failPrecommit) {
        throw new Error("Simulated precommit failure");
      }
      state = staged;
      return result;
    } finally {
      lastStaged = structuredClone(staged);
    }
  };

  return {
    getState: () => state,
    getLastStagedState: () => lastStaged,
    getOpLog: () => opLog,
    clearOpLog: () => { opLog.length = 0; },
    setFailAuditCreate: (val: boolean) => { failAuditCreate = val; },
    setFailPrecommit: (val: boolean) => { failPrecommit = val; },
    restore: () => {
      (prisma as any).$transaction = originalTransaction;
      (prisma.paymentReceivingAccount as any).findMany = originalAccountFindMany;
      (prisma.paymentReceivingAccount as any).findUnique = originalAccountFindUnique;
      (prisma.auditLog as any).findMany = originalAuditFindMany;
    },
  };
}

test("AC-1: createPaymentAccount acquires collection lock BEFORE reads, enforces 100-account cap, and projects safe DTO", async () => {
  const harness = createMetadataHarness();
  const actorId = "admin-user-1";
  const accountId = crypto.randomUUID();

  try {
    harness.clearOpLog();
    const created = await createPaymentAccount(
      {
        id: accountId,
        providerLabel: "  Nabil Bank QR  ",
        accountHolder: "  KhataSathi Store  ",
        accountIdentifier: "  0123456789012  ",
        settlementMethod: "BANK_TRANSFER",
        confirmationMode: "MANUAL_RECEIPT",
      },
      actorId,
    );

    // 1. Assert locking order: LOCK_COLLECTION must precede ORM reads/counts
    const log = harness.getOpLog();
    const lockIndex = log.indexOf("LOCK_COLLECTION");
    const findIndex = log.indexOf(`ORM_FIND_UNIQUE:${accountId}`);
    const countIndex = log.indexOf("ORM_COUNT_ACCOUNTS");
    const firstIndex = log.indexOf("ORM_FIND_FIRST");
    const createIndex = log.indexOf(`ORM_CREATE_ACCOUNT:${accountId}`);

    assert.ok(lockIndex !== -1, "LOCK_COLLECTION must be acquired");
    assert.ok(lockIndex < findIndex, "LOCK_COLLECTION must precede findUnique");
    assert.ok(lockIndex < countIndex, "LOCK_COLLECTION must precede account count");
    assert.ok(lockIndex < firstIndex, "LOCK_COLLECTION must precede findFirst max sortOrder");
    assert.ok(createIndex > lockIndex, "Account creation occurs after lock");

    // 2. Assert safe DTO allowlist projection
    assert.equal(created.id, accountId);
    assert.equal(created.providerLabel, "Nabil Bank QR");
    assert.equal(created.accountHolder, "KhataSathi Store");
    assert.equal(created.accountIdentifier, "0123456789012");
    assert.equal(created.settlementMethod, "BANK_TRANSFER");
    assert.equal(created.confirmationMode, "MANUAL_RECEIPT");
    assert.equal(created.enabled, false);
    assert.equal(created.sortOrder, 0);
    assert.equal(created.version, 1);
    assert.equal(created.activeQrAssetId, null);
    assert.equal(created.activeQrAsset, null);
    assert.equal(created.createdById, actorId);
    assert.equal(created.createdBy.name, "Admin One");
    assert.equal(created.updatedById, actorId);
    assert.equal(created.totalAssetsCount, 0);
    assert.equal(created.linkedPaymentsCount, 0);

    // Assert internal fields are NOT present
    assert.equal((created as any).creationPayloadHash, undefined);
    assert.equal((created as any).storedPath, undefined);
    assert.equal((created as any).fileName, undefined);

    // 3. State & audit assertion
    const state = harness.getState();
    assert.ok(state.accounts[accountId]);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, "PAYMENT_ACCOUNT_CREATED");
    assert.equal(state.audits[0].entityId, accountId);
  } finally {
    harness.restore();
  }
});

test("AC-1: createPaymentAccount exact replay after metadata mutation/disable returns CURRENT state without resetting", async () => {
  const accountId = crypto.randomUUID();
  const actorId = "admin-user-1";
  const initialInput = {
    id: accountId,
    providerLabel: "Fonepay Primary",
    accountHolder: "Store Owner",
    accountIdentifier: "9800000000",
    settlementMethod: "FONEPAY" as const,
    confirmationMode: "MANUAL_RECEIPT" as const,
  };

  const harness = createMetadataHarness();

  try {
    // 1. Create account initially
    await createPaymentAccount(initialInput, actorId);

    // 2. Modify account: patch label, bump version, set activeQrAssetId, etc.
    const state = harness.getState();
    const assetId = crypto.randomUUID();
    state.assets[assetId] = {
      id: assetId,
      accountId,
      width: 400,
      height: 400,
      sizeBytes: 5000,
      thumbnailSizeBytes: 1200,
      mimeType: "image/png",
      checksum: "abc123checksum",
      createdAt: new Date(),
    };
    state.accounts[accountId].providerLabel = "Fonepay Primary (Updated)";
    state.accounts[accountId].activeQrAssetId = assetId;
    state.accounts[accountId].version = 4;
    state.accounts[accountId].updatedById = "admin-user-2";

    // 3. Re-send exact creation payload
    harness.clearOpLog();
    const replayResult = await createPaymentAccount(initialInput, actorId);

    // Assert it returned CURRENT state, not reset to initial
    assert.equal(replayResult.id, accountId);
    assert.equal(replayResult.providerLabel, "Fonepay Primary (Updated)", "Must return current mutated label");
    assert.equal(replayResult.version, 4, "Must return current version");
    assert.equal(replayResult.activeQrAssetId, assetId, "Must return current active asset pointer");
    assert.equal(replayResult.activeQrAsset?.id, assetId);
    assert.equal(replayResult.updatedById, "admin-user-2");

    // Assert no new audit log generated on replay
    assert.equal(harness.getState().audits.length, 1, "Replay must NOT create duplicate audit log");

    // 4. Mismatched actor on same ID -> 409
    await assert.rejects(
      () => createPaymentAccount(initialInput, "different-admin-id"),
      (err: any) => err instanceof PaymentAccountError && err.code === "ACCOUNT_EXISTS_CONFLICT",
    );

    // 5. Mismatched payload on same ID -> 409
    await assert.rejects(
      () =>
        createPaymentAccount(
          {
            ...initialInput,
            providerLabel: "Completely Different Label",
          },
          actorId,
        ),
      (err: any) => err instanceof PaymentAccountError && err.code === "ACCOUNT_EXISTS_CONFLICT",
    );
  } finally {
    harness.restore();
  }
});

test("AC-1: 99 to 100 accounts cap boundary succeeds, 101st is rejected under collection lock", async () => {
  // Seed 99 accounts
  const seededAccounts = Array.from({ length: 99 }, (_, i) => ({
    id: crypto.randomUUID(),
    providerLabel: `Provider ${i + 1}`,
    accountHolder: `Holder ${i + 1}`,
    accountIdentifier: `id-${i + 1}`,
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: i % 2 === 0,
    sortOrder: i,
    version: 1,
    creationPayloadHash: `hash-${i + 1}`,
    activeQrAssetId: null,
    createdById: "admin-user-1",
    updatedById: "admin-user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const harness = createMetadataHarness({ accounts: seededAccounts });
  const actorId = "admin-user-1";

  try {
    // 100th account create succeeds
    const account100Id = crypto.randomUUID();
    const acc100 = await createPaymentAccount(
      {
        id: account100Id,
        providerLabel: "100th Account",
        accountHolder: "Store 100",
        accountIdentifier: "9810010000",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
      },
      actorId,
    );
    assert.equal(acc100.id, account100Id);
    assert.equal(acc100.sortOrder, 99);

    // 101st account attempt is rejected with 400 MAX_PAYMENT_ACCOUNTS_EXCEEDED
    const account101Id = crypto.randomUUID();
    harness.clearOpLog();
    await assert.rejects(
      () =>
        createPaymentAccount(
          {
            id: account101Id,
            providerLabel: "101st Account",
            accountHolder: "Store 101",
            accountIdentifier: "9810110100",
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
          },
          actorId,
        ),
      (err: any) => err instanceof PaymentAccountError && err.code === "MAX_PAYMENT_ACCOUNTS_EXCEEDED",
    );

    // Verify collection lock was acquired before count rejection
    const log = harness.getOpLog();
    assert.ok(log.indexOf("LOCK_COLLECTION") !== -1, "LOCK_COLLECTION must be acquired before cap rejection");
    assert.equal(harness.getState().accounts[account101Id], undefined, "101st account must not be written");
  } finally {
    harness.restore();
  }
});

test("AC-1: reorderPaymentAccounts enforces collection lock first, sorted locks, full-set validation, version increments, and transaction-local return", async () => {
  const idA = "11111111-1111-4111-8111-111111111111";
  const idB = "22222222-2222-4222-8222-222222222222";
  const idC = "33333333-3333-4333-8333-333333333333";

  const initialAccounts = [
    {
      id: idA,
      providerLabel: "Account A",
      accountHolder: "Holder A",
      accountIdentifier: "idA",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      enabled: true,
      sortOrder: 0,
      version: 1,
      creationPayloadHash: "hashA",
      activeQrAssetId: null,
      createdById: "admin-user-1",
      updatedById: "admin-user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: idB,
      providerLabel: "Account B",
      accountHolder: "Holder B",
      accountIdentifier: "idB",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      enabled: false,
      sortOrder: 1,
      version: 2,
      creationPayloadHash: "hashB",
      activeQrAssetId: null,
      createdById: "admin-user-1",
      updatedById: "admin-user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: idC,
      providerLabel: "Account C",
      accountHolder: "Holder C",
      accountIdentifier: "idC",
      settlementMethod: "BANK_TRANSFER",
      confirmationMode: "MANUAL_RECEIPT",
      enabled: false,
      sortOrder: 2,
      version: 1,
      creationPayloadHash: "hashC",
      activeQrAssetId: null,
      createdById: "admin-user-1",
      updatedById: "admin-user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const harness = createMetadataHarness({ accounts: initialAccounts });
  const actorId = "admin-user-1";

  try {
    // 1. Valid reorder: C (index 0), A (index 1), B (index 2)
    harness.clearOpLog();
    const result = await reorderPaymentAccounts(
      [
        { id: idC, expectedVersion: 1 },
        { id: idA, expectedVersion: 1 },
        { id: idB, expectedVersion: 2 },
      ],
      actorId,
    );

    const log = harness.getOpLog();
    const colLockIdx = log.indexOf("LOCK_COLLECTION");
    const lockAIdx = log.indexOf(`LOCK_ACCOUNT:${idA}`);
    const lockBIdx = log.indexOf(`LOCK_ACCOUNT:${idB}`);
    const lockCIdx = log.indexOf(`LOCK_ACCOUNT:${idC}`);
    const firstUpdateIdx = log.findIndex((entry) => entry.startsWith("ORM_UPDATE_ACCOUNT:"));

    assert.ok(colLockIdx !== -1, "Collection lock must be acquired");
    assert.ok(lockAIdx !== -1 && lockBIdx !== -1 && lockCIdx !== -1, "Individual account locks must be acquired in lexicographical order");
    assert.ok(colLockIdx < lockAIdx, "Collection lock must precede account A lock");
    assert.ok(lockAIdx < lockBIdx, "Account locks must be acquired in sorted UUID order (A < B)");
    assert.ok(lockBIdx < lockCIdx, "Account locks must be acquired in sorted UUID order (B < C)");
    assert.ok(firstUpdateIdx !== -1, "Mutations must occur after locking");
    assert.ok(lockCIdx < firstUpdateIdx, "All account locks must precede mutations");

    // Assert transaction-local return: TX_ACCOUNT_FIND_MANY used, NOT GLOBAL_ACCOUNT_FIND_MANY
    assert.ok(log.indexOf("TX_ACCOUNT_FIND_MANY") !== -1, "Must use transaction-local read");
    assert.equal(log.indexOf("GLOBAL_ACCOUNT_FIND_MANY"), -1, "Must NOT invoke global prisma inside transaction");

    // Result order and version checks:
    assert.equal(result.length, 3);
    assert.equal(result[0].id, idC);
    assert.equal(result[0].sortOrder, 0);
    assert.equal(result[0].version, 2, "C sortOrder changed 2->0: version incremented 1->2");

    assert.equal(result[1].id, idA);
    assert.equal(result[1].sortOrder, 1);
    assert.equal(result[1].version, 2, "A sortOrder changed 0->1: version incremented 1->2");

    assert.equal(result[2].id, idB);
    assert.equal(result[2].sortOrder, 2);
    assert.equal(result[2].version, 3, "B sortOrder changed 1->2: version incremented 2->3");

    // Single collection audit log
    const state = harness.getState();
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, "PAYMENT_ACCOUNT_REORDERED");
    assert.equal(state.audits[0].entityType, "PaymentReceivingAccountCollection");
    assert.equal(state.audits[0].meta.changes.length, 3);

    // 2. Reorder No-op: Same order C, A, B with current versions
    harness.clearOpLog();
    const noopResult = await reorderPaymentAccounts(
      [
        { id: idC, expectedVersion: 2 },
        { id: idA, expectedVersion: 2 },
        { id: idB, expectedVersion: 3 },
      ],
      actorId,
    );
    assert.equal(noopResult.length, 3);
    assert.equal(noopResult[0].version, 2, "No-op must not increment version");
    assert.equal(noopResult[1].version, 2, "No-op must not increment version");
    assert.equal(noopResult[2].version, 3, "No-op must not increment version");
    assert.equal(harness.getState().audits.length, 1, "No-op must NOT create new audit log");

    // 3. Reorder Partial set rejected (only 2 of 3) -> 400
    await assert.rejects(
      () =>
        reorderPaymentAccounts(
          [
            { id: idC, expectedVersion: 2 },
            { id: idA, expectedVersion: 2 },
          ],
          actorId,
        ),
      (err: any) => err instanceof PaymentAccountError && err.code === "INCOMPLETE_REORDER_SET",
    );

    // 4. Duplicate IDs rejected -> 400 (validation schema)
    await assert.rejects(
      () =>
        reorderPaymentAccounts(
          [
            { id: idC, expectedVersion: 2 },
            { id: idC, expectedVersion: 2 },
            { id: idB, expectedVersion: 3 },
          ],
          actorId,
        ),
      /duplicate/i,
    );

    // 5. Stale expectedVersion rejected -> 409
    await assert.rejects(
      () =>
        reorderPaymentAccounts(
          [
            { id: idC, expectedVersion: 1 }, // Current is 2
            { id: idA, expectedVersion: 2 },
            { id: idB, expectedVersion: 3 },
          ],
          actorId,
        ),
      (err: any) => err instanceof PaymentAccountError && err.code === "VERSION_CONFLICT",
    );
  } finally {
    harness.restore();
  }
});

test("AC-1: patchPaymentAccount locking, identity immutability, enabling requirements, and no-ops", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const actorId = "admin-user-1";

  const initialAccount = {
    id: accountId,
    providerLabel: "Global IME Bank",
    accountHolder: "Store Main",
    accountIdentifier: "0011223344",
    settlementMethod: "BANK_TRANSFER",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: false,
    sortOrder: 0,
    version: 1,
    creationPayloadHash: "initialHash",
    activeQrAssetId: null,
    createdById: actorId,
    updatedById: actorId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const harness = createMetadataHarness({ accounts: [initialAccount] });

  try {
    // 1. Patch without active asset attempting to enable -> 400 CANNOT_ENABLE_WITHOUT_QR_ASSET
    await assert.rejects(
      () => patchPaymentAccount(accountId, { expectedVersion: 1, enabled: true }, actorId),
      (err: any) => err instanceof PaymentAccountError && err.code === "CANNOT_ENABLE_WITHOUT_QR_ASSET",
    );

    // 2. Stale expectedVersion -> 409 VERSION_CONFLICT
    await assert.rejects(
      () => patchPaymentAccount(accountId, { expectedVersion: 99, providerLabel: "New Label" }, actorId),
      (err: any) => err instanceof PaymentAccountError && err.code === "VERSION_CONFLICT",
    );

    // 3. Valid label patch increments version to 2
    harness.clearOpLog();
    const patched1 = await patchPaymentAccount(
      accountId,
      { expectedVersion: 1, providerLabel: "Global IME Bank (Main Branch)" },
      actorId,
    );
    assert.equal(patched1.version, 2);
    assert.equal(patched1.providerLabel, "Global IME Bank (Main Branch)");
    assert.equal(harness.getState().audits.length, 1);
    assert.equal(harness.getState().audits[0].action, "PAYMENT_ACCOUNT_UPDATED");

    // 4. Same-value patch at matching version (no-op) -> returns DTO, zero version increment, zero new audit
    harness.clearOpLog();
    const noopPatched = await patchPaymentAccount(
      accountId,
      { expectedVersion: 2, providerLabel: "Global IME Bank (Main Branch)" },
      actorId,
    );
    assert.equal(noopPatched.version, 2, "Version must remain 2 on no-op");
    assert.equal(harness.getState().audits.length, 1, "Zero new audits on no-op");

    // 5. Add linked payment to test referenced identity immutability
    const state = harness.getState();
    state.payments.push({
      id: crypto.randomUUID(),
      receivingAccountId: accountId,
      amount: 1500,
    });

    // Attempting to change settlementMethod on account with linked payment -> 409 ACCOUNT_IDENTITY_IN_USE
    harness.clearOpLog();
    await assert.rejects(
      () => patchPaymentAccount(accountId, { expectedVersion: 2, settlementMethod: "FONEPAY" }, actorId),
      (err: any) => err instanceof PaymentAccountError && err.code === "ACCOUNT_IDENTITY_IN_USE",
    );

    // Verify account lock was acquired BEFORE payment count query
    const log = harness.getOpLog();
    const acctLockIdx = log.indexOf(`LOCK_ACCOUNT:${accountId}`);
    const pmtCountIdx = log.indexOf(`ORM_PAYMENT_COUNT:${accountId}`);
    assert.ok(acctLockIdx !== -1, "Account lock must be acquired");
    assert.ok(pmtCountIdx !== -1, "Payment count query executed");
    assert.ok(acctLockIdx < pmtCountIdx, "Account lock must precede linked payment check");

    // Attempting to change accountIdentifier on account with linked payment -> 409 ACCOUNT_IDENTITY_IN_USE
    await assert.rejects(
      () => patchPaymentAccount(accountId, { expectedVersion: 2, accountIdentifier: "9999999999" }, actorId),
      (err: any) => err instanceof PaymentAccountError && err.code === "ACCOUNT_IDENTITY_IN_USE",
    );

    // 6. Non-identity fields (providerLabel, accountHolder) ARE editable even with linked payments
    const patched2 = await patchPaymentAccount(
      accountId,
      { expectedVersion: 2, accountHolder: "Store Main Branch (Updated)" },
      actorId,
    );
    assert.equal(patched2.version, 3);
    assert.equal(patched2.accountHolder, "Store Main Branch (Updated)");
    assert.equal(patched2.accountIdentifier, "0011223344", "Identifier remains intact");
    assert.equal(harness.getState().audits.length, 2);
  } finally {
    harness.restore();
  }
});

test("AC-5: staged audit failure rollbacks with zero writes escaping in create, patch, and reorder", async () => {
  const accountId1 = crypto.randomUUID();
  const accountId2 = crypto.randomUUID();
  const actorId = "admin-user-1";
  const initialAccount1 = {
    id: accountId1,
    providerLabel: "Test Account 1",
    accountHolder: "Test Holder 1",
    accountIdentifier: "test-id-1",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: false,
    sortOrder: 0,
    version: 1,
    creationPayloadHash: "hash-test-1",
    activeQrAssetId: null,
    createdById: actorId,
    updatedById: actorId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const initialAccount2 = {
    id: accountId2,
    providerLabel: "Test Account 2",
    accountHolder: "Test Holder 2",
    accountIdentifier: "test-id-2",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: false,
    sortOrder: 1,
    version: 1,
    creationPayloadHash: "hash-test-2",
    activeQrAssetId: null,
    createdById: actorId,
    updatedById: actorId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const harness = createMetadataHarness({ accounts: [initialAccount1, initialAccount2] });

  try {
    // 1. Create with audit failure -> rolls back completely
    const newAccountId = crypto.randomUUID();
    harness.setFailAuditCreate(true);
    await assert.rejects(
      () =>
        createPaymentAccount(
          {
            id: newAccountId,
            providerLabel: "Fail Create",
            accountHolder: "Fail Holder",
            accountIdentifier: "9800112233",
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
          },
          actorId,
        ),
      /Simulated audit creation database error/,
    );
    harness.setFailAuditCreate(false);

    // Assert committed state has zero writes
    assert.equal(harness.getState().accounts[newAccountId], undefined, "Uncommitted account must not escape to state");
    assert.equal(harness.getState().audits.length, 0);

    // 2. Patch with audit failure -> rolls back completely
    harness.setFailAuditCreate(true);
    await assert.rejects(
      () => patchPaymentAccount(accountId1, { expectedVersion: 1, providerLabel: "Fail Label Update" }, actorId),
      /Simulated audit creation database error/,
    );
    harness.setFailAuditCreate(false);

    assert.equal(harness.getState().accounts[accountId1].version, 1, "Committed version remains 1");
    assert.equal(harness.getState().accounts[accountId1].providerLabel, "Test Account 1", "Committed label remains unchanged");
    assert.equal(harness.getState().audits.length, 0);

    // 3. Reorder with audit failure -> swap 2 accounts, staged version/order changed, rolls back completely
    harness.setFailAuditCreate(true);
    await assert.rejects(
      () =>
        reorderPaymentAccounts(
          [
            { id: accountId2, expectedVersion: 1 },
            { id: accountId1, expectedVersion: 1 },
          ],
          actorId,
        ),
      /Simulated audit creation database error/,
    );
    harness.setFailAuditCreate(false);

    const stagedDuringFail = harness.getLastStagedState();
    assert.ok(stagedDuringFail, "Transaction work callback executed before audit failure");
    assert.equal(stagedDuringFail.accounts[accountId2].sortOrder, 0, "Staged sortOrder was changed");
    assert.equal(stagedDuringFail.accounts[accountId2].version, 2, "Staged version was bumped");
    assert.equal(stagedDuringFail.accounts[accountId1].sortOrder, 1, "Staged sortOrder was changed");
    assert.equal(stagedDuringFail.accounts[accountId1].version, 2, "Staged version was bumped");

    assert.equal(harness.getState().accounts[accountId1].sortOrder, 0, "Committed sortOrder remains 0 after failed reorder");
    assert.equal(harness.getState().accounts[accountId1].version, 1, "Committed version remains 1 after failed reorder");
    assert.equal(harness.getState().accounts[accountId2].sortOrder, 1, "Committed sortOrder remains 1 after failed reorder");
    assert.equal(harness.getState().accounts[accountId2].version, 1, "Committed version remains 1 after failed reorder");
    assert.equal(harness.getState().audits.length, 0);
  } finally {
    harness.restore();
  }
});
