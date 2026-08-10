import fs from "fs/promises";
import { constants, existsSync, mkdirSync, createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import type { CreateDocumentInput, ListDocumentsInput, UpdateDocumentMetadataInput } from "./validation";
import type { DocumentType, DocumentVisibility, Prisma } from "@prisma/client";

type DocumentProcessingStatus = "PROCESSED" | "UNPROCESSED";
type ViewerRole = "ADMIN" | "MANAGER" | "CASHIER";
type DocumentWithUploader = Prisma.DocumentGetPayload<{
  include: { uploadedBy: { select: { id: true; name: true } } };
}>;

function getDocumentProcessingStatus(doc: {
  linkedEntityType: string | null;
  linkedEntityId: string | null;
}): DocumentProcessingStatus {
  return doc.linkedEntityType && doc.linkedEntityId ? "PROCESSED" : "UNPROCESSED";
}

function getDocumentProcessingLabel(doc: {
  documentType: DocumentType;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
}) {
  if (getDocumentProcessingStatus(doc) === "UNPROCESSED") {
    if (doc.documentType === "STOCK_BILL") return "Unprocessed stock bill";
    if (doc.documentType === "PRODUCT_IMPORT") return "Import not linked";
    return "Not linked";
  }

  if (doc.linkedEntityType === "StockReceiveBatch") return "Linked to stock receive";
  if (doc.linkedEntityType === "StockTransaction") return "Linked to stock adjustment";
  if (doc.linkedEntityType === "ProductImportBatch") return "Linked to import review";
  return `Linked to ${doc.linkedEntityType}`;
}

function normalizeViewerRole(role?: string | null): ViewerRole {
  if (role === "MANAGER" || role === "CASHIER") return role;
  return "ADMIN";
}

function visibilityWhereForRole(role?: string | null) {
  const normalized = normalizeViewerRole(role);
  if (normalized === "ADMIN") return {};
  if (normalized === "MANAGER") {
    return { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } };
  }
  return { visibility: "ALL_AUTHENTICATED" };
}

function canRoleViewDocument(
  visibility: DocumentVisibility,
  role?: string | null,
) {
  const normalized = normalizeViewerRole(role);
  if (normalized === "ADMIN") return true;
  if (normalized === "MANAGER") {
    return visibility === "ALL_AUTHENTICATED" || visibility === "ADMIN_MANAGER";
  }
  return visibility === "ALL_AUTHENTICATED";
}

function defaultDocumentTitle(fileName: string) {
  const extension = path.extname(fileName);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  return baseName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled document";
}

function documentLabel(doc: { title?: string | null; fileName: string }) {
  return doc.title?.trim() || defaultDocumentTitle(doc.fileName);
}

// resolving the document storage root from env, defaulting to backend/document-storage/
const configuredRoot = process.env.DOCUMENT_STORAGE_ROOT?.trim();
const STORAGE_ROOT = configuredRoot
  ? path.resolve(configuredRoot)
  : path.resolve(__dirname, "../../../document-storage");

// ensuring the storage root exists on startup
try {
  mkdirSync(STORAGE_ROOT, { recursive: true });
} catch {
  // will fail later on actual operations with a meaningful error
}

// computing ISO week number for the folder structure
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// building the relative folder path: documents/YYYY/MM/WXX
function buildRelativeFolderPath(date: Date = new Date()): string {
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const week = `W${String(getISOWeekNumber(date)).padStart(2, "0")}`;
  return path.join("documents", year, month, week);
}

// building a safe stored filename: {cuid}_{document-type}.{ext}
function buildStoredFileName(
  id: string,
  documentType: string,
  originalName: string,
): string {
  const ext = path.extname(originalName).toLowerCase() || ".bin";
  const typeSlug = documentType.toLowerCase().replace(/_/g, "-");
  return `${id}_${typeSlug}${ext}`;
}

// computing SHA-256 checksum of a file
async function computeChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// validating that the storage root is accessible and writable
function assertStorageReady() {
  if (!existsSync(STORAGE_ROOT)) {
    throw new Error(
      `Document storage root does not exist: ${STORAGE_ROOT}. ` +
      `Set DOCUMENT_STORAGE_ROOT in .env to a valid writable path.`,
    );
  }
}

