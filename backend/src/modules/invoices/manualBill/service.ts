import type {
  BillRecordStatus,
  DocumentVisibility,
  ExternalDocumentType,
  Prisma,
} from "@prisma/client";
import prisma from "../../../db/prisma";
import { parseBusinessDate } from "../../../lib/businessDate";
import {
  lockInvoiceForUpdate,
  runFinancialTransaction,
} from "../../../lib/transactionLocks";
import {
  getDocumentFilePath,
  getDocumentThumbnailFilePath,
} from "../../documents/service";
import {
  getBusinessCapabilities,
  type BusinessCapabilities,
} from "../../settings/capabilities";
import {
  ManualBillAuthorizationError,
  ManualBillConflictError,
  ManualBillNotFoundError,
  ManualBillValidationError,
  type AttachedProofSummary,
  type DuplicateReferenceWarning,
  type ExpectedManualBillRecord,
  type ListManualBillQueueInput,
  type ManualBillActor,
  type ManualBillAuditEntry,
  type ManualBillQueueItem,
  type ManualBillQueueResponse,
  type PublicManualBillRecord,
  type RecordReferenceInput,
  type VerifyReferenceInput,
  type MarkMissingInput,
  type WithdrawReferenceInput,
} from "./types";
import {
  listManualBillQueueSchema,
  markMissingSchema,
  recordReferenceSchema,
  verifyReferenceSchema,
  withdrawReferenceSchema,
  expectedManualBillRecordSchema,
} from "./validation";

export function formatUtcCalendarDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveHistoricalCustomer(inv: {
  customerSnapshotCapturedAt?: Date | string | null;
  customerNameSnapshot?: string | null;
  customerPanSnapshot?: string | null;
  customer?: { name?: string | null; panNo?: string | null } | null;
}): { name: string | null; panNo: string | null } {
  if (inv.customerSnapshotCapturedAt != null) {
    return {
      name: inv.customerNameSnapshot ? inv.customerNameSnapshot.trim() || null : null,
      panNo: inv.customerPanSnapshot ? inv.customerPanSnapshot.trim() || null : null,
    };
  }

  const liveName = inv.customer?.name ? inv.customer.name.trim() || null : null;
  const livePan = inv.customer?.panNo ? inv.customer.panNo.trim() || null : null;

  return {
    name: inv.customerNameSnapshot ? inv.customerNameSnapshot.trim() || null : liveName,
    panNo: inv.customerPanSnapshot ? inv.customerPanSnapshot.trim() || null : livePan,
  };
}

export async function assertManualBillOperator(
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<void> {
  if (!actor || !["ADMIN", "MANAGER", "CASHIER"].includes(actor.role)) {
    throw new ManualBillAuthorizationError(
      "Access denied — insufficient role for manual bill operations",
    );
  }

  const capabilities = await capabilitiesResolver();
  if (!capabilities.posEnabled) {
    throw new ManualBillAuthorizationError(
      `POS capability is disabled in ${capabilities.businessMode} mode`,
      "FEATURE_DISABLED",
    );
  }
}

export async function assertManualBillReviewer(
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<void> {
  if (!actor || !["ADMIN", "MANAGER"].includes(actor.role)) {
    throw new ManualBillAuthorizationError(
      "Access denied — supervisor or admin role required for manual bill review",
    );
  }

  const capabilities = await capabilitiesResolver();
  if (!capabilities.posEnabled) {
    throw new ManualBillAuthorizationError(
      `POS capability is disabled in ${capabilities.businessMode} mode`,
      "FEATURE_DISABLED",
    );
  }
}

export function isDocumentVisibleToActor(
  visibility: DocumentVisibility,
  actor: ManualBillActor,
): boolean {
  if (actor.role === "ADMIN") return true;
  if (actor.role === "MANAGER") {
    return visibility === "ALL_AUTHENTICATED" || visibility === "ADMIN_MANAGER";
  }
  if (actor.role === "CASHIER") {
    return visibility === "ALL_AUTHENTICATED";
  }
  return false;
}

export async function initializeManualBillMetadataTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  if (!tx.businessSettings) return;

  const settings = await tx.businessSettings.findUnique({
    where: { id: 1 },
    select: { defaultBillingChannel: true },
  });

  if (settings?.defaultBillingChannel === "MANUAL_EXTERNAL" && tx.invoice) {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        billingChannel: "MANUAL_EXTERNAL",
        billRecordStatus: "PENDING",
      },
    });
  }
}

