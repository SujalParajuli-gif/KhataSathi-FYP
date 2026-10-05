import { createHash, randomBytes } from "crypto";
import fs from "node:fs";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import type { Prisma } from "@prisma/client";
import {
  getDocumentFilePath,
  toPublicDocument,
  type PublicDocument,
} from "../documents/service";
import {
  getBusinessCapabilities,
  type BusinessCapabilities,
} from "../settings/capabilities";
import {
  getBusinessSettings,
} from "../settings/service";
import {
  lockCashDrawerForUpdate,
  lockCashierForUpdate,
  runFinancialTransaction,
} from "../../lib/transactionLocks";
import { parseBusinessDate, toBusinessClock } from "../../lib/businessDate";
import {
  findDuplicateReferencesTx,
  getManualBillRecord,
} from "../invoices/manualBill/service";
import type {
  PublicManualBillRecord,
} from "../invoices/manualBill/types";
import {
  buildCheckoutPayloadHash,
  checkoutInvoiceTx,
  normalizeCheckoutConfirmation,
  normalizeCheckoutItems,
  normalizeCheckoutPayments,
  type NormalizedCheckoutContext,
} from "../invoices/service";
import {
  paymentAssessmentSchema,
  reviseSaleEvidenceRecoverySchema,
  saleEvidenceRecoverySchema,
  type PaymentAssessment,
  type ReviseSaleEvidenceRecoveryInput,
  type SaleEvidenceRecoveryInput,
} from "./validation";
import {
  assertSalesEvidenceReviewer,
  SalesEvidenceAuthorizationError,
  SalesEvidenceConflictError,
  toPublicSaleEvidence,
  type PublicSaleEvidence,
  type SalesEvidenceActor,
} from "./service";

export interface RecoveryOutcomeResponse {
  status: "UNPREPARED" | "PREPARED" | "COMMITTED" | "ARCHIVED" | "UNCERTAIN";
  document: PublicSaleEvidence;
  invoice: PublicManualBillRecord | null;
  esewaPaymentIntent?: any | null;
  latestAttempt?: {
    id: string;
    actorId: string;
    createdAt: Date;
    reason?: string | null;
  } | null;
  retryEligible: boolean;
  blockedReason?: string | null;
  uncertainExplanation?: string | null;
}

export interface PostRecoveryResult {
  document: PublicSaleEvidence;
  invoice: PublicManualBillRecord;
  esewaPaymentIntent: any | null;
  replayed: boolean;
}

export interface ReviseRecoveryResult {
  document: PublicSaleEvidence;
  attemptId: string;
  status: "PREPARED";
}

export function isSameNepalDay(d1: Date, d2: Date): boolean {
  const n1 = toBusinessClock(d1);
  const n2 = toBusinessClock(d2);
  return (
    n1.getUTCFullYear() === n2.getUTCFullYear() &&
    n1.getUTCMonth() === n2.getUTCMonth() &&
    n1.getUTCDate() === n2.getUTCDate()
  );
}

