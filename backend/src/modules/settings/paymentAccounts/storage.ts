import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  paymentAccountsDir,
  documentTempDir,
  documentStorageRoot,
  assertDocumentStorageAccessible,
  asStorageUnavailableError,
  StorageUnavailableError,
} from "../../../lib/storageReadiness";

export { StorageUnavailableError };

export const MAX_IMAGE_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_PROCESSED_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_THUMBNAIL_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MIN_IMAGE_DIMENSION = 128;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_DECODED_PIXELS = 16_000_000;
export const THUMBNAIL_EDGE = 320;

const ALLOWED_IMAGE_FORMATS = new Set(["jpeg", "jpg", "png", "webp"]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_FILENAME_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(_thumb)?\.png$/i;

export class PaymentAccountStorageError extends Error {
  statusCode: number;
  code: string;
  isOperational: boolean;

  constructor(message: string, statusCode = 400, code = "INVALID_IMAGE") {
    super(message);
    this.name = "PaymentAccountStorageError";
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export interface PreparedQrAssetFiles {
  assetId: string;
  accountId: string;
  storedPath: string;
  fileName: string;
  thumbnailFileName: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailSizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  sourceChecksum: string;
}

export function isValidUuid(id: string): boolean {
  return typeof id === "string" && UUID_REGEX.test(id.trim());
}

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function assertNoSymlinksInPath(targetPath: string, rootDir: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new PaymentAccountStorageError("Storage path outside root directory", 400, "INVALID_STORAGE_PATH");
  }

  // Walk up from target to root, checking lstat for symlinks on any existing component
  let current = resolvedTarget;
  while (current.length >= resolvedRoot.length) {
    try {
      const lstat = await fs.lstat(current);
      if (lstat.isSymbolicLink()) {
        throw new PaymentAccountStorageError("Symbolic links not permitted in storage path", 400, "INVALID_STORAGE_PATH");
      }
    } catch (err: any) {
      if (err instanceof PaymentAccountStorageError) throw err;
      if (err.code !== "ENOENT") {
        throw new StorageUnavailableError();
      }
    }
    if (current === resolvedRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // If the target path exists, also verify realpath stays within root
  try {
    const realTarget = await fs.realpath(resolvedTarget);
    const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new PaymentAccountStorageError("Resolved storage path escapes root", 400, "INVALID_STORAGE_PATH");
    }
  } catch (err: any) {
    if (err instanceof PaymentAccountStorageError) throw err;
    if (err.code !== "ENOENT") {
      throw new StorageUnavailableError();
    }
  }
}

export function resolveAccountDir(accountId: string): string {
  const trimmed = String(accountId || "").trim();
  if (!isValidUuid(trimmed)) {
    throw new PaymentAccountStorageError("Invalid account ID format", 400, "INVALID_ACCOUNT_ID");
  }
  const accountDir = path.resolve(paymentAccountsDir, trimmed);
  if (!accountDir.startsWith(paymentAccountsDir + path.sep)) {
    throw new PaymentAccountStorageError("Storage traversal detected", 400, "INVALID_STORAGE_PATH");
  }
  return accountDir;
}

export function resolveAssetFilePath(accountId: string, fileName: string): string {
  const accountDir = resolveAccountDir(accountId);
  const normalizedFileName = path.basename(String(fileName || "").trim());
  if (!normalizedFileName || normalizedFileName !== fileName || !ASSET_FILENAME_REGEX.test(normalizedFileName)) {
    throw new PaymentAccountStorageError("Invalid asset file name", 400, "INVALID_FILE_NAME");
  }
  const fullPath = path.resolve(accountDir, normalizedFileName);
  if (!fullPath.startsWith(accountDir + path.sep)) {
    throw new PaymentAccountStorageError("Storage traversal detected", 400, "INVALID_STORAGE_PATH");
  }
  return fullPath;
}

export async function promoteFileExclusively(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  // Same-filesystem atomic exclusive hard link promotion.
  // Fails with EEXIST if destination already exists.
  // Never fallback to fs.copyFile to prevent truncation, non-atomic partial file writes, or shared destination corruption.
  try {
    await fs.link(sourcePath, destinationPath);
  } catch (err: any) {
    if (err.code === "EEXIST") {
      throw err;
    }
    throw new StorageUnavailableError();
  }
}

export async function processAndPromoteQrAsset(params: {
  accountId: string;
  assetId: string;
  inputBuffer: Buffer;
  originalMimeType?: string;
}): Promise<PreparedQrAssetFiles> {
  const { accountId, assetId, inputBuffer } = params;

  if (!isValidUuid(accountId)) {
    throw new PaymentAccountStorageError("Invalid account ID format", 400, "INVALID_ACCOUNT_ID");
  }
  if (!isValidUuid(assetId)) {
    throw new PaymentAccountStorageError("Invalid asset ID format", 400, "INVALID_ASSET_ID");
  }

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new PaymentAccountStorageError("Uploaded file is empty", 400, "EMPTY_FILE");
  }

  if (inputBuffer.length > MAX_IMAGE_INPUT_BYTES) {
    throw new PaymentAccountStorageError(
      `Image size exceeds maximum limit of 5 MiB (${inputBuffer.length} bytes)`,
      400,
      "FILE_TOO_LARGE",
    );
  }

  const accountDir = resolveAccountDir(accountId);
  const fileName = `${assetId}.png`;
  const thumbnailFileName = `${assetId}_thumb.png`;
  const storedPath = `payment-accounts/${accountId}`;
  const finalMainPath = resolveAssetFilePath(accountId, fileName);
  const finalThumbPath = resolveAssetFilePath(accountId, thumbnailFileName);

  // Validate approved root and all owned namespace/temp components BEFORE any mkdir/readiness/write
  await assertNoSymlinksInPath(documentStorageRoot, documentStorageRoot);
  await assertNoSymlinksInPath(paymentAccountsDir, documentStorageRoot);
  await assertNoSymlinksInPath(accountDir, paymentAccountsDir);
  await assertNoSymlinksInPath(documentTempDir, documentStorageRoot);
  await assertNoSymlinksInPath(finalMainPath, accountDir);
  await assertNoSymlinksInPath(finalThumbPath, accountDir);

  const sourceChecksum = computeSha256(inputBuffer);

  let metadata: sharp.Metadata;
  try {
    const probe = sharp(inputBuffer, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_PIXELS,
    });
    metadata = await probe.metadata();
  } catch (err: any) {
    throw new PaymentAccountStorageError(
      "Unable to decode image. Only valid JPEG, PNG, and WebP images are accepted.",
      400,
      "INVALID_IMAGE_FORMAT",
    );
  }

  const format = String(metadata.format || "").toLowerCase();
  if (!ALLOWED_IMAGE_FORMATS.has(format)) {
    throw new PaymentAccountStorageError(
      `Unsupported image format: ${format || "unknown"}. Only JPEG, PNG, and WebP are allowed.`,
      400,
      "UNSUPPORTED_FORMAT",
    );
  }

  if (metadata.pages && metadata.pages > 1) {
    throw new PaymentAccountStorageError(
      "Multipage or animated images are not allowed.",
      400,
      "MULTIPAGE_NOT_ALLOWED",
    );
  }

  const origWidth = metadata.width || 0;
  const origHeight = metadata.height || 0;

  if (
    origWidth < MIN_IMAGE_DIMENSION ||
    origHeight < MIN_IMAGE_DIMENSION ||
    origWidth > MAX_IMAGE_DIMENSION ||
    origHeight > MAX_IMAGE_DIMENSION
  ) {
    throw new PaymentAccountStorageError(
      `Image dimensions (${origWidth}x${origHeight}) are outside allowed bounds [${MIN_IMAGE_DIMENSION}..${MAX_IMAGE_DIMENSION}px]`,
      400,
      "INVALID_DIMENSIONS",
    );
  }

  if (origWidth * origHeight > MAX_DECODED_PIXELS) {
    throw new PaymentAccountStorageError(
      `Image decoded pixels exceed maximum allowed limit of ${MAX_DECODED_PIXELS} pixels`,
      400,
      "PIXEL_LIMIT_EXCEEDED",
    );
  }

  // 1. Process full-size lossless PNG on white background
  let fullPngBuffer: Buffer;
  let finalWidth = origWidth;
  let finalHeight = origHeight;

  try {
    const processed = await sharp(inputBuffer, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_PIXELS,
    })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });

    fullPngBuffer = processed.data;
    finalWidth = processed.info.width;
    finalHeight = processed.info.height;
  } catch (err: any) {
    throw new PaymentAccountStorageError(
      "Failed to process image to canonical PNG format",
      400,
      "IMAGE_PROCESSING_FAILED",
    );
  }

  if (fullPngBuffer.length > MAX_PROCESSED_IMAGE_BYTES) {
    throw new PaymentAccountStorageError(
      "Processed PNG image exceeds maximum size limit of 20 MiB",
      400,
      "PROCESSED_IMAGE_TOO_LARGE",
    );
  }

  const checksum = computeSha256(fullPngBuffer);

  // 2. Process bounded 320px fit-inside thumbnail PNG
  let thumbPngBuffer: Buffer;
  try {
    thumbPngBuffer = await sharp(fullPngBuffer, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_PIXELS,
    })
      .resize({
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (err: any) {
    throw new PaymentAccountStorageError(
      "Failed to generate QR thumbnail",
      400,
      "THUMBNAIL_PROCESSING_FAILED",
    );
  }

  if (thumbPngBuffer.length > MAX_THUMBNAIL_BYTES) {
    throw new PaymentAccountStorageError(
      "Processed thumbnail exceeds maximum size limit of 1 MiB",
      400,
      "THUMBNAIL_TOO_LARGE",
    );
  }

  const thumbChecksum = computeSha256(thumbPngBuffer);

  await fs.mkdir(accountDir, { recursive: true });
  await fs.mkdir(documentTempDir, { recursive: true });

  // Revalidate containment after mkdir
  await assertNoSymlinksInPath(accountDir, paymentAccountsDir);
  await assertNoSymlinksInPath(documentTempDir, documentStorageRoot);
  await assertNoSymlinksInPath(finalMainPath, accountDir);
  await assertNoSymlinksInPath(finalThumbPath, accountDir);

  // Check existing files on disk for replay or half-pair condition
  let mainExists = false;
  let thumbExists = false;

  try {
    const mainStat = await fs.stat(finalMainPath);
    mainExists = mainStat.isFile();
  } catch (err: any) {
    if (err.code !== "ENOENT") throw new StorageUnavailableError();
  }

  try {
    const thumbStat = await fs.stat(finalThumbPath);
    thumbExists = thumbStat.isFile();
  } catch (err: any) {
    if (err.code !== "ENOENT") throw new StorageUnavailableError();
  }

  if (mainExists) {
    const existingMain = await fs.readFile(finalMainPath);
    if (computeSha256(existingMain) !== checksum) {
      throw new PaymentAccountStorageError(
        "Conflicting QR asset already exists with different contents",
        409,
        "ASSET_CONFLICT",
      );
    }
  }

  if (thumbExists) {
    const existingThumb = await fs.readFile(finalThumbPath);
    if (computeSha256(existingThumb) !== thumbChecksum) {
      throw new PaymentAccountStorageError(
        "Conflicting QR asset thumbnail already exists with different contents",
        409,
        "ASSET_CONFLICT",
      );
    }
  }

  if (mainExists && thumbExists) {
    // Both files already exist and match expected checksums
    return {
      assetId,
      accountId,
      storedPath,
      fileName,
      thumbnailFileName,
      mimeType: "image/png",
      sizeBytes: fullPngBuffer.length,
      thumbnailSizeBytes: thumbPngBuffer.length,
      width: finalWidth,
      height: finalHeight,
      checksum,
      sourceChecksum,
    };
  }

  // Create request-owned scratch files in temp dir
  const scratchId = crypto.randomUUID();
  const scratchMain = path.join(documentTempDir, `${scratchId}.tmp`);
  const scratchThumb = path.join(documentTempDir, `${scratchId}_thumb.tmp`);
  let scratchMainCreated = false;
  let scratchThumbCreated = false;

  await assertNoSymlinksInPath(scratchMain, documentTempDir);
  await assertNoSymlinksInPath(scratchThumb, documentTempDir);

  try {
    await fs.writeFile(scratchMain, fullPngBuffer, { flag: "wx", mode: 0o644 });
    scratchMainCreated = true;
    await fs.writeFile(scratchThumb, thumbPngBuffer, { flag: "wx", mode: 0o644 });
    scratchThumbCreated = true;

    // Atomic exclusive promotion without overwrite
    if (!mainExists) {
      try {
        await promoteFileExclusively(scratchMain, finalMainPath);
      } catch (err: any) {
        if (err.code === "EEXIST") {
          const existingMain = await fs.readFile(finalMainPath);
          if (computeSha256(existingMain) !== checksum) {
            throw new PaymentAccountStorageError(
              "Conflicting QR asset already exists with different contents",
              409,
              "ASSET_CONFLICT",
            );
          }
        } else {
          throw err instanceof StorageUnavailableError ? err : new StorageUnavailableError();
        }
      }
    }

    if (!thumbExists) {
      try {
        await promoteFileExclusively(scratchThumb, finalThumbPath);
      } catch (err: any) {
        if (err.code === "EEXIST") {
          const existingThumb = await fs.readFile(finalThumbPath);
          if (computeSha256(existingThumb) !== thumbChecksum) {
            throw new PaymentAccountStorageError(
              "Conflicting QR asset thumbnail already exists with different contents",
              409,
              "ASSET_CONFLICT",
            );
          }
        } else {
          throw err instanceof StorageUnavailableError ? err : new StorageUnavailableError();
        }
      }
    }
  } catch (err: any) {
    if (err instanceof PaymentAccountStorageError) throw err;
    if (err instanceof StorageUnavailableError) throw err;
    throw new StorageUnavailableError();
  } finally {
    // Cleanup ONLY request-owned scratch files if created by this request and still within validated temp namespace
    if (scratchMainCreated) {
      try {
        await assertNoSymlinksInPath(scratchMain, documentTempDir);
        await fs.unlink(scratchMain);
      } catch {
        // ignore cleanup errors
      }
    }
    if (scratchThumbCreated) {
      try {
        await assertNoSymlinksInPath(scratchThumb, documentTempDir);
        await fs.unlink(scratchThumb);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // Double check that both final files exist and match before returning
  const verifiedMain = await fs.readFile(finalMainPath);
  const verifiedThumb = await fs.readFile(finalThumbPath);

  if (computeSha256(verifiedMain) !== checksum || computeSha256(verifiedThumb) !== thumbChecksum) {
    throw new PaymentAccountStorageError(
      "Promoted QR asset verification failed",
      500,
      "STORAGE_VERIFICATION_FAILED",
    );
  }

  return {
    assetId,
    accountId,
    storedPath,
    fileName,
    thumbnailFileName,
    mimeType: "image/png",
    sizeBytes: fullPngBuffer.length,
    thumbnailSizeBytes: thumbPngBuffer.length,
    width: finalWidth,
    height: finalHeight,
    checksum,
    sourceChecksum,
  };
}

