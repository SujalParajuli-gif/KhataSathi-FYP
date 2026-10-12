import crypto from "node:crypto";
import fs from "node:fs";
import type { Prisma, Role } from "@prisma/client";
import prisma from "../../db/prisma";
import { lockInvoiceForUpdate, runFinancialTransaction } from "../../lib/transactionLocks";
import { parseBusinessDate } from "../../lib/businessDate";
import { getDocumentFilePath } from "../documents/service";
import { getBusinessCapabilities, type BusinessCapabilities } from "../settings/capabilities";
import { expectedRecordsEqual, findDuplicateReferencesTx, formatUtcCalendarDate, getManualBillRecord } from "../invoices/manualBill/service";
import { assertSalesEvidenceReviewer, SalesEvidenceConflictError, toPublicSaleEvidence, type SalesEvidenceActor } from "./service";
import { reassociateSaleEvidenceSchema, voidSaleEvidenceSchema, type ReassociateSaleEvidenceInput, type VoidSaleEvidenceInput } from "./validation";

function visibility(actor: SalesEvidenceActor): Prisma.DocumentWhereInput {
  return actor.role === "MANAGER" ? { visibility: { in: ["ADMIN_MANAGER", "ALL_AUTHENTICATED"] } } : {};
}
function observed(invoice: any) {
  return { billingChannel: invoice.billingChannel ?? null, externalDocumentType: invoice.externalDocumentType ?? null,
    externalBillNo: invoice.externalBillNo ?? null, externalBillDate: formatUtcCalendarDate(invoice.externalBillDate),
    billRecordStatus: invoice.billRecordStatus ?? null };
}
function documentObservation(doc: any) {
  return { id: doc.id, documentType: doc.documentType, visibility: doc.visibility,
    saleRecoveryStatus: doc.saleRecoveryStatus, linkedEntityType: doc.linkedEntityType, linkedEntityId: doc.linkedEntityId,
    recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey, recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash };
}
function sameObservation(a: any, b: any) {
  return !!a && Object.entries(b).every(([key, value]) => Object.prototype.hasOwnProperty.call(a, key) && a[key] === value);
}
function fingerprint(input: unknown, actor: SalesEvidenceActor) {
  return crypto.createHash("sha256").update(JSON.stringify({ actorId: actor.id, input })).digest("hex");
}
async function lockDocument(tx: Prisma.TransactionClient, id: string, actor: SalesEvidenceActor) {
  if (actor.role === "MANAGER") {
    await tx.$queryRaw`SELECT id FROM Document WHERE id = ${id} AND documentType = 'SALE_BILL' AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT id FROM Document WHERE id = ${id} AND documentType = 'SALE_BILL' FOR UPDATE`;
  }
}
function assertEligible(invoice: any) {
  if (!invoice || invoice.deletedAt || invoice.status !== "FINALIZED" || invoice.cancelledAt || invoice.paymentStatus === "CANCELLED" ||
      invoice.billingChannel === "IRD_ELECTRONIC" || invoice.creditNotesAsOriginal?.length || invoice.creditNoteAsReplacement) {
    throw new SalesEvidenceConflictError("Proof correction requires active finalized invoices without cancellation or replacement relationships", "INVOICE_INELIGIBLE");
  }
}
const invoiceInclude = { creditNotesAsOriginal: { select: { id: true } }, creditNoteAsReplacement: { select: { id: true } } };

