import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../db/prisma";
import * as caps from "../modules/settings/capabilities";
import * as purchases from "../modules/inventory/purchases";
import { confirmPurchaseReview, getPurchaseReview, type ReviewState } from "../modules/inventory/purchaseReview";
import { confirmationRequest, validateReviewClaim, recordReviewResolution } from "../modules/inventory/purchaseReviewClaim";

const facts = { supplierName: "Reviewed supplier", supplierId: "supplier", billNumber: "B25", billDate: "2026-10-09", payable: "20", lines: [{ name: "Rice", code: null, unit: "BOX", quantity: "2", cost: "10", productId: "product", conversionFactor: "3" }] };
function source() { return { id: "source", fileName: "bill.png", mimeType: "image/png", documentType: "PURCHASE_BILL", visibility: "ADMIN_MANAGER", deletedAt: null, linkedEntityId: null, linkedEntityType: null,
  purchaseReview: { version: 1, revision: randomUUID(), extractionId: randomUUID(), operationKey: randomUUID(), sourceSha256: "owned", model: "stub", extractedAt: new Date().toISOString(), observations: { ...facts, payable: "9999" }, corrected: facts, warnings: [] } as ReviewState }; }

test("purchase confirmation accepts decisions only and rejects arbitrary posting keys/financial payload", () => {
  const request = { action: "create", expectedRevision: randomUUID(), reason: "Reviewed duplicates" };
  assert.ok(confirmationRequest.safeParse(request).success);
  for (const extra of [{ operationKey: randomUUID() }, { payable: "0" }, { lines: [] }, { receiptId: "target" }]) assert.equal(confirmationRequest.safeParse({ ...request, ...extra }).success, false);
  assert.equal(confirmationRequest.safeParse({ ...request, reason: "" }).success, false);
  assert.equal(confirmationRequest.safeParse({ ...request, action: "attach" }).success, false);
});

