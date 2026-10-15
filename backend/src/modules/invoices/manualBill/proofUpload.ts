import crypto from "node:crypto";
import prisma from "../../../db/prisma";
import { lockInvoiceForUpdate, runFinancialTransaction } from "../../../lib/transactionLocks";
import { logger } from "../../../lib/logger";
import { prepareDocumentFile, removePreparedDocumentFiles, type UploadedFileInfo } from "../../documents/service";
import { assertManualBillOperator, getManualBillRecord } from "./service";
import { ManualBillAuthorizationError, ManualBillConflictError, ManualBillNotFoundError, type ManualBillActor } from "./types";

function assertTarget(invoice: any, actor: ManualBillActor) {
  if (!invoice || invoice.deletedAt) throw new ManualBillNotFoundError("Invoice not found");
  if (actor.role === "CASHIER" && invoice.cashierId !== actor.id) throw new ManualBillAuthorizationError("Cashiers may upload proof only for their own sales.");
  if (invoice.status !== "FINALIZED" || invoice.cancelledAt || invoice.paymentStatus === "CANCELLED" || invoice.creditNotesAsOriginal?.some((note: any) => note.replacementInvoiceId)) {
    throw new ManualBillConflictError("Proof cannot be added to a draft, cancelled or replaced sale.", "INVOICE_NOT_ACTIVE");
  }
}

// Invoice-bound upload grants no unresolved-evidence review, transfer, deletion or posting rights.
export async function uploadInvoiceProof(invoiceId: string, file: UploadedFileInfo, actor: ManualBillActor) {
  await assertManualBillOperator(actor);
  const target = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { creditNotesAsOriginal: true } });
  assertTarget(target, actor);
  const documentId = crypto.randomUUID();
  const prepared = await prepareDocumentFile(file, documentId, "SALE_BILL");
  let keepPrepared = false;
  let workCompleted = false;
  try {
    const result = await runFinancialTransaction(prisma, async (tx: any) => {
      await lockInvoiceForUpdate(tx, invoiceId);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { creditNotesAsOriginal: true } });
      assertTarget(invoice, actor);
      const existing = await tx.document.findFirst({ where: { linkedEntityType: "Invoice", linkedEntityId: invoiceId,
        documentType: "SALE_BILL", saleRecoveryStatus: "ATTACHED", checksum: prepared.checksum, deletedAt: null } });
      if (existing) return { documentId: existing.id, replayed: true };
      if (actor.role === "CASHIER" && invoice.billRecordStatus === "VERIFIED") throw new ManualBillAuthorizationError("A reviewer must add proof to a verified record.");
      await tx.document.create({ data: { id: documentId, documentType: "SALE_BILL", title: file.originalname,
        fileName: prepared.fileName, storedFileName: prepared.storedFileName, storedPath: prepared.storedPath,
        mimeType: prepared.mimeType, fileSize: prepared.fileSize, checksum: prepared.checksum,
        thumbnailFileName: prepared.thumbnailFileName, thumbnailSize: prepared.thumbnailSize,
        linkedEntityType: "Invoice", linkedEntityId: invoiceId, visibility: "ALL_AUTHENTICATED",
        saleRecoveryStatus: "ATTACHED", uploadedById: actor.id } });
      if (invoice.billRecordStatus === "VERIFIED") await tx.invoice.update({ where: { id: invoiceId }, data: { billRecordStatus: "RECORDED" } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: "MANUAL_BILL_ATTACHED", entityType: "Invoice", entityId: invoiceId,
        meta: { documentId, checksum: prepared.checksum, previousStatus: invoice.billRecordStatus, source: "INVOICE_BOUND_UPLOAD" } } });
      workCompleted = true;
      return { documentId, replayed: false };
    });
    keepPrepared = !result.replayed;
    return { ...result, invoice: await getManualBillRecord(invoiceId, actor) };
  } catch (error) {
    // Preserve completed files on an ambiguous database result; never delete a committed proof.
    try { keepPrepared = workCompleted || Boolean(await prisma.document.findUnique({ where: { id: documentId }, select: { id: true } })); }
    catch (reconcileError) { keepPrepared = true; logger.error("Proof upload outcome uncertain; retaining prepared source", { documentId, reconcileError }); }
    throw error;
  } finally {
    if (!keepPrepared) await removePreparedDocumentFiles(prepared);
  }
}
