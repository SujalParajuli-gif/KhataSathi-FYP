import crypto from "crypto";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import type { Prisma, SaleRecoveryStatus } from "@prisma/client";
import {
  defaultDocumentTitle,
  getDocumentFilePath,
  getDocumentThumbnailFilePath,
  prepareDocumentFile,
  removePreparedDocumentFiles,
  toPublicDocument,
  type PublicDocument,
  type UploadedFileInfo,
} from "../documents/service";
import {
  getBusinessCapabilities,
  type BusinessCapabilities,
} from "../settings/capabilities";
import {
  archiveSaleEvidenceSchema,
  createSaleEvidenceSchema,
  listSaleEvidenceSchema,
  type ArchiveSaleEvidenceInput,
  type CreateSaleEvidenceInput,
  type ListSaleEvidenceInput,
} from "./validation";

export interface SalesEvidenceActor {
  id: string;
  role: string;
  name?: string;
}

export interface PublicSaleEvidence extends PublicDocument {
  saleRecoveryStatus: SaleRecoveryStatus | null;
}

export interface ArchiveSaleEvidenceResult {
  document: PublicSaleEvidence;
  replayed: boolean;
}

export class SalesEvidenceAuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SalesEvidenceAuthorizationError";
    this.code = code;
  }
}

export class SalesEvidenceConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  readonly document?: PublicSaleEvidence;

  constructor(
    message: string,
    code = "CONFLICT",
    document?: PublicSaleEvidence,
  ) {
    super(message);
    this.name = "SalesEvidenceConflictError";
    this.code = code;
    this.document = document;
  }
}


export async function assertSalesEvidenceReviewer(
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<void> {
  if (!actor || (actor.role !== "ADMIN" && actor.role !== "MANAGER")) {
    throw new SalesEvidenceAuthorizationError(
      "Access denied — insufficient role",
    );
  }

  const capabilities = await capabilitiesResolver();
  if (!capabilities.posEnabled) {
    throw new SalesEvidenceAuthorizationError(
      `POS is disabled in ${capabilities.businessMode} mode`,
      "FEATURE_DISABLED",
    );
  }
}

export function toPublicSaleEvidence<
  T extends Parameters<typeof toPublicDocument>[0] & {
    saleRecoveryStatus?: SaleRecoveryStatus | null;
  },
>(doc: T): PublicSaleEvidence {
  const base = toPublicDocument(doc);
  return {
    ...base,
    saleRecoveryStatus: doc.saleRecoveryStatus ?? null,
  };
}

export async function createSaleEvidence(
  file: UploadedFileInfo,
  metadata: CreateSaleEvidenceInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicSaleEvidence> {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);

  const validatedMetadata = createSaleEvidenceSchema.parse(metadata);
  const documentId = crypto.randomUUID();

  const prepared = await prepareDocumentFile(file, documentId, "SALE_BILL");
  const title =
    validatedMetadata.title?.trim() || defaultDocumentTitle(file.originalname);
  const remarks = validatedMetadata.remarks?.trim() || null;

  let createdDoc: any;

  try {
    createdDoc = await prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          id: documentId,
          documentType: "SALE_BILL",
          title,
          fileName: prepared.fileName,
          storedFileName: prepared.storedFileName,
          storedPath: prepared.storedPath,
          mimeType: prepared.mimeType,
          fileSize: prepared.fileSize,
          checksum: prepared.checksum,
          thumbnailFileName: prepared.thumbnailFileName,
          thumbnailSize: prepared.thumbnailSize,
          supplierName: null,
          billNumber: null,
          billDate: null,
          billAmount: null,
          remarks,
          linkedEntityType: null,
          linkedEntityId: null,
          visibility: "ADMIN_MANAGER",
          saleRecoveryStatus: "UNRESOLVED",
          recoveryCheckoutOperationKey: null,
          recoveryCheckoutPayloadHash: null,
          uploadedById: actor.id,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALE_EVIDENCE_UPLOADED",
          entityType: "Document",
          entityId: doc.id,
          meta: {
            documentId: doc.id,
            title: doc.title,
            documentType: "SALE_BILL",
            fileName: doc.fileName,
            storedFileName: doc.storedFileName,
            storedPath: doc.storedPath,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            checksum: doc.checksum,
            visibility: doc.visibility,
            saleRecoveryStatus: doc.saleRecoveryStatus,
          },
        },
      });

      return doc;
    });
  } catch (txError) {
    try {
      const existing = await prisma.document.findUnique({
        where: { id: documentId },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      if (existing) {
        logger.warn(
          "Transaction error encountered but document row was committed; retaining prepared files",
          { documentId },
        );
        return toPublicSaleEvidence(existing);
      }
      await removePreparedDocumentFiles(prepared);
    } catch (reconcileError) {
      logger.error(
        "Failed to reconcile document existence after transaction failure; retaining prepared files",
        {
          documentId,
          txError,
          reconcileError,
        },
      );
    }
    throw txError;
  }

  return toPublicSaleEvidence(createdDoc);
}

export async function listSaleEvidence(
  filters: ListSaleEvidenceInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
) {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);
  const validatedFilters = listSaleEvidenceSchema.parse(filters);

  const where: Prisma.DocumentWhereInput = {
    documentType: "SALE_BILL",
    deletedAt: null,
  };

  if (actor.role === "MANAGER") {
    where.visibility = { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] };
  }

  if (validatedFilters.saleRecoveryStatus) {
    where.saleRecoveryStatus = validatedFilters.saleRecoveryStatus;
  }

  if (validatedFilters.q) {
    where.OR = [
      { title: { contains: validatedFilters.q } },
      { fileName: { contains: validatedFilters.q } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.document.findMany({
      where,
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (validatedFilters.page - 1) * validatedFilters.pageSize,
      take: validatedFilters.pageSize,
    }),
    prisma.document.count({ where }),
  ]);

  return {
    documents: rows.map(toPublicSaleEvidence),
    total,
    page: validatedFilters.page,
    pageSize: validatedFilters.pageSize,
    totalPages: Math.ceil(total / validatedFilters.pageSize),
  };
}

