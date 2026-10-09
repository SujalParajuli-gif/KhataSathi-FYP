import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import prisma from "../db/prisma";
import * as capabilities from "../modules/settings/capabilities";
import * as documents from "../modules/documents/service";
import { readPurchaseBill, normalizeObservations, correctedSchema, saveRequest, extractionRequest, getPurchaseReview, extractPurchaseReview, savePurchaseReview, purchaseReviewCandidates, purchaseReviewDuplicates, PurchaseReviewError } from "../modules/inventory/purchaseReview";
import { purchaseReviewHandler } from "../modules/inventory/purchaseReviewController";

const observations = { supplierName: "Himalayan Supply", billNumber: "BILL-25", billDate: "2026-10-09", payable: "20.00", lines: [{ name: "Rice", code: null, unit: "PIECE", quantity: "2", cost: "10" }] };
const corrected = { ...observations, supplierId: null, lines: observations.lines.map(l => ({ ...l, productId: null })) };

test("purchase reader leaves uncertain decimals, dates and identity unresolved and rejects unbounded shapes", () => {
  const result = normalizeObservations({ ...observations, supplierName: null, billDate: "2083/06/23", payable: 20, lines: [{ name: "Rice", quantity: "two", cost: null }] });
  assert.equal(result.observations.billDate, null); assert.equal(result.observations.payable, null); assert.equal(result.observations.lines[0].quantity, null); assert.ok(result.warnings.length >= 4);
  assert.throws(() => normalizeObservations({ lines: Array(101).fill({}) }), PurchaseReviewError);
  assert.equal(correctedSchema.safeParse({ ...corrected, payable: "1e3" }).success, false);
  assert.equal(correctedSchema.safeParse({ ...corrected, payable: "-1" }).success, false);
  assert.equal(saveRequest.safeParse({ expectedRevision: randomUUID(), corrected, postStock: true }).success, false);
  assert.equal(extractionRequest.safeParse({ operationKey: randomUUID(), expectedRevision: null, supplierId: "not-authority" }).success, false);
});

