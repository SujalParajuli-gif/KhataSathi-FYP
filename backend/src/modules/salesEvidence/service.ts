import crypto from "crypto";
import fs from "node:fs";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import type { BillRecordStatus, Prisma, SaleRecoveryStatus } from "@prisma/client";
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
  attachSaleEvidenceSchema,
  candidatesQuerySchema,
  createSaleEvidenceSchema,
  listSaleEvidenceSchema,
  type ArchiveSaleEvidenceInput,
  type AttachSaleEvidenceInput,
  type CandidatesQueryInput,
  type CreateSaleEvidenceInput,
  type ListSaleEvidenceInput,
} from "./validation";
import {
  lockInvoiceForUpdate,
  runFinancialTransaction,
} from "../../lib/transactionLocks";
import { parseBusinessDate } from "../../lib/businessDate";
import {
  expectedRecordsEqual,
  findDuplicateReferencesTx,
  formatUtcCalendarDate,
  getManualBillRecord,
  resolveHistoricalCustomer,
} from "../invoices/manualBill/service";
import type {
  ExpectedManualBillRecord,
  PublicManualBillRecord,
} from "../invoices/manualBill/types";

export interface SalesEvidenceActor {
  id: string;
  role: string;
  name?: string;
}

export interface PublicSaleEvidence extends PublicDocument {
  saleRecoveryStatus: SaleRecoveryStatus | null;
  canVoidMistakenUpload: boolean;
}

export interface ArchiveSaleEvidenceResult {
  document: PublicSaleEvidence;
  replayed: boolean;
}

export interface PublicSaleCandidate {
  id: string;
  invoiceNo: string;
  netTotal: number;
  finalizedAt: Date | null;
  paymentStatus: string;
  customerName: string | null;
  customerPan: string | null;
  billingChannel: string | null;
  billRecordStatus: string | null;
  externalBillNo: string | null;
  externalBillDate: string | null;
  externalDocumentType: string | null;
}

export interface AttachSaleEvidenceResult {
  document: PublicSaleEvidence;
  invoice: PublicManualBillRecord;
  replayed: boolean;
}

function attachmentObservationsMatch(meta: Record<string, any>, doc: {
  id: string; documentType: string; visibility: string;
  recoveryCheckoutOperationKey: string | null; recoveryCheckoutPayloadHash: string | null;
}): boolean {
  const previous = meta.previousDocument;
  return !!previous && previous.id === doc.id &&
    previous.documentType === "SALE_BILL" && previous.visibility === doc.visibility &&
    previous.saleRecoveryStatus === "UNRESOLVED" &&
    previous.linkedEntityType === null && previous.linkedEntityId === null &&
    previous.recoveryCheckoutOperationKey === null && previous.recoveryCheckoutPayloadHash === null &&
    doc.recoveryCheckoutOperationKey === null && doc.recoveryCheckoutPayloadHash === null;
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
    recoveryCheckoutOperationKey?: string | null;
    recoveryCheckoutPayloadHash?: string | null;
    deletedAt?: Date | null;
  },
>(doc: T): PublicSaleEvidence {
  const base = toPublicDocument(doc);
  return {
    ...base,
    saleRecoveryStatus: doc.saleRecoveryStatus ?? null,
    canVoidMistakenUpload: !doc.deletedAt && ["UNRESOLVED", "ARCHIVED"].includes(doc.saleRecoveryStatus || "") &&
      !doc.linkedEntityType && !doc.linkedEntityId && !doc.recoveryCheckoutOperationKey && !doc.recoveryCheckoutPayloadHash,
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

export async function getSaleEvidenceCandidates(
  documentId: string,
  rawQuery: CandidatesQueryInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<{ candidates: PublicSaleCandidate[] }> {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);
  const query = candidatesQuerySchema.parse(rawQuery);

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      documentType: "SALE_BILL",
      deletedAt: null,
      ...(actor.role === "MANAGER"
        ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
        : {}),
    },
  });

  if (!document) {
    throw new SalesEvidenceConflictError(
      "Sales evidence not found",
      "NOT_FOUND",
    );
  }

  const where: Prisma.InvoiceWhereInput = {
    status: "FINALIZED",
    cancelledAt: null,
    deletedAt: null,
    paymentStatus: { not: "CANCELLED" },
    OR: [{ billingChannel: null }, { billingChannel: "MANUAL_EXTERNAL" }],
    ...(document.saleRecoveryStatus === "ATTACHED" ? {
      creditNotesAsOriginal: { none: {} }, creditNoteAsReplacement: { is: null },
      ...(document.linkedEntityId ? { id: { not: document.linkedEntityId } } : {}),
    } : {}),
  };

  if (query.search) {
    where.AND = [{ OR: [
      { invoiceNo: { contains: query.search } },
      { externalBillNo: { contains: query.search } },
      { customer: { name: { contains: query.search } } },
      { customerNameSnapshot: { contains: query.search } },
    ] }];
  }

  const invoices = await prisma.invoice.findMany({
    where,
    select: {
      id: true,
      invoiceNo: true,
      netTotal: true,
      finalizedAt: true,
      paymentStatus: true,
      billingChannel: true,
      billRecordStatus: true,
      externalBillNo: true,
      externalBillDate: true,
      externalDocumentType: true,
      customerSnapshotCapturedAt: true,
      customerNameSnapshot: true,
      customerPanSnapshot: true,
      customer: { select: { name: true, panNo: true } },
    },
    orderBy: [{ finalizedAt: "desc" }, { id: "desc" }],
    take: query.limit,
  });

  const candidates: PublicSaleCandidate[] = invoices.map((inv) => {
    const historicalCustomer = resolveHistoricalCustomer(inv);
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      netTotal: inv.netTotal,
      finalizedAt: inv.finalizedAt,
      paymentStatus: inv.paymentStatus,
      customerName: historicalCustomer.name,
      customerPan: historicalCustomer.panNo,
      billingChannel: inv.billingChannel,
      billRecordStatus: inv.billRecordStatus,
      externalBillNo: inv.externalBillNo,
      externalBillDate: formatUtcCalendarDate(inv.externalBillDate),
      externalDocumentType: inv.externalDocumentType,
    };
  });

  return { candidates };
}

