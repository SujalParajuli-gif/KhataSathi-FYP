import prisma from "../../db/prisma";
import { permanentlyDeleteDocument, restoreDocument } from "../documents/service";
import {
  isSaleEvidenceSnapshot,
  SaleEvidenceProtectedError,
  isPurchaseEvidenceSnapshot,
  PurchaseEvidenceProtectedError,
} from "../documents/protection";
import { removeImportSource } from "../products/importSourceStorage";

async function removeStoredBatchSource(batchId: string) {
  const source = await prisma.productImportBatch.findUnique({
    where: { id: batchId },
    select: { sourceStoredPath: true, sourceStoredFileName: true },
  });
  if (source) await removeImportSource(source);
}

const AUTO_PURGE_ENTITY_TYPES = ["Document", "ProductImportBatch"];

function binAction(entityType: string, suffix: "RESTORED" | "PURGED") {
  if (entityType === "Document") return `DOCUMENT_${suffix}`;
  if (entityType === "ProductImportBatch") return `PRODUCT_IMPORT_BATCH_${suffix}`;
  return `${entityType.toUpperCase()}_${suffix}`;
}

async function findSystemAuditActorId() {
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { role: "ADMIN", isActive: true },
        { role: "ADMIN" },
        { isActive: true },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  return user?.id || null;
}

