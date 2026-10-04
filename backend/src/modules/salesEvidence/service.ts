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
  createSaleEvidenceSchema,
  listSaleEvidenceSchema,
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

export class SalesEvidenceAuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SalesEvidenceAuthorizationError";
    this.code = code;
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