export async function attachSaleEvidence(
  documentId: string,
  rawInput: AttachSaleEvidenceInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<AttachSaleEvidenceResult> {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);
  const input = attachSaleEvidenceSchema.parse(rawInput);
  const parsedDate = parseBusinessDate(
    input.reference.externalBillDate,
    "externalBillDate",
  );

  // Read-only preflight: ensure document exists, is accessible, and original regular file is present and non-empty
  const preflightDoc = await prisma.document.findFirst({
    where: {
      id: documentId,
      documentType: "SALE_BILL",
      deletedAt: null,
      ...(actor.role === "MANAGER"
        ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
        : {}),
    },
  });

  if (!preflightDoc) {
    throw new SalesEvidenceConflictError(
      "Sales evidence not found or deleted",
      "NOT_FOUND",
    );
  }

  const preflightFilePath = getDocumentFilePath(preflightDoc);
  if (!preflightFilePath || !fs.existsSync(preflightFilePath)) {
    throw new SalesEvidenceConflictError(
      "Sales evidence file not found on disk",
      "INVALID_FILE",
    );
  }

  const fileStat = fs.statSync(preflightFilePath);
  if (!fileStat.isFile() || fileStat.size === 0 || preflightDoc.fileSize === 0) {
    throw new SalesEvidenceConflictError(
      "Sales evidence file is invalid or empty",
      "INVALID_FILE",
    );
  }

  try {
    const result = await runFinancialTransaction(prisma, async (tx) => {
      // 1. Lock invoice first (Invoice-first locking convention)
      await lockInvoiceForUpdate(tx, input.invoiceId);

      // 2. Lock document FOR UPDATE with visibility predicate
      if (actor.role === "MANAGER") {
        await tx.$queryRaw`SELECT id FROM Document WHERE id = ${documentId} AND documentType = 'SALE_BILL' AND deletedAt IS NULL AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM Document WHERE id = ${documentId} AND documentType = 'SALE_BILL' AND deletedAt IS NULL FOR UPDATE`;
      }

      const doc = await tx.document.findFirst({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          deletedAt: null,
          ...(actor.role === "MANAGER"
            ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
            : {}),
        },
      });

      if (!doc) {
        throw new SalesEvidenceConflictError(
          "Sales evidence not found or deleted",
          "NOT_FOUND",
        );
      }

      // Check if already attached (idempotent replay check)
      if (doc.saleRecoveryStatus === "ATTACHED") {
        if (
          doc.linkedEntityType === "Invoice" &&
          doc.linkedEntityId === input.invoiceId
        ) {
          const latestDocAudit = await tx.auditLog.findFirst({
            where: {
              entityType: "Document",
              entityId: doc.id,
              action: "SALES_EVIDENCE_ATTACHED",
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });

          const meta = (latestDocAudit?.meta as Record<string, any>) ?? {};
          const isMatchingAudit =
            attachmentObservationsMatch(meta, doc) &&
            meta.invoiceId === input.invoiceId &&
            meta.reference?.billNo === input.reference.billNo &&
            meta.reference?.externalDocumentType === input.reference.externalDocumentType &&
            meta.reference?.externalBillDate === input.reference.externalBillDate &&
            (meta.reason ?? null) === input.reason.trim() &&
            (meta.duplicateOverrideReason ?? null) ===
              (input.duplicateOverrideReason?.trim() || null) &&
            expectedRecordsEqual(input.expectedInvoice, meta.previousInvoice ?? {});

          if (isMatchingAudit) {
            const currentInvoiceRecord = await getManualBillRecord(
              input.invoiceId,
              actor as any,
              tx,
              capabilitiesResolver,
            );
            return {
              document: toPublicSaleEvidence(doc),
              invoice: currentInvoiceRecord,
              replayed: true,
            };
          }

          throw new SalesEvidenceConflictError(
            "Sales evidence is already attached with different reference or reason",
            "ATTACHED_CONFLICT",
            toPublicSaleEvidence(doc),
          );
        }

        throw new SalesEvidenceConflictError(
          "Sales evidence is already attached to another invoice",
          "ATTACHED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (doc.saleRecoveryStatus === "ARCHIVED") {
        throw new SalesEvidenceConflictError(
          "Archived sales evidence cannot be attached",
          "ARCHIVED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (
        doc.linkedEntityType !== null ||
        doc.linkedEntityId !== null
      ) {
        throw new SalesEvidenceConflictError(
          "Sales evidence is already linked to another entity",
          "LINKED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (
        doc.recoveryCheckoutOperationKey !== null ||
        doc.recoveryCheckoutPayloadHash !== null
      ) {
        throw new SalesEvidenceConflictError(
          "Sales evidence is locked by an in-flight checkout operation",
          "ACTIVE_OPERATION_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      // 3. Target Invoice validation
      const invoice = await tx.invoice.findUnique({
        where: { id: input.invoiceId },
      });

      if (!invoice || invoice.deletedAt !== null) {
        throw new SalesEvidenceConflictError(
          "Target invoice not found or deleted",
          "INVOICE_NOT_FOUND",
        );
      }

      if (invoice.status !== "FINALIZED") {
        throw new SalesEvidenceConflictError(
          "Cannot attach sales evidence to a draft invoice",
          "INVOICE_NOT_FINALIZED",
        );
      }

      if (invoice.cancelledAt !== null || invoice.paymentStatus === "CANCELLED") {
        throw new SalesEvidenceConflictError(
          "Cannot attach sales evidence to a cancelled invoice",
          "INVOICE_CANCELLED",
        );
      }

      if (invoice.billingChannel === "IRD_ELECTRONIC") {
        throw new SalesEvidenceConflictError(
          "Cannot attach sales evidence to an electronic/IRD invoice",
          "UNSUPPORTED_BILLING_CHANNEL",
        );
      }

      // Expected target invoice state comparison
      const currentInvoiceExpected = {
        billingChannel: invoice.billingChannel ?? null,
        externalDocumentType: invoice.externalDocumentType ?? null,
        externalBillNo: invoice.externalBillNo ?? null,
        externalBillDate: formatUtcCalendarDate(invoice.externalBillDate),
        billRecordStatus: invoice.billRecordStatus ?? null,
      };

      if (!expectedRecordsEqual(input.expectedInvoice, currentInvoiceExpected)) {
        throw new SalesEvidenceConflictError(
          "The target invoice manual paper bill record was modified by another user. Please refresh and review.",
          "STALE_RECORD_CONFLICT",
        );
      }

      // Duplicate check
      const duplicates = await findDuplicateReferencesTx(
        tx,
        input.invoiceId,
        input.reference.externalDocumentType,
        input.reference.billNo,
        parsedDate,
      );

      if (duplicates.length > 0) {
        if (!input.duplicateOverrideReason?.trim()) {
          throw new SalesEvidenceConflictError(
            `Another active invoice already has paper bill reference ${input.reference.billNo}. Reviewer duplicate override reason is required.`,
            "DUPLICATE_REVIEW_REQUIRED",
          );
        }
        if (actor.role !== "ADMIN" && actor.role !== "MANAGER") {
          throw new SalesEvidenceAuthorizationError(
            "Only supervisors or administrators can override duplicate paper bill warnings",
          );
        }
      }

      // 4. Conditional claim on Document with visibility predicate
      const claimResult = await tx.document.updateMany({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          saleRecoveryStatus: "UNRESOLVED",
          linkedEntityType: null,
          linkedEntityId: null,
          recoveryCheckoutOperationKey: null,
          recoveryCheckoutPayloadHash: null,
          deletedAt: null,
          ...(actor.role === "MANAGER"
            ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
            : {}),
        },
        data: {
          saleRecoveryStatus: "ATTACHED",
          linkedEntityType: "Invoice",
          linkedEntityId: input.invoiceId,
        },
      });

      if (claimResult.count === 0) {
        throw new SalesEvidenceConflictError(
          "Sales evidence was already claimed by another operation",
          "CLAIM_CONFLICT",
        );
      }

      // 5. Update Target Invoice
      const isSameReference =
        invoice.externalBillNo === input.reference.billNo &&
        invoice.externalDocumentType === input.reference.externalDocumentType &&
        formatUtcCalendarDate(invoice.externalBillDate) ===
          input.reference.externalBillDate;

      let targetStatus: BillRecordStatus = "RECORDED";
      if (invoice.billRecordStatus === "VERIFIED" && isSameReference) {
        targetStatus = "VERIFIED";
      }

      const previousInvoiceFields = currentInvoiceExpected;
      const targetBillingChannel = invoice.billingChannel || "MANUAL_EXTERNAL";

      await tx.invoice.update({
        where: { id: input.invoiceId },
        data: {
          billingChannel: targetBillingChannel,
          externalBillNo: input.reference.billNo,
          externalBillDate: parsedDate,
          externalDocumentType: input.reference.externalDocumentType,
          billRecordStatus: targetStatus,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true, role: true },
      });

      // 6. Atomic Audit Logs
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALES_EVIDENCE_ATTACHED",
          entityType: "Document",
          entityId: documentId,
          meta: {
            invoiceId: input.invoiceId,
            invoiceNo: invoice.invoiceNo,
            documentTitle: doc.title,
            reference: input.reference,
            previousInvoice: currentInvoiceExpected,
            previousDocument: {
              id: doc.id,
              documentType: doc.documentType,
              visibility: doc.visibility,
              saleRecoveryStatus: doc.saleRecoveryStatus,
              linkedEntityType: doc.linkedEntityType,
              linkedEntityId: doc.linkedEntityId,
              recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey,
              recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash,
            },
            actorName: user?.name || null,
            actorRole: user?.role || null,
            reason: input.reason.trim(),
            duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "MANUAL_BILL_ATTACHED",
          entityType: "Invoice",
          entityId: input.invoiceId,
          meta: {
            invoiceNo: invoice.invoiceNo,
            documentId,
            documentTitle: doc.title,
            reference: input.reference,
            previous: previousInvoiceFields,
            current: {
              billingChannel: targetBillingChannel,
              externalBillNo: input.reference.billNo,
              externalBillDate: input.reference.externalBillDate,
              externalDocumentType: input.reference.externalDocumentType,
              billRecordStatus: targetStatus,
            },
            actorName: user?.name || null,
            actorRole: user?.role || null,
            reason: input.reason.trim(),
            duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
          },
        },
      });

      const committedDoc = await tx.document.findUnique({
        where: { id: documentId },
      });

      const committedInvoice = await getManualBillRecord(
        input.invoiceId,
        actor as any,
        tx,
        capabilitiesResolver,
      );

      return {
        document: toPublicSaleEvidence(committedDoc!),
        invoice: committedInvoice,
        replayed: false,
      };
    });

    return result;
  } catch (txError) {
    if (
      txError instanceof SalesEvidenceConflictError ||
      txError instanceof SalesEvidenceAuthorizationError
    ) {
      throw txError;
    }

    try {
      const committed = await prisma.document.findFirst({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          deletedAt: null,
          ...(actor.role === "MANAGER"
            ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
            : {}),
        },
      });

      if (
        committed &&
        committed.saleRecoveryStatus === "ATTACHED" &&
        committed.linkedEntityType === "Invoice" &&
        committed.linkedEntityId === input.invoiceId
      ) {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Document",
            entityId: committed.id,
            action: "SALES_EVIDENCE_ATTACHED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });

        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          attachmentObservationsMatch(meta, committed) &&
          meta.invoiceId === input.invoiceId &&
          meta.reference?.billNo === input.reference.billNo &&
          meta.reference?.externalDocumentType === input.reference.externalDocumentType &&
          meta.reference?.externalBillDate === input.reference.externalBillDate &&
          (meta.reason ?? null) === input.reason.trim() &&
          (meta.duplicateOverrideReason ?? null) ===
            (input.duplicateOverrideReason?.trim() || null) &&
          expectedRecordsEqual(input.expectedInvoice, meta.previousInvoice ?? {})
        ) {
          logger.warn(
            "Transaction error encountered but document attachment was committed and verified with audit; returning replayed attachment",
            { documentId },
          );
          return {
            document: toPublicSaleEvidence(committed),
            invoice: await getManualBillRecord(
              input.invoiceId,
              actor as any,
              prisma,
              capabilitiesResolver,
            ),
            replayed: true,
          };
        }
      }
    } catch (reconcileErr) {
      logger.error("Failed to reconcile attach existence after transaction failure", {
        documentId,
        txError,
        reconcileErr,
      });
    }

    throw txError;
  }
}