export async function cancelManualBillObligationTx(
  tx: Prisma.TransactionClient,
  invoice: {
    id: string;
    invoiceNo: string;
    billRecordStatus?: BillRecordStatus | null;
    billingChannel?: string | null;
  },
  actorId: string,
  actor?: { name?: string | null; role?: string | null } | null,
): Promise<void> {
  if (
    invoice.billRecordStatus === "PENDING" ||
    invoice.billRecordStatus === "MISSING"
  ) {
    if (tx.invoice) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          billRecordStatus: null,
        },
      });
    }

    if (tx.auditLog) {
      await tx.auditLog.create({
        data: {
          actorId,
          action: "MANUAL_BILL_OBLIGATION_CLEARED",
          entityType: "Invoice",
          entityId: invoice.id,
          meta: {
            invoiceNo: invoice.invoiceNo,
            previousStatus: invoice.billRecordStatus,
            newStatus: null,
            billingChannel: invoice.billingChannel || null,
            actorName: actor?.name || null,
            actorRole: actor?.role || null,
            reason: "Finalized invoice cancelled or modified",
          },
        },
      });
    }
  }
}

function extractCurrentExpectedRecord(invoice: {
  billingChannel: any;
  externalDocumentType: any;
  externalBillNo: any;
  externalBillDate: any;
  billRecordStatus: any;
}): ExpectedManualBillRecord {
  return {
    billingChannel: invoice.billingChannel ?? null,
    externalDocumentType: invoice.externalDocumentType ?? null,
    externalBillNo: invoice.externalBillNo ?? null,
    externalBillDate: formatUtcCalendarDate(invoice.externalBillDate),
    billRecordStatus: invoice.billRecordStatus ?? null,
  };
}

export function expectedRecordsEqual(
  a: ExpectedManualBillRecord,
  b: ExpectedManualBillRecord | Record<string, any>,
): boolean {
  // Audit observations must be complete; absence never proves an observed null.
  if (!expectedManualBillRecordSchema.safeParse(a).success ||
      !expectedManualBillRecordSchema.safeParse(b).success) return false;
  return (
    (a.billingChannel ?? null) === (b.billingChannel ?? null) &&
    (a.externalDocumentType ?? null) === (b.externalDocumentType ?? null) &&
    (a.externalBillNo ?? null) === (b.externalBillNo ?? null) &&
    (a.externalBillDate ?? null) === (b.externalBillDate ?? null) &&
    (a.billRecordStatus ?? null) === (b.billRecordStatus ?? null)
  );
}

function assertExpectedMatches(
  current: ExpectedManualBillRecord,
  expected: ExpectedManualBillRecord,
  currentRecordForConflict?: PublicManualBillRecord,
): void {
  const matchChannel = (expected.billingChannel ?? null) === (current.billingChannel ?? null);
  const matchType = (expected.externalDocumentType ?? null) === (current.externalDocumentType ?? null);
  const matchNo = (expected.externalBillNo ?? null) === (current.externalBillNo ?? null);
  const matchDate = (expected.externalBillDate ?? null) === (current.externalBillDate ?? null);
  const matchStatus = (expected.billRecordStatus ?? null) === (current.billRecordStatus ?? null);

  if (!matchChannel || !matchType || !matchNo || !matchDate || !matchStatus) {
    throw new ManualBillConflictError(
      "The manual paper bill record was modified by another user. Please refresh and review the updated details.",
      "STALE_RECORD_CONFLICT",
      { currentRecord: currentRecordForConflict },
    );
  }
}

export async function findDuplicateReferencesTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  externalDocumentType: ExternalDocumentType,
  externalBillNo: string,
  externalBillDate: Date,
): Promise<DuplicateReferenceWarning[]> {
  const duplicates = await tx.invoice.findMany({
    where: {
      id: { not: invoiceId },
      externalDocumentType,
      externalBillNo,
      externalBillDate,
      status: "FINALIZED",
      cancelledAt: null,
      deletedAt: null,
      paymentStatus: { not: "CANCELLED" },
    },
    select: {
      id: true,
      invoiceNo: true,
      externalBillNo: true,
      externalBillDate: true,
      externalDocumentType: true,
      finalizedAt: true,
    },
    take: 20,
  });

  return duplicates.map((d) => ({
    invoiceId: d.id,
    invoiceNo: d.invoiceNo,
    externalBillNo: d.externalBillNo ?? "",
    externalBillDate: formatUtcCalendarDate(d.externalBillDate) ?? "",
    externalDocumentType: d.externalDocumentType as ExternalDocumentType,
    finalizedAt: d.finalizedAt,
  }));
}

