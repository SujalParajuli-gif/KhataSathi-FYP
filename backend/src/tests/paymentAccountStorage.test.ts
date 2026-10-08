import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

let originalDocRoot: string | undefined;
let originalUploadsRoot: string | undefined;
let testStorageRoot: string;

let processAndPromoteQrAsset: typeof import("../modules/settings/paymentAccounts/storage.js").processAndPromoteQrAsset;
let promoteFileExclusively: typeof import("../modules/settings/paymentAccounts/storage.js").promoteFileExclusively;
let resolveAccountDir: typeof import("../modules/settings/paymentAccounts/storage.js").resolveAccountDir;
let resolveAssetFilePath: typeof import("../modules/settings/paymentAccounts/storage.js").resolveAssetFilePath;
let assertNoSymlinksInPath: typeof import("../modules/settings/paymentAccounts/storage.js").assertNoSymlinksInPath;
let computeSha256: typeof import("../modules/settings/paymentAccounts/storage.js").computeSha256;
let isValidUuid: typeof import("../modules/settings/paymentAccounts/storage.js").isValidUuid;
let PaymentAccountStorageError: typeof import("../modules/settings/paymentAccounts/storage.js").PaymentAccountStorageError;
let StorageUnavailableError: typeof import("../lib/storageReadiness.js").StorageUnavailableError;
let documentStorageRoot: string;
let documentTempDir: string;
let paymentAccountsDir: string;