export async function getDocumentStorageHealth() {
  if (!existsSync(STORAGE_ROOT)) {
    return {
      storageRoot: STORAGE_ROOT,
      isAccessible: false,
      isWritable: false,
      error: `Document storage root does not exist: ${STORAGE_ROOT}`,
    };
  }

  try {
    await fs.access(STORAGE_ROOT, constants.R_OK | constants.W_OK);
    return {
      storageRoot: STORAGE_ROOT,
      isAccessible: true,
      isWritable: true,
      error: null,
    };
  } catch (error: any) {
    return {
      storageRoot: STORAGE_ROOT,
      isAccessible: true,
      isWritable: false,
      error: error?.message || "Document storage root is not writable",
    };
  }
}

// moving a file from the temp upload location to its final storage path
async function moveToFinalPath(
  tempPath: string,
  relativeFolderPath: string,
  storedFileName: string,
): Promise<string> {
  const absoluteFolder = path.resolve(STORAGE_ROOT, relativeFolderPath);
  mkdirSync(absoluteFolder, { recursive: true });

  const finalPath = path.join(absoluteFolder, storedFileName);
  await fs.rename(tempPath, finalPath);
  return finalPath;
}

// removing a stored document file from disk
async function removeFileFromDisk(
  relativePath: string,
  storedFileName: string,
): Promise<void> {
  const absolutePath = path.resolve(STORAGE_ROOT, relativePath, storedFileName);
  try {
    await fs.unlink(absolutePath);
  } catch (error: any) {
    // ENOENT = file already gone, which is fine
    if (error?.code !== "ENOENT") {
      logger.error("Failed to delete document file", { absolutePath, error });
    }
  }
}

// preventing path traversal when resolving a document file for download
function resolveDocumentFileSafe(
  relativePath: string,
  storedFileName: string,
): string | null {
  const absolutePath = path.resolve(STORAGE_ROOT, relativePath, storedFileName);
  const normalizedRoot = path.resolve(STORAGE_ROOT);

  // ensuring the resolved path stays within the storage root
  if (!absolutePath.startsWith(`${normalizedRoot}${path.sep}`) && absolutePath !== normalizedRoot) {
    return null;
  }

  if (!existsSync(absolutePath)) return null;
  return absolutePath;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface UploadedFileInfo {
  originalname: string;
  mimetype: string;
  size: number;
  path: string; // temp path from multer
}

// creating document records for one or more uploaded files
// supports multiple files per upload (e.g. front and back of a bill)
export async function createDocuments(
  files: UploadedFileInfo[],
  metadata: CreateDocumentInput,
  userId: string,
): Promise<any[]> {
  assertStorageReady();

  const relativeFolderPath = buildRelativeFolderPath();
  const results: any[] = [];

  for (const [fileIndex, file] of files.entries()) {
    // generating a unique ID for this document using Prisma's cuid
    // we create the DB record first to get the ID, then move the file
    const doc = await prisma.document.create({
      data: {
        documentType: metadata.documentType as DocumentType,
        title: metadata.titles?.[fileIndex]?.trim() || defaultDocumentTitle(file.originalname),
        fileName: file.originalname,
        storedFileName: "", // placeholder, updated after file move
        storedPath: relativeFolderPath,
        mimeType: file.mimetype,
        fileSize: file.size,
        supplierName: metadata.supplierName || null,
        billNumber: metadata.billNumber || null,
        billDate: metadata.billDate ? new Date(metadata.billDate) : null,
        billAmount: metadata.billAmount ?? null,
        remarks: metadata.remarks || null,
        linkedEntityType: metadata.linkedEntityType || null,
        linkedEntityId: metadata.linkedEntityId || null,
        visibility: metadata.visibility || "ALL_AUTHENTICATED",
        uploadedById: userId,
      },
    });

    const storedFileName = buildStoredFileName(doc.id, metadata.documentType, file.originalname);

    try {
      // moving file from temp to final storage location
      await moveToFinalPath(file.path, relativeFolderPath, storedFileName);

      // computing checksum of the final file
      const finalPath = path.resolve(STORAGE_ROOT, relativeFolderPath, storedFileName);
      const checksum = await computeChecksum(finalPath);

      // updating the document record with final filename and checksum
      const updated = await prisma.document.update({
        where: { id: doc.id },
        data: { storedFileName, checksum },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      results.push({
        ...updated,
        processingStatus: getDocumentProcessingStatus(updated),
        processingLabel: getDocumentProcessingLabel(updated),
      });
    } catch (error) {
      // if file move fails, clean up the orphaned DB record
      await prisma.document.delete({ where: { id: doc.id } }).catch(() => {});
      // also try to clean up the temp file
      await fs.unlink(file.path).catch(() => {});
      throw error;
    }
  }

  // creating a single audit log entry for the upload batch
  if (results.length > 0) {
    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "DOCUMENT_UPLOADED",
        entityType: "Document",
        entityId: results.map((d) => d.id).join(","),
        meta: {
          count: results.length,
          titles: results.map((document) => document.title),
          documentType: metadata.documentType,
          supplierName: metadata.supplierName,
          linkedEntityType: metadata.linkedEntityType,
          linkedEntityId: metadata.linkedEntityId,
          visibility: metadata.visibility || "ALL_AUTHENTICATED",
        },
      },
    }).catch((err) => {
      logger.error("Document upload audit log error", err);
    });
  }

  return results;
}