export async function getSaleEvidenceById(
  id: string,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
) {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);

  const doc = await prisma.document.findFirst({
    where: {
      id,
      documentType: "SALE_BILL",
      deletedAt: null,
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  if (!doc) return null;
  if (actor.role === "MANAGER" && doc.visibility === "ADMIN_ONLY") {
    return null;
  }

  return toPublicSaleEvidence(doc);
}

export async function getSaleEvidenceFile(
  id: string,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
) {
  const doc = await getSaleEvidenceById(id, actor, capabilitiesResolver);
  if (!doc) return null;

  const filePath = getDocumentFilePath(doc);
  return { doc, filePath };
}

export async function getSaleEvidenceThumbnail(
  id: string,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
) {
  const doc = await getSaleEvidenceById(id, actor, capabilitiesResolver);
  if (!doc) return null;

  const thumbnailPath = getDocumentThumbnailFilePath(doc);
  return { doc, thumbnailPath };
}

function extractAuditedReasonIfValidProvenance(
  audit: {
    action: string;
    entityType: string;
    entityId: string;
    meta: unknown;
  } | null | undefined,
  expectedDocId: string,
): string | null {
  if (!audit) return null;
  if (audit.action !== "SALE_EVIDENCE_ARCHIVED") return null;
  if (audit.entityType !== "Document") return null;
  if (audit.entityId !== expectedDocId) return null;

  const meta = audit.meta as Record<string, unknown> | null;
  if (!meta || typeof meta !== "object") return null;

  const auditedDocId = meta.documentId;
  const auditedReason =
    typeof meta.reason === "string" ? meta.reason.trim() : null;
  const oldStatus = meta.oldSaleRecoveryStatus;
  const newStatus = meta.newSaleRecoveryStatus;
  const linkedEntityType = meta.linkedEntityType;
  const linkedEntityId = meta.linkedEntityId;

  if (auditedDocId !== expectedDocId) return null;
  if (!auditedReason || auditedReason.length === 0) return null;
  if (oldStatus !== "UNRESOLVED") return null;
  if (newStatus !== "ARCHIVED") return null;
  if (linkedEntityType !== null) return null;
  if (linkedEntityId !== null) return null;

  return auditedReason;
}

function isValidArchiveDecisionAudit(
  audit: {
    action: string;
    entityType: string;
    entityId: string;
    meta: unknown;
  } | null | undefined,
  expectedDocId: string,
  expectedReason: string,
): boolean {
  const auditedReason = extractAuditedReasonIfValidProvenance(
    audit,
    expectedDocId,
  );
  return auditedReason !== null && auditedReason === expectedReason;
}

export async function archiveSaleEvidence(
  id: string,
  input: ArchiveSaleEvidenceInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<ArchiveSaleEvidenceResult | null> {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);

  const validatedInput = archiveSaleEvidenceSchema.parse(input);
  const normalizedReason = validatedInput.reason.trim();

  const visibilityFilter =
    actor.role === "MANAGER"
      ? ({ in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } as const)
      : undefined;

  const existing = await prisma.document.findFirst({
    where: {
      id,
      documentType: "SALE_BILL",
      deletedAt: null,
      ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  if (!existing) {
    return null;
  }

  const filePath = getDocumentFilePath(existing);
  if (!filePath) {
    throw new SalesEvidenceConflictError(
      "Original sales evidence file is missing or inaccessible on disk",
      "MISSING_EVIDENCE_FILE",
      toPublicSaleEvidence(existing),
    );
  }

  if (existing.saleRecoveryStatus === null) {
    throw new SalesEvidenceConflictError(
      "Legacy sales evidence without recovery status cannot be archived",
      "LEGACY_STATUS_CONFLICT",
      toPublicSaleEvidence(existing),
    );
  }

  if (
    existing.saleRecoveryStatus === "ATTACHED" ||
    existing.linkedEntityType !== null ||
    existing.linkedEntityId !== null
  ) {
    throw new SalesEvidenceConflictError(
      "Attached sales evidence cannot be archived",
      "ATTACHED_CONFLICT",
      toPublicSaleEvidence(existing),
    );
  }

  if (
    existing.recoveryCheckoutOperationKey !== null ||
    existing.recoveryCheckoutPayloadHash !== null
  ) {
    throw new SalesEvidenceConflictError(
      "Sales evidence with active recovery checkout operation cannot be archived",
      "ACTIVE_OPERATION_CONFLICT",
      toPublicSaleEvidence(existing),
    );
  }

  if (existing.saleRecoveryStatus === "ARCHIVED") {
    const latestAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: "Document",
        entityId: existing.id,
        action: "SALE_EVIDENCE_ARCHIVED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    if (isValidArchiveDecisionAudit(latestAudit, existing.id, normalizedReason)) {
      return {
        document: toPublicSaleEvidence(existing),
        replayed: true,
      };
    }

    const auditedReason = extractAuditedReasonIfValidProvenance(
      latestAudit,
      existing.id,
    );
    if (auditedReason !== null && auditedReason !== normalizedReason) {
      throw new SalesEvidenceConflictError(
        "Sales evidence is already archived with a different decision reason",
        "DECISION_CONFLICT",
        toPublicSaleEvidence(existing),
      );
    }

    throw new SalesEvidenceConflictError(
      "Cannot verify prior archive decision audit",
      "UNVERIFIED_ARCHIVE",
      toPublicSaleEvidence(existing),
    );
  }

  if (existing.saleRecoveryStatus !== "UNRESOLVED") {
    throw new SalesEvidenceConflictError(
      "Sales evidence is not eligible to be archived",
      "INELIGIBLE_STATUS",
      toPublicSaleEvidence(existing),
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (actor.role === "MANAGER") {
        await tx.$queryRaw`SELECT id FROM Document WHERE id = ${id} AND documentType = 'SALE_BILL' AND deletedAt IS NULL AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM Document WHERE id = ${id} AND documentType = 'SALE_BILL' AND deletedAt IS NULL FOR UPDATE`;
      }

      const lockedDoc = await tx.document.findFirst({
        where: {
          id,
          documentType: "SALE_BILL",
          deletedAt: null,
          ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      if (!lockedDoc) {
        return null;
      }

      if (lockedDoc.saleRecoveryStatus === "ARCHIVED") {
        if (
          lockedDoc.linkedEntityType !== null ||
          lockedDoc.linkedEntityId !== null
        ) {
          throw new SalesEvidenceConflictError(
            "Attached sales evidence cannot be archived",
            "ATTACHED_CONFLICT",
            toPublicSaleEvidence(lockedDoc),
          );
        }

        if (
          lockedDoc.recoveryCheckoutOperationKey !== null ||
          lockedDoc.recoveryCheckoutPayloadHash !== null
        ) {
          throw new SalesEvidenceConflictError(
            "Sales evidence with active recovery checkout operation cannot be archived",
            "ACTIVE_OPERATION_CONFLICT",
            toPublicSaleEvidence(lockedDoc),
          );
        }

        const latestAudit = await tx.auditLog.findFirst({
          where: {
            entityType: "Document",
            entityId: lockedDoc.id,
            action: "SALE_EVIDENCE_ARCHIVED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });

        if (isValidArchiveDecisionAudit(latestAudit, lockedDoc.id, normalizedReason)) {
          return {
            document: toPublicSaleEvidence(lockedDoc),
            replayed: true,
          };
        }

        const auditedReason = extractAuditedReasonIfValidProvenance(
          latestAudit,
          lockedDoc.id,
        );
        if (auditedReason !== null && auditedReason !== normalizedReason) {
          throw new SalesEvidenceConflictError(
            "Sales evidence is already archived with a different decision reason",
            "DECISION_CONFLICT",
            toPublicSaleEvidence(lockedDoc),
          );
        }

        throw new SalesEvidenceConflictError(
          "Cannot verify prior archive decision audit",
          "UNVERIFIED_ARCHIVE",
          toPublicSaleEvidence(lockedDoc),
        );
      }

      if (
        lockedDoc.saleRecoveryStatus !== "UNRESOLVED" ||
        lockedDoc.linkedEntityType !== null ||
        lockedDoc.linkedEntityId !== null
      ) {
        throw new SalesEvidenceConflictError(
          lockedDoc.saleRecoveryStatus === "ATTACHED" || lockedDoc.linkedEntityType !== null
            ? "Attached sales evidence cannot be archived"
            : "Sales evidence is not eligible to be archived",
          lockedDoc.saleRecoveryStatus === "ATTACHED" || lockedDoc.linkedEntityType !== null
            ? "ATTACHED_CONFLICT"
            : "INELIGIBLE_STATUS",
          toPublicSaleEvidence(lockedDoc),
        );
      }

      if (
        lockedDoc.recoveryCheckoutOperationKey !== null ||
        lockedDoc.recoveryCheckoutPayloadHash !== null
      ) {
        throw new SalesEvidenceConflictError(
          "Sales evidence with active recovery checkout operation cannot be archived",
          "ACTIVE_OPERATION_CONFLICT",
          toPublicSaleEvidence(lockedDoc),
        );
      }

      const updateResult = await tx.document.updateMany({
        where: {
          id,
          documentType: "SALE_BILL",
          deletedAt: null,
          saleRecoveryStatus: "UNRESOLVED",
          linkedEntityType: null,
          linkedEntityId: null,
          recoveryCheckoutOperationKey: null,
          recoveryCheckoutPayloadHash: null,
          ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
        },
        data: {
          saleRecoveryStatus: "ARCHIVED",
        },
      });

      if (updateResult.count !== 1) {
        throw new SalesEvidenceConflictError(
          "Concurrent modification prevented archiving",
          "CONCURRENT_MODIFICATION",
          toPublicSaleEvidence(lockedDoc),
        );
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALE_EVIDENCE_ARCHIVED",
          entityType: "Document",
          entityId: lockedDoc.id,
          meta: {
            documentId: lockedDoc.id,
            reason: normalizedReason,
            oldSaleRecoveryStatus: lockedDoc.saleRecoveryStatus,
            newSaleRecoveryStatus: "ARCHIVED",
            linkedEntityType: lockedDoc.linkedEntityType,
            linkedEntityId: lockedDoc.linkedEntityId,
          },
        },
      });

      const updatedDoc = {
        ...lockedDoc,
        saleRecoveryStatus: "ARCHIVED" as const,
      };

      return {
        document: toPublicSaleEvidence(updatedDoc),
        replayed: false,
      };
    });

    return result;
  } catch (txError) {
    if (txError instanceof SalesEvidenceConflictError) {
      throw txError;
    }

    try {
      const committed = await prisma.document.findFirst({
        where: {
          id,
          documentType: "SALE_BILL",
          deletedAt: null,
          ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      if (!committed) {
        return null;
      }

      if (committed.saleRecoveryStatus === "ARCHIVED") {
        if (
          committed.linkedEntityType !== null ||
          committed.linkedEntityId !== null
        ) {
          throw new SalesEvidenceConflictError(
            "Attached sales evidence cannot be archived",
            "ATTACHED_CONFLICT",
            toPublicSaleEvidence(committed),
          );
        }

        if (
          committed.recoveryCheckoutOperationKey !== null ||
          committed.recoveryCheckoutPayloadHash !== null
        ) {
          throw new SalesEvidenceConflictError(
            "Sales evidence with active recovery checkout operation cannot be archived",
            "ACTIVE_OPERATION_CONFLICT",
            toPublicSaleEvidence(committed),
          );
        }

        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Document",
            entityId: committed.id,
            action: "SALE_EVIDENCE_ARCHIVED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });

        if (isValidArchiveDecisionAudit(latestAudit, committed.id, normalizedReason)) {
          logger.warn(
            "Transaction error encountered but document archive was committed and verified with audit; returning replayed archive",
            { documentId: id },
          );
          return {
            document: toPublicSaleEvidence(committed),
            replayed: true,
          };
        }

        const auditedReason = extractAuditedReasonIfValidProvenance(
          latestAudit,
          committed.id,
        );
        if (auditedReason !== null && auditedReason !== normalizedReason) {
          throw new SalesEvidenceConflictError(
            "Sales evidence is already archived with a different decision reason",
            "DECISION_CONFLICT",
            toPublicSaleEvidence(committed),
          );
        }

        throw new SalesEvidenceConflictError(
          "Cannot verify prior archive decision audit",
          "UNVERIFIED_ARCHIVE",
          toPublicSaleEvidence(committed),
        );
      }
    } catch (reconcileErr) {
      if (reconcileErr instanceof SalesEvidenceConflictError) {
        throw reconcileErr;
      }
      logger.error(
        "Failed to reconcile archive existence after transaction failure",
        {
          documentId: id,
          txError,
          reconcileErr,
        },
      );
    }

    throw txError;
  }
}