test.before(async () => {
  originalDocRoot = process.env.DOCUMENT_STORAGE_ROOT;
  originalUploadsRoot = process.env.UPLOADS_ROOT;
  testStorageRoot = path.join(os.tmpdir(), `ks-storage-test-${crypto.randomUUID()}`);
  process.env.DOCUMENT_STORAGE_ROOT = testStorageRoot;
  process.env.UPLOADS_ROOT = path.join(testStorageRoot, "uploads");

  await fs.mkdir(testStorageRoot, { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "payment-accounts"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, ".temp"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "documents"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "import-sources"), { recursive: true });
  await fs.mkdir(path.join(testStorageRoot, "uploads"), { recursive: true });

  const storageMod = await import("../modules/settings/paymentAccounts/storage.js");
  const readinessMod = await import("../lib/storageReadiness.js");

  processAndPromoteQrAsset = storageMod.processAndPromoteQrAsset;
  promoteFileExclusively = storageMod.promoteFileExclusively;
  resolveAccountDir = storageMod.resolveAccountDir;
  resolveAssetFilePath = storageMod.resolveAssetFilePath;
  assertNoSymlinksInPath = storageMod.assertNoSymlinksInPath;
  computeSha256 = storageMod.computeSha256;
  isValidUuid = storageMod.isValidUuid;
  PaymentAccountStorageError = storageMod.PaymentAccountStorageError;

  documentStorageRoot = readinessMod.documentStorageRoot;
  documentTempDir = readinessMod.documentTempDir;
  paymentAccountsDir = readinessMod.paymentAccountsDir;
  StorageUnavailableError = readinessMod.StorageUnavailableError;
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

test("isValidUuid checks strict RFC UUID syntax", () => {
  assert.equal(isValidUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidUuid("c8a5b281-7dc8-4f24-9b21-4ec15d862e3b"), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
  assert.equal(isValidUuid("../traversal"), false);
  assert.equal(isValidUuid(""), false);
  assert.equal(isValidUuid("   "), false);
});

test("storage path resolution enforces valid UUIDs and prevents traversal", () => {
  const validAccountId = "c8a5b281-7dc8-4f24-9b21-4ec15d862e3b";
  const validAssetId = "d9b6c392-8ed9-4a35-ac32-5fd26e973f4c";

  const accountDir = resolveAccountDir(validAccountId);
  assert.ok(accountDir.includes(validAccountId));

  const mainPath = resolveAssetFilePath(validAccountId, `${validAssetId}.png`);
  assert.ok(mainPath.endsWith(`${validAssetId}.png`));

  const thumbPath = resolveAssetFilePath(validAccountId, `${validAssetId}_thumb.png`);
  assert.ok(thumbPath.endsWith(`${validAssetId}_thumb.png`));

  assert.throws(
    () => resolveAccountDir("../outside"),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_ACCOUNT_ID",
  );

  assert.throws(
    () => resolveAssetFilePath(validAccountId, "../escaped.png"),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_FILE_NAME",
  );

  assert.throws(
    () => resolveAssetFilePath(validAccountId, "arbitrary-name.exe"),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_FILE_NAME",
  );
});

test("assertNoSymlinksInPath rejects symbolic links and junctions escaping root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symlink-test-"));
  const realStorageDir = path.join(tempRoot, "storage");
  const targetDir = path.join(realStorageDir, "subfolder");
  await fs.mkdir(targetDir, { recursive: true });

  const symlinkDir = path.join(tempRoot, "symlink_dir");
  try {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(targetDir, symlinkDir, symlinkType);

    // Valid path inside realStorageDir
    await assert.doesNotReject(() => assertNoSymlinksInPath(targetDir, realStorageDir));

    // Symlinked / junction path escaping root should be rejected
    await assert.rejects(
      () => assertNoSymlinksInPath(path.join(symlinkDir, "file.png"), realStorageDir),
      (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_STORAGE_PATH",
    );
  } catch (err: any) {
    if (err.code !== "EPERM" && err.code !== "ENOTSUP") {
      throw err;
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("promoteFileExclusively performs atomic hard link and fails closed with EEXIST without copy fallback", async () => {
  const scratchDir = path.join(testStorageRoot, ".scratch-test");
  await fs.mkdir(scratchDir, { recursive: true });

  const sourceFile = path.join(scratchDir, "test-source.tmp");
  const destFile = path.join(scratchDir, "test-promoted.png");
  await fs.writeFile(sourceFile, Buffer.from("test-content"), { flag: "wx" });

  // First promotion: should succeed via hard link
  await promoteFileExclusively(sourceFile, destFile);
  const destStat = await fs.stat(destFile);
  assert.ok(destStat.isFile());
  assert.equal(await fs.readFile(destFile, "utf-8"), "test-content");

  // Second promotion to same destination: MUST throw EEXIST (no-overwrite atomic guarantee)
  const anotherSource = path.join(scratchDir, "test-source-2.tmp");
  await fs.writeFile(anotherSource, Buffer.from("different-content"), { flag: "wx" });

  await assert.rejects(
    () => promoteFileExclusively(anotherSource, destFile),
    (err: any) => err.code === "EEXIST",
  );

  // Content of destFile must remain untouched ("test-content"), not overwritten or truncated
  assert.equal(await fs.readFile(destFile, "utf-8"), "test-content");
});

test("promoteFileExclusively wraps native path-bearing EIO and EXDEV errors into generic safe StorageUnavailableError without path disclosure", async () => {
  const scratchDir = path.join(testStorageRoot, ".scratch-exdev-test");
  await fs.mkdir(scratchDir, { recursive: true });
  const sourceFile = path.join(scratchDir, "src.tmp");
  const destFile = path.join(scratchDir, "dest.png");
  await fs.writeFile(sourceFile, Buffer.from("data"), { flag: "wx" });

  const originalFsLink = fs.link;
  try {
    const sensitivePath = "/secret/path/to/system/mount/file.tmp";
    (fs as any).link = async () => {
      const err: any = new Error(`EXDEV: cross-device link not permitted, link '${sensitivePath}' -> '/secret/dest.png'`);
      err.code = "EXDEV";
      err.path = sensitivePath;
      throw err;
    };

    await assert.rejects(
      () => promoteFileExclusively(sourceFile, destFile),
      (err: any) => {
        assert.ok(err instanceof StorageUnavailableError);
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "STORAGE_UNAVAILABLE");
        assert.equal(err.message, "File storage is temporarily unavailable. Please try again shortly.");
        assert.ok(!err.message.includes(sensitivePath));
        return true;
      },
    );

    (fs as any).link = async () => {
      const err: any = new Error(`EIO: i/o error, link '${sensitivePath}'`);
      err.code = "EIO";
      err.path = sensitivePath;
      throw err;
    };

    await assert.rejects(
      () => promoteFileExclusively(sourceFile, destFile),
      (err: any) => {
        assert.ok(err instanceof StorageUnavailableError);
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "STORAGE_UNAVAILABLE");
        assert.equal(err.message, "File storage is temporarily unavailable. Please try again shortly.");
        assert.ok(!err.message.includes(sensitivePath));
        return true;
      },
    );
  } finally {
    (fs as any).link = originalFsLink;
  }
});

test("processAndPromoteQrAsset validates image inputs and rejects invalid formats/dimensions", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  // 1. Empty buffer
  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: Buffer.alloc(0) }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "EMPTY_FILE",
  );

  // 2. Corrupt / invalid image bytes
  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: Buffer.from("not an image at all") }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_IMAGE_FORMAT",
  );

  // 3. Image with dimensions below minimum (128px)
  const tooSmallBuffer = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: tooSmallBuffer }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_DIMENSIONS",
  );

  // 4. Oversize buffer (> 5 MiB)
  const hugeBuffer = Buffer.alloc(6 * 1024 * 1024);
  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: hugeBuffer }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "FILE_TOO_LARGE",
  );
});