export async function getManualBillRecord(
  invoiceId: string,
  actor: ManualBillActor,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicManualBillRecord> {
  await assertManualBillOperator(actor, capabilitiesResolver);

  const invoice = await db.invoice.findFirst({
    where: {
      id: invoiceId,
      deletedAt: null,
    },
    include: {
      customer: { select: { id: true, name: true, panNo: true } },
      creditNotesAsOriginal: { select: { id: true, replacementInvoiceId: true } },
      creditNoteAsReplacement: { select: { id: true, originalInvoiceId: true } },
    },
  });

  if (!invoice) {
    throw new ManualBillNotFoundError("Invoice not found or deleted");
  }

  const attachedDocs = await db.document.findMany({
    where: {
      linkedEntityType: "Invoice",
      linkedEntityId: invoice.id,
      documentType: "SALE_BILL",
      saleRecoveryStatus: "ATTACHED",
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  const permittedProofs: AttachedProofSummary[] = attachedDocs
    .filter((doc) => isDocumentVisibleToActor(doc.visibility, actor))
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      fileSize: doc.fileSize,
      thumbnailFileName: doc.thumbnailFileName,
      visibility: doc.visibility,
      saleRecoveryStatus: doc.saleRecoveryStatus,
      createdAt: doc.createdAt,
      fileUrl: `/api/invoices/manual-bills/${invoice.id}/proofs/${doc.id}/file`,
      thumbnailUrl: doc.thumbnailFileName
        ? `/api/invoices/manual-bills/${invoice.id}/proofs/${doc.id}/thumbnail`
        : null,
    }));

  const permittedProofIds = new Set(permittedProofs.map((p) => p.id));

  const auditLogs = await db.auditLog.findMany({
    where: {
      entityType: "Invoice",
      entityId: invoice.id,
      action: {
        in: [
          "MANUAL_BILL_REFERENCE_RECORDED",
          "MANUAL_BILL_REFERENCE_VERIFIED",
          "MANUAL_BILL_REFERENCE_WITHDRAWN",
          "MANUAL_BILL_MARKED_MISSING",
          "MANUAL_BILL_ATTACHED",
          "MANUAL_BILL_OBLIGATION_CLEARED",
          "SALES_EVIDENCE_ATTACHED",
        ],
      },
    },
    include: {
      actor: { select: { id: true, name: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const history: ManualBillAuditEntry[] = [];
  for (const log of auditLogs) {
    const rawMeta = (log.meta as Record<string, unknown>) ?? {};
    if (log.action === "MANUAL_BILL_ATTACHED" || log.action === "SALES_EVIDENCE_ATTACHED") {
      const docId = (rawMeta.documentId as string | undefined) || (log.entityType === "Document" ? log.entityId : undefined);
      // B-6: If actor does not have visibility to this proof document, completely hide the event/metadata
      if (!docId || !permittedProofIds.has(docId)) {
        continue;
      }
      history.push({
        id: log.id,
        action: log.action,
        actorId: log.actorId,
        actorName: log.actor?.name ?? null,
        actorRole: log.actor?.role ?? null,
        meta: {
          invoiceNo: rawMeta.invoiceNo ?? invoice.invoiceNo,
          reference: rawMeta.reference ?? null,
          documentId: rawMeta.documentId ?? docId,
          documentTitle: rawMeta.documentTitle ?? null,
          reason: rawMeta.reason ?? null,
          duplicateOverrideReason: rawMeta.duplicateOverrideReason ?? null,
        },
        createdAt: log.createdAt,
      });
      continue;
    }

    history.push({
      id: log.id,
      action: log.action,
      actorId: log.actorId,
      actorName: log.actor?.name ?? null,
      actorRole: log.actor?.role ?? null,
      meta: {
        invoiceNo: rawMeta.invoiceNo ?? invoice.invoiceNo,
        previousStatus: rawMeta.previousStatus ?? null,
        newStatus: rawMeta.newStatus ?? null,
        targetStatus: rawMeta.targetStatus ?? null,
        previous: rawMeta.previous ?? null,
        current: rawMeta.current ?? null,
        reason: rawMeta.reason ?? null,
        duplicateOverrideReason: rawMeta.duplicateOverrideReason ?? null,
      },
      createdAt: log.createdAt,
    });
  }

  const replacementInvoiceId =
    invoice.creditNotesAsOriginal?.[0]?.replacementInvoiceId ?? null;
  const originalInvoiceId =
    invoice.creditNoteAsReplacement?.originalInvoiceId ?? null;

  const historicalCustomer = resolveHistoricalCustomer(invoice);

  return {
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    status: invoice.status,
    billingChannel: invoice.billingChannel,
    externalDocumentType: invoice.externalDocumentType,
    externalBillNo: invoice.externalBillNo,
    externalBillDate: formatUtcCalendarDate(invoice.externalBillDate),
    billRecordStatus: invoice.billRecordStatus,
    netTotal: invoice.netTotal,
    finalizedAt: invoice.finalizedAt,
    cancelledAt: invoice.cancelledAt,
    paymentStatus: invoice.paymentStatus,
    customerName: historicalCustomer.name,
    customerPan: historicalCustomer.panNo,
    replacementInvoiceId,
    originalInvoiceId,
    attachedProofs: permittedProofs,
    history,
  };
}

export async function listManualBillQueue(
  rawInput: ListManualBillQueueInput,
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<ManualBillQueueResponse> {
  await assertManualBillOperator(actor, capabilitiesResolver);
  const input = listManualBillQueueSchema.parse(rawInput);

  const where: Prisma.InvoiceWhereInput = {
    status: "FINALIZED",
    cancelledAt: null,
    deletedAt: null,
    paymentStatus: { not: "CANCELLED" },
    billingChannel: "MANUAL_EXTERNAL",
  };

  if (input.status === "PENDING") {
    where.billRecordStatus = "PENDING";
  } else if (input.status === "MISSING") {
    where.billRecordStatus = "MISSING";
  } else {
    where.billRecordStatus = { in: ["PENDING", "MISSING"] };
  }

  if (input.search) {
    where.OR = [
      { invoiceNo: { contains: input.search } },
      { externalBillNo: { contains: input.search } },
      { customer: { name: { contains: input.search } } },
      { customerNameSnapshot: { contains: input.search } },
    ];
  }

  const [total, invoices] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        billingChannel: true,
        externalDocumentType: true,
        externalBillNo: true,
        externalBillDate: true,
        billRecordStatus: true,
        netTotal: true,
        finalizedAt: true,
        paymentStatus: true,
        customerSnapshotCapturedAt: true,
        customerNameSnapshot: true,
        customerPanSnapshot: true,
        customer: { select: { name: true, panNo: true } },
      },
      orderBy: [{ finalizedAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ]);

  const invoiceIds = invoices.map((i) => i.id);
  const documentCounts = await prisma.document.groupBy({
    by: ["linkedEntityId"],
    where: {
      linkedEntityType: "Invoice",
      linkedEntityId: { in: invoiceIds },
      documentType: "SALE_BILL",
      saleRecoveryStatus: "ATTACHED",
      deletedAt: null,
      ...(actor.role === "CASHIER"
        ? { visibility: "ALL_AUTHENTICATED" }
        : actor.role === "MANAGER"
          ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
          : {}),
    },
    _count: { id: true },
  });

  const countMap = new Map<string, number>();
  for (const row of documentCounts) {
    if (row.linkedEntityId) {
      countMap.set(row.linkedEntityId, row._count.id);
    }
  }

  const items: ManualBillQueueItem[] = invoices.map((inv) => {
    const historicalCustomer = resolveHistoricalCustomer(inv);
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      billingChannel: inv.billingChannel,
      externalDocumentType: inv.externalDocumentType,
      externalBillNo: inv.externalBillNo,
      externalBillDate: formatUtcCalendarDate(inv.externalBillDate),
      billRecordStatus: inv.billRecordStatus,
      netTotal: inv.netTotal,
      finalizedAt: inv.finalizedAt,
      paymentStatus: inv.paymentStatus,
      customerName: historicalCustomer.name,
      attachedProofCount: countMap.get(inv.id) ?? 0,
    };
  });

  const totalPages = Math.ceil(total / input.pageSize) || 1;

  return {
    items,
    total,
    page: input.page,
    pageSize: input.pageSize,
    totalPages,
  };
}

export async function recordManualBillReference(
  invoiceId: string,
  rawInput: RecordReferenceInput,
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicManualBillRecord> {
  await assertManualBillOperator(actor, capabilitiesResolver);
  const input = recordReferenceSchema.parse(rawInput);
  const parsedDate = parseBusinessDate(
    input.reference.externalBillDate,
    "externalBillDate",
  );

  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      await lockInvoiceForUpdate(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          customer: { select: { id: true, name: true } },
        },
      });

      if (!invoice || invoice.deletedAt !== null) {
        throw new ManualBillNotFoundError("Invoice not found or deleted");
      }

      if (invoice.status !== "FINALIZED") {
        throw new ManualBillConflictError(
          "Cannot record external bill reference on a draft invoice",
          "INVOICE_NOT_FINALIZED",
        );
      }

      if (invoice.cancelledAt !== null || invoice.paymentStatus === "CANCELLED") {
        throw new ManualBillConflictError(
          "Cannot record external bill reference on a cancelled invoice",
          "INVOICE_CANCELLED",
        );
      }

      if (invoice.billingChannel === "IRD_ELECTRONIC") {
        throw new ManualBillConflictError(
          "Cannot record manual paper bill reference on an electronic/IRD invoice",
          "UNSUPPORTED_BILLING_CHANNEL",
        );
      }

      const currentExpected = extractCurrentExpectedRecord(invoice);

      // 1. Idempotent replay check: matches target fields AND prior audit with matching intent/expected
      const isSameRef =
        invoice.externalBillNo === input.reference.billNo &&
        invoice.externalDocumentType === input.reference.externalDocumentType &&
        formatUtcCalendarDate(invoice.externalBillDate) ===
          input.reference.externalBillDate &&
        (invoice.billRecordStatus === "RECORDED" ||
          invoice.billRecordStatus === "VERIFIED");

      if (isSameRef) {
        const priorAudit = await tx.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_RECORDED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });

        const meta = (priorAudit?.meta as Record<string, any>) ?? {};
        const matchesAuditIntent =
          meta.current?.externalBillNo === input.reference.billNo &&
          meta.current?.externalDocumentType === input.reference.externalDocumentType &&
          meta.current?.externalBillDate === input.reference.externalBillDate &&
          (meta.reason ?? null) === (input.reason?.trim() || null) &&
          (meta.duplicateOverrideReason ?? null) ===
            (input.duplicateOverrideReason?.trim() || null) &&
          expectedRecordsEqual(input.expected, meta.previous ?? {});

        if (matchesAuditIntent) {
          return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
        }
      }

      // 2. If not a replay, determine if modifying an existing recorded reference
      const isFirstRecord =
        invoice.billRecordStatus === null ||
        invoice.billRecordStatus === "PENDING" ||
        invoice.billRecordStatus === "MISSING";

      if (!isFirstRecord) {
        if (actor.role !== "ADMIN" && actor.role !== "MANAGER") {
          throw new ManualBillAuthorizationError(
            "Only supervisors or administrators can modify an existing recorded paper reference",
          );
        }
        if (!input.reason?.trim()) {
          throw new ManualBillValidationError(
            "Reason is required to modify an existing recorded reference",
          );
        }
      }

      // 3. Stale-write conflict check
      assertExpectedMatches(
        currentExpected,
        input.expected,
        await getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver),
      );

      // 4. Duplicate check
      const duplicates = await findDuplicateReferencesTx(
        tx,
        invoiceId,
        input.reference.externalDocumentType,
        input.reference.billNo,
        parsedDate,
      );

      if (duplicates.length > 0) {
        if (!input.duplicateOverrideReason?.trim()) {
          throw new ManualBillConflictError(
            `Another active invoice already has paper bill reference ${input.reference.billNo}. Reviewer duplicate override reason is required.`,
            "DUPLICATE_REVIEW_REQUIRED",
            { duplicates },
          );
        }
        if (actor.role !== "ADMIN" && actor.role !== "MANAGER") {
          throw new ManualBillAuthorizationError(
            "Only supervisors or administrators can override duplicate paper bill warnings",
          );
        }
      }

      const newStatus: BillRecordStatus = "RECORDED";
      const previousFields = currentExpected;
      const targetBillingChannel = invoice.billingChannel || "MANUAL_EXTERNAL";

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          billingChannel: targetBillingChannel,
          externalBillNo: input.reference.billNo,
          externalBillDate: parsedDate,
          externalDocumentType: input.reference.externalDocumentType,
          billRecordStatus: newStatus,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "MANUAL_BILL_REFERENCE_RECORDED",
          entityType: "Invoice",
          entityId: invoiceId,
          meta: {
            invoiceNo: invoice.invoiceNo,
            actorName: user?.name || null,
            actorRole: user?.role || null,
            previous: previousFields as unknown as Prisma.InputJsonObject,
            current: {
              externalBillNo: input.reference.billNo,
              externalBillDate: input.reference.externalBillDate,
              externalDocumentType: input.reference.externalDocumentType,
              billRecordStatus: newStatus,
              billingChannel: targetBillingChannel,
            },
            reason: input.reason?.trim() || null,
            duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
            duplicateCount: duplicates.length,
            isFirstRecord,
          },
        },
      });

      return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
    });
  } catch (txError) {
    if (
      txError instanceof ManualBillConflictError ||
      txError instanceof ManualBillAuthorizationError ||
      txError instanceof ManualBillValidationError ||
      txError instanceof ManualBillNotFoundError
    ) {
      throw txError;
    }

    try {
      const committedInvoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
      });
      if (
        committedInvoice &&
        committedInvoice.billRecordStatus === "RECORDED" &&
        committedInvoice.externalBillNo === input.reference.billNo &&
        committedInvoice.externalDocumentType === input.reference.externalDocumentType &&
        formatUtcCalendarDate(committedInvoice.externalBillDate) === input.reference.externalBillDate
      ) {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_RECORDED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          meta.current?.externalBillNo === input.reference.billNo &&
          meta.current?.externalDocumentType === input.reference.externalDocumentType &&
          meta.current?.externalBillDate === input.reference.externalBillDate &&
          (meta.reason ?? null) === (input.reason?.trim() || null) &&
          (meta.duplicateOverrideReason ?? null) === (input.duplicateOverrideReason?.trim() || null) &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return await getManualBillRecord(invoiceId, actor, prisma, capabilitiesResolver);
        }
      }
    } catch {
      // ignore reconcile error and throw original txError
    }

    throw txError;
  }
}

