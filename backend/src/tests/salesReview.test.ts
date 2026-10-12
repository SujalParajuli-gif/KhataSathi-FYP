import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import prisma from "../db/prisma";
import * as capabilities from "../modules/settings/capabilities";
import * as documents from "../modules/documents/service";
import { observationSchema, correctedSchema, saveRequest, extractRequest, getSalesReview, extractSalesReview, saveSalesReview, salesReviewMatches, readSalesBill } from "../modules/salesEvidence/review";

const actor = { id: "reviewer", role: "ADMIN" };
const observations = { billNumber: "SALE-12", customerName: "Sita", billDate: "2026-10-12", total: "20.50", lines: [{ name: "Rice", code: null, unit: "PIECE", quantity: "2", unitPrice: null }] };
const corrected = { ...observations, lines: observations.lines.map(l => ({ ...l, productId: null })) };

test("sales review validates untrusted facts without posting fields, guessed dates or numeric coercion", () => {
  assert.equal(observationSchema.safeParse(observations).success, true);
  for (const extra of [{ total: 20 }, { billDate: "2083/06/26" }, { billDate: "2026-02-30" }, { total: "1e3" }, { total: "-1" }, { lines: Array(101).fill(observations.lines[0]) }, { autoPost: true }])
    assert.equal(observationSchema.safeParse({ ...observations, ...extra }).success, false);
  assert.equal(correctedSchema.safeParse(corrected).success, true);
  assert.equal(saveRequest.safeParse({ expectedRevision: null, corrected, taxRate: 13 }).success, false);
  assert.equal(extractRequest.safeParse({ operationKey: randomUUID(), expectedRevision: null, productId: "auto-selected" }).success, false);
});

