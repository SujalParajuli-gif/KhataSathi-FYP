import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

let originalDocRoot: string | undefined;
let originalUploadsRoot: string | undefined;
let testStorageRoot: string;

let prisma: typeof import("../db/prisma.js").default;
let calculateCreationPayloadHash: typeof import("../modules/settings/paymentAccounts/service.js").calculateCreationPayloadHash;
let getQrAssetFile: typeof import("../modules/settings/paymentAccounts/service.js").getQrAssetFile;
let PaymentAccountError: typeof import("../modules/settings/paymentAccounts/service.js").PaymentAccountError;
let PaymentAccountStorageError: typeof import("../modules/settings/paymentAccounts/storage.js").PaymentAccountStorageError;
let processAndPromoteQrAsset: typeof import("../modules/settings/paymentAccounts/storage.js").processAndPromoteQrAsset;
let resolveAssetFilePath: typeof import("../modules/settings/paymentAccounts/storage.js").resolveAssetFilePath;

let uploadAndPublishQrAsset: typeof import("../modules/settings/paymentAccounts/service.js").uploadAndPublishQrAsset;

test.before(async () => {
  originalDocRoot = process.env.DOCUMENT_STORAGE_ROOT;
  originalUploadsRoot = process.env.UPLOADS_ROOT;
  testStorageRoot = path.join(os.tmpdir(), `ks-accounts-test-${crypto.randomUUID()}`);
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
  const storageMod = await import("../modules/settings/paymentAccounts/storage.js");

  const rawPrisma = prismaMod.default as any;
  prisma = rawPrisma?.default?.$transaction ? rawPrisma.default : rawPrisma;
  calculateCreationPayloadHash = serviceMod.calculateCreationPayloadHash;
  getQrAssetFile = serviceMod.getQrAssetFile;
  uploadAndPublishQrAsset = serviceMod.uploadAndPublishQrAsset;
  PaymentAccountError = serviceMod.PaymentAccountError;
  PaymentAccountStorageError = storageMod.PaymentAccountStorageError;
  processAndPromoteQrAsset = storageMod.processAndPromoteQrAsset;
  resolveAssetFilePath = storageMod.resolveAssetFilePath;
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

test("calculateCreationPayloadHash produces deterministic SHA256 from normalized fields", () => {
  const input1 = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    providerLabel: "  Nabil Bank  ",
    accountHolder: "  Ram Shrestha  ",
    accountIdentifier: " 1234567890 ",
    settlementMethod: "BANK_TRANSFER" as const,
    confirmationMode: "MANUAL_RECEIPT" as const,
  };

  const input2 = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    providerLabel: "Nabil Bank",
    accountHolder: "Ram Shrestha",
    accountIdentifier: "1234567890",
    settlementMethod: "BANK_TRANSFER" as const,
    confirmationMode: "MANUAL_RECEIPT" as const,
  };

  const hash1 = calculateCreationPayloadHash(input1);
  const hash2 = calculateCreationPayloadHash(input2);

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

type AccountState = {
  accounts: Record<string, any>;
  assets: Record<string, any>;
  audits: any[];
};

function createPublicationHarness(initialState: {
  account: any;
  assets?: any[];
  audits?: any[];
}) {
  let state: AccountState = {
    accounts: { [initialState.account.id]: structuredClone(initialState.account) },
    assets: Object.fromEntries((initialState.assets || []).map((a) => [a.id, structuredClone(a)])),
    audits: structuredClone(initialState.audits || []),
  };

  const originalTransaction = prisma.$transaction;
  const originalAccountFindUnique = prisma.paymentReceivingAccount.findUnique;
  const originalAssetFindUnique = prisma.paymentReceivingQrAsset.findUnique;
  const originalUnlink = fs.unlink;

  let lockCount = 0;
  let failAssetCreate = false;
  let failAuditCreate = false;
  let failPrecommit = false;
  let commitThenThrow = false;
  let lastStaged: AccountState | null = null;
  const unlinkedPaths: string[] = [];

  (fs as any).unlink = async (targetPath: string) => {
    unlinkedPaths.push(path.normalize(targetPath));
    return originalUnlink(targetPath);
  };

  (prisma.paymentReceivingAccount as any).findUnique = async ({ where }: any) =>
    state.accounts[where.id] ? structuredClone(state.accounts[where.id]) : null;

  (prisma.paymentReceivingQrAsset as any).findUnique = async ({ where }: any) =>
    state.assets[where.id] ? structuredClone(state.assets[where.id]) : null;

  (prisma as any).$transaction = async (work: (tx: any) => Promise<any>) => {
    const staged: AccountState = structuredClone(state);

    const tx: any = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const accountId = values[0];
        lockCount++;
        const acc = staged.accounts[accountId];
        if (!acc) return [];
        return [
          {
            id: acc.id,
            providerLabel: acc.providerLabel,
            accountHolder: acc.accountHolder,
            accountIdentifier: acc.accountIdentifier,
            settlementMethod: acc.settlementMethod,
            confirmationMode: acc.confirmationMode,
            enabled: acc.enabled,
            sortOrder: acc.sortOrder,
            version: acc.version,
            creationPayloadHash: acc.creationPayloadHash,
            activeQrAssetId: acc.activeQrAssetId,
          },
        ];
      },
      paymentReceivingAccount: {
        findUnique: async ({ where }: any) =>
          staged.accounts[where.id] ? structuredClone(staged.accounts[where.id]) : null,
        findUniqueOrThrow: async ({ where }: any) => {
          const acc = staged.accounts[where.id];
          if (!acc) throw new Error("Account not found");
          return structuredClone(acc);
        },
        update: async ({ where, data }: any) => {
          const acc = staged.accounts[where.id];
          if (!acc) throw new Error("Account not found");
          Object.assign(acc, data);
          return structuredClone(acc);
        },
      },
      paymentReceivingQrAsset: {
        findUnique: async ({ where }: any) =>
          staged.assets[where.id] ? structuredClone(staged.assets[where.id]) : null,
        create: async ({ data }: any) => {
          if (failAssetCreate) {
            throw new Error("Simulated asset create DB error");
          }
          const asset = {
            ...data,
            createdAt: new Date(),
          };
          staged.assets[asset.id] = structuredClone(asset);
          return structuredClone(asset);
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          if (failAuditCreate) {
            throw new Error("Simulated audit create DB error");
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

    const result = await work(tx);
    lastStaged = structuredClone(staged);

    if (failPrecommit) {
      throw new Error("Simulated precommit failure");
    }

    if (commitThenThrow) {
      state = staged;
      throw new Error("Simulated network loss after commit");
    }

    state = staged;
    return result;
  };

  return {
    getState: () => state,
    getLastStagedState: () => lastStaged,
    getLockCount: () => lockCount,
    getUnlinkedPaths: () => unlinkedPaths,
    setFailAssetCreate: (val: boolean) => { failAssetCreate = val; },
    setFailAuditCreate: (val: boolean) => { failAuditCreate = val; },
    setFailPrecommit: (val: boolean) => { failPrecommit = val; },
    setCommitThenThrow: (val: boolean) => { commitThenThrow = val; },
    restore: () => {
      (prisma as any).$transaction = originalTransaction;
      (prisma.paymentReceivingAccount as any).findUnique = originalAccountFindUnique;
      (prisma.paymentReceivingQrAsset as any).findUnique = originalAssetFindUnique;
      (fs as any).unlink = originalUnlink;
    },
  };
}

test("AC-1/AC-5: uploadAndPublishQrAsset staged publication, safe DTO, replays, rollbacks, and file retention", async () => {
  const accountId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const uploadId1 = crypto.randomUUID();
  const uploadId2 = crypto.randomUUID();

  const validPng1 = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 150, b: 200 } },
  }).png().toBuffer();

  const validPng2 = await sharp({
    create: { width: 320, height: 320, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer();

  const initialAccount = {
    id: accountId,
    providerLabel: "Fonepay QR",
    accountHolder: "KhataSathi Store",
    accountIdentifier: "9800000000",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: true,
    sortOrder: 0,
    version: 1,
    creationPayloadHash: "initial-hash",
    activeQrAssetId: null,
    createdById: actorId,
    updatedById: actorId,
  };

  const harness = createPublicationHarness({ account: initialAccount });

  try {
    // 1. Fresh publication increments version/pointer/audit once keeping enabled
    const pubRes1 = await uploadAndPublishQrAsset({
      accountId,
      uploadId: uploadId1,
      expectedVersion: 1,
      fileBuffer: validPng1,
      actorId,
    });

    assert.equal(harness.getLockCount(), 1, "Account lock must be acquired");
    assert.equal(pubRes1.id, uploadId1);
    assert.equal(pubRes1.accountId, accountId);
    assert.equal(pubRes1.publicationExpectedVersion, 1);
    assert.equal(pubRes1.mimeType, "image/png");
    assert.equal(pubRes1.width, 300);
    assert.equal(pubRes1.height, 300);
    assert.ok(pubRes1.sizeBytes > 0);
    assert.ok(pubRes1.thumbnailSizeBytes > 0);
    assert.equal(typeof pubRes1.checksum, "string");
    assert.ok(pubRes1.createdAt instanceof Date);
    assert.equal(pubRes1.currentAccountVersion, 2);
    assert.equal(pubRes1.activeQrAssetId, uploadId1);

    // Safe DTO privacy assertions (no filesystem paths, sourceChecksum, createdById, raw relations)
    assert.equal((pubRes1 as any).storedPath, undefined);
    assert.equal((pubRes1 as any).fileName, undefined);
    assert.equal((pubRes1 as any).thumbnailFileName, undefined);
    assert.equal((pubRes1 as any).sourceChecksum, undefined);
    assert.equal((pubRes1 as any).createdById, undefined);

    // State assertions
    const stateAfter1 = harness.getState();
    assert.equal(stateAfter1.accounts[accountId].version, 2);
    assert.equal(stateAfter1.accounts[accountId].activeQrAssetId, uploadId1);
    assert.equal(stateAfter1.accounts[accountId].enabled, true, "Account enabled state must be preserved");
    assert.equal(stateAfter1.audits.length, 1);

    const audit1 = stateAfter1.audits[0];
    assert.equal(audit1.action, "PAYMENT_ACCOUNT_QR_PUBLISHED");
    assert.equal(audit1.entityId, accountId);
    assert.equal(audit1.meta.assetId, uploadId1);
    assert.equal(audit1.meta.oldActiveAssetId, null);
    assert.equal(audit1.meta.version, 2);
    assert.equal(audit1.meta.checksum, pubRes1.checksum);
    assert.equal(audit1.meta.width, 300);
    assert.equal(audit1.meta.height, 300);
    // Audit privacy assertions
    assert.equal(audit1.meta.sourceChecksum, undefined);
    assert.equal(audit1.meta.storedPath, undefined);
    assert.equal(audit1.meta.fileName, undefined);
    assert.equal(audit1.meta.fileBuffer, undefined);

    // Promoted files exist on disk
    const mainPath1 = resolveAssetFilePath(accountId, `${uploadId1}.png`);
    const thumbPath1 = resolveAssetFilePath(accountId, `${uploadId1}_thumb.png`);
    const statMain1 = await fs.stat(mainPath1);
    const statThumb1 = await fs.stat(thumbPath1);
    assert.ok(statMain1.isFile());
    assert.ok(statThumb1.isFile());

    // 2. Exact retry after response loss returns original asset/current pointer/version without repoint/new audit
    const replayRes1 = await uploadAndPublishQrAsset({
      accountId,
      uploadId: uploadId1,
      expectedVersion: 1,
      fileBuffer: validPng1,
      actorId,
    });

    assert.equal(replayRes1.id, uploadId1);
    assert.equal(replayRes1.publicationExpectedVersion, 1);
    assert.equal(replayRes1.currentAccountVersion, 2);
    assert.equal(replayRes1.activeQrAssetId, uploadId1);
    assert.equal((replayRes1 as any).storedPath, undefined);
    assert.equal((replayRes1 as any).sourceChecksum, undefined);

    const stateAfterReplay1 = harness.getState();
    assert.equal(stateAfterReplay1.accounts[accountId].version, 2);
    assert.equal(stateAfterReplay1.audits.length, 1, "Replay must not create duplicate audit log");

    // Publish replacement asset (uploadId2)
    const pubRes2 = await uploadAndPublishQrAsset({
      accountId,
      uploadId: uploadId2,
      expectedVersion: 2,
      fileBuffer: validPng2,
      actorId,
    });
    assert.equal(pubRes2.currentAccountVersion, 3);
    assert.equal(pubRes2.activeQrAssetId, uploadId2);

    const stateAfter2 = harness.getState();
    assert.equal(stateAfter2.accounts[accountId].version, 3);
    assert.equal(stateAfter2.accounts[accountId].activeQrAssetId, uploadId2);
    assert.equal(stateAfter2.audits.length, 2);

    // Exact retry of uploadId1 after subsequent replacement: returns uploadId1 with current account version & activeQrAssetId (uploadId2)
    const replayOldAsset = await uploadAndPublishQrAsset({
      accountId,
      uploadId: uploadId1,
      expectedVersion: 1,
      fileBuffer: validPng1,
      actorId,
    });
    assert.equal(replayOldAsset.id, uploadId1);
    assert.equal(replayOldAsset.publicationExpectedVersion, 1);
    assert.equal(replayOldAsset.currentAccountVersion, 3);
    assert.equal(replayOldAsset.activeQrAssetId, uploadId2, "Current activeQrAssetId must point to latest active asset");

    const stateAfterOldReplay = harness.getState();
    assert.equal(stateAfterOldReplay.accounts[accountId].version, 3);
    assert.equal(stateAfterOldReplay.accounts[accountId].activeQrAssetId, uploadId2, "Account pointer must NOT repoint on old replay");
    assert.equal(stateAfterOldReplay.audits.length, 2);

    // 3. Mismatch actor/account/source hash/expectedVersion conflicts
    // Mismatched actor
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadId1,
          expectedVersion: 1,
          fileBuffer: validPng1,
          actorId: "different-actor-id",
        }),
      (err: any) =>
        (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) &&
        err.code === "ASSET_CONFLICT" &&
        err.statusCode === 409,
    );

    // Mismatched source hash (fails safely at storage with PaymentAccountStorageError ASSET_CONFLICT 409 before service replay)
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadId1,
          expectedVersion: 1,
          fileBuffer: validPng2,
          actorId,
        }),
      (err: any) =>
        (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) &&
        err.code === "ASSET_CONFLICT" &&
        err.statusCode === 409,
    );

    // Prove no pointer/version/audit/files altered after source hash mismatch conflict
    const stateAfterMismatch = harness.getState();
    assert.equal(stateAfterMismatch.accounts[accountId].version, 3, "Account version remains 3");
    assert.equal(stateAfterMismatch.accounts[accountId].activeQrAssetId, uploadId2, "Active pointer remains uploadId2");
    assert.equal(stateAfterMismatch.audits.length, 2, "Audit count remains 2");
    const main1Content = await fs.readFile(resolveAssetFilePath(accountId, `${uploadId1}.png`));
    const main1Hash = crypto.createHash("sha256").update(main1Content).digest("hex");
    assert.equal(main1Hash, pubRes1.checksum, "Existing uploadId1 file contents remain untouched");

    // Mismatched expectedVersion for existing asset
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadId1,
          expectedVersion: 99,
          fileBuffer: validPng1,
          actorId,
        }),
      (err: any) =>
        (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) &&
        err.code === "ASSET_CONFLICT" &&
        err.statusCode === 409,
    );

    // 4. Stale fresh expectedVersion 409 no writes
    const uploadIdStale = crypto.randomUUID();
    const pngStale = await sharp({
      create: { width: 310, height: 310, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();

    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadIdStale,
          expectedVersion: 1, // Current is 3
          fileBuffer: pngStale,
          actorId,
        }),
      (err: any) => err instanceof PaymentAccountError && err.code === "VERSION_CONFLICT",
    );

    const stateAfterStale = harness.getState();
    assert.equal(stateAfterStale.accounts[accountId].version, 3);
    assert.equal(stateAfterStale.assets[uploadIdStale], undefined, "No asset record should be created on 409 conflict");
    assert.equal(stateAfterStale.audits.length, 2);

    // 5. Asset insert/audit/precommit failures retain prior pointer/version/audit/asset and candidate file bytes
    // 5a. Asset insert failure
    const uploadIdFail1 = crypto.randomUUID();
    const pngFail1 = await sharp({
      create: { width: 330, height: 330, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).png().toBuffer();

    harness.setFailAssetCreate(true);
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadIdFail1,
          expectedVersion: 3,
          fileBuffer: pngFail1,
          actorId,
        }),
      /Simulated asset create DB error/,
    );
    harness.setFailAssetCreate(false);

    const stateAfterFail1 = harness.getState();
    assert.equal(stateAfterFail1.accounts[accountId].version, 3);
    assert.equal(stateAfterFail1.accounts[accountId].activeQrAssetId, uploadId2);
    assert.equal(stateAfterFail1.assets[uploadIdFail1], undefined);
    assert.equal(stateAfterFail1.audits.length, 2);

    // Promoted candidate files are retained on disk even after DB failure
    const fail1Main = resolveAssetFilePath(accountId, `${uploadIdFail1}.png`);
    const fail1Thumb = resolveAssetFilePath(accountId, `${uploadIdFail1}_thumb.png`);
    assert.ok((await fs.stat(fail1Main)).isFile());
    assert.ok((await fs.stat(fail1Thumb)).isFile());

    // 5b. Audit create failure
    const uploadIdFail2 = crypto.randomUUID();
    const pngFail2 = await sharp({
      create: { width: 340, height: 340, channels: 3, background: { r: 30, g: 60, b: 90 } },
    }).png().toBuffer();

    harness.setFailAuditCreate(true);
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadIdFail2,
          expectedVersion: 3,
          fileBuffer: pngFail2,
          actorId,
        }),
      /Simulated audit create DB error/,
    );
    harness.setFailAuditCreate(false);

    const stateAfterFail2 = harness.getState();
    assert.equal(stateAfterFail2.accounts[accountId].version, 3);
    assert.equal(stateAfterFail2.accounts[accountId].activeQrAssetId, uploadId2);
    assert.equal(stateAfterFail2.assets[uploadIdFail2], undefined);
    assert.equal(stateAfterFail2.audits.length, 2);

    // 5c. Precommit failure
    const uploadIdFail3 = crypto.randomUUID();
    const pngFail3 = await sharp({
      create: { width: 350, height: 350, channels: 3, background: { r: 40, g: 80, b: 120 } },
    }).png().toBuffer();

    harness.setFailPrecommit(true);
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadIdFail3,
          expectedVersion: 3,
          fileBuffer: pngFail3,
          actorId,
        }),
      /Simulated precommit failure/,
    );
    harness.setFailPrecommit(false);

    const stagedDuringFail3 = harness.getLastStagedState();
    assert.ok(stagedDuringFail3, "Transaction work callback must have executed");
    assert.equal(stagedDuringFail3.accounts[accountId].version, 4, "Version was staged in transaction");
    assert.equal(stagedDuringFail3.accounts[accountId].activeQrAssetId, uploadIdFail3, "Pointer was staged in transaction");
    assert.ok(stagedDuringFail3.assets[uploadIdFail3], "Asset was staged in transaction");
    assert.equal(stagedDuringFail3.audits.length, 3, "Audit was staged in transaction");

    // Assert committed state remains unchanged with prior version/pointer/audits
    const stateAfterFail3 = harness.getState();
    assert.equal(stateAfterFail3.accounts[accountId].version, 3, "Committed account version unchanged");
    assert.equal(stateAfterFail3.accounts[accountId].activeQrAssetId, uploadId2, "Committed pointer unchanged");
    assert.equal(stateAfterFail3.assets[uploadIdFail3], undefined, "Uncommitted staged asset must not leak into committed state");
    assert.equal(stateAfterFail3.audits.length, 2, "Uncommitted staged audit must not leak into committed state");

    // 6. Commit-then-throw retains committed candidate and exact retry reconciles
    const uploadIdCommitThrow = crypto.randomUUID();
    const pngCommitThrow = await sharp({
      create: { width: 360, height: 360, channels: 3, background: { r: 50, g: 100, b: 150 } },
    }).png().toBuffer();

    harness.setCommitThenThrow(true);
    await assert.rejects(
      () =>
        uploadAndPublishQrAsset({
          accountId,
          uploadId: uploadIdCommitThrow,
          expectedVersion: 3,
          fileBuffer: pngCommitThrow,
          actorId,
        }),
      /Simulated network loss after commit/,
    );
    harness.setCommitThenThrow(false);

    // DB was committed before throw
    const stateAfterCommitThrow = harness.getState();
    assert.equal(stateAfterCommitThrow.accounts[accountId].version, 4);
    assert.equal(stateAfterCommitThrow.accounts[accountId].activeQrAssetId, uploadIdCommitThrow);
    assert.ok(stateAfterCommitThrow.assets[uploadIdCommitThrow]);
    assert.equal(stateAfterCommitThrow.audits.length, 3);

    // Exact retry after unknown-commit network loss reconciles cleanly
    const reconcileRes = await uploadAndPublishQrAsset({
      accountId,
      uploadId: uploadIdCommitThrow,
      expectedVersion: 3,
      fileBuffer: pngCommitThrow,
      actorId,
    });
    assert.equal(reconcileRes.id, uploadIdCommitThrow);
    assert.equal(reconcileRes.publicationExpectedVersion, 3);
    assert.equal(reconcileRes.currentAccountVersion, 4);
    assert.equal(reconcileRes.activeQrAssetId, uploadIdCommitThrow);

    const stateAfterReconcile = harness.getState();
    assert.equal(stateAfterReconcile.accounts[accountId].version, 4);
    assert.equal(stateAfterReconcile.audits.length, 3, "No duplicate audit on retry reconciliation");

    // 7. Unlink assertion: Record actual unlink calls and assert no final promoted paths unlinked on every outcome
    const unlinked = harness.getUnlinkedPaths();
    const accountDirNorm = path.normalize(path.join(testStorageRoot, "payment-accounts", accountId));
    const unlinkedAccountFiles = unlinked.filter((p) => p.startsWith(accountDirNorm));
    assert.equal(
      unlinkedAccountFiles.length,
      0,
      `Zero final promoted files in account dir should ever be unlinked. Found unlinked: ${unlinkedAccountFiles.join(", ")}`,
    );
  } finally {
    harness.restore();
  }
});