export async function assertSalesEvidenceRecoveryManager(
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<void> {
  if (!actor || actor.role !== "MANAGER") {
    throw new SalesEvidenceAuthorizationError(
      "Access denied — missing sale recovery requires active MANAGER role with POS capability",
      "MANAGER_ROLE_REQUIRED",
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, isActive: true },
  });

  if (!user || !user.isActive || user.role !== "MANAGER") {
    throw new SalesEvidenceAuthorizationError(
      "Access denied — missing sale recovery requires active MANAGER role with POS capability",
      "MANAGER_ROLE_REQUIRED",
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

export function buildRecoveryFingerprint(
  documentId: string,
  checkoutPayloadHash: string,
  reference: {
    billNo: string;
    externalDocumentType: string;
    externalBillDate: string;
  },
  reason: string,
  duplicateOverrideReason: string | null | undefined,
  paymentAssessment: PaymentAssessment,
): string {
  const payload = {
    version: "1.0",
    documentId,
    checkoutPayloadHash,
    reference: {
      billNo: reference.billNo.trim(),
      externalDocumentType: reference.externalDocumentType,
      externalBillDate: reference.externalBillDate.trim(),
    },
    reason: reason.trim(),
    duplicateOverrideReason: duplicateOverrideReason?.trim() || null,
    paymentAssessment,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function verifyRecoveryCommittedProvenance(
  client: any,
  doc: {
    id: string;
    saleRecoveryStatus?: string | null;
    linkedEntityType?: string | null;
    linkedEntityId?: string | null;
    recoveryCheckoutOperationKey?: string | null;
    recoveryCheckoutPayloadHash?: string | null;
  },
  options: {
    expectedKey?: string;
    expectedFingerprint?: string;
    requiredActorId?: string;
    expectedCheckoutPayloadHash?: string;
  } = {},
): Promise<{
  valid: boolean;
  explanation?: string;
  completedOp?: any;
  prepAudit?: any;
  postAudit?: any;
  attachAudit?: any;
}> {
  if (
    doc.saleRecoveryStatus !== "ATTACHED" ||
    doc.linkedEntityType !== "Invoice" ||
    !doc.linkedEntityId ||
    !doc.recoveryCheckoutOperationKey ||
    !doc.recoveryCheckoutPayloadHash
  ) {
    return {
      valid: false,
      explanation: "Document is not attached to an invoice with recovery provenance",
    };
  }

  if (
    options.expectedKey &&
    doc.recoveryCheckoutOperationKey !== options.expectedKey
  ) {
    return {
      valid: false,
      explanation: "Document recovery operation key does not match expected key",
    };
  }

  if (
    options.expectedFingerprint &&
    doc.recoveryCheckoutPayloadHash !== options.expectedFingerprint
  ) {
    return {
      valid: false,
      explanation: "Document recovery payload hash does not match expected fingerprint",
    };
  }

  const opKey = doc.recoveryCheckoutOperationKey;
  const recFingerprint = doc.recoveryCheckoutPayloadHash;
  const invoiceId = doc.linkedEntityId;

  // 1. CheckoutOperation verification
  let completedOp: any = null;
  try {
    completedOp = await client.checkoutOperation.findUnique({
      where: { operationKey: opKey },
    });
  } catch (err) {
    return {
      valid: false,
      explanation: "Failed to query checkout operation",
    };
  }

  if (
    !completedOp ||
    !completedOp.completedAt ||
    completedOp.invoiceId !== invoiceId
  ) {
    return {
      valid: false,
      explanation:
        "Checkout operation is missing, incomplete, or linked to a different invoice",
    };
  }

  if (options.requiredActorId && completedOp.actorId !== options.requiredActorId) {
    return {
      valid: false,
      explanation: "Checkout operation actor does not match required owner",
    };
  }

  if (
    options.expectedCheckoutPayloadHash &&
    completedOp.payloadHash !== options.expectedCheckoutPayloadHash
  ) {
    return {
      valid: false,
      explanation:
        "Checkout operation payload hash does not match expected checkout hash",
    };
  }

  // 2. Preparation / Revision Audit verification
  let prepAudit: any = null;
  try {
    prepAudit = await client.auditLog.findFirst({
      where: {
        entityType: "Document",
        entityId: doc.id,
        action: {
          in: ["SALE_RECOVERY_ATTEMPT_PREPARED", "SALE_RECOVERY_ATTEMPT_REVISED"],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  } catch {
    return {
      valid: false,
      explanation: "Failed to query preparation audit",
    };
  }

  if (!prepAudit) {
    return {
      valid: false,
      explanation: "Preparation audit log is missing",
    };
  }

  const prepMeta = (prepAudit.meta as Record<string, any>) || {};
  const metaOpKey = prepMeta.operationKey || prepMeta.newOperationKey;
  const metaFingerprint = prepMeta.recoveryFingerprint || prepMeta.newPayloadHash;

  if (metaOpKey !== opKey || metaFingerprint !== recFingerprint) {
    return {
      valid: false,
      explanation:
        "Preparation audit metadata does not match document recovery identity",
    };
  }

  if (options.requiredActorId && prepAudit.actorId !== options.requiredActorId) {
    return {
      valid: false,
      explanation: "Preparation audit actor does not match required owner",
    };
  }

  // 3. Posting Audit verification on Invoice
  let postAudit: any = null;
  try {
    postAudit = await client.auditLog.findFirst({
      where: {
        entityType: "Invoice",
        entityId: invoiceId,
        action: "SALE_RECOVERY_POSTED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  } catch {
    return {
      valid: false,
      explanation: "Failed to query posting audit",
    };
  }

  if (!postAudit) {
    return {
      valid: false,
      explanation: "Invoice recovery posting audit is missing",
    };
  }

  const postMeta = (postAudit.meta as Record<string, any>) || {};
  if (
    postMeta.operationKey !== opKey ||
    postMeta.recoveryFingerprint !== recFingerprint
  ) {
    return {
      valid: false,
      explanation: "Posting audit metadata does not match recovery identity",
    };
  }

  if (options.requiredActorId && postAudit.actorId !== options.requiredActorId) {
    return {
      valid: false,
      explanation: "Posting audit actor does not match required owner",
    };
  }

  // 4. Attachment Audit verification on Document
  let attachAudit: any = null;
  try {
    attachAudit = await client.auditLog.findFirst({
      where: {
        entityType: "Document",
        entityId: doc.id,
        action: "SALE_RECOVERY_ATTACHED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  } catch {
    return {
      valid: false,
      explanation: "Failed to query attachment audit",
    };
  }

  if (!attachAudit) {
    return {
      valid: false,
      explanation: "Document recovery attachment audit is missing",
    };
  }

  const attachMeta = (attachAudit.meta as Record<string, any>) || {};
  if (attachMeta.invoiceId !== invoiceId) {
    return {
      valid: false,
      explanation: "Attachment audit invoice ID does not match linked invoice",
    };
  }

  if (options.requiredActorId && attachAudit.actorId !== options.requiredActorId) {
    return {
      valid: false,
      explanation: "Attachment audit actor does not match required owner",
    };
  }

  return { valid: true, completedOp, prepAudit, postAudit, attachAudit };
}

export async function getSaleEvidenceRecoveryOutcome(
  documentId: string,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<RecoveryOutcomeResponse | null> {
  await assertSalesEvidenceReviewer(actor, capabilitiesResolver);

  const doc = await prisma.document.findFirst({
    where: {
      id: documentId,
      documentType: "SALE_BILL",
      deletedAt: null,
      ...(actor.role === "MANAGER"
        ? { visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] } }
        : {}),
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  if (!doc) return null;

  const publicDoc = toPublicSaleEvidence(doc);

  if (doc.saleRecoveryStatus === "ARCHIVED") {
    return {
      status: "ARCHIVED",
      document: publicDoc,
      invoice: null,
      retryEligible: false,
    };
  }

  if (doc.saleRecoveryStatus === "ATTACHED") {
    if (!doc.recoveryCheckoutOperationKey || !doc.recoveryCheckoutPayloadHash) {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: "Document is attached via ordinary workflow, not recovery",
      };
    }

    const provenance = await verifyRecoveryCommittedProvenance(prisma, doc);
    if (!provenance.valid) {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: provenance.explanation || "Incomplete recovery provenance",
      };
    }

    try {
      const invoiceRecord = await getManualBillRecord(
        doc.linkedEntityId!,
        actor as any,
        prisma,
        capabilitiesResolver,
      );
      const savedResponse = provenance.completedOp?.responseJson as any;
      const esewaPaymentIntent = savedResponse?.esewaPaymentIntent || null;
      return {
        status: "COMMITTED",
        document: publicDoc,
        invoice: invoiceRecord,
        esewaPaymentIntent,
        retryEligible: false,
      };
    } catch (err) {
      logger.error("Failed to load attached invoice for committed recovery", {
        documentId: doc.id,
        invoiceId: doc.linkedEntityId,
        err,
      });
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: "Attached invoice record could not be loaded",
      };
    }
  }

  if (doc.saleRecoveryStatus === "UNRESOLVED") {
    if (!doc.recoveryCheckoutOperationKey) {
      return {
        status: "UNPREPARED",
        document: publicDoc,
        invoice: null,
        retryEligible: actor.role === "MANAGER",
      };
    }

    // Document is UNRESOLVED with a prepared operation key
    let latestAttempt: any = null;
    try {
      latestAttempt = await prisma.auditLog.findFirst({
        where: {
          entityType: "Document",
          entityId: doc.id,
          action: {
            in: ["SALE_RECOVERY_ATTEMPT_PREPARED", "SALE_RECOVERY_ATTEMPT_REVISED"],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
    } catch {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: "Failed to verify preparation audit records",
      };
    }

    if (!latestAttempt) {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation:
          "Attempt identity exists on document but preparation audit was not found",
      };
    }

    const meta = (latestAttempt.meta as Record<string, any>) || {};
    const metaOpKey = meta.operationKey || meta.newOperationKey;
    const metaFingerprint = meta.recoveryFingerprint || meta.newPayloadHash;

    if (
      metaOpKey !== doc.recoveryCheckoutOperationKey ||
      metaFingerprint !== doc.recoveryCheckoutPayloadHash
    ) {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation:
          "Preparation audit metadata does not match document recovery identity",
      };
    }

    let op: any = null;
    try {
      op = await prisma.checkoutOperation.findUnique({
        where: { operationKey: doc.recoveryCheckoutOperationKey },
      });
    } catch {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: "Failed to verify checkout operation state",
      };
    }

    if (op) {
      return {
        status: "UNCERTAIN",
        document: publicDoc,
        invoice: null,
        retryEligible: false,
        uncertainExplanation: op.completedAt
          ? "Checkout operation was completed but document attachment is unconfirmed"
          : "Prior checkout operation is active or incomplete",
      };
    }

    const retryEligible =
      actor.role === "MANAGER" && actor.id === latestAttempt.actorId;

    return {
      status: "PREPARED",
      document: publicDoc,
      invoice: null,
      latestAttempt: {
        id: latestAttempt.id,
        actorId: latestAttempt.actorId,
        createdAt: latestAttempt.createdAt,
        reason: meta.reason || meta.recoveryReason || null,
      },
      retryEligible,
    };
  }

  return {
    status: "UNCERTAIN",
    document: publicDoc,
    invoice: null,
    retryEligible: false,
    uncertainExplanation: "Unknown sale recovery status",
  };
}

export interface PreparedRecoveryAttempt {
  serverKey: string;
  checkoutPayloadHash: string;
  recoveryFingerprint: string;
  isNewPrep: boolean;
}

export async function prepareSaleEvidenceRecoveryAttempt(
  documentId: string,
  input: SaleEvidenceRecoveryInput,
  actor: SalesEvidenceActor,
  parsedDate: Date,
  checkoutItems: any,
  checkoutPayments: any,
  normalizedConfirmation: any,
): Promise<PreparedRecoveryAttempt> {
  return runFinancialTransaction(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM Document WHERE id = ${documentId} AND documentType = 'SALE_BILL' AND deletedAt IS NULL AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;

    const doc = await tx.document.findFirst({
      where: {
        id: documentId,
        documentType: "SALE_BILL",
        deletedAt: null,
        visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] },
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });

    if (!doc) {
      throw new SalesEvidenceConflictError(
        "Sales evidence not found or deleted",
        "NOT_FOUND",
      );
    }

    if (doc.saleRecoveryStatus === "ARCHIVED") {
      throw new SalesEvidenceConflictError(
        "Archived sales evidence cannot be recovered into a sale",
        "ARCHIVED_CONFLICT",
        toPublicSaleEvidence(doc),
      );
    }

    if (doc.saleRecoveryStatus === "ATTACHED") {
      if (
        doc.linkedEntityType === "Invoice" &&
        doc.linkedEntityId &&
        doc.recoveryCheckoutOperationKey &&
        doc.recoveryCheckoutPayloadHash
      ) {
        const expectedHash = buildCheckoutPayloadHash(
          {
            operationKey: doc.recoveryCheckoutOperationKey,
            draftInvoiceId: null,
            draftRequestId: null,
            customerId: input.checkout.customerId ? String(input.checkout.customerId).trim() : null,
            discountAmount: input.checkout.discountAmount,
            overridePin: input.checkout.overridePin,
            notes: input.checkout.notes,
            items: input.checkout.items,
            payment: input.checkout.payment,
            payments: input.checkout.payments,
            confirmation: input.checkout.confirmation,
          },
          checkoutItems,
          checkoutPayments,
          false,
          normalizedConfirmation,
        );
        const expectedFingerprint = buildRecoveryFingerprint(
          doc.id,
          expectedHash,
          input.reference,
          input.reason,
          input.duplicateOverrideReason,
          input.paymentAssessment,
        );

        if (doc.recoveryCheckoutPayloadHash === expectedFingerprint) {
          const provenance = await verifyRecoveryCommittedProvenance(tx, doc, {
            expectedKey: doc.recoveryCheckoutOperationKey,
            expectedFingerprint: expectedFingerprint,
            requiredActorId: actor.id,
            expectedCheckoutPayloadHash: expectedHash,
          });

          if (!provenance.valid) {
            throw new SalesEvidenceAuthorizationError(
              "Another manager prepared this recovery attempt. Only the preparing manager may post or replay this recovery.",
              "ATTEMPT_OWNER_MISMATCH",
            );
          }

          return {
            serverKey: doc.recoveryCheckoutOperationKey,
            checkoutPayloadHash: expectedHash,
            recoveryFingerprint: expectedFingerprint,
            isNewPrep: false,
          };
        }
      }

      throw new SalesEvidenceConflictError(
        "Sales evidence is already attached to another invoice",
        "ATTACHED_CONFLICT",
        toPublicSaleEvidence(doc),
      );
    }

    if (doc.saleRecoveryStatus !== "UNRESOLVED") {
      throw new SalesEvidenceConflictError(
        "Sales evidence is not eligible for recovery",
        "INELIGIBLE_STATUS",
        toPublicSaleEvidence(doc),
      );
    }

    if (doc.linkedEntityType !== null || doc.linkedEntityId !== null) {
      throw new SalesEvidenceConflictError(
        "Sales evidence is already linked to another entity",
        "LINKED_CONFLICT",
        toPublicSaleEvidence(doc),
      );
    }

    if (doc.recoveryCheckoutOperationKey) {
      // Document is already prepared: verify matching actor & intent
      const serverKey = doc.recoveryCheckoutOperationKey;
      const checkoutPayloadHash = buildCheckoutPayloadHash(
        {
          operationKey: serverKey,
          draftInvoiceId: null,
          draftRequestId: null,
          customerId: input.checkout.customerId ? String(input.checkout.customerId).trim() : null,
          discountAmount: input.checkout.discountAmount,
          overridePin: input.checkout.overridePin,
          notes: input.checkout.notes,
          items: input.checkout.items,
          payment: input.checkout.payment,
          payments: input.checkout.payments,
          confirmation: input.checkout.confirmation,
        },
        checkoutItems,
        checkoutPayments,
        false,
        normalizedConfirmation,
      );
      const recoveryFingerprint = buildRecoveryFingerprint(
        doc.id,
        checkoutPayloadHash,
        input.reference,
        input.reason,
        input.duplicateOverrideReason,
        input.paymentAssessment,
      );

      const latestAttempt = await tx.auditLog.findFirst({
        where: {
          entityType: "Document",
          entityId: doc.id,
          action: {
            in: ["SALE_RECOVERY_ATTEMPT_PREPARED", "SALE_RECOVERY_ATTEMPT_REVISED"],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      if (!latestAttempt) {
        throw new SalesEvidenceConflictError(
          "Recovery attempt identity exists but prior attempt audit is missing",
          "UNVERIFIED_PREPARATION",
        );
      }

      const prepMeta = (latestAttempt.meta as Record<string, any>) || {};
      const metaOpKey = prepMeta.operationKey || prepMeta.newOperationKey;
      const metaFingerprint = prepMeta.recoveryFingerprint || prepMeta.newPayloadHash;

      if (
        metaOpKey !== serverKey ||
        metaFingerprint !== doc.recoveryCheckoutPayloadHash
      ) {
        throw new SalesEvidenceConflictError(
          "Recovery attempt was modified or has unverified metadata",
          "UNVERIFIED_PREPARATION",
        );
      }

      if (latestAttempt.actorId !== actor.id) {
        throw new SalesEvidenceAuthorizationError(
          "Another manager prepared this recovery attempt. Only the preparing manager may post or revise this attempt.",
          "ATTEMPT_OWNER_MISMATCH",
        );
      }

      if (doc.recoveryCheckoutPayloadHash !== recoveryFingerprint) {
        throw new SalesEvidenceConflictError(
          "Recovery attempt was prepared with different intent. Explicit revision is required to change items, prices, reference, or payment assessment.",
          "INTENT_CONFLICT",
        );
      }

      return {
        serverKey,
        checkoutPayloadHash,
        recoveryFingerprint,
        isNewPrep: false,
      };
    }

    // Unprepared document: Perform preparation
    const duplicates = await findDuplicateReferencesTx(
      tx,
      null,
      input.reference.externalDocumentType,
      input.reference.billNo,
      parsedDate,
    );

    if (duplicates.length > 0 && !input.duplicateOverrideReason?.trim()) {
      throw new SalesEvidenceConflictError(
        `Another active invoice already has paper bill reference ${input.reference.billNo}. Reviewer duplicate override reason is required.`,
        "DUPLICATE_REVIEW_REQUIRED",
      );
    }

    const serverKey = `rec_${randomBytes(24).toString("base64url")}`;
    const checkoutPayloadHash = buildCheckoutPayloadHash(
      {
        operationKey: serverKey,
        draftInvoiceId: null,
        draftRequestId: null,
        customerId: input.checkout.customerId ? String(input.checkout.customerId).trim() : null,
        discountAmount: input.checkout.discountAmount,
        overridePin: input.checkout.overridePin,
        notes: input.checkout.notes,
        items: input.checkout.items,
        payment: input.checkout.payment,
        payments: input.checkout.payments,
        confirmation: input.checkout.confirmation,
      },
      checkoutItems,
      checkoutPayments,
      false,
      normalizedConfirmation,
    );
    const recoveryFingerprint = buildRecoveryFingerprint(
      doc.id,
      checkoutPayloadHash,
      input.reference,
      input.reason,
      input.duplicateOverrideReason,
      input.paymentAssessment,
    );

    const prepResult = await tx.document.updateMany({
      where: {
        id: documentId,
        documentType: "SALE_BILL",
        saleRecoveryStatus: "UNRESOLVED",
        linkedEntityType: null,
        linkedEntityId: null,
        recoveryCheckoutOperationKey: null,
        recoveryCheckoutPayloadHash: null,
        deletedAt: null,
        visibility: { in: ["ADMIN_MANAGER", "ALL_AUTHENTICATED"] },
      },
      data: {
        recoveryCheckoutOperationKey: serverKey,
        recoveryCheckoutPayloadHash: recoveryFingerprint,
      },
    });

    if (prepResult.count !== 1) {
      throw new SalesEvidenceConflictError(
        "Concurrent modification prevented recovery preparation",
        "CONCURRENT_MODIFICATION",
      );
    }

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "SALE_RECOVERY_ATTEMPT_PREPARED",
        entityType: "Document",
        entityId: doc.id,
        meta: {
          version: "1.0",
          documentId: doc.id,
          originalActorId: actor.id,
          operationKey: serverKey,
          recoveryFingerprint,
          checkoutPayloadHash,
          reference: input.reference,
          reason: input.reason.trim(),
          duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
          paymentAssessment: input.paymentAssessment,
          safeNormalizedCheckoutIntent: {
            customerId: input.checkout.customerId ? String(input.checkout.customerId).trim() : null,
            discountAmount: input.checkout.discountAmount || 0,
            notes: input.checkout.notes || null,
            items: checkoutItems.map((i: any) => ({
              productId: i.productId,
              qty: i.qty,
              overrideUnitPrice: i.overrideUnitPrice,
              overrideReason: i.overrideReason,
            })),
            payments: checkoutPayments.map((p: any) => ({
              method: p.method,
              amount: p.amount,
              reference: p.reference,
              tenderedAmount: p.tenderedAmount,
            })),
            confirmation: normalizedConfirmation,
          },
          oldObservations: {
            saleRecoveryStatus: doc.saleRecoveryStatus,
            linkedEntityType: doc.linkedEntityType,
            linkedEntityId: doc.linkedEntityId,
            recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey,
            recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash,
          },
          newObservations: {
            saleRecoveryStatus: "UNRESOLVED",
            linkedEntityType: null,
            linkedEntityId: null,
            recoveryCheckoutOperationKey: serverKey,
            recoveryCheckoutPayloadHash: recoveryFingerprint,
          },
        },
      },
    });

    return {
      serverKey,
      checkoutPayloadHash,
      recoveryFingerprint,
      isNewPrep: true,
    };
  });
}

export async function prepareAndPostSaleEvidenceRecovery(
  documentId: string,
  rawInput: SaleEvidenceRecoveryInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<PostRecoveryResult> {
  // 1. Role and Capability Check: MANAGER only
  await assertSalesEvidenceRecoveryManager(actor, capabilitiesResolver);

  // 2. Strict Schema Validation
  const input = saleEvidenceRecoverySchema.parse(rawInput);
  const parsedDate = parseBusinessDate(
    input.reference.externalBillDate,
    "externalBillDate",
  );

  // 3. Payment Assessment Policy Checks
  const { paymentAssessment } = input;
  if (
    paymentAssessment.type === "PRIOR_OR_OTHER_CASH" ||
    paymentAssessment.type === "PRIOR_DIGITAL" ||
    paymentAssessment.type === "UNKNOWN"
  ) {
    throw new SalesEvidenceConflictError(
      "Payment reconciliation is required before missing sale recovery can proceed. Cash collected in prior/other drawers or pre-existing digital payments cannot be posted as current drawer cash.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const rawCheckout = input.checkout;
  const checkoutItems = normalizeCheckoutItems(rawCheckout.items);
  const checkoutPayments = normalizeCheckoutPayments(rawCheckout as any);
  const normalizedConfirmation = normalizeCheckoutConfirmation(
    rawCheckout.confirmation,
  );

  if (!normalizedConfirmation) {
    throw new SalesEvidenceConflictError(
      "Checkout review confirmation is required for missing sale recovery.",
      "MISSING_CONFIRMATION",
    );
  }

  if (paymentAssessment.type === "CURRENT_DRAWER_CASH") {
    if (paymentAssessment.alreadyAccounted !== false) {
      throw new SalesEvidenceConflictError(
        "Cash already accounted for in a prior ledger or float cannot be posted to current drawer.",
        "PAYMENT_RECONCILIATION_REQUIRED",
      );
    }

    const cashPayments = checkoutPayments.filter((p) => p.method === "CASH");
    if (cashPayments.length !== 1 || checkoutPayments.length !== 1) {
      throw new SalesEvidenceConflictError(
        "Current drawer cash assessment requires exactly one matching cash payment in checkout.",
        "INVALID_PAYMENT_ASSESSMENT",
      );
    }

    if (cashPayments[0].amount !== normalizedConfirmation.payableTotal) {
      throw new SalesEvidenceConflictError(
        "Current drawer cash payment amount must match confirmation payable total.",
        "INVALID_PAYMENT_ASSESSMENT",
      );
    }
  }

  // 4. File existence & readability preflight
  const preflightDoc = await prisma.document.findFirst({
    where: {
      id: documentId,
      documentType: "SALE_BILL",
      deletedAt: null,
      visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] },
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

  // Step 1: Durable Preparation in its own short financial transaction (B-1)
  let prepared: PreparedRecoveryAttempt;
  try {
    prepared = await prepareSaleEvidenceRecoveryAttempt(
      documentId,
      input,
      actor,
      parsedDate,
      checkoutItems,
      checkoutPayments,
      normalizedConfirmation,
    );
  } catch (prepErr) {
    // Ambiguous preparation commit reconciliation
    const checkDoc = await prisma.document.findFirst({
      where: { id: documentId },
    });
    if (
      checkDoc &&
      checkDoc.saleRecoveryStatus === "UNRESOLVED" &&
      checkDoc.recoveryCheckoutOperationKey &&
      checkDoc.recoveryCheckoutPayloadHash
    ) {
      const serverKey = checkDoc.recoveryCheckoutOperationKey;
      const checkoutPayloadHash = buildCheckoutPayloadHash(
        {
          operationKey: serverKey,
          draftInvoiceId: null,
          draftRequestId: null,
          customerId: input.checkout.customerId ? String(input.checkout.customerId).trim() : null,
          discountAmount: input.checkout.discountAmount,
          overridePin: input.checkout.overridePin,
          notes: input.checkout.notes,
          items: input.checkout.items,
          payment: input.checkout.payment,
          payments: input.checkout.payments,
          confirmation: input.checkout.confirmation,
        },
        checkoutItems,
        checkoutPayments,
        false,
        normalizedConfirmation,
      );
      const recoveryFingerprint = buildRecoveryFingerprint(
        checkDoc.id,
        checkoutPayloadHash,
        input.reference,
        input.reason,
        input.duplicateOverrideReason,
        input.paymentAssessment,
      );

      if (checkDoc.recoveryCheckoutPayloadHash === recoveryFingerprint) {
        prepared = {
          serverKey,
          checkoutPayloadHash,
          recoveryFingerprint,
          isNewPrep: false,
        };
      } else {
        throw prepErr;
      }
    } else {
      throw prepErr;
    }
  }

  const { serverKey, checkoutPayloadHash, recoveryFingerprint } = prepared;

  // Step 2: Financial Posting in its own transaction
  const settings = await getBusinessSettings();

  try {
    return await runFinancialTransaction(prisma, async (tx) => {
      // Lock Document FOR UPDATE
      await tx.$queryRaw`SELECT id FROM Document WHERE id = ${documentId} AND documentType = 'SALE_BILL' AND deletedAt IS NULL AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;

      const doc = await tx.document.findFirst({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          deletedAt: null,
          visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] },
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      if (!doc) {
        throw new SalesEvidenceConflictError(
          "Sales evidence not found or deleted",
          "NOT_FOUND",
        );
      }

      if (doc.saleRecoveryStatus === "ATTACHED") {
        const provenance = await verifyRecoveryCommittedProvenance(tx, doc, {
          expectedKey: serverKey,
          expectedFingerprint: recoveryFingerprint,
          requiredActorId: actor.id,
          expectedCheckoutPayloadHash: checkoutPayloadHash,
        });

        if (provenance.valid) {
          const invoiceRecord = await getManualBillRecord(
            doc.linkedEntityId!,
            actor as any,
            tx,
            capabilitiesResolver,
          );
          const savedResponse = provenance.completedOp?.responseJson as any;
          const esewaPaymentIntent = savedResponse?.esewaPaymentIntent || null;
          return {
            document: toPublicSaleEvidence(doc),
            invoice: invoiceRecord,
            esewaPaymentIntent,
            replayed: true,
          };
        }

        if (doc.recoveryCheckoutOperationKey === serverKey) {
          throw new SalesEvidenceAuthorizationError(
            "Another manager prepared this recovery attempt. Only the preparing manager may post or replay this recovery.",
            "ATTEMPT_OWNER_MISMATCH",
          );
        }

        throw new SalesEvidenceConflictError(
          "Sales evidence is already attached to another invoice",
          "ATTACHED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (doc.saleRecoveryStatus !== "UNRESOLVED") {
        throw new SalesEvidenceConflictError(
          "Sales evidence is not eligible for recovery",
          "INELIGIBLE_STATUS",
          toPublicSaleEvidence(doc),
        );
      }

      if (
        doc.recoveryCheckoutOperationKey !== serverKey ||
        doc.recoveryCheckoutPayloadHash !== recoveryFingerprint
      ) {
        throw new SalesEvidenceConflictError(
          "Recovery attempt identity does not match prepared state",
          "CONCURRENT_MODIFICATION",
        );
      }

      // Recheck duplicate references advisory under lock
      const duplicates = await findDuplicateReferencesTx(
        tx,
        null,
        input.reference.externalDocumentType,
        input.reference.billNo,
        parsedDate,
      );

      if (duplicates.length > 0 && !input.duplicateOverrideReason?.trim()) {
        throw new SalesEvidenceConflictError(
          `Another active invoice already has paper bill reference ${input.reference.billNo}. Reviewer duplicate override reason is required.`,
          "DUPLICATE_REVIEW_REQUIRED",
        );
      }

      // Drawer Lock & Nepal Day Timing Validation (B-4)
      if (paymentAssessment.type === "CURRENT_DRAWER_CASH") {
        const drawerId = paymentAssessment.drawerId;
        await lockCashierForUpdate(tx, actor.id);
        await lockCashDrawerForUpdate(tx, drawerId);

        const drawer = await tx.cashDrawer.findUnique({
          where: { id: drawerId },
        });

        if (!drawer) {
          throw new SalesEvidenceConflictError(
            "Specified cash drawer was not found",
            "DRAWER_NOT_FOUND",
          );
        }

        if (drawer.status !== "OPEN") {
          throw new SalesEvidenceConflictError(
            "Current drawer cash requires an open cash drawer. The specified drawer is closed.",
            "DRAWER_CLOSED",
          );
        }

        if (drawer.cashierId !== actor.id) {
          throw new SalesEvidenceConflictError(
            "Specified cash drawer belongs to another cashier/manager",
            "DRAWER_OWNER_MISMATCH",
          );
        }

        const collectedDate = new Date(paymentAssessment.collectedAt);
        const collectedTime = collectedDate.getTime();
        const now = new Date();
        if (
          isNaN(collectedTime) ||
          collectedTime > now.getTime() ||
          collectedTime < drawer.openedAt.getTime()
        ) {
          throw new SalesEvidenceConflictError(
            "Collection time must be within the current open drawer interval and cannot be in the future",
            "INVALID_COLLECTION_TIME",
          );
        }

        if (
          !isSameNepalDay(drawer.openedAt, now) ||
          !isSameNepalDay(collectedDate, now)
        ) {
          throw new SalesEvidenceConflictError(
            "Current drawer cash must be collected during the current Nepal business day",
            "DRAWER_DAY_MISMATCH",
          );
        }
      } else if (paymentAssessment.type === "NOT_COLLECTED") {
        const hasCash = checkoutPayments.some((p) => p.method === "CASH");
        if (hasCash) {
          await lockCashierForUpdate(tx, actor.id);
          const openDrawer = await tx.cashDrawer.findFirst({
            where: { cashierId: actor.id, status: "OPEN" },
            orderBy: { openedAt: "desc" },
          });

          if (!openDrawer) {
            throw new SalesEvidenceConflictError(
              "Receiving fresh cash payment during recovery requires an open cash drawer for the posting manager.",
              "OPEN_DRAWER_REQUIRED",
            );
          }

          await lockCashDrawerForUpdate(tx, openDrawer.id);

          const lockedDrawer = await tx.cashDrawer.findUnique({
            where: { id: openDrawer.id },
          });

          if (!lockedDrawer || lockedDrawer.status !== "OPEN") {
            throw new SalesEvidenceConflictError(
              "Cash drawer is no longer open",
              "DRAWER_CLOSED",
            );
          }

          if (!isSameNepalDay(lockedDrawer.openedAt, new Date())) {
            throw new SalesEvidenceConflictError(
              "Cash drawer must be from the current Nepal business day",
              "DRAWER_DAY_MISMATCH",
            );
          }
        }
      }

      // Execute Checkout Transaction Core
      const synthesizedCheckoutInput = {
        operationKey: serverKey,
        draftInvoiceId: null,
        draftRequestId: null,
        customerId: rawCheckout.customerId ? String(rawCheckout.customerId).trim() : null,
        discountAmount: rawCheckout.discountAmount,
        overridePin: rawCheckout.overridePin,
        notes: rawCheckout.notes,
        items: rawCheckout.items,
        payment: rawCheckout.payment,
        payments: rawCheckout.payments,
        confirmation: rawCheckout.confirmation,
      };

      const normalizedContext: NormalizedCheckoutContext = {
        operationKey: serverKey,
        payloadHash: checkoutPayloadHash,
        input: synthesizedCheckoutInput,
        checkoutItems,
        checkoutPayments,
        normalizedConfirmation,
      };

      const checkoutResult = await checkoutInvoiceTx(
        tx,
        actor.id,
        normalizedContext,
        settings,
      );

      // Conditional Claim on Document
      const claimResult = await tx.document.updateMany({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          saleRecoveryStatus: "UNRESOLVED",
          linkedEntityType: null,
          linkedEntityId: null,
          recoveryCheckoutOperationKey: serverKey,
          recoveryCheckoutPayloadHash: recoveryFingerprint,
          deletedAt: null,
          visibility: { in: ["ADMIN_MANAGER", "ALL_AUTHENTICATED"] },
        },
        data: {
          saleRecoveryStatus: "ATTACHED",
          linkedEntityType: "Invoice",
          linkedEntityId: checkoutResult.invoice.id,
        },
      });

      if (claimResult.count !== 1) {
        throw new SalesEvidenceConflictError(
          "Sales evidence was already claimed by another concurrent operation",
          "CLAIM_CONFLICT",
        );
      }

      // Update Invoice with External Manual Reference
      await tx.invoice.update({
        where: { id: checkoutResult.invoice.id },
        data: {
          billingChannel: "MANUAL_EXTERNAL",
          billRecordStatus: "RECORDED",
          externalDocumentType: input.reference.externalDocumentType,
          externalBillNo: input.reference.billNo,
          externalBillDate: parsedDate,
        },
      });

      // Audits with SALE_RECOVERY_ prefix (B-5)
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALE_RECOVERY_POSTED",
          entityType: "Invoice",
          entityId: checkoutResult.invoice.id,
          meta: {
            version: "1.0",
            documentId: doc.id,
            invoiceId: checkoutResult.invoice.id,
            invoiceNo: checkoutResult.invoice.invoiceNo,
            operationKey: serverKey,
            recoveryFingerprint,
            reference: input.reference,
            reason: input.reason.trim(),
            duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
            paymentAssessment: input.paymentAssessment,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALE_RECOVERY_ATTACHED",
          entityType: "Document",
          entityId: doc.id,
          meta: {
            version: "1.0",
            documentId: doc.id,
            documentTitle: doc.title,
            invoiceId: checkoutResult.invoice.id,
            invoiceNo: checkoutResult.invoice.invoiceNo,
            reference: input.reference,
            reason: input.reason.trim(),
            duplicateOverrideReason: input.duplicateOverrideReason?.trim() || null,
            previousDocument: {
              id: doc.id,
              documentType: "SALE_BILL",
              visibility: doc.visibility,
              saleRecoveryStatus: "UNRESOLVED",
              linkedEntityType: null,
              linkedEntityId: null,
              recoveryCheckoutOperationKey: serverKey,
              recoveryCheckoutPayloadHash: recoveryFingerprint,
            },
          },
        },
      });

      // Reload Invoice Record & Update bound CheckoutOperation response
      const finalInvoiceRecord = await getManualBillRecord(
        checkoutResult.invoice.id,
        actor as any,
        tx,
        capabilitiesResolver,
      );

      const updatedResponse = {
        invoice: finalInvoiceRecord,
        esewaPaymentIntent: checkoutResult.esewaPaymentIntent,
      };

      await tx.checkoutOperation.update({
        where: { id: checkoutResult.operation.id },
        data: {
          responseJson: JSON.parse(JSON.stringify(updatedResponse)) as Prisma.InputJsonValue,
        },
      });

      const updatedDoc: any = {
        ...doc,
        saleRecoveryStatus: "ATTACHED" as const,
        linkedEntityType: "Invoice",
        linkedEntityId: checkoutResult.invoice.id,
        recoveryCheckoutOperationKey: serverKey,
        recoveryCheckoutPayloadHash: recoveryFingerprint,
      };

      return {
        document: toPublicSaleEvidence(updatedDoc),
        invoice: finalInvoiceRecord,
        esewaPaymentIntent: checkoutResult.esewaPaymentIntent,
        replayed: false,
      };
    });
  } catch (err) {
    // Outer catch reconciliation (B-2): check if financial transaction actually committed
    try {
      const checkDoc = await prisma.document.findFirst({
        where: { id: documentId },
      });
      if (checkDoc) {
        const provenance = await verifyRecoveryCommittedProvenance(prisma, checkDoc, {
          expectedKey: serverKey,
          expectedFingerprint: recoveryFingerprint,
          requiredActorId: actor.id,
          expectedCheckoutPayloadHash: checkoutPayloadHash,
        });
        if (provenance.valid) {
          const invoiceRecord = await getManualBillRecord(
            checkDoc.linkedEntityId!,
            actor as any,
            prisma,
            capabilitiesResolver,
          );
          const savedResponse = provenance.completedOp?.responseJson as any;
          return {
            document: toPublicSaleEvidence(checkDoc),
            invoice: invoiceRecord,
            esewaPaymentIntent: savedResponse?.esewaPaymentIntent || null,
            replayed: true,
          };
        }
      }
    } catch {
      // ignore reconciliation check errors and rethrow original
    }
    throw err;
  }
}

export async function reviseSaleEvidenceRecoveryAttempt(
  documentId: string,
  rawInput: ReviseSaleEvidenceRecoveryInput,
  actor: SalesEvidenceActor,
  capabilitiesResolver: () => Promise<BusinessCapabilities> = getBusinessCapabilities,
): Promise<ReviseRecoveryResult> {
  // 1. Role and Capability Check: MANAGER only
  await assertSalesEvidenceRecoveryManager(actor, capabilitiesResolver);

  // 2. Strict Schema Validation
  const input = reviseSaleEvidenceRecoverySchema.parse(rawInput);
  const recoveryInput = input.recovery;
  const parsedDate = parseBusinessDate(
    recoveryInput.reference.externalBillDate,
    "externalBillDate",
  );

  // 3. Payment Assessment Policy Preflight
  const { paymentAssessment } = recoveryInput;
  if (
    paymentAssessment.type === "PRIOR_OR_OTHER_CASH" ||
    paymentAssessment.type === "PRIOR_DIGITAL" ||
    paymentAssessment.type === "UNKNOWN"
  ) {
    throw new SalesEvidenceConflictError(
      "Payment reconciliation is required before missing sale recovery can proceed. Cash collected in prior/other drawers or pre-existing digital payments cannot be posted as current drawer cash.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const rawCheckout = recoveryInput.checkout;
  const checkoutItems = normalizeCheckoutItems(rawCheckout.items);
  const checkoutPayments = normalizeCheckoutPayments(rawCheckout as any);
  const normalizedConfirmation = normalizeCheckoutConfirmation(
    rawCheckout.confirmation,
  );

  if (!normalizedConfirmation) {
    throw new SalesEvidenceConflictError(
      "Checkout review confirmation is required for missing sale recovery.",
      "MISSING_CONFIRMATION",
    );
  }

  // 4. File existence & readability preflight (B-3)
  const preflightDoc = await prisma.document.findFirst({
    where: {
      id: documentId,
      documentType: "SALE_BILL",
      deletedAt: null,
      visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] },
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
    return await runFinancialTransaction(prisma, async (tx) => {
      // 5. Lock Document FOR UPDATE
      await tx.$queryRaw`SELECT id FROM Document WHERE id = ${documentId} AND documentType = 'SALE_BILL' AND deletedAt IS NULL AND visibility IN ('ADMIN_MANAGER', 'ALL_AUTHENTICATED') FOR UPDATE`;

      const doc = await tx.document.findFirst({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          deletedAt: null,
          visibility: { in: ["ALL_AUTHENTICATED", "ADMIN_MANAGER"] },
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      if (!doc) {
        throw new SalesEvidenceConflictError(
          "Sales evidence not found or deleted",
          "NOT_FOUND",
        );
      }

      if (doc.saleRecoveryStatus === "ATTACHED") {
        throw new SalesEvidenceConflictError(
          "Attached sales evidence cannot be revised",
          "ATTACHED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (doc.saleRecoveryStatus === "ARCHIVED") {
        throw new SalesEvidenceConflictError(
          "Archived sales evidence cannot be revised",
          "ARCHIVED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      if (doc.saleRecoveryStatus !== "UNRESOLVED" || !doc.recoveryCheckoutOperationKey) {
        throw new SalesEvidenceConflictError(
          "Sales evidence has no prepared recovery attempt to revise",
          "INELIGIBLE_STATUS",
          toPublicSaleEvidence(doc),
        );
      }

      if (doc.linkedEntityType !== null || doc.linkedEntityId !== null) {
        throw new SalesEvidenceConflictError(
          "Sales evidence is already linked to another entity",
          "LINKED_CONFLICT",
          toPublicSaleEvidence(doc),
        );
      }

      // Find latest attempt audit log on this Document
      const latestAttempt = await tx.auditLog.findFirst({
        where: {
          entityType: "Document",
          entityId: doc.id,
          action: {
            in: ["SALE_RECOVERY_ATTEMPT_PREPARED", "SALE_RECOVERY_ATTEMPT_REVISED"],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      if (!latestAttempt) {
        throw new SalesEvidenceConflictError(
          "Prior recovery attempt audit log was not found",
          "UNVERIFIED_PREPARATION",
        );
      }

      if (latestAttempt.id !== input.expectedAttemptId) {
        throw new SalesEvidenceConflictError(
          "The recovery attempt was modified by another action. Please refresh and review current state.",
          "STALE_ATTEMPT_CONFLICT",
        );
      }

      const prepMeta = (latestAttempt.meta as Record<string, any>) || {};
      const metaOpKey = prepMeta.operationKey || prepMeta.newOperationKey;
      const metaFingerprint = prepMeta.recoveryFingerprint || prepMeta.newPayloadHash;

      if (
        metaOpKey !== doc.recoveryCheckoutOperationKey ||
        metaFingerprint !== doc.recoveryCheckoutPayloadHash
      ) {
        throw new SalesEvidenceConflictError(
          "Prior recovery attempt has unverified metadata",
          "UNVERIFIED_PREPARATION",
        );
      }

      if (latestAttempt.actorId !== actor.id) {
        throw new SalesEvidenceAuthorizationError(
          "Another manager prepared this recovery attempt. Only the preparing manager may revise this attempt.",
          "ATTEMPT_OWNER_MISMATCH",
        );
      }

      // Verify prior CheckoutOperation is NOT completed or active (B-3)
      const priorOp = await tx.checkoutOperation.findUnique({
        where: { operationKey: doc.recoveryCheckoutOperationKey },
      });

      if (priorOp) {
        throw new SalesEvidenceConflictError(
          "Prior checkout operation is active or completed and cannot be revised",
          "ACTIVE_OPERATION_CONFLICT",
        );
      }

      // Duplicate check for new reference
      const duplicates = await findDuplicateReferencesTx(
        tx,
        null,
        recoveryInput.reference.externalDocumentType,
        recoveryInput.reference.billNo,
        parsedDate,
      );

      if (duplicates.length > 0 && !recoveryInput.duplicateOverrideReason?.trim()) {
        throw new SalesEvidenceConflictError(
          `Another active invoice already has paper bill reference ${recoveryInput.reference.billNo}. Reviewer duplicate override reason is required.`,
          "DUPLICATE_REVIEW_REQUIRED",
        );
      }

      // Generate new server key and new fingerprint
      const newServerKey = `rec_${randomBytes(24).toString("base64url")}`;
      const newCheckoutPayloadHash = buildCheckoutPayloadHash(
        {
          operationKey: newServerKey,
          draftInvoiceId: null,
          draftRequestId: null,
          customerId: rawCheckout.customerId ? String(rawCheckout.customerId).trim() : null,
          discountAmount: rawCheckout.discountAmount,
          overridePin: rawCheckout.overridePin,
          notes: rawCheckout.notes,
          items: rawCheckout.items,
          payment: rawCheckout.payment,
          payments: rawCheckout.payments,
          confirmation: rawCheckout.confirmation,
        },
        checkoutItems,
        checkoutPayments,
        false,
        normalizedConfirmation,
      );
      const newRecoveryFingerprint = buildRecoveryFingerprint(
        doc.id,
        newCheckoutPayloadHash,
        recoveryInput.reference,
        recoveryInput.reason,
        recoveryInput.duplicateOverrideReason,
        recoveryInput.paymentAssessment,
      );

      const updateRes = await tx.document.updateMany({
        where: {
          id: documentId,
          documentType: "SALE_BILL",
          saleRecoveryStatus: "UNRESOLVED",
          linkedEntityType: null,
          linkedEntityId: null,
          recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey,
          recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash,
          deletedAt: null,
          visibility: { in: ["ADMIN_MANAGER", "ALL_AUTHENTICATED"] },
        },
        data: {
          recoveryCheckoutOperationKey: newServerKey,
          recoveryCheckoutPayloadHash: newRecoveryFingerprint,
        },
      });

      if (updateRes.count !== 1) {
        throw new SalesEvidenceConflictError(
          "Concurrent modification prevented attempt revision",
          "CONCURRENT_MODIFICATION",
        );
      }

      const revisionAudit = await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "SALE_RECOVERY_ATTEMPT_REVISED",
          entityType: "Document",
          entityId: doc.id,
          meta: {
            version: "1.0",
            documentId: doc.id,
            previousAttemptAuditId: input.expectedAttemptId,
            reason: input.reason.trim(),
            oldOperationKey: doc.recoveryCheckoutOperationKey,
            oldPayloadHash: doc.recoveryCheckoutPayloadHash,
            newOperationKey: newServerKey,
            newPayloadHash: newRecoveryFingerprint,
            newCheckoutPayloadHash,
            reference: recoveryInput.reference,
            recoveryReason: recoveryInput.reason.trim(),
            duplicateOverrideReason: recoveryInput.duplicateOverrideReason?.trim() || null,
            paymentAssessment: recoveryInput.paymentAssessment,
            safeNormalizedCheckoutIntent: {
              customerId: recoveryInput.checkout.customerId ? String(recoveryInput.checkout.customerId).trim() : null,
              discountAmount: recoveryInput.checkout.discountAmount || 0,
              notes: recoveryInput.checkout.notes || null,
              items: checkoutItems.map((i: any) => ({
                productId: i.productId,
                qty: i.qty,
                overrideUnitPrice: i.overrideUnitPrice,
                overrideReason: i.overrideReason,
              })),
              payments: checkoutPayments.map((p: any) => ({
                method: p.method,
                amount: p.amount,
                reference: p.reference,
                tenderedAmount: p.tenderedAmount,
              })),
              confirmation: normalizedConfirmation,
            },
            oldObservations: {
              saleRecoveryStatus: doc.saleRecoveryStatus,
              linkedEntityType: doc.linkedEntityType,
              linkedEntityId: doc.linkedEntityId,
              recoveryCheckoutOperationKey: doc.recoveryCheckoutOperationKey,
              recoveryCheckoutPayloadHash: doc.recoveryCheckoutPayloadHash,
            },
            newObservations: {
              saleRecoveryStatus: "UNRESOLVED",
              linkedEntityType: null,
              linkedEntityId: null,
              recoveryCheckoutOperationKey: newServerKey,
              recoveryCheckoutPayloadHash: newRecoveryFingerprint,
            },
          },
        },
      });

      const updatedDoc: any = {
        ...doc,
        recoveryCheckoutOperationKey: newServerKey,
        recoveryCheckoutPayloadHash: newRecoveryFingerprint,
      };

      return {
        document: toPublicSaleEvidence(updatedDoc),
        attemptId: revisionAudit.id,
        status: "PREPARED",
      };
    });
  } catch (err) {
    // Ambiguous revision commit reconciliation
    try {
      const checkDoc = await prisma.document.findFirst({
        where: { id: documentId },
      });
      if (
        checkDoc &&
        checkDoc.saleRecoveryStatus === "UNRESOLVED" &&
        checkDoc.recoveryCheckoutOperationKey &&
        checkDoc.recoveryCheckoutOperationKey !== rawInput.recovery.reference.billNo
      ) {
        const latestAudit = await prisma.auditLog.findFirst({
          where: {
            entityType: "Document",
            entityId: documentId,
            action: "SALE_RECOVERY_ATTEMPT_REVISED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (
          latestAudit &&
          latestAudit.actorId === actor.id &&
          (latestAudit.meta as any)?.previousAttemptAuditId === input.expectedAttemptId
        ) {
          return {
            document: toPublicSaleEvidence(checkDoc),
            attemptId: latestAudit.id,
            status: "PREPARED",
          };
        }
      }
    } catch {
      // ignore reconciliation error
    }
    throw err;
  }
}
