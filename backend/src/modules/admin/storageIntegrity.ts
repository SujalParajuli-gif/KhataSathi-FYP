import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../../db/prisma";
import { uploadsRoot } from "../../lib/uploads";
import { getDocumentStorageRootPath } from "../documents/service";

export type StorageArea = "UPLOADS" | "DOCUMENTS";
export type StorageOwnerType =
  | "PRODUCT_IMAGE"
  | "PRODUCT_THUMBNAIL"
  | "PROFILE_IMAGE"
  | "DOCUMENT_ORIGINAL"
  | "DOCUMENT_THUMBNAIL"
  | "PRODUCT_IMPORT_SOURCE";

export type StorageReference = {
  storage: StorageArea;
  ownerType: StorageOwnerType;
  ownerId: string;
  ownerLabel: string;
  relativePath: string;
  ownerInactive?: boolean;
  ownerDeleted?: boolean;
};

export type StorageIntegrityIssue = {
  storage: StorageArea;
  relativePath: string;
  ownerType?: StorageOwnerType;
  ownerId?: string;
  ownerLabel?: string;
  ownerInactive?: boolean;
  ownerDeleted?: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
};

export type StorageIntegrityReport = {
  generatedAt: string;
  readOnly: true;
  status: "HEALTHY" | "ATTENTION" | "UNAVAILABLE";
  summary: {
    databaseReferences: number;
    filesOnDisk: number;
    bytesOnDisk: number;
    missingReferences: number;
    unreferencedFiles: number;
    unreferencedBytes: number;
    staleTempFiles: number;
    staleTempBytes: number;
  };
  roots: Array<{
    storage: StorageArea;
    accessible: boolean;
    filesOnDisk: number;
    bytesOnDisk: number;
    error: string | null;
  }>;
  issues: {
    missingReferences: StorageIntegrityIssue[];
    unreferencedFiles: StorageIntegrityIssue[];
    staleTempFiles: StorageIntegrityIssue[];
  };
  limits: {
    maxItemsPerSection: number;
    staleTempHours: number;
    missingReferencesTruncated: boolean;
    unreferencedFilesTruncated: boolean;
    staleTempFilesTruncated: boolean;
  };
};

type DiskFile = {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: Date;
};

type ScanRootResult = {
  accessible: boolean;
  files: DiskFile[];
  error: string | null;
};

const MAX_ITEMS_PER_SECTION = 100;
const STALE_TEMP_HOURS = 24;

function normalizeRelativePath(value: string) {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

  if (
    !normalized ||
    normalized === "." ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return null;
  }

  return normalized;
}

export function managedUploadRelativePath(publicUrl?: string | null) {
  if (!publicUrl || typeof publicUrl !== "string") return null;
  const pathOnly = publicUrl.split(/[?#]/, 1)[0];
  if (!pathOnly.startsWith("/uploads/")) return null;
  return normalizeRelativePath(pathOnly.slice("/uploads/".length));
}

export function documentRelativePath(
  storedPath?: string | null,
  storedFileName?: string | null,
) {
  if (!storedFileName) return null;
  return normalizeRelativePath(
    [storedPath || "", storedFileName].filter(Boolean).join("/"),
  );
}

async function scanRoot(root: string): Promise<ScanRootResult> {
  const files: DiskFile[] = [];

  async function walk(absoluteDirectory: string, relativeDirectory: string) {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      if (!relativePath) continue;

      const absolutePath = path.resolve(root, ...relativePath.split("/"));
      if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
        continue;
      }

      // Never follow links during an integrity scan. A link may point outside
      // the configured storage volume and is not an application-managed file.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stats = await fs.stat(absolutePath);
      files.push({ relativePath, sizeBytes: stats.size, modifiedAt: stats.mtime });
    }
  }

  try {
    await fs.access(root);
    await walk(root, "");
    return { accessible: true, files, error: null };
  } catch (error: any) {
    return {
      accessible: false,
      files: [],
      error: error?.code === "ENOENT" ? "Storage directory does not exist." : "Storage directory could not be read.",
    };
  }
}