test("getQrAssetFile denies unauthorized access with ZERO DB queries", async () => {
  const accountId = "550e8400-e29b-41d4-a716-446655440000";
  const assetId = "660e8400-e29b-41d4-a716-446655440000";

  let queryCount = 0;
  const originalAccountFindUnique = prisma.paymentReceivingAccount.findUnique;
  const originalAssetFindUnique = prisma.paymentReceivingQrAsset.findUnique;

  (prisma.paymentReceivingAccount as any).findUnique = async () => {
    queryCount++;
    return null;
  };
  (prisma.paymentReceivingQrAsset as any).findUnique = async () => {
    queryCount++;
    return null;
  };

  try {
    // 1. STAFF is denied before any DB query
    await assert.rejects(
      () => getQrAssetFile({ accountId, assetId, isThumbnail: false, userRole: "STAFF" }),
      (err: any) => err instanceof PaymentAccountError && err.code === "FORBIDDEN",
    );
    assert.equal(queryCount, 0, "Zero DB queries must be executed on STAFF denial");

    // 2. Missing user role is denied before any DB query
    await assert.rejects(
      () => getQrAssetFile({ accountId, assetId, isThumbnail: false, userRole: "" }),
      (err: any) => err instanceof PaymentAccountError && err.code === "FORBIDDEN",
    );
    assert.equal(queryCount, 0, "Zero DB queries must be executed on missing role denial");

    // 3. CASHIER is denied when POS capability is disabled before any DB query
    await assert.rejects(
      () =>
        getQrAssetFile({
          accountId,
          assetId,
          isThumbnail: false,
          userRole: "CASHIER",
          posEnabled: false,
        }),
      (err: any) => err instanceof PaymentAccountError && err.code === "FEATURE_DISABLED",
    );
    assert.equal(queryCount, 0, "Zero DB queries must be executed when POS capability is disabled");

    // 4. MANAGER is denied when POS capability is disabled before any DB query
    await assert.rejects(
      () =>
        getQrAssetFile({
          accountId,
          assetId,
          isThumbnail: false,
          userRole: "MANAGER",
          posEnabled: false,
        }),
      (err: any) => err instanceof PaymentAccountError && err.code === "FEATURE_DISABLED",
    );
    assert.equal(queryCount, 0, "Zero DB queries must be executed when POS capability is disabled");
  } finally {
    (prisma.paymentReceivingAccount as any).findUnique = originalAccountFindUnique;
    (prisma.paymentReceivingQrAsset as any).findUnique = originalAssetFindUnique;
  }
});

