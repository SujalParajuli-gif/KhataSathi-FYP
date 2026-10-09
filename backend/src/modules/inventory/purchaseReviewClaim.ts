import { Prisma } from "@prisma/client";
import { z } from "zod/v4";

export class PurchaseConfirmationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const confirmationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), expectedRevision: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal("attach"), expectedRevision: z.string().uuid(), receiptId: z.string().trim().min(1).max(120), reason: z.string().trim().min(3).max(500) }).strict(),
]);
export type ConfirmationInput = z.infer<typeof confirmationRequest>;
export type ReviewClaim = ConfirmationInput & { documentId: string; actorId: string };
export type ReviewResolution = { action: "create" | "attach"; expectedRevision: string; receiptId: string; actorId: string; reason: string; confirmedAt: string };

export function matchesResolution(resolution: ReviewResolution, input: ConfirmationInput, actorId: string) {
  return resolution.expectedRevision === input.expectedRevision && resolution.action === input.action &&
    resolution.actorId === actorId && resolution.reason === input.reason &&
    (input.action === "create" || resolution.receiptId === input.receiptId);
}

// Called only after Phase4 has acquired the Document lock, before financial/claim effects.
export function validateReviewClaim(doc: any, claim: ReviewClaim, role: string) {
  if (!doc || doc.deletedAt || doc.documentType !== "PURCHASE_BILL" || (role === "MANAGER" && doc.visibility === "ADMIN_ONLY"))
    throw new PurchaseConfirmationError(404, "Purchase source not found");
  const review = doc.purchaseReview;
  if (!review || review.version !== 1 || review.revision !== claim.expectedRevision || !review.corrected)
    throw new PurchaseConfirmationError(409, "Saved review changed. Reload and inspect it before confirming.");
  if (doc.checksum && review.sourceSha256 !== doc.checksum) throw new PurchaseConfirmationError(409, "Source integrity changed. Inspect the retained source before confirming.");
  if (review.resolution) {
    if (doc.linkedEntityType === "StockReceiveBatch" && doc.linkedEntityId === review.resolution.receiptId && matchesResolution(review.resolution, claim, claim.actorId)) return;
    throw new PurchaseConfirmationError(409, "This review already has a different confirmed outcome.");
  }
  if (doc.linkedEntityId || doc.linkedEntityType) throw new PurchaseConfirmationError(409, "Source was claimed by another operation. Inspect the linked receipt.");
}

export async function recordReviewResolution(tx: Prisma.TransactionClient, doc: any, claim: ReviewClaim, receiptId: string) {
  if (doc.purchaseReview.resolution) return;
  const resolution: ReviewResolution = { action: claim.action, expectedRevision: claim.expectedRevision, receiptId, actorId: claim.actorId, reason: claim.reason, confirmedAt: new Date().toISOString() };
  await tx.document.update({ where: { id: doc.id }, data: { purchaseReview: { ...doc.purchaseReview, resolution } } });
  await tx.auditLog.create({ data: { actorId: claim.actorId, action: "PURCHASE_OCR_CONFIRMED", entityType: "Document", entityId: doc.id,
    meta: { extractionId: doc.purchaseReview.extractionId, sourceSha256: doc.purchaseReview.sourceSha256, corrected: doc.purchaseReview.corrected, resolution } } });
}