// fetching a single document by ID
export async function getDocumentById(id: string, viewerRole?: string | null) {
  const doc = await prisma.document.findFirst({
    where: { id, deletedAt: null },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  if (!doc) return null;
  if (!canRoleViewDocument(doc.visibility, viewerRole)) return null;
  return {
    ...doc,
    processingStatus: getDocumentProcessingStatus(doc),
    processingLabel: getDocumentProcessingLabel(doc),
  };
}

// listing documents with filters and pagination
export async function listDocuments(filters: ListDocumentsInput, viewerRole?: string | null) {
  const where: any = { deletedAt: null };
  const and: any[] = [visibilityWhereForRole(viewerRole)];

  if (filters.q) {
    and.push({
      OR: [
        { title: { contains: filters.q } },
        { fileName: { contains: filters.q } },
        { supplierName: { contains: filters.q } },
        { billNumber: { contains: filters.q } },
      ],
    });
  }
  if (filters.documentType) where.documentType = filters.documentType;
  if (filters.visibility) where.visibility = filters.visibility;
  if (filters.supplierName) {
    where.supplierName = { contains: filters.supplierName };
  }
  if (filters.billNumber) {
    where.billNumber = { contains: filters.billNumber };
  }
  if (filters.linkedEntityType) where.linkedEntityType = filters.linkedEntityType;
  if (filters.linkedEntityId) where.linkedEntityId = filters.linkedEntityId;
  if (filters.processingStatus === "PROCESSED") {
    and.push({ linkedEntityType: { not: null } }, { linkedEntityId: { not: null } });
  } else if (filters.processingStatus === "UNPROCESSED") {
    and.push({ OR: [{ linkedEntityType: null }, { linkedEntityId: null }] });
  }
  where.AND = and;

  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.document.count({ where }),
  ]);

  return {
    documents: documents.map((doc) => ({
      ...doc,
      processingStatus: getDocumentProcessingStatus(doc),
      processingLabel: getDocumentProcessingLabel(doc),
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.ceil(total / filters.pageSize),
  };
}

// resolving the absolute file path for download/preview
export function getDocumentFilePath(doc: { storedPath: string; storedFileName: string }) {
  return resolveDocumentFileSafe(doc.storedPath, doc.storedFileName);
}

// deleting a document — removes both the DB record and the file from disk
export async function deleteDocument(id: string, userId: string, viewerRole?: string | null) {
  const doc = await prisma.document.findFirst({ where: { id, deletedAt: null } });
  if (!doc) throw new Error("Document not found");
  if (!canRoleViewDocument(doc.visibility, viewerRole)) throw new Error("Document not found");

  const purgeAfter = new Date();
  purgeAfter.setDate(purgeAfter.getDate() + 30);

  await prisma.$transaction([
    prisma.document.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedById: userId,
        purgeAfter,
        deleteReason: "Deleted from document storage",
      },
    }),
    prisma.softDeleteRecord.create({
      data: {
        entityType: "Document",
        entityId: id,
        entityLabel: documentLabel(doc),
        deletedById: userId,
        deleteReason: "Deleted from document storage",
        purgeAfter,
        entitySnapshot: {
          id: doc.id,
          title: doc.title,
          documentType: doc.documentType,
          fileName: doc.fileName,
          supplierName: doc.supplierName,
          billNumber: doc.billNumber,
          billDate: doc.billDate,
          billAmount: doc.billAmount,
          visibility: doc.visibility,
        },
      },
    }),
  ]);

  // audit log for the deletion
  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "DOCUMENT_DELETED",
      entityType: "Document",
      entityId: id,
      meta: {
        fileName: doc.fileName,
        title: doc.title,
        documentType: doc.documentType,
        supplierName: doc.supplierName,
        visibility: doc.visibility,
      },
    },
  }).catch((err) => {
    logger.error("Document delete audit log error", err);
  });

  return doc;
}