test("getQrAssetFile allows authorized reads, handles missing files, and checks active asset status", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const inactiveAssetId = crypto.randomUUID();

  // Create real image files in isolated storage
  const validPng = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 50, g: 100, b: 150 } },
  }).png().toBuffer();

  const prepared = await processAndPromoteQrAsset({
    accountId,
    assetId,
    inputBuffer: validPng,
  });

  const originalAccountFindUnique = prisma.paymentReceivingAccount.findUnique;
  const originalAssetFindUnique = prisma.paymentReceivingQrAsset.findUnique;

  try {
    // Mock Prisma responses for testing protected read branches
    (prisma.paymentReceivingAccount as any).findUnique = async (args: any) => {
      if (args.where.id === accountId) {
        return {
          id: accountId,
          enabled: true,
          activeQrAssetId: assetId,
        };
      }
      return null;
    };

    (prisma.paymentReceivingQrAsset as any).findUnique = async (args: any) => {
      if (args.where.id === assetId) {
        return {
          id: assetId,
          accountId,
          fileName: prepared.fileName,
          thumbnailFileName: prepared.thumbnailFileName,
          storedPath: prepared.storedPath,
        };
      }
      if (args.where.id === inactiveAssetId) {
        return {
          id: inactiveAssetId,
          accountId,
          fileName: `${inactiveAssetId}.png`,
          thumbnailFileName: `${inactiveAssetId}_thumb.png`,
          storedPath: prepared.storedPath,
        };
      }
      return null;
    };

    // 1. CASHIER with posEnabled reading active asset of enabled account -> succeeds
    const cashierResult = await getQrAssetFile({
      accountId,
      assetId,
      isThumbnail: false,
      userRole: "CASHIER",
      posEnabled: true,
    });
    assert.equal(cashierResult.mimeType, "image/png");
    assert.ok(cashierResult.sizeBytes > 0);

    // 2. CASHIER reading inactive asset -> 404 ASSET_NOT_ACCESSIBLE
    await assert.rejects(
      () =>
        getQrAssetFile({
          accountId,
          assetId: inactiveAssetId,
          isThumbnail: false,
          userRole: "CASHIER",
          posEnabled: true,
        }),
      (err: any) => err instanceof PaymentAccountError && err.code === "ASSET_NOT_ACCESSIBLE",
    );

    // 3. ADMIN reading inactive asset -> permitted (retained reads bypass POS & active requirements)
    // but the inactive file does not exist on disk -> 404 FILE_NOT_FOUND
    await assert.rejects(
      () =>
        getQrAssetFile({
          accountId,
          assetId: inactiveAssetId,
          isThumbnail: false,
          userRole: "ADMIN",
        }),
      (err: any) => err instanceof PaymentAccountError && err.code === "FILE_NOT_FOUND",
    );
  } finally {
    (prisma.paymentReceivingAccount as any).findUnique = originalAccountFindUnique;
    (prisma.paymentReceivingQrAsset as any).findUnique = originalAssetFindUnique;
  }
});