test("actual sales review branches preserve raw/corrected state, staged audit rollback and competing decisions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ks-sales-review-")), filename = path.join(directory, "source.png");
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).png().toBuffer(); await fs.writeFile(filename, bytes);
  let doc: any = { id: "source", documentType: "SALE_BILL", visibility: "ADMIN_MANAGER", deletedAt: null, linkedEntityId: null, linkedEntityType: null,
    saleRecoveryStatus: "UNRESOLVED", recoveryCheckoutOperationKey: null, recoveryCheckoutPayloadHash: null, salesReview: null, title: "Sales source", fileName: "source.png", storedFileName: "source.png", mimeType: "image/png", checksum: createHash("sha256").update(bytes).digest("hex") };
  let audits: any[] = [], writes = 0, locks = 0, calls = 0, failAudit = false, pos = true, activeProducts = 0;
  let onProvider: (() => void) | null = null, onLock: (() => void) | null = null;
  const original = { caps: capabilities.getBusinessCapabilities, file: documents.getDocumentFilePath, find: prisma.document.findUnique, many: prisma.document.findMany,
    products: prisma.product.findMany, invoices: prisma.invoice.findMany, tx: prisma.$transaction, fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY };
  (capabilities as any).getBusinessCapabilities = async () => ({ posEnabled: pos });
  (documents as any).getDocumentFilePath = () => filename;
  (prisma.document as any).findUnique = async () => structuredClone(doc);
  (prisma as any).$transaction = async (work: any) => {
    let staged = structuredClone(doc); const pending: any[] = [];
    const result = await work({
      $queryRaw: async (query: any) => { assert.match(query.join(" "), /Document.*FOR UPDATE/); locks++; onLock?.(); staged = structuredClone(doc); },
      document: { findUnique: async () => structuredClone(staged), update: async ({ data }: any) => { writes++; staged = { ...staged, ...data }; return structuredClone(staged); } },
      product: { count: async () => activeProducts }, auditLog: { create: async ({ data }: any) => { pending.push(data); if (failAudit) throw Error("Injected audit failure after staged review write"); return data; } },
    });
    doc = staged; audits.push(...pending); return result;
  };
  const reader = async (input: Buffer, mime: string) => { calls++; assert.equal(mime, "image/png"); assert.deepEqual(input, bytes); onProvider?.(); return { observations, model: "fixture-only" }; };
  try {
    await assert.rejects(getSalesReview("source", { id: "staff", role: "STAFF" }), (e: any) => e.statusCode === 403);
    pos = false; await assert.rejects(getSalesReview("source", actor), (e: any) => e.statusCode === 403); pos = true;
    doc.visibility = "ADMIN_ONLY"; await assert.rejects(getSalesReview("source", { ...actor, role: "MANAGER" }), (e: any) => e.status === 404); doc.visibility = "ADMIN_MANAGER";
    const manual = await saveSalesReview("source", actor, { expectedRevision: null, corrected });
    assert.equal(manual.review!.model, "MANUAL"); assert.equal(manual.review!.observations.total, null); assert.equal(audits.length, 1);
    await saveSalesReview("source", actor, { expectedRevision: null, corrected }); assert.equal(audits.length, 1, "lost-response manual save replay is nonmutating");
    const op = { operationKey: randomUUID(), expectedRevision: manual.review!.revision };
    const read = await extractSalesReview("source", actor, op, reader); assert.ok(locks > 0); assert.equal(calls, 1);
    assert.deepEqual(read.review!.observations, observations); assert.deepEqual(read.review!.corrected, corrected);
    await extractSalesReview("source", actor, op, reader); assert.equal(calls, 1); assert.equal(audits.length, 2);
    await assert.rejects(extractSalesReview("source", actor, { ...op, expectedRevision: null }, reader), (e: any) => e.status === 409);
    const changed = { ...corrected, total: "21.00" }, input = { expectedRevision: read.review!.revision, corrected: changed };
    const saved = await saveSalesReview("source", actor, input); assert.deepEqual(saved.review!.observations, observations); assert.equal(saved.review!.corrected!.total, "21.00");
    await saveSalesReview("source", actor, input); assert.equal(audits.length, 3);
    await assert.rejects(saveSalesReview("source", actor, { ...input, corrected }), (e: any) => e.status === 409);
    const before = structuredClone(doc), writesBefore = writes; failAudit = true;
    await assert.rejects(saveSalesReview("source", actor, { expectedRevision: saved.review!.revision, corrected }), /Injected audit failure/);
    assert.equal(writes, writesBefore + 1, "real review write staged before fault"); assert.deepEqual(doc, before); assert.equal(audits.length, 3); failAudit = false;
    await assert.rejects(saveSalesReview("source", actor, { expectedRevision: saved.review!.revision, corrected: { ...corrected, lines: [{ ...corrected.lines[0], productId: "inactive" }] } }), (e: any) => e.status === 400);
    const mutationCount = writes;
    onProvider = () => { doc.saleRecoveryStatus = "ARCHIVED"; };
    await assert.rejects(extractSalesReview("source", actor, { operationKey: randomUUID(), expectedRevision: saved.review!.revision }, reader), (e: any) => e.status === 409);
    assert.equal(writes, mutationCount); assert.equal(audits.length, 3); assert.equal(doc.saleRecoveryStatus, "ARCHIVED"); assert.deepEqual(doc.salesReview, before.salesReview);
    assert.equal((await getSalesReview("source", actor)).document.saleRecoveryStatus, "ARCHIVED", "refresh shows competing terminal outcome");
    onProvider = null; doc.saleRecoveryStatus = "UNRESOLVED";
    onLock = () => { doc.visibility = "ADMIN_ONLY"; };
    await assert.rejects(saveSalesReview("source", { ...actor, role: "MANAGER" }, { expectedRevision: saved.review!.revision, corrected }), (e: any) => e.status === 404);
    assert.equal(writes, mutationCount); onLock = null; doc.visibility = "ADMIN_MANAGER";
    onProvider = () => { pos = false; };
    await assert.rejects(extractSalesReview("source", actor, { operationKey: randomUUID(), expectedRevision: saved.review!.revision }, reader), (e: any) => e.statusCode === 403);
    assert.equal(writes, mutationCount); onProvider = null; pos = true;
    doc.recoveryCheckoutOperationKey = "prepared-operation";
    await assert.rejects(saveSalesReview("source", actor, { expectedRevision: saved.review!.revision, corrected }), (e: any) => e.status === 409); doc.recoveryCheckoutOperationKey = null;
    doc.checksum = "0".repeat(64);
    await assert.rejects(extractSalesReview("source", actor, { operationKey: randomUUID(), expectedRevision: saved.review!.revision }, reader), (e: any) => e.status === 409); doc.checksum = before.checksum;
    assert.equal(writes, mutationCount);

    (prisma.product as any).findMany = async (args: any) => { assert.equal(args.where.isActive, true); if (args.where.sku === "R1") { assert.equal(args.take, 1); return [{ id: "exact-B", name: "Rice", sku: "R1" }]; } assert.equal(args.take, 4); return [{ id: "ambiguous-A", name: "Rice", sku: "R2" }]; };
    (prisma.invoice as any).findMany = async (args: any) => { assert.equal(args.take, 20); assert.equal(args.where.cancelledAt, undefined, "cancelled candidates are not silently excluded"); return [
      { id: "cancelled", invoiceNo: "INV-CANCELLED", netTotal: 22, cancelledAt: new Date(), paymentStatus: "CANCELLED", billingChannel: null, externalBillNo: "OTHER", externalBillDate: null, customerSnapshotCapturedAt: new Date(), customerNameSnapshot: "Other", creditNotesAsOriginal: [], creditNoteAsReplacement: null, items: [] },
      { id: "replaced", invoiceNo: "INV-REPLACED", netTotal: 21, cancelledAt: null, paymentStatus: "PAID", billingChannel: null, externalBillDate: null, creditNotesAsOriginal: [{ id: "correction" }], creditNoteAsReplacement: null, items: [] },
    ]; };
    (prisma.document as any).findMany = async (args: any) => { assert.equal(args.take, 10); assert.deepEqual(args.where.visibility.in, ["ALL_AUTHENTICATED", "ADMIN_MANAGER"]); return [{ id: "visible-duplicate", fileName: "duplicate.png", saleRecoveryStatus: "ATTACHED" }]; };
    const matches = await salesReviewMatches("source", { ...actor, role: "MANAGER" }, "R1");
    assert.equal(matches.products[0].id, "exact-B"); assert.equal(matches.products.length, 2, "ambiguous suggestions retained, never autoselected");
    assert.ok(matches.candidates.every(c => !c.eligible)); assert.ok(matches.candidates[0].differences.includes("Printed total differs from invoice net total"));
    assert.equal(matches.duplicates.length, 1); assert.deepEqual(doc, before, "matching emits no review/claim/financial writes");

    process.env.GEMINI_API_KEY = "test-sales-reader-key";
    globalThis.fetch = async (_url: any, init: any) => { const body = JSON.parse(init.body); assert.match(body.contents[0].parts[0].text, /sales bill/); assert.equal(body.contents[0].parts[1].inline_data.mime_type, "image/png"); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(observations) }] } }] })); };
    assert.deepEqual((await readSalesBill(bytes, "image/png")).observations, observations);
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...observations, total: 20 }) }] } }] }));
    await assert.rejects(readSalesBill(bytes, "image/png"), (e: any) => e.status === 502);
    globalThis.fetch = async () => { throw Error("credential-bearing provider error must never escape"); };
    await assert.rejects(readSalesBill(bytes, "image/png"), (e: any) => e.status === 503 && !e.message.includes("credential-bearing"));
  } finally {
    (capabilities as any).getBusinessCapabilities = original.caps; (documents as any).getDocumentFilePath = original.file;
    (prisma.document as any).findUnique = original.find; (prisma.document as any).findMany = original.many;
    (prisma.product as any).findMany = original.products; (prisma.invoice as any).findMany = original.invoices; (prisma as any).$transaction = original.tx;
    globalThis.fetch = original.fetch; if (original.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original.key;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