export async function updateDocumentVisibility(
  id: string,
  visibility: DocumentVisibility,
  userId: string,
) {
  const existing = await prisma.document.findFirst({
    where: { id, deletedAt: null },
  });
  if (!existing) throw new Error("Document not found");
  if (existing.visibility === visibility) {
    return {
      document: existing,
      changed: false,
    };
  }

  const document = await prisma.document.update({
    where: { id },
    data: { visibility },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "DOCUMENT_VISIBILITY_UPDATED",
      entityType: "Document",
      entityId: id,
      meta: {
        fileName: existing.fileName,
        previousVisibility: existing.visibility,
        visibility,
      },
    },
  }).catch((err) => {
    logger.error("Document visibility audit log error", err);
  });

  return {
    document: {
      ...document,
      processingStatus: getDocumentProcessingStatus(document),
      processingLabel: getDocumentProcessingLabel(document),
    },
    changed: true,
  };
}

function cleanNullableText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const cleaned = value?.trim() || "";
  return cleaned ? cleaned : null;
}

function parseNullableDate(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid bill date");
  }
  return parsed;
}

function nullableDateChanged(current: Date | null, next: Date | null | undefined) {
  if (next === undefined) return false;
  if (!current && !next) return false;
  if (!current || !next) return true;
  return current.getTime() !== next.getTime();
}