test("saved corrections own Phase4 input, server key is stable, replay remains private and conflicts do not post", async () => {
  let doc: any = source(); let enabled = true; let calls = 0; let payload: any; let mode = "create";
  const original = { find: prisma.document.findFirst, caps: caps.getBusinessCapabilities, post: purchases.postFinancialPurchaseReceipt, attach: purchases.attachDocumentsToPurchaseReceipt };
  (caps as any).getBusinessCapabilities = async () => ({ inventoryEnabled: enabled });
  (prisma.document as any).findFirst = async () => structuredClone(doc);
  const finish = async (claim: any) => {
    calls++; validateReviewClaim(doc, claim, "ADMIN");
    let staged = structuredClone(doc); const audits: any[] = [];
    await recordReviewResolution({ document: { update: async ({ data }: any) => { staged = { ...staged, ...data }; } }, auditLog: { create: async ({ data }: any) => audits.push(data) } } as any, doc, claim, "receipt");
    doc = { ...staged, linkedEntityId: "receipt", linkedEntityType: "StockReceiveBatch" }; assert.equal(audits.length, 1); return { id: "receipt" };
  };
  (purchases as any).postFinancialPurchaseReceipt = async (input: any, actor: string, role: string, claim: any) => { payload = input; assert.equal(role, "ADMIN"); return finish(claim); };
  (purchases as any).attachDocumentsToPurchaseReceipt = async (id: string, ids: string[], actor: string, role: string, claim: any) => { mode = "attach"; assert.equal(id, "receipt"); assert.deepEqual(ids, ["source"]); return finish(claim); };
  try {
    const input: any = { action: "create", expectedRevision: doc.purchaseReview.revision, reason: "Inspected duplicate candidates" };
    await assert.rejects(confirmPurchaseReview("source", "CASHIER", "actor", input), (e: any) => e.status === 403);
    enabled = false; await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", input), (e: any) => e.status === 403); enabled = true;
    await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", { ...input, expectedRevision: randomUUID() }), (e: any) => e.status === 409); assert.equal(calls, 0);
    doc.purchaseReview.corrected = null; await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", input), (e: any) => e.status === 409);
    doc.purchaseReview.corrected = { ...facts, payable: null }; await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", input), (e: any) => e.status === 400);
    doc.purchaseReview.corrected = facts;
    const first = await confirmPurchaseReview("source", "ADMIN", "actor", input); assert.equal(calls, 1); assert.equal(first.review!.resolution!.receiptId, "receipt");
    assert.equal(payload.payable, "20"); assert.equal(payload.lines[0].conversionFactor, "3"); assert.notEqual(payload.operationKey, doc.purchaseReview.operationKey); assert.deepEqual(payload.documentIds, ["source"]);
    await confirmPurchaseReview("source", "ADMIN", "actor", input); assert.equal(calls, 1, "lost response retries read committed outcome without posting again");
    for (const modified of [{ ...input, reason: "Changed decision" }, { ...input, action: "attach", receiptId: "receipt" }, { ...input, expectedRevision: randomUUID() }]) await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", modified), (e: any) => e.status === 409);
    await assert.rejects(confirmPurchaseReview("source", "ADMIN", "other", input), (e: any) => e.status === 409);
    assert.ok((await getPurchaseReview("source", "MANAGER")).review!.resolution, "second authorized reviewer reads outcome without impersonating actor");
    doc.visibility = "ADMIN_ONLY"; await assert.rejects(confirmPurchaseReview("source", "MANAGER", "actor", input), (e: any) => e.status === 404); assert.equal(calls, 1);
    doc = source(); await confirmPurchaseReview("source", "ADMIN", "actor", { action: "attach", expectedRevision: doc.purchaseReview.revision, receiptId: "receipt", reason: "Same existing purchase" }); assert.equal(mode, "attach"); assert.equal(calls, 2);
    doc = source(); doc.purchaseReview.corrected = { ...facts, lines: facts.lines.map(l => ({ ...l, conversionFactor: null })) };
    await assert.rejects(confirmPurchaseReview("source", "ADMIN", "actor", { action: "create", expectedRevision: doc.purchaseReview.revision, reason: "Reviewed unknown conversion" }), (e: any) => e.status === 400); assert.equal(calls, 2);
    doc = source(); doc.purchaseReview.corrected = { ...facts, billDate: null };
    await confirmPurchaseReview("source", "ADMIN", "actor", { action: "create", expectedRevision: doc.purchaseReview.revision, reason: "Reviewed missing date; preserve unknown" }); assert.equal(payload.billDate, null); assert.equal(calls, 3);
  } finally { prisma.document.findFirst = original.find; (caps as any).getBusinessCapabilities = original.caps; (purchases as any).postFinancialPurchaseReceipt = original.post; (purchases as any).attachDocumentsToPurchaseReceipt = original.attach; }
});

test("locked claim rejects stale/private/claimed sources and actual staged outcome audit rolls back", async () => {
  const doc: any = source(); const claim: any = { documentId: doc.id, actorId: "actor", action: "create", expectedRevision: doc.purchaseReview.revision, reason: "Reviewed source" };
  assert.throws(() => validateReviewClaim({ ...doc, visibility: "ADMIN_ONLY" }, claim, "MANAGER"), (e: any) => e.status === 404);
  assert.throws(() => validateReviewClaim(doc, { ...claim, expectedRevision: randomUUID() }, "ADMIN"), (e: any) => e.status === 409);
  assert.throws(() => validateReviewClaim({ ...doc, checksum: "changed-source" }, claim, "ADMIN"), (e: any) => e.status === 409);
  assert.throws(() => validateReviewClaim({ ...doc, linkedEntityId: "other" }, claim, "ADMIN"), (e: any) => e.status === 409);
  let committed = structuredClone(doc); let stagedWrites = 0; let stagedAudits = 0;
  async function tx(fail: boolean) { let staged = structuredClone(committed);
    await recordReviewResolution({ document: { update: async ({ data }: any) => { stagedWrites++; staged = { ...staged, ...data }; } }, auditLog: { create: async () => { stagedAudits++; if (fail) throw Error("Injected outcome audit failure"); } } } as any, committed, claim, "receipt"); committed = staged;
  }
  await assert.rejects(tx(true), /Injected outcome audit/); assert.equal(stagedWrites, 1); assert.equal(stagedAudits, 1); assert.deepEqual(committed, doc);
  await tx(false); assert.equal(committed.purchaseReview.resolution.receiptId, "receipt"); assert.deepEqual(committed.purchaseReview.corrected, facts);
});