test("actual purchase review services preserve raw observations, enforce privacy/stale guards and roll back staged audit failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ks-purchase-review-test-"));
  const filename = path.join(directory, "bill.png");
  const bytes = await sharp(Buffer.from('<svg width="400" height="200"><rect width="400" height="200" fill="white"/><text x="20" y="40">Himalayan Supply BILL-25</text><text x="20" y="100">Rice 2 PIECE 10.00 Total 20.00</text></svg>')).png().toBuffer();
  await fs.writeFile(filename, bytes);
  let doc: any = { id: "source", documentType: "STOCK_BILL", visibility: "ADMIN_MANAGER", deletedAt: null, linkedEntityId: null, linkedEntityType: null, purchaseReview: null, title: "Supplier bill", fileName: "bill.png", mimeType: "image/png", storedFileName: "bill.png", checksum: createHash("sha256").update(bytes).digest("hex") };
  let audits: any[] = []; let stagedWrites = 0; let locks = 0; let calls = 0; let failAudit = false; let inventoryEnabled = true; let providerError = false; let onProvider: (() => void) | null = null;
  const original = { caps: capabilities.getBusinessCapabilities, file: documents.getDocumentFilePath, find: prisma.document.findFirst, many: prisma.document.findMany, suppliers: prisma.supplier.findMany, receipts: prisma.stockReceiveBatch.findMany, tx: prisma.$transaction, fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY };
  (capabilities as any).getBusinessCapabilities = async () => ({ inventoryEnabled });
  (documents as any).getDocumentFilePath = () => filename;
  (prisma.document as any).findFirst = async () => structuredClone(doc);
  globalThis.fetch = async (_url: any, init: any) => {
    calls++; const body = JSON.parse(init.body); assert.equal(body.contents[0].parts[1].inline_data.mime_type, doc.mimeType); assert.ok(body.contents[0].parts[1].inline_data.data.length > 0);
    onProvider?.();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(observations) }] } }] }), { status: providerError ? 503 : 200 });
  };
  process.env.GEMINI_API_KEY = "test-purchase-reader-key";
  (prisma as any).$transaction = async (work: any) => {
    let staged = structuredClone(doc); const pending: any[] = [];
    const result = await work({ $queryRaw: async (query: any) => { assert.match(query.join(" "), /Document.*FOR UPDATE/); locks++; }, document: { findUnique: async () => structuredClone(staged), update: async ({ data }: any) => { stagedWrites++; staged = { ...staged, ...data }; return structuredClone(staged); } }, supplier: { findFirst: async () => null }, product: { count: async () => 0 }, auditLog: { create: async ({ data }: any) => { pending.push(data); if (failAudit) throw Error("Injected audit failure after staged write"); return data; } } });
    doc = staged; audits.push(...pending); return result;
  };
  try {
    for (const role of ["CASHIER", "STAFF", "UNKNOWN"]) await assert.rejects(getPurchaseReview("source", role), (e: any) => e.status === 403);
    inventoryEnabled = false; await assert.rejects(getPurchaseReview("source", "ADMIN"), (e: any) => e.status === 403); inventoryEnabled = true;
    doc.visibility = "ADMIN_ONLY"; await assert.rejects(getPurchaseReview("source", "MANAGER"), (e: any) => e.status === 404); doc.visibility = "ADMIN_MANAGER";
    const op = { operationKey: randomUUID(), expectedRevision: null };
    const extracted = await extractPurchaseReview("source", "ADMIN", "actor", op); assert.equal(calls, 1); assert.equal(audits.length, 1); assert.ok(locks);
    assert.equal(doc.documentType, "PURCHASE_BILL", "extraction upgrades generic stock proof to restricted purchase evidence");
    assert.equal((extracted as any).document.storedFileName, undefined); assert.equal((extracted as any).document.checksum, undefined);
    await extractPurchaseReview("source", "ADMIN", "actor", op); assert.equal(calls, 1); assert.equal(audits.length, 1);
    const input = { expectedRevision: extracted.review!.revision, corrected };
    const saved = await savePurchaseReview("source", "ADMIN", "actor", input); assert.deepEqual(saved.review!.observations, observations); assert.deepEqual(saved.review!.corrected, corrected);
    await savePurchaseReview("source", "ADMIN", "actor", input); assert.equal(audits.length, 2, "same save replay produces no second audit");
    await assert.rejects(savePurchaseReview("source", "ADMIN", "actor", { ...input, corrected: { ...corrected, payable: "21" } }), (e: any) => e.status === 409);
    const before = structuredClone(doc); const writesBefore = stagedWrites; failAudit = true;
    await assert.rejects(savePurchaseReview("source", "ADMIN", "actor", { expectedRevision: saved.review!.revision, corrected: { ...corrected, payable: "22" } }), /Injected audit/);
    assert.equal(stagedWrites, writesBefore + 1, "real document update staged before failure"); assert.deepEqual(doc, before); assert.equal(audits.length, 2); failAudit = false;
    providerError = true; await assert.rejects(extractPurchaseReview("source", "ADMIN", "actor", { operationKey: randomUUID(), expectedRevision: saved.review!.revision }), (e: any) => e.status === 503); assert.deepEqual(doc, before); providerError = false;
    onProvider = () => { doc.linkedEntityType = "StockReceiveBatch"; doc.linkedEntityId = "competing-receipt"; };
    await assert.rejects(extractPurchaseReview("source", "ADMIN", "actor", { operationKey: randomUUID(), expectedRevision: saved.review!.revision }), (e: any) => e.status === 409); assert.equal(audits.length, 2); onProvider = null; doc.linkedEntityId = null; doc.linkedEntityType = null;
    doc.purchaseReview = null; doc.mimeType = "application/pdf"; const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF"); await fs.writeFile(filename, pdf); doc.checksum = createHash("sha256").update(pdf).digest("hex");
    const pdfResult = await extractPurchaseReview("source", "MANAGER", "actor", { operationKey: randomUUID(), expectedRevision: null }); assert.equal(pdfResult.document.mimeType, "application/pdf");
    let candidateArgs: any; (prisma.supplier as any).findMany = async (args: any) => { candidateArgs = args; return [{ id: "supplier", name: "Himalayan Supply" }]; };
    await purchaseReviewCandidates("source", "ADMIN", "Himalayan", "supplier"); assert.equal(candidateArgs.take, 5); assert.deepEqual(candidateArgs.select, { id: true, name: true, panNo: true });
    let where: any; (prisma.document as any).findMany = async (args: any) => { where = args.where; return [{ linkedEntityId: "receipt" }]; }; (prisma.stockReceiveBatch as any).findMany = async (args: any) => { assert.equal(args.take, 10); return [{ id: "receipt", supplierName: "Old text", billNumber: "BILL-25", payable: null, supplierId: null, postedAt: null }]; };
    const dup = await purchaseReviewDuplicates("source", "MANAGER"); assert.deepEqual(where.visibility, { not: "ADMIN_ONLY" }); assert.equal(dup.items[0].knownPayable, false); assert.equal(dup.items[0].reason, "Same uploaded file");
    const req: any = { user: { id: "cashier", role: "CASHIER" }, params: { id: "source" } }; let status = 0; const res: any = { status(v: number) { status = v; return this; }, json() { return this; } };
    await purchaseReviewHandler("extract")(req, res); assert.equal(status, 403);
  } finally {
    (capabilities as any).getBusinessCapabilities = original.caps; (documents as any).getDocumentFilePath = original.file;
    prisma.document.findFirst = original.find; prisma.document.findMany = original.many; prisma.supplier.findMany = original.suppliers; prisma.stockReceiveBatch.findMany = original.receipts; (prisma as any).$transaction = original.tx; globalThis.fetch = original.fetch;
    if (original.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original.key;
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("purchase provider rejects missing configuration, malformed response and actual deadline abort without losing source authority", async () => {
  const names = ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_AI_API_KEY"];
  const keys = names.map(name => process.env[name]); const originalFetch = globalThis.fetch; const originalTimer = globalThis.setTimeout;
  try {
    names.forEach(name => delete process.env[name]);
    await assert.rejects(readPurchaseBill(Buffer.from("owned"), "image/png"), (e: any) => e.status === 503 && /not configured/.test(e.message));
    process.env.GEMINI_API_KEY = "test-only-key";
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{not valid JSON" }] } }] }));
    await assert.rejects(readPurchaseBill(Buffer.from("owned"), "image/png"), (e: any) => e.status === 503);
    let aborted = false;
    (globalThis as any).setTimeout = (fn: any, ms: number, ...args: any[]) => (originalTimer as any)(fn, ms === 55000 ? 1 : ms, ...args);
    globalThis.fetch = async (_url: any, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("Owned deadline abort")); }, { once: true }));
    await assert.rejects(readPurchaseBill(Buffer.from("owned"), "application/pdf"), (e: any) => e.status === 503 && /timed out/.test(e.message));
    assert.equal(aborted, true, "provider signal actually entered abort branch");
  } finally {
    names.forEach((name, i) => { if (keys[i] === undefined) delete process.env[name]; else process.env[name] = keys[i]; });
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer;
  }
});