export async function verifyManualBillReference(
  invoiceId: string,
  rawInput: VerifyReferenceInput,
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicManualBillRecord> {
  await assertManualBillReviewer(actor, capabilitiesResolver);
  const input = verifyReferenceSchema.parse(rawInput);

  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      await lockInvoiceForUpdate(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
      });

      if (!invoice || invoice.deletedAt !== null) {
        throw new ManualBillNotFoundError("Invoice not found or deleted");
      }

      if (invoice.status !== "FINALIZED") {
        throw new ManualBillConflictError(
          "Cannot verify paper bill on a draft invoice",
          "INVOICE_NOT_FINALIZED",
        );
      }

      if (invoice.cancelledAt !== null || invoice.paymentStatus === "CANCELLED") {
        throw new ManualBillConflictError(
          "Cannot verify paper bill on a cancelled invoice",
          "INVOICE_CANCELLED",
        );
      }

      if (invoice.billingChannel === "IRD_ELECTRONIC") {
        throw new ManualBillConflictError(
          "Cannot verify manual paper bill on an electronic/IRD invoice",
          "UNSUPPORTED_BILLING_CHANNEL",
        );
      }

      const currentExpected = extractCurrentExpectedRecord(invoice);

      if (invoice.billRecordStatus === "VERIFIED") {
        const latestAudit = await tx.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_VERIFIED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });

        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        const matchesVerificationAudit =
          (meta.reason ?? null) === input.reason.trim() &&
          expectedRecordsEqual(input.expected, meta.previous ?? {});

        if (matchesVerificationAudit) {
          return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
        }
      }

      assertExpectedMatches(
        currentExpected,
        input.expected,
        await getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver),
      );

      if (invoice.billRecordStatus !== "RECORDED") {
        throw new ManualBillConflictError(
          "Only recorded manual paper bills can be verified",
          "INVALID_RECORD_STATUS",
        );
      }

      if (
        !invoice.externalBillNo ||
        !invoice.externalBillDate ||
        !invoice.externalDocumentType
      ) {
        throw new ManualBillValidationError(
          "Cannot verify reference with missing paper bill number, date, or type",
        );
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          billRecordStatus: "VERIFIED",
        },
      });

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "MANUAL_BILL_REFERENCE_VERIFIED",
          entityType: "Invoice",
          entityId: invoiceId,
          meta: {
            invoiceNo: invoice.invoiceNo,
            actorName: user?.name || null,
            actorRole: user?.role || null,
            previous: currentExpected as unknown as Prisma.InputJsonObject,
            previousStatus: invoice.billRecordStatus,
            newStatus: "VERIFIED",
            externalBillNo: invoice.externalBillNo,
            externalBillDate: formatUtcCalendarDate(invoice.externalBillDate),
            externalDocumentType: invoice.externalDocumentType,
            reason: input.reason.trim(),
          },
        },
      });

      return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
    });
  } catch (txError) {
    if (
      txError instanceof ManualBillConflictError ||
      txError instanceof ManualBillAuthorizationError ||
      txError instanceof ManualBillValidationError ||
      txError instanceof ManualBillNotFoundError
    ) {
      throw txError;
    }

    try {
      const committedInvoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
      });
      if (committedInvoice && committedInvoice.billRecordStatus === "VERIFIED") {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_VERIFIED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          (meta.reason ?? null) === input.reason.trim() &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return await getManualBillRecord(invoiceId, actor, prisma, capabilitiesResolver);
        }
      }
    } catch {
      // ignore
    }

    throw txError;
  }
}