export async function reassociateSaleEvidence(id: string, rawInput: ReassociateSaleEvidenceInput, actor: SalesEvidenceActor,
  resolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities) {
  await assertSalesEvidenceReviewer(actor, resolver);
  const input = reassociateSaleEvidenceSchema.parse(rawInput);
  const decisionHash = fingerprint(input, actor);
  const date = parseBusinessDate(input.reference.externalBillDate, "externalBillDate");
  const preflight = await prisma.document.findFirst({ where: { id, documentType: "SALE_BILL", deletedAt: null, ...visibility(actor) } });
  if (!preflight) throw new SalesEvidenceConflictError("Sales evidence not found", "NOT_FOUND");
  const file = getDocumentFilePath(preflight);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0 || !preflight.fileSize) {
    throw new SalesEvidenceConflictError("Sales evidence file is missing or empty", "INVALID_FILE");
  }
  async function replay(db: any, doc: any) {
    const audit = await db.auditLog.findFirst({ where: { entityType: "Document", entityId: id, action: "SALES_EVIDENCE_REASSOCIATED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const meta = audit?.meta as any;
    if (!meta || audit.actorId !== actor.id || meta.decisionHash !== decisionHash || doc.deletedAt ||
        !sameObservation(meta.currentDocument, documentObservation(doc))) return null;
    const source = await db.invoice.findUnique({ where: { id: input.expectedSourceInvoiceId } });
    const target = await db.invoice.findUnique({ where: { id: input.invoiceId } });
    if (!source || !target || !expectedRecordsEqual(meta.currentSource, observed(source)) || !expectedRecordsEqual(meta.currentTarget, observed(target))) return null;
    return { document: toPublicSaleEvidence(doc), sourceInvoice: await getManualBillRecord(source.id, { ...actor, role: actor.role as Role }, db, resolver),
      invoice: await getManualBillRecord(target.id, { ...actor, role: actor.role as Role }, db, resolver), replayed: true };
  }
  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      for (const invoiceId of [input.expectedSourceInvoiceId, input.invoiceId].sort()) await lockInvoiceForUpdate(tx, invoiceId);
      await lockDocument(tx, id, actor);
      // No consistent read occurs in this transaction before all row locks are held.
      const doc = await tx.document.findFirst({ where: { id, documentType: "SALE_BILL", deletedAt: null, ...visibility(actor) } });
      if (!doc) throw new SalesEvidenceConflictError("Sales evidence not found", "NOT_FOUND");
      const prior = await replay(tx, doc);
      if (prior) return prior;
      if (doc.saleRecoveryStatus !== "ATTACHED" || doc.linkedEntityType !== "Invoice" || doc.linkedEntityId !== input.expectedSourceInvoiceId) {
        throw new SalesEvidenceConflictError("The proof association changed. Refresh both sales before correcting it.", "STALE_ASSOCIATION", toPublicSaleEvidence(doc));
      }
      const source = await tx.invoice.findUnique({ where: { id: input.expectedSourceInvoiceId }, include: invoiceInclude });
      const target = await tx.invoice.findUnique({ where: { id: input.invoiceId }, include: invoiceInclude });
      assertEligible(source); assertEligible(target);
      const previousSource = observed(source), previousTarget = observed(target);
      if (!expectedRecordsEqual(input.expectedSourceInvoice, previousSource) || !expectedRecordsEqual(input.expectedInvoice, previousTarget)) {
        throw new SalesEvidenceConflictError("A paper record changed. Refresh both sales before correcting the association.", "STALE_RECORD_CONFLICT");
      }
      const duplicates = await findDuplicateReferencesTx(tx, input.invoiceId, input.reference.externalDocumentType, input.reference.billNo, date);
      if (duplicates.length && !input.duplicateOverrideReason) throw new SalesEvidenceConflictError("Duplicate paper reference requires reviewer justification", "DUPLICATE_REVIEW_REQUIRED");
      const claim = await tx.document.updateMany({ where: { id, documentType: "SALE_BILL", deletedAt: null, saleRecoveryStatus: "ATTACHED",
        linkedEntityType: "Invoice", linkedEntityId: input.expectedSourceInvoiceId, recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey,
        recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash, ...visibility(actor) }, data: { linkedEntityId: input.invoiceId } });
      if (claim.count !== 1) throw new SalesEvidenceConflictError("Proof was corrected by another reviewer", "CLAIM_CONFLICT");
      if (source!.billRecordStatus === "VERIFIED") await tx.invoice.update({ where: { id: source!.id }, data: { billRecordStatus: "RECORDED" } });
      await tx.invoice.update({ where: { id: target!.id }, data: { billingChannel: "MANUAL_EXTERNAL", externalBillNo: input.reference.billNo,
        externalBillDate: date, externalDocumentType: input.reference.externalDocumentType, billRecordStatus: "RECORDED" } });
      const currentSource = { ...previousSource, billRecordStatus: previousSource.billRecordStatus === "VERIFIED" ? "RECORDED" : previousSource.billRecordStatus };
      const currentTarget = { billingChannel: "MANUAL_EXTERNAL", externalBillNo: input.reference.billNo, externalBillDate: input.reference.externalBillDate,
        externalDocumentType: input.reference.externalDocumentType, billRecordStatus: "RECORDED" };
      const meta = { documentId: id, sourceInvoiceId: source!.id, targetInvoiceId: target!.id,
        previousDocument: documentObservation(doc), currentDocument: { ...documentObservation(doc), linkedEntityId: target!.id },
        previousSource, currentSource, previousTarget, currentTarget, reference: input.reference,
        reason: input.reason, duplicateOverrideReason: input.duplicateOverrideReason ?? null, decisionHash,
        actorName: actor.name ?? null, actorRole: actor.role };
      const priorCorrection = await tx.auditLog.findFirst({ where: { entityType: "Document", entityId: id, action: "SALES_EVIDENCE_REASSOCIATED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const createdAt = new Date(Math.max(Date.now(), (priorCorrection?.createdAt.getTime() ?? 0) + 1));
      for (const [entityType, entityId] of [["Document", id], ["Invoice", source!.id], ["Invoice", target!.id]]) {
        await tx.auditLog.create({ data: { actorId: actor.id, action: "SALES_EVIDENCE_REASSOCIATED", entityType, entityId, meta, createdAt } });
      }
      return { document: toPublicSaleEvidence({ ...doc, linkedEntityId: target!.id }), sourceInvoice: await getManualBillRecord(source!.id, { ...actor, role: actor.role as Role }, tx, resolver),
        invoice: await getManualBillRecord(target!.id, { ...actor, role: actor.role as Role }, tx, resolver), replayed: false };
    });
  } catch (error) {
    if (error instanceof SalesEvidenceConflictError || (error as any)?.statusCode === 403) throw error;
    const doc = await prisma.document.findFirst({ where: { id, documentType: "SALE_BILL", ...visibility(actor) } });
    const committed = doc && await replay(prisma, doc);
    if (committed) return committed;
    throw error;
  }
}

export async function voidSaleEvidence(id: string, rawInput: VoidSaleEvidenceInput, actor: SalesEvidenceActor,
  resolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities) {
  await assertSalesEvidenceReviewer(actor, resolver);
  const input = voidSaleEvidenceSchema.parse(rawInput), decisionHash = fingerprint(input, actor);
  async function replay(db: any, doc: any) {
    if (!doc.deletedAt || doc.deletedById !== actor.id || doc.deleteReason !== input.reason || doc.purgeAfter !== null ||
      doc.saleRecoveryStatus !== input.expectedStatus || doc.linkedEntityType || doc.linkedEntityId || doc.recoveryCheckoutOperationKey || doc.recoveryCheckoutPayloadHash) return null;
    const audit = await db.auditLog.findFirst({ where: { entityType: "Document", entityId: id, action: "SALE_EVIDENCE_VOIDED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const meta = audit?.meta as any;
    return audit?.actorId === actor.id && meta?.decisionHash === decisionHash && sameObservation(meta.previousDocument, documentObservation(doc)) &&
      meta?.deletedAt === doc.deletedAt.toISOString() ? { document: toPublicSaleEvidence(doc), replayed: true } : null;
  }
  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      await lockDocument(tx, id, actor);
      const doc = await tx.document.findFirst({ where: { id, documentType: "SALE_BILL", ...visibility(actor) } });
      if (!doc) throw new SalesEvidenceConflictError("Sales evidence not found", "NOT_FOUND");
      const prior = await replay(tx, doc); if (prior) return prior;
      if (doc.deletedAt || doc.saleRecoveryStatus !== input.expectedStatus || doc.linkedEntityType || doc.linkedEntityId || doc.recoveryCheckoutOperationKey || doc.recoveryCheckoutPayloadHash) {
        throw new SalesEvidenceConflictError("Only an unlinked, unprepared mistaken upload can be voided. Refresh the outcome.", "VOID_CONFLICT", toPublicSaleEvidence(doc));
      }
      const deletedAt = new Date();
      const claim = await tx.document.updateMany({ where: { id, documentType: "SALE_BILL", deletedAt: null, saleRecoveryStatus: input.expectedStatus,
        linkedEntityType: null, linkedEntityId: null, recoveryCheckoutOperationKey: null, recoveryCheckoutPayloadHash: null, ...visibility(actor) },
        data: { deletedAt, deletedById: actor.id, deleteReason: input.reason, purgeAfter: null } });
      if (claim.count !== 1) throw new SalesEvidenceConflictError("The upload outcome changed", "CLAIM_CONFLICT");
      await tx.auditLog.create({ data: { actorId: actor.id, action: "SALE_EVIDENCE_VOIDED", entityType: "Document", entityId: id,
        meta: { documentId: id, previousDocument: documentObservation(doc), deletedAt: deletedAt.toISOString(), previousDeletedAt: null,
          deletedById: actor.id, previousDeletedById: doc.deletedById, reason: input.reason, purgeAfter: null, retained: true, decisionHash,
          actorName: actor.name ?? null, actorRole: actor.role } } });
      return { document: toPublicSaleEvidence({ ...doc, deletedAt, deletedById: actor.id, deleteReason: input.reason, purgeAfter: null }), replayed: false };
    });
  } catch (error) {
    if (error instanceof SalesEvidenceConflictError || (error as any)?.statusCode === 403) throw error;
    const doc = await prisma.document.findFirst({ where: { id, documentType: "SALE_BILL", ...visibility(actor) } });
    const committed = doc && await replay(prisma, doc); if (committed) return committed;
    throw error;
  }
}

export function projectProofHistory(log: any) {
  const meta = (log.meta ?? {}) as Record<string, any>;
  const links = (value: any) => value ? { linkedEntityType: value.linkedEntityType ?? null, linkedEntityId: value.linkedEntityId ?? null,
    saleRecoveryStatus: value.saleRecoveryStatus ?? null } : null;
  const paper = (value: any) => value ? { billingChannel: value.billingChannel ?? null, externalDocumentType: value.externalDocumentType ?? null,
    externalBillNo: value.externalBillNo ?? null, externalBillDate: value.externalBillDate ?? null, billRecordStatus: value.billRecordStatus ?? null } : null;
  return { id: log.id, action: log.action, actorId: log.actorId, actorName: log.actor?.name ?? null, actorRole: log.actor?.role ?? null,
    createdAt: log.createdAt, meta: { documentId: meta.documentId ?? log.entityId, invoiceId: meta.invoiceId ?? null,
      sourceInvoiceId: meta.sourceInvoiceId ?? null, targetInvoiceId: meta.targetInvoiceId ?? null, reference: meta.reference ?? null,
      previous: links(meta.previousDocument ?? meta.previous), current: links(meta.currentDocument ?? meta.current),
      previousSource: paper(meta.previousSource), currentSource: paper(meta.currentSource), previousTarget: paper(meta.previousTarget),
      currentTarget: paper(meta.currentTarget), reason: meta.reason ?? null, duplicateOverrideReason: meta.duplicateOverrideReason ?? null,
      retained: meta.retained ?? null, deletedAt: meta.deletedAt ?? null,
      ...(log.action.startsWith("SALES_OCR_") ? { review: {
        priorRevision: typeof meta.priorRevision === "string" ? meta.priorRevision : null,
        revision: typeof meta.revision === "string" ? meta.revision : null,
      } } : {}) } };
}
export async function getSaleEvidenceHistory(id: string, actor: SalesEvidenceActor,
  resolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities) {
  await assertSalesEvidenceReviewer(actor, resolver);
  const doc = await prisma.document.findFirst({ where: { id, documentType: "SALE_BILL", ...visibility(actor) } });
  if (!doc) throw new SalesEvidenceConflictError("Sales evidence not found", "NOT_FOUND");
  const logs = await prisma.auditLog.findMany({ where: { entityType: "Document", entityId: id, OR: [
    { action: { startsWith: "SALE_EVIDENCE_" } }, { action: { startsWith: "SALES_EVIDENCE_" } }, { action: { startsWith: "SALE_RECOVERY_" } },
    { action: { startsWith: "SALES_OCR_" } },
  ] }, include: { actor: { select: { id: true, name: true, role: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  return { document: { id: doc.id, saleRecoveryStatus: doc.saleRecoveryStatus, linkedEntityId: doc.linkedEntityId, voidedAt: doc.deletedAt, retained: true },
    history: logs.map(projectProofHistory) };
}