test("processAndPromoteQrAsset processes valid image, generates canonical PNG + thumbnail, and supports replay & conflict detection", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  // Create valid 400x400 PNG with transparency
  const validPng = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 120, g: 180, b: 240, alpha: 0.5 } },
  }).png().toBuffer();

  const prepared = await processAndPromoteQrAsset({
    accountId,
    assetId,
    inputBuffer: validPng,
  });

  assert.equal(prepared.accountId, accountId);
  assert.equal(prepared.assetId, assetId);
  assert.equal(prepared.storedPath, `payment-accounts/${accountId}`);
  assert.equal(prepared.fileName, `${assetId}.png`);
  assert.equal(prepared.thumbnailFileName, `${assetId}_thumb.png`);
  assert.equal(prepared.mimeType, "image/png");
  assert.equal(prepared.width, 400);
  assert.equal(prepared.height, 400);
  assert.ok(prepared.sizeBytes > 0);
  assert.ok(prepared.thumbnailSizeBytes > 0);
  assert.equal(prepared.sourceChecksum, computeSha256(validPng));

  // Verify file locations on disk
  const mainPath = resolveAssetFilePath(accountId, prepared.fileName);
  const thumbPath = resolveAssetFilePath(accountId, prepared.thumbnailFileName);

  const mainDisk = await fs.readFile(mainPath);
  const thumbDisk = await fs.readFile(thumbPath);

  assert.equal(computeSha256(mainDisk), prepared.checksum);
  assert.ok(thumbDisk.length > 0);

  // Idempotent replay: Re-running with same assetId and inputBuffer returns matching metadata
  const replayed = await processAndPromoteQrAsset({
    accountId,
    assetId,
    inputBuffer: validPng,
  });

  assert.equal(replayed.checksum, prepared.checksum);
  assert.equal(replayed.sourceChecksum, prepared.sourceChecksum);

  // Conflict: Re-running with same assetId but different image content throws ASSET_CONFLICT
  const differentPng = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: differentPng }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "ASSET_CONFLICT",
  );
});

test("processAndPromoteQrAsset recovers half-promoted pair if matching or rejects if mismatching", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  const validPng = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).png().toBuffer();

  // 1. First run promotion
  const prepared = await processAndPromoteQrAsset({
    accountId,
    assetId,
    inputBuffer: validPng,
  });

  const thumbPath = resolveAssetFilePath(accountId, prepared.thumbnailFileName);
  // Simulate deleted/missing thumbnail
  await fs.unlink(thumbPath);

  // 2. Re-run: should detect matching main image, promote missing thumbnail, and succeed
  const recovered = await processAndPromoteQrAsset({
    accountId,
    assetId,
    inputBuffer: validPng,
  });

  assert.equal(recovered.checksum, prepared.checksum);
  const reThumbDisk = await fs.readFile(thumbPath);
  assert.ok(reThumbDisk.length > 0);

  // 3. Re-run with conflicting content for half-pair: should reject with ASSET_CONFLICT
  const conflictingPng = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 100, b: 0 } },
  }).png().toBuffer();

  await fs.unlink(thumbPath);
  await assert.rejects(
    () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: conflictingPng }),
    (err: any) => err instanceof PaymentAccountStorageError && err.code === "ASSET_CONFLICT",
  );
});

