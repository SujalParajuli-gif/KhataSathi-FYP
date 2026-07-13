import prisma from "../../db/prisma";
import { permanentlyDeleteDocument, restoreDocument } from "../documents/service";

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
    await permanentlyDeleteDocument(record.entityId);
  } else if (record.entityType === "ProductImportBatch") {
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
  const dueRecords = await prisma.softDeleteRecord.findMany({
    where: {
      purgedAt: null,
      purgeAfter: { lte: now },
      entityType: { in: AUTO_PURGE_ENTITY_TYPES },
    },
    orderBy: { purgeAfter: "asc" },
    take: 100,
  });

  const result = {
    documents: 0,
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

  for (const record of dueRecords) {
    try {
      if (record.entityType === "Document") {
        await permanentlyDeleteDocument(record.entityId);
        await prisma.softDeleteRecord.update({
          where: { id: record.id },
          data: { purgedAt: new Date() },
        });
        result.documents += 1;
      } else if (record.entityType === "ProductImportBatch") {
        await prisma.$transaction([
          prisma.productImportRow.deleteMany({ where: { batchId: record.entityId } }),
          prisma.productImportBatch.deleteMany({ where: { id: record.entityId } }),
          prisma.softDeleteRecord.update({
            where: { id: record.id },
            data: { purgedAt: new Date() },
          }),
        ]);
        result.productImportBatches += 1;
      }
    } catch (error: any) {
      result.failed += 1;
      result.failures.push({
        recordId: record.id,
        entityType: record.entityType,
        entityId: record.entityId,
        message: error?.message || "Auto purge failed",
      });
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
