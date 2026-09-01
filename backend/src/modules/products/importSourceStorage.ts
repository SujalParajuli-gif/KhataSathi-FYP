import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeDocumentRelativePath,
  resolveDocumentStoragePath,
} from "../documents/storagePath";

const configuredStorageRoot = process.env.DOCUMENT_STORAGE_ROOT?.trim();
const STORAGE_ROOT = configuredStorageRoot
  ? path.resolve(configuredStorageRoot)
  : path.resolve(__dirname, "../../../document-storage");

function safeExtension(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

function importMimeType(fileName: string, provided?: string) {
  const normalized = provided?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  const extension = safeExtension(fileName);
  const byExtension: Record<string, string> = {
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return byExtension[extension] || "application/octet-stream";
}

function relativeImportFolder(date = new Date()) {
  return path.posix.join(
    "import-sources",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
  );
}

export type StoredImportSource = {
  sourceStoredFileName: string;
  sourceStoredPath: string;
  sourceMimeType: string;
  sourceChecksum: string;
};

export async function storeImportSource(input: {
  batchId: string;
  originalName: string;
  mimeType?: string;
  buffer: Buffer;
}): Promise<StoredImportSource> {
  const sourceStoredPath = relativeImportFolder();
  const portablePath = normalizeDocumentRelativePath(sourceStoredPath);
  if (!portablePath) throw new Error("Invalid import source storage path.");

  const sourceStoredFileName = `${input.batchId}_${crypto.randomBytes(8).toString("hex")}${safeExtension(input.originalName)}`;
  const absolutePath = resolveDocumentStoragePath(
    STORAGE_ROOT,
    portablePath,
    sourceStoredFileName,
  );
  if (!absolutePath) throw new Error("Invalid import source filename.");

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.buffer, { flag: "wx" });

  return {
    sourceStoredFileName,
    sourceStoredPath: portablePath,
    sourceMimeType: importMimeType(input.originalName, input.mimeType),
    sourceChecksum: crypto.createHash("sha256").update(input.buffer).digest("hex"),
  };
}

export function getImportSourcePath(source: {
  sourceStoredPath: string | null;
  sourceStoredFileName: string | null;
}) {
  if (!source.sourceStoredPath || !source.sourceStoredFileName) return null;
  return resolveDocumentStoragePath(
    STORAGE_ROOT,
    source.sourceStoredPath,
    source.sourceStoredFileName,
  );
}

export async function removeImportSource(source: {
  sourceStoredPath: string | null;
  sourceStoredFileName: string | null;
}) {
  const absolutePath = getImportSourcePath(source);
  if (!absolutePath) return;
  await fs.unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