export async function updateDocumentMetadata(
  id: string,
  input: UpdateDocumentMetadataInput,
  userId: string,
) {
  const existing = await prisma.document.findFirst({
    where: { id, deletedAt: null },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  if (!existing) throw new Error("Document not found");

  const supplierName = cleanNullableText(input.supplierName);
  const title = input.title?.trim();
  const billNumber = cleanNullableText(input.billNumber);
  const remarks = cleanNullableText(input.remarks);
  const billDate = parseNullableDate(input.billDate);

  const data: Prisma.DocumentUpdateInput = {};
  const changedFields: string[] = [];

  if (title !== undefined && title !== existing.title) {
    data.title = title;
    changedFields.push("title");
  }

  if (input.documentType && input.documentType !== existing.documentType) {
    data.documentType = input.documentType as DocumentType;
    changedFields.push("documentType");
  }
  if (supplierName !== undefined && supplierName !== existing.supplierName) {
    data.supplierName = supplierName;
    changedFields.push("supplierName");
  }
  if (billNumber !== undefined && billNumber !== existing.billNumber) {
    data.billNumber = billNumber;
    changedFields.push("billNumber");
  }
  if (nullableDateChanged(existing.billDate, billDate)) {
    data.billDate = billDate;
    changedFields.push("billDate");
  }
  if (input.billAmount !== undefined && input.billAmount !== existing.billAmount) {
    data.billAmount = input.billAmount;
    changedFields.push("billAmount");
  }
  if (remarks !== undefined && remarks !== existing.remarks) {
    data.remarks = remarks;
    changedFields.push("remarks");
  }

  if (changedFields.length === 0) {
    return {
      document: {
        ...existing,
        processingStatus: getDocumentProcessingStatus(existing),
        processingLabel: getDocumentProcessingLabel(existing),
      },
      changed: false,
      changedFields,
    };
  }

  const document = await prisma.document.update({
    where: { id },
    data,
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId: userId,
      action: "DOCUMENT_METADATA_UPDATED",
      entityType: "Document",
      entityId: id,
      meta: {
        fileName: existing.fileName,
        title: existing.title,
        changedFields,
        previous: {
          title: existing.title,
          documentType: existing.documentType,
          supplierName: existing.supplierName,
          billNumber: existing.billNumber,
          billDate: existing.billDate,
          billAmount: existing.billAmount,
        },
        next: {
          title: document.title,
          documentType: document.documentType,
          supplierName: document.supplierName,
          billNumber: document.billNumber,
          billDate: document.billDate,
          billAmount: document.billAmount,
        },
      },
    },
  }).catch((err) => {
    logger.error("Document metadata audit log error", err);
  });

  return {
    document: {
      ...document,
      processingStatus: getDocumentProcessingStatus(document),
      processingLabel: getDocumentProcessingLabel(document),
    },
    changed: true,
    changedFields,
  };
}

export async function assertDocumentsCanLinkToEntity(input: {
  documentIds: string[];
  documentType: DocumentType;
  linkedEntityType: string;
  viewerRole?: string | null;
}) {
  const uniqueIds = Array.from(new Set(input.documentIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const documents = await prisma.document.findMany({
    where: {
      id: { in: uniqueIds },
      deletedAt: null,
    },
  });

  if (documents.length !== uniqueIds.length) {
    throw new Error("One or more selected documents are no longer available.");
  }

  for (const document of documents) {
    if (!canRoleViewDocument(document.visibility, input.viewerRole)) {
      throw new Error("One or more selected documents are not visible to your role.");
    }
    if (document.documentType !== input.documentType) {
      throw new Error(`Only ${input.documentType.replace(/_/g, " ").toLowerCase()} documents can be linked here.`);
    }
    if (document.linkedEntityType || document.linkedEntityId) {
      throw new Error(`${document.fileName} is already linked to another workflow.`);
    }
  }

  return documents;
}

export async function linkDocumentsToEntity(input: {
  documentIds: string[];
  documentType: DocumentType;
  linkedEntityType: string;
  linkedEntityId: string;
  userId: string;
  viewerRole?: string | null;
  metadata?: {
    supplierName?: string;
    billNumber?: string;
    billDate?: string;
    billAmount?: number;
    remarks?: string;
  };
}) {
  const documents = await assertDocumentsCanLinkToEntity(input);
  if (documents.length === 0) return [];

  const updatedDocuments = await prisma.$transaction(async (tx) => {
    const updated: DocumentWithUploader[] = [];

    for (const document of documents) {
      const next = await tx.document.update({
        where: { id: document.id },
        data: {
          linkedEntityType: input.linkedEntityType,
          linkedEntityId: input.linkedEntityId,
          supplierName: document.supplierName || input.metadata?.supplierName || null,
          billNumber: document.billNumber || input.metadata?.billNumber || null,
          billDate: document.billDate || (input.metadata?.billDate ? new Date(input.metadata.billDate) : null),
          billAmount: document.billAmount ?? input.metadata?.billAmount ?? null,
          remarks: document.remarks || input.metadata?.remarks || null,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      updated.push(next);
    }

    await tx.auditLog.create({
      data: {
        actorId: input.userId,
        action: "DOCUMENT_LINKED",
        entityType: "Document",
        entityId: updated.map((document) => document.id).join(","),
        meta: {
          count: updated.length,
          documentType: input.documentType,
          linkedEntityType: input.linkedEntityType,
          linkedEntityId: input.linkedEntityId,
        },
      },
    });

    return updated;
  });

  return updatedDocuments.map((document) => ({
    ...document,
    processingStatus: getDocumentProcessingStatus(document),
    processingLabel: getDocumentProcessingLabel(document),
  }));
}

export async function restoreDocument(id: string) {
  return prisma.document.update({
    where: { id },
    data: {
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      purgeAfter: null,
    },
  });
}

export async function permanentlyDeleteDocument(id: string) {
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return null;

  await removeFileFromDisk(doc.storedPath, doc.storedFileName);
  await prisma.document.delete({ where: { id } });
  return doc;
}

// fetching storage health and statistics for the admin panel
export async function getStorageInfo() {
  const [totalDocuments, totalSize, storageHealth] = await Promise.all([
    prisma.document.count({ where: { deletedAt: null } }),
    prisma.document.aggregate({ where: { deletedAt: null }, _sum: { fileSize: true } }),
    getDocumentStorageHealth(),
  ]);

  // getting counts by document type
  const byType = await prisma.document.groupBy({
    by: ["documentType"],
    where: { deletedAt: null },
    _count: { id: true },
    _sum: { fileSize: true },
  });

  return {
    storageRoot: STORAGE_ROOT,
    isConfigured: !!configuredRoot,
    isAccessible: storageHealth.isAccessible,
    isWritable: storageHealth.isWritable,
    storageError: storageHealth.error,
    totalDocuments,
    totalSizeBytes: totalSize._sum.fileSize || 0,
    byType: byType.map((t) => ({
      type: t.documentType,
      count: t._count.id,
      sizeBytes: t._sum.fileSize || 0,
    })),
  };
}

// getting the temp directory path for multer uploads
export function getTempUploadDir(): string {
  const tempDir = path.join(STORAGE_ROOT, ".temp");
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}