export async function scanStorageIntegrity(input: {
  uploadsRoot: string;
  documentStorageRoot: string;
  references: StorageReference[];
  now?: Date;
  maxItemsPerSection?: number;
  staleTempHours?: number;
}): Promise<StorageIntegrityReport> {
  const now = input.now || new Date();
  const maxItems = input.maxItemsPerSection || MAX_ITEMS_PER_SECTION;
  const staleTempHours = input.staleTempHours || STALE_TEMP_HOURS;
  const staleBefore = now.getTime() - staleTempHours * 60 * 60 * 1000;
  const rootInputs: Array<{ storage: StorageArea; root: string }> = [
    { storage: "UPLOADS", root: path.resolve(input.uploadsRoot) },
    { storage: "DOCUMENTS", root: path.resolve(input.documentStorageRoot) },
  ];
  const scans = await Promise.all(
    rootInputs.map(async ({ storage, root }) => ({
      storage,
      ...(await scanRoot(root)),
    })),
  );

  const missingReferences: StorageIntegrityIssue[] = [];
  const unreferencedFiles: StorageIntegrityIssue[] = [];
  const staleTempFiles: StorageIntegrityIssue[] = [];

  for (const scan of scans) {
    if (!scan.accessible) continue;
    const diskPaths = new Set(scan.files.map((file) => file.relativePath));
    const references = input.references.filter(
      (reference) => reference.storage === scan.storage,
    );
    const referencedPaths = new Set(references.map((reference) => reference.relativePath));

    for (const reference of references) {
      if (diskPaths.has(reference.relativePath)) continue;
      missingReferences.push({
        storage: reference.storage,
        relativePath: reference.relativePath,
        ownerType: reference.ownerType,
        ownerId: reference.ownerId,
        ownerLabel: reference.ownerLabel,
        ownerInactive: reference.ownerInactive,
        ownerDeleted: reference.ownerDeleted,
      });
    }

    for (const file of scan.files) {
      const isDocumentTemp =
        scan.storage === "DOCUMENTS" &&
        (file.relativePath === ".temp" || file.relativePath.startsWith(".temp/"));
      if (isDocumentTemp) {
        if (file.modifiedAt.getTime() < staleBefore) {
          staleTempFiles.push({
            storage: scan.storage,
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            modifiedAt: file.modifiedAt.toISOString(),
          });
        }
        continue;
      }

      if (!referencedPaths.has(file.relativePath)) {
        unreferencedFiles.push({
          storage: scan.storage,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt.toISOString(),
        });
      }
    }
  }

  const filesOnDisk = scans.reduce((total, scan) => total + scan.files.length, 0);
  const bytesOnDisk = scans.reduce(
    (total, scan) => total + scan.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    0,
  );
  const unreferencedBytes = unreferencedFiles.reduce(
    (total, issue) => total + (issue.sizeBytes || 0),
    0,
  );
  const staleTempBytes = staleTempFiles.reduce(
    (total, issue) => total + (issue.sizeBytes || 0),
    0,
  );
  const unavailable = scans.some((scan) => !scan.accessible);
  const attention =
    missingReferences.length > 0 ||
    unreferencedFiles.length > 0 ||
    staleTempFiles.length > 0;

  return {
    generatedAt: now.toISOString(),
    readOnly: true,
    status: unavailable ? "UNAVAILABLE" : attention ? "ATTENTION" : "HEALTHY",
    summary: {
      databaseReferences: input.references.length,
      filesOnDisk,
      bytesOnDisk,
      missingReferences: missingReferences.length,
      unreferencedFiles: unreferencedFiles.length,
      unreferencedBytes,
      staleTempFiles: staleTempFiles.length,
      staleTempBytes,
    },
    roots: scans.map((scan) => ({
      storage: scan.storage,
      accessible: scan.accessible,
      filesOnDisk: scan.files.length,
      bytesOnDisk: scan.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      error: scan.error,
    })),
    issues: {
      missingReferences: missingReferences.slice(0, maxItems),
      unreferencedFiles: unreferencedFiles.slice(0, maxItems),
      staleTempFiles: staleTempFiles.slice(0, maxItems),
    },
    limits: {
      maxItemsPerSection: maxItems,
      staleTempHours,
      missingReferencesTruncated: missingReferences.length > maxItems,
      unreferencedFilesTruncated: unreferencedFiles.length > maxItems,
      staleTempFilesTruncated: staleTempFiles.length > maxItems,
    },
  };
}