export async function listBin(filters: {
  entityType?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, filters.page || 1);
  const pageSize = Math.max(1, Math.min(100, filters.pageSize || 30));
  const where: any = { purgedAt: null };
  if (filters.entityType) where.entityType = filters.entityType;

  const [records, total] = await Promise.all([
    prisma.softDeleteRecord.findMany({
      where,
      include: { deletedBy: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.softDeleteRecord.count({ where }),
  ]);

  return {
    records,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function restoreBinRecord(id: string, actorId: string) {
  const record = await prisma.softDeleteRecord.findFirst({
    where: { id, purgedAt: null },
  });
  if (!record) throw new Error("Bin record not found");

  if (record.entityType === "Document") {
    if (isSaleEvidenceSnapshot(record.entitySnapshot)) {
      throw new SaleEvidenceProtectedError();
    }
    if (isPurchaseEvidenceSnapshot(record.entitySnapshot)) {
      throw new PurchaseEvidenceProtectedError();
    }
    await restoreDocument(record.entityId);
  } else if (record.entityType === "ProductImportBatch") {
    await prisma.productImportBatch.update({
      where: { id: record.entityId },
      data: {
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        purgeAfter: null,
      },
    });
  } else {
    throw new Error(`Restore is not supported for ${record.entityType}`);
  }

  await prisma.$transaction([
    prisma.softDeleteRecord.delete({ where: { id } }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: binAction(record.entityType, "RESTORED"),
        entityType: record.entityType,
        entityId: record.entityId,
        meta: {
          entityLabel: record.entityLabel,
          originalDeletedAt: record.createdAt,
        },
      },
    }),
  ]);

  return { restored: true, record };
}

export async function permanentlyDeleteBinRecord(id: string, actorId: string) {
  const record = await prisma.softDeleteRecord.findFirst({
    where: { id, purgedAt: null },
  });
  if (!record) throw new Error("Bin record not found");

  if (record.entityType === "Document") {
    if (isSaleEvidenceSnapshot(record.entitySnapshot)) {
      throw new SaleEvidenceProtectedError();
    }
    if (isPurchaseEvidenceSnapshot(record.entitySnapshot)) {
      throw new PurchaseEvidenceProtectedError();
    }
    await permanentlyDeleteDocument(record.entityId);
  } else if (record.entityType === "ProductImportBatch") {
    await removeStoredBatchSource(record.entityId);
    await prisma.$transaction([
      prisma.productImportRow.deleteMany({ where: { batchId: record.entityId } }),
      prisma.productImportBatch.deleteMany({ where: { id: record.entityId } }),
    ]);
  } else {
    throw new Error(`Permanent delete is not supported for ${record.entityType}`);
  }

  await prisma.$transaction([
    prisma.softDeleteRecord.update({
      where: { id },
      data: { purgedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        actorId,
        action: binAction(record.entityType, "PURGED"),
        entityType: record.entityType,
        entityId: record.entityId,
        meta: {
          entityLabel: record.entityLabel,
          deletedAt: record.createdAt,
        },
      },
    }),
  ]);

  return { purged: true, record };
}

export async function runDueBinPurge(now = new Date()) {
  const result = {
    documents: 0,
    protectedDocuments: 0,
    productImportBatches: 0,
    alerts: 0,
    failed: 0,
    failures: [] as Array<{
      recordId: string;
      entityType: string;
      entityId: string;
      message: string;
    }>,
  };

  const MAX_DESTRUCTIVE_ATTEMPTS = 100;
  const PAGE_SIZE = 100;
  let destructiveAttempts = 0;
  let cursorId: string | null = null;

  while (destructiveAttempts < MAX_DESTRUCTIVE_ATTEMPTS) {
    const queryArgs: any = {
      where: {
        purgedAt: null,
        purgeAfter: { lte: now },
        entityType: { in: AUTO_PURGE_ENTITY_TYPES },
      },
      orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
    };

    if (cursorId) {
      queryArgs.cursor = { id: cursorId };
      queryArgs.skip = 1;
    }

    const dueRecords = await prisma.softDeleteRecord.findMany(queryArgs);
    if (dueRecords.length === 0) {
      break;
    }

    for (const record of dueRecords) {
      cursorId = record.id;
      try {
        if (record.entityType === "Document") {
          if (
            isSaleEvidenceSnapshot(record.entitySnapshot) ||
            isPurchaseEvidenceSnapshot(record.entitySnapshot)
          ) {
            result.protectedDocuments += 1;
            continue;
          }

          try {
            await permanentlyDeleteDocument(record.entityId);
          } catch (docError: any) {
            if (
              docError instanceof SaleEvidenceProtectedError ||
              docError?.code === "SALE_EVIDENCE_PROTECTED" ||
              docError instanceof PurchaseEvidenceProtectedError ||
              docError?.code === "PURCHASE_EVIDENCE_PROTECTED"
            ) {
              result.protectedDocuments += 1;
              continue;
            }
            throw docError;
          }

          await prisma.softDeleteRecord.update({
            where: { id: record.id },
            data: { purgedAt: new Date() },
          });
          result.documents += 1;
          destructiveAttempts += 1;
        } else if (record.entityType === "ProductImportBatch") {
          await removeStoredBatchSource(record.entityId);
          await prisma.$transaction([
            prisma.productImportRow.deleteMany({ where: { batchId: record.entityId } }),
            prisma.productImportBatch.deleteMany({ where: { id: record.entityId } }),
            prisma.softDeleteRecord.update({
              where: { id: record.id },
              data: { purgedAt: new Date() },
            }),
          ]);
          result.productImportBatches += 1;
          destructiveAttempts += 1;
        }
      } catch (error: any) {
        destructiveAttempts += 1;
        result.failed += 1;
        result.failures.push({
          recordId: record.id,
          entityType: record.entityType,
          entityId: record.entityId,
          message: error?.message || "Auto purge failed",
        });
      }

      if (destructiveAttempts >= MAX_DESTRUCTIVE_ATTEMPTS) {
        break;
      }
    }

    if (dueRecords.length < PAGE_SIZE) {
      break;
    }
  }

  const deletedAlerts = await prisma.userAlertRead.deleteMany({
    where: {
      deletedAt: { not: null },
      purgeAfter: { lte: now },
    },
  });
  result.alerts = deletedAlerts.count;

  const changed =
    result.documents > 0 ||
    result.productImportBatches > 0 ||
    result.alerts > 0 ||
    result.failed > 0;

  if (changed) {
    const actorId = await findSystemAuditActorId();
    if (actorId) {
      await prisma.auditLog.create({
        data: {
          actorId,
          action: "BIN_AUTO_PURGE",
          entityType: "System",
          entityId: "bin-auto-purge",
          meta: {
            ranAt: now.toISOString(),
            purgedDocuments: result.documents,
            protectedDocuments: result.protectedDocuments,
            purgedProductImportBatches: result.productImportBatches,
            purgedAlerts: result.alerts,
            failedCount: result.failed,
            failures: result.failures,
          },
        },
      });
    }
  }

  return result;
}
