import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { uploadsRoot, productUploadsDir } from "./uploads";

const configuredDocumentRoot = process.env.DOCUMENT_STORAGE_ROOT?.trim();
export const documentStorageRoot = configuredDocumentRoot
  ? path.resolve(configuredDocumentRoot)
  : path.resolve(__dirname, "../../../document-storage");

export const documentTempDir = path.join(documentStorageRoot, ".temp");
export const documentFilesDir = path.join(documentStorageRoot, "documents");
export const importSourcesDir = path.join(documentStorageRoot, "import-sources");

export class StorageUnavailableError extends Error {
  statusCode = 503;
  code = "STORAGE_UNAVAILABLE";

  constructor(message = "File storage is temporarily unavailable. Please try again shortly.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

function requiredStorageDirectories() {
  return [uploadsRoot, productUploadsDir, documentStorageRoot, documentTempDir, documentFilesDir, importSourcesDir];
}

function isStorageSystemError(error: unknown) {
  const code = String((error as NodeJS.ErrnoException)?.code || "");
  return ["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "ENOENT"].includes(code);
}

export function asStorageUnavailableError(error: unknown) {
  if (error instanceof StorageUnavailableError) return error;
  if (isStorageSystemError(error)) return new StorageUnavailableError();
  return error instanceof Error ? error : new Error("File storage operation failed.");
}

function probeDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  const probe = path.join(directory, `.khatasathi-write-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
  } finally {
    try { fs.unlinkSync(probe); } catch { /* original write error is more useful */ }
  }
}

/** Run once before the HTTP listener starts. A container must not report healthy
 * when its persistent volumes cannot accept uploads. */
export function ensureApplicationStorageReady() {
  try {
    for (const directory of requiredStorageDirectories()) probeDirectory(directory);
  } catch (error) {
    throw asStorageUnavailableError(error);
  }
}

/** Cheap readiness check used by health checks and before expensive extraction. */
export function assertApplicationStorageAccessible() {
  try {
    for (const directory of requiredStorageDirectories()) {
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (error) {
    throw asStorageUnavailableError(error);
  }
}

export function assertDocumentStorageAccessible() {
  try {
    for (const directory of [documentStorageRoot, documentTempDir, documentFilesDir, importSourcesDir]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (error) {
    throw asStorageUnavailableError(error);
  }
}