export async function markManualBillMissing(
  invoiceId: string,
  rawInput: MarkMissingInput,
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicManualBillRecord> {
  await assertManualBillReviewer(actor, capabilitiesResolver);
  const input = markMissingSchema.parse(rawInput);

  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      await lockInvoiceForUpdate(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
      });

      if (!invoice || invoice.deletedAt !== null) {
        throw new ManualBillNotFoundError("Invoice not found or deleted");
      }

      if (invoice.status !== "FINALIZED") {
        throw new ManualBillConflictError(
          "Cannot mark paper bill missing on a draft invoice",
          "INVOICE_NOT_FINALIZED",
        );
      }

      if (invoice.cancelledAt !== null || invoice.paymentStatus === "CANCELLED") {
        throw new ManualBillConflictError(
          "Cannot mark paper bill missing on a cancelled invoice",
          "INVOICE_CANCELLED",
        );
      }

      if (invoice.billingChannel === "IRD_ELECTRONIC") {
        throw new ManualBillConflictError(
          "Cannot mark paper bill missing on an electronic/IRD invoice",
          "UNSUPPORTED_BILLING_CHANNEL",
        );
      }

      const currentExpected = extractCurrentExpectedRecord(invoice);

      if (
        invoice.billRecordStatus === "MISSING" &&
        !invoice.externalBillNo &&
        !invoice.externalBillDate &&
        !invoice.externalDocumentType
      ) {
        const latestAudit = await tx.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_MARKED_MISSING",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          (meta.reason ?? null) === input.reason.trim() &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
        }
      }

      assertExpectedMatches(
        currentExpected,
        input.expected,
        await getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver),
      );

      const previous = currentExpected;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          billingChannel: invoice.billingChannel || "MANUAL_EXTERNAL",
          externalBillNo: null,
          externalBillDate: null,
          externalDocumentType: null,
          billRecordStatus: "MISSING",
        },
      });

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "MANUAL_BILL_MARKED_MISSING",
          entityType: "Invoice",
          entityId: invoiceId,
          meta: {
            invoiceNo: invoice.invoiceNo,
            actorName: user?.name || null,
            actorRole: user?.role || null,
            previous: previous as unknown as Prisma.InputJsonObject,
            newStatus: "MISSING",
            reason: input.reason.trim(),
          },
        },
      });

      return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
    });
  } catch (txError) {
    if (
      txError instanceof ManualBillConflictError ||
      txError instanceof ManualBillAuthorizationError ||
      txError instanceof ManualBillValidationError ||
      txError instanceof ManualBillNotFoundError
    ) {
      throw txError;
    }

    try {
      const committedInvoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
      });
      if (
        committedInvoice &&
        committedInvoice.billRecordStatus === "MISSING" &&
        !committedInvoice.externalBillNo &&
        !committedInvoice.externalBillDate &&
        !committedInvoice.externalDocumentType
      ) {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_MARKED_MISSING",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          (meta.reason ?? null) === input.reason.trim() &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return await getManualBillRecord(invoiceId, actor, prisma, capabilitiesResolver);
        }
      }
    } catch {
      // ignore
    }

    throw txError;
  }
}