export async function buildStorageIntegrityReport() {
  const [products, users, documents, importBatches] = await Promise.all([
    prisma.product.findMany({
      select: { id: true, name: true, sku: true, isActive: true, imageUrl: true, thumbnailUrl: true },
    }),
    prisma.user.findMany({
      select: { id: true, name: true, email: true, isActive: true, profileImage: true },
    }),
    prisma.document.findMany({
      select: {
        id: true,
        title: true,
        fileName: true,
        storedPath: true,
        storedFileName: true,
        thumbnailFileName: true,
        deletedAt: true,
      },
    }),
    prisma.productImportBatch.findMany({
      select: {
        id: true,
        fileName: true,
        sourceType: true,
        sourceStoredPath: true,
        sourceStoredFileName: true,
        deletedAt: true,
      },
    }),
  ]);

  const references: StorageReference[] = [];
  for (const product of products) {
    const ownerLabel = `${product.name} (${product.sku})`;
    const imagePath = managedUploadRelativePath(product.imageUrl);
    if (imagePath) {
      references.push({
        storage: "UPLOADS",
        ownerType: "PRODUCT_IMAGE",
        ownerId: product.id,
        ownerLabel,
        ownerInactive: !product.isActive,
        relativePath: imagePath,
      });
    }
    const thumbnailPath = managedUploadRelativePath(product.thumbnailUrl);
    if (thumbnailPath) {
      references.push({
        storage: "UPLOADS",
        ownerType: "PRODUCT_THUMBNAIL",
        ownerId: product.id,
        ownerLabel,
        ownerInactive: !product.isActive,
        relativePath: thumbnailPath,
      });
    }
  }

  for (const user of users) {
    const profilePath = managedUploadRelativePath(user.profileImage);
    if (!profilePath) continue;
    references.push({
      storage: "UPLOADS",
      ownerType: "PROFILE_IMAGE",
      ownerId: user.id,
      ownerLabel: user.name || user.email || "User",
      ownerInactive: !user.isActive,
      relativePath: profilePath,
    });
  }

  for (const document of documents) {
    const ownerLabel = document.title?.trim() || document.fileName;
    const originalPath = documentRelativePath(document.storedPath, document.storedFileName);
    if (originalPath) {
      references.push({
        storage: "DOCUMENTS",
        ownerType: "DOCUMENT_ORIGINAL",
        ownerId: document.id,
        ownerLabel,
        ownerDeleted: Boolean(document.deletedAt),
        relativePath: originalPath,
      });
    }
    const thumbnailPath = documentRelativePath(document.storedPath, document.thumbnailFileName);
    if (thumbnailPath) {
      references.push({
        storage: "DOCUMENTS",
        ownerType: "DOCUMENT_THUMBNAIL",
        ownerId: document.id,
        ownerLabel,
        ownerDeleted: Boolean(document.deletedAt),
        relativePath: thumbnailPath,
      });
    }
  }

  for (const batch of importBatches) {
    const sourcePath = documentRelativePath(
      batch.sourceStoredPath,
      batch.sourceStoredFileName,
    );
    if (!sourcePath) continue;
    references.push({
      storage: "DOCUMENTS",
      ownerType: "PRODUCT_IMPORT_SOURCE",
      ownerId: batch.id,
      ownerLabel: batch.fileName || `${batch.sourceType} import review`,
      ownerDeleted: Boolean(batch.deletedAt),
      relativePath: sourcePath,
    });
  }

  return scanStorageIntegrity({
    uploadsRoot,
    documentStorageRoot: getDocumentStorageRootPath(),
    references,
  });
}