test("processAndPromoteQrAsset rejects symlink or junction in root/payment/account/temp BEFORE outside writes", async (t) => {
  const escapeBase = path.join(os.tmpdir(), `ks-outside-escape-${crypto.randomUUID()}`);
  await fs.mkdir(escapeBase, { recursive: true });

  const validPng = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 128 } },
  }).png().toBuffer();

  const symlinkType = process.platform === "win32" ? "junction" : "dir";

  try {
    // Subcase 1: accountDir linked to outside directory
    const escapeAccountDir = path.join(escapeBase, "account-target");
    await fs.mkdir(escapeAccountDir, { recursive: true });
    const accountId1 = crypto.randomUUID();
    const assetId1 = crypto.randomUUID();
    const accountDir1 = resolveAccountDir(accountId1);

    try {
      try {
        await fs.symlink(escapeAccountDir, accountDir1, symlinkType);
      } catch (err: any) {
        if (err.code === "EPERM" || err.code === "ENOTSUP") {
          t.skip(`Symlink/junction creation not supported in this environment (${err.code})`);
          return;
        }
        throw err;
      }

      await assert.rejects(
        () => processAndPromoteQrAsset({ accountId: accountId1, assetId: assetId1, inputBuffer: validPng }),
        (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_STORAGE_PATH",
      );

      const outsideFiles1 = await fs.readdir(escapeAccountDir);
      assert.equal(outsideFiles1.length, 0, "No outside files should be created through linked accountDir");
    } finally {
      await fs.unlink(accountDir1).catch(() => undefined);
    }

    // Subcase 2: paymentAccountsDir linked to outside directory
    const escapePaymentAccountsDir = path.join(escapeBase, "payment-accounts-target");
    await fs.mkdir(escapePaymentAccountsDir, { recursive: true });
    const accountId2 = crypto.randomUUID();
    const assetId2 = crypto.randomUUID();
    const paymentAccountsBackup = path.join(testStorageRoot, "payment-accounts-backup");

    try {
      await fs.rename(paymentAccountsDir, paymentAccountsBackup);
      try {
        await fs.symlink(escapePaymentAccountsDir, paymentAccountsDir, symlinkType);
      } catch (err: any) {
        if (err.code === "EPERM" || err.code === "ENOTSUP") {
          t.skip(`Symlink/junction creation not supported in this environment (${err.code})`);
          return;
        }
        throw err;
      }

      await assert.rejects(
        () => processAndPromoteQrAsset({ accountId: accountId2, assetId: assetId2, inputBuffer: validPng }),
        (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_STORAGE_PATH",
      );

      const outsideFiles2 = await fs.readdir(escapePaymentAccountsDir);
      assert.equal(outsideFiles2.length, 0, "No outside files should be created through linked paymentAccountsDir");
    } finally {
      await fs.unlink(paymentAccountsDir).catch(() => undefined);
      await fs.rename(paymentAccountsBackup, paymentAccountsDir).catch(() => undefined);
    }

    // Subcase 3: documentTempDir linked to outside directory
    const escapeTempDir = path.join(escapeBase, "temp-target");
    await fs.mkdir(escapeTempDir, { recursive: true });
    const accountId3 = crypto.randomUUID();
    const assetId3 = crypto.randomUUID();
    const tempBackup = path.join(testStorageRoot, ".temp-backup");

    try {
      await fs.rename(documentTempDir, tempBackup);
      try {
        await fs.symlink(escapeTempDir, documentTempDir, symlinkType);
      } catch (err: any) {
        if (err.code === "EPERM" || err.code === "ENOTSUP") {
          t.skip(`Symlink/junction creation not supported in this environment (${err.code})`);
          return;
        }
        throw err;
      }

      await assert.rejects(
        () => processAndPromoteQrAsset({ accountId: accountId3, assetId: assetId3, inputBuffer: validPng }),
        (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_STORAGE_PATH",
      );

      const outsideFiles3 = await fs.readdir(escapeTempDir);
      assert.equal(outsideFiles3.length, 0, "No outside files should be created through linked documentTempDir");
    } finally {
      await fs.unlink(documentTempDir).catch(() => undefined);
      await fs.rename(tempBackup, documentTempDir).catch(() => undefined);
    }

    // Subcase 4: documentStorageRoot linked to outside directory
    const escapeDocRootTarget = path.join(escapeBase, "doc-root-target");
    await fs.mkdir(escapeDocRootTarget, { recursive: true });
    const accountId4 = crypto.randomUUID();
    const assetId4 = crypto.randomUUID();
    const docRootBackup = `${testStorageRoot}-backup`;

    try {
      await fs.rename(testStorageRoot, docRootBackup);
      try {
        await fs.symlink(escapeDocRootTarget, testStorageRoot, symlinkType);
      } catch (err: any) {
        if (err.code === "EPERM" || err.code === "ENOTSUP") {
          t.skip(`Symlink/junction creation not supported in this environment (${err.code})`);
          return;
        }
        throw err;
      }

      await assert.rejects(
        () => processAndPromoteQrAsset({ accountId: accountId4, assetId: assetId4, inputBuffer: validPng }),
        (err: any) => err instanceof PaymentAccountStorageError && err.code === "INVALID_STORAGE_PATH",
      );

      const outsideFiles4 = await fs.readdir(escapeDocRootTarget);
      assert.equal(outsideFiles4.length, 0, "No outside files should be created through linked documentStorageRoot");
    } finally {
      await fs.unlink(testStorageRoot).catch(() => undefined);
      await fs.rename(docRootBackup, testStorageRoot).catch(() => undefined);
    }
  } finally {
    await fs.rm(escapeBase, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("processAndPromoteQrAsset handles concurrent matching uploads and conflicting uploads safely", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  const validPng = await sharp({
    create: { width: 350, height: 350, channels: 3, background: { r: 10, g: 50, b: 150 } },
  }).png().toBuffer();

  // 1. Concurrent identical uploads: both must resolve successfully with identical checksums
  const [res1, res2] = await Promise.all([
    processAndPromoteQrAsset({ accountId, assetId, inputBuffer: validPng }),
    processAndPromoteQrAsset({ accountId, assetId, inputBuffer: validPng }),
  ]);

  assert.equal(res1.checksum, res2.checksum);
  assert.equal(res1.sourceChecksum, res2.sourceChecksum);

  // 2. Overlapping concurrent conflict: same accountId + same assetId with differing canonical input bytes
  const conflictAccountId = crypto.randomUUID();
  const conflictAssetId = crypto.randomUUID();

  const pngA = await sharp({
    create: { width: 360, height: 360, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  const pngB = await sharp({
    create: { width: 360, height: 360, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).png().toBuffer();

  const originalFsLink = fs.link;
  const originalFsUnlink = fs.unlink;
  const unlinkedPaths: string[] = [];

  try {
    (fs as any).unlink = async (targetPath: string) => {
      unlinkedPaths.push(path.normalize(targetPath));
      return originalFsUnlink(targetPath);
    };

    let linkAttempts = 0;
    let barrierResolver: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      barrierResolver = resolve;
    });

    (fs as any).link = async (src: string, dest: string) => {
      linkAttempts++;
      if (linkAttempts === 1) {
        // First contender waits until second contender also reaches promotion stage
        await barrier;
      } else if (linkAttempts === 2 && barrierResolver) {
        barrierResolver();
      }
      return originalFsLink(src, dest);
    };

    const [settledA, settledB] = await Promise.allSettled([
      processAndPromoteQrAsset({ accountId: conflictAccountId, assetId: conflictAssetId, inputBuffer: pngA }),
      processAndPromoteQrAsset({ accountId: conflictAccountId, assetId: conflictAssetId, inputBuffer: pngB }),
    ]);

    assert.ok(linkAttempts >= 2, "Both collision contenders must reach the link barrier");

    const fulfilled = [settledA, settledB].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = [settledA, settledB].filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    assert.equal(fulfilled.length, 1, "Exactly one contender must win promotion");
    assert.equal(rejected.length, 1, "Exactly one contender must fail with conflict");

    const winner = fulfilled[0].value;
    const conflictErr = rejected[0].reason;

    assert.ok(conflictErr instanceof PaymentAccountStorageError);
    assert.equal(conflictErr.statusCode, 409);
    assert.equal(conflictErr.code, "ASSET_CONFLICT");

    // Both final files on disk must match winner and no final files unlinked
    const mainPath = resolveAssetFilePath(conflictAccountId, `${conflictAssetId}.png`);
    const thumbPath = resolveAssetFilePath(conflictAccountId, `${conflictAssetId}_thumb.png`);

    const mainDisk = await fs.readFile(mainPath);
    const thumbDisk = await fs.readFile(thumbPath);

    assert.equal(computeSha256(mainDisk), winner.checksum);
    assert.equal(thumbDisk.length, winner.thumbnailSizeBytes);

    // Winner thumbnail bytes equal expected canonical processed thumbnail
    const winnerSourceBuffer = winner.sourceChecksum === computeSha256(pngA) ? pngA : pngB;
    const canonicalFullPng = await sharp(winnerSourceBuffer)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const expectedCanonicalThumb = await sharp(canonicalFullPng)
      .resize({
        width: 320,
        height: 320,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    assert.equal(computeSha256(thumbDisk), computeSha256(expectedCanonicalThumb));

    // Zero final unlinks for raced/conflicting promotion branches
    const finalMainNorm = path.normalize(mainPath);
    const finalThumbNorm = path.normalize(thumbPath);
    assert.ok(!unlinkedPaths.includes(finalMainNorm), "Final main QR file must not be unlinked on collision");
    assert.ok(!unlinkedPaths.includes(finalThumbNorm), "Final thumbnail file must not be unlinked on collision");
    const accountDirNorm = path.normalize(resolveAccountDir(conflictAccountId));
    assert.ok(
      unlinkedPaths.every((p) => !p.startsWith(accountDirNorm)),
      "Zero files in account directory must be unlinked during race",
    );
  } finally {
    (fs as any).link = originalFsLink;
    (fs as any).unlink = originalFsUnlink;
  }

  // 3. Different asset ID on same account works independently
  const assetId2 = crypto.randomUUID();
  const validPng2 = await sharp({
    create: { width: 350, height: 350, channels: 3, background: { r: 200, g: 50, b: 10 } },
  }).png().toBuffer();

  const res3 = await processAndPromoteQrAsset({ accountId, assetId: assetId2, inputBuffer: validPng2 });
  assert.equal(res3.assetId, assetId2);
  assert.notEqual(res3.checksum, res1.checksum);
});

test("processAndPromoteQrAsset handles native path-bearing EIO/EXDEV link failures safely without path disclosure and recovers on retry", async () => {
  const accountId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  const validPng = await sharp({
    create: { width: 280, height: 280, channels: 3, background: { r: 70, g: 140, b: 210 } },
  }).png().toBuffer();

  const originalFsLink = fs.link;
  const originalFsUnlink = fs.unlink;
  const unlinkedPaths: string[] = [];
  let linkCalls = 0;
  const sensitivePath = "/private/super/secret/internal/path/file.tmp";

  (fs as any).unlink = async (targetPath: string) => {
    unlinkedPaths.push(path.normalize(targetPath));
    return originalFsUnlink(targetPath);
  };

  // Intercept fs.link to fail on thumbnail promotion (second link call) with native path-bearing error
  (fs as any).link = async (src: string, dest: string) => {
    linkCalls++;
    if (linkCalls === 2) {
      const err: any = new Error(`EIO: disk i/o failure, link '${sensitivePath}' -> '${dest}'`);
      err.code = "EIO";
      err.path = sensitivePath;
      throw err;
    }
    return originalFsLink(src, dest);
  };

  try {
    await assert.rejects(
      () => processAndPromoteQrAsset({ accountId, assetId, inputBuffer: validPng }),
      (err: any) => {
        assert.ok(err instanceof StorageUnavailableError);
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "STORAGE_UNAVAILABLE");
        assert.equal(err.message, "File storage is temporarily unavailable. Please try again shortly.");
        assert.ok(!err.message.includes(sensitivePath));
        return true;
      },
    );

    // 1. The first promoted file (main image) was already promoted and must be RETAINED on disk
    const mainPath = resolveAssetFilePath(accountId, `${assetId}.png`);
    const mainStat = await fs.stat(mainPath);
    assert.ok(mainStat.isFile(), "Main asset file must be retained on disk despite thumbnail link error");

    // Zero final unlinks for failed promotion branch
    const finalMainNorm = path.normalize(mainPath);
    assert.ok(!unlinkedPaths.includes(finalMainNorm), "Promoted main asset must not be unlinked on thumbnail failure");

    // 2. Temp scratch files must be cleaned up
    const tempEntries = await fs.readdir(documentTempDir);
    const tempScratch = tempEntries.filter((f) => f.endsWith(".tmp"));
    assert.equal(tempScratch.length, 0, "All request-owned scratch files must be unlinked in finally");
  } finally {
    (fs as any).link = originalFsLink;
    (fs as any).unlink = originalFsUnlink;
  }

  // 3. Re-running after restoring link recovers the half-pair successfully
  const recovered = await processAndPromoteQrAsset({ accountId, assetId, inputBuffer: validPng });
  assert.equal(recovered.assetId, assetId);

  const thumbPath = resolveAssetFilePath(accountId, `${assetId}_thumb.png`);
  const thumbStat = await fs.stat(thumbPath);
  assert.ok(thumbStat.isFile(), "Thumbnail must now be promoted successfully");
});