export async function withdrawManualBillReference(
  invoiceId: string,
  rawInput: WithdrawReferenceInput,
  actor: ManualBillActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PublicManualBillRecord> {
  await assertManualBillReviewer(actor, capabilitiesResolver);
  const input = withdrawReferenceSchema.parse(rawInput);

  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      await lockInvoiceForUpdate(tx, invoiceId);

      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
      });

      if (!invoice || invoice.deletedAt !== null) {
        throw new ManualBillNotFoundError("Invoice not found or deleted");
      }

      if (invoice.status !== "FINALIZED") {
        throw new ManualBillConflictError(
          "Cannot withdraw paper bill reference on a draft invoice",
          "INVOICE_NOT_FINALIZED",
        );
      }

      if (invoice.cancelledAt !== null || invoice.paymentStatus === "CANCELLED") {
        throw new ManualBillConflictError(
          "Cannot withdraw paper bill reference on a cancelled invoice",
          "INVOICE_CANCELLED",
        );
      }

      if (invoice.billingChannel === "IRD_ELECTRONIC") {
        throw new ManualBillConflictError(
          "Cannot withdraw paper bill reference on an electronic/IRD invoice",
          "UNSUPPORTED_BILLING_CHANNEL",
        );
      }

      const currentExpected = extractCurrentExpectedRecord(invoice);

      if (
        invoice.billRecordStatus === input.targetStatus &&
        !invoice.externalBillNo &&
        !invoice.externalBillDate &&
        !invoice.externalDocumentType
      ) {
        const latestAudit = await tx.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_WITHDRAWN",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          (meta.reason ?? null) === input.reason.trim() &&
          meta.targetStatus === input.targetStatus &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
        }
      }

      assertExpectedMatches(
        currentExpected,
        input.expected,
        await getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver),
      );

      const previous = currentExpected;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          externalBillNo: null,
          externalBillDate: null,
          externalDocumentType: null,
          billRecordStatus: input.targetStatus,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "MANUAL_BILL_REFERENCE_WITHDRAWN",
          entityType: "Invoice",
          entityId: invoiceId,
          meta: {
            invoiceNo: invoice.invoiceNo,
            actorName: user?.name || null,
            actorRole: user?.role || null,
            previous: previous as unknown as Prisma.InputJsonObject,
            targetStatus: input.targetStatus,
            reason: input.reason.trim(),
          },
        },
      });

      return getManualBillRecord(invoiceId, actor, tx, capabilitiesResolver);
    });
  } catch (txError) {
    if (
      txError instanceof ManualBillConflictError ||
      txError instanceof ManualBillAuthorizationError ||
      txError instanceof ManualBillValidationError ||
      txError instanceof ManualBillNotFoundError
    ) {
      throw txError;
    }

    try {
      const committedInvoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
      });
      if (
        committedInvoice &&
        committedInvoice.billRecordStatus === input.targetStatus &&
        !committedInvoice.externalBillNo &&
        !committedInvoice.externalBillDate &&
        !committedInvoice.externalDocumentType
      ) {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Invoice",
            entityId: invoiceId,
            action: "MANUAL_BILL_REFERENCE_WITHDRAWN",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const meta = (latestAudit?.meta as Record<string, any>) ?? {};
        if (
          latestAudit &&
          (meta.reason ?? null) === input.reason.trim() &&
          meta.targetStatus === input.targetStatus &&
          expectedRecordsEqual(input.expected, meta.previous ?? {})
        ) {
          return await getManualBillRecord(invoiceId, actor, prisma, capabilitiesResolver);
        }
      }
    } catch {
      // ignore
    }

    throw txError;
  }
}

export async function getManualBillProofFile(
  invoiceId: string,
  documentId: string,
  actor: ManualBillActor,
  isThumbnail = false,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<{ filePath: string; mimeType: string; fileName: string }> {
  await assertManualBillOperator(actor, capabilitiesResolver);

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    select: { id: true },
  });

  if (!invoice) {
    throw new ManualBillNotFoundError("Invoice not found");
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      linkedEntityType: "Invoice",
      linkedEntityId: invoice.id,
      documentType: "SALE_BILL",
      saleRecoveryStatus: "ATTACHED",
      deletedAt: null,
    },
  });

  if (!document) {
    throw new ManualBillNotFoundError("Attached proof not found");
  }

  if (!isDocumentVisibleToActor(document.visibility, actor)) {
    // Existence hiding: return 404
    throw new ManualBillNotFoundError("Attached proof not found");
  }

  if (isThumbnail) {
    if (!document.thumbnailFileName) {
      throw new ManualBillNotFoundError("Proof thumbnail not found");
    }
    const filePath = getDocumentThumbnailFilePath(document);
    if (!filePath) {
      throw new ManualBillNotFoundError("Proof thumbnail not found on disk");
    }
    return {
      filePath,
      mimeType: "image/webp",
      fileName: `${document.id}-thumb.webp`,
    };
  }

  const filePath = getDocumentFilePath(document);
  if (!filePath) {
    throw new ManualBillNotFoundError("Proof file not found on disk");
  }
  return {
    filePath,
    mimeType: document.mimeType,
    fileName: document.fileName,
  };
}
