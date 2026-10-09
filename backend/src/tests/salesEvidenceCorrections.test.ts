import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prisma from "../db/prisma";
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "ks-proof-corrections-"));
process.env.DOCUMENT_STORAGE_ROOT = storage;
const { reassociateSaleEvidence, voidSaleEvidence, getSaleEvidenceHistory } = require("../modules/salesEvidence/corrections") as typeof import("../modules/salesEvidence/corrections");
const { getManualBillRecord } = require("../modules/invoices/manualBill/service") as typeof import("../modules/invoices/manualBill/service");
const { listAuditLogs, listCategorizedHistory } = require("../modules/audit/service") as typeof import("../modules/audit/service");
const { reassociateSaleEvidenceHandler, voidSaleEvidenceHandler, getSaleEvidenceHistoryHandler } = require("../modules/salesEvidence/controller") as typeof import("../modules/salesEvidence/controller");
after(() => fs.rmSync(storage, { recursive: true, force: true }));
const actor = { id: "reviewer", role: "MANAGER" as const, name: "Reviewer" };
const caps = async () => ({ businessMode: "FULL_POS" as const, catalogEnabled: true as const, inventoryEnabled: true, posEnabled: true, staffDraftRequestsEnabled: true, stockTracked: true });
const paper = { billingChannel: "MANUAL_EXTERNAL" as const, externalDocumentType: "PAN_INVOICE" as const, externalBillNo: "OLD", externalBillDate: "2026-10-01", billRecordStatus: "VERIFIED" as const };
const payload = () => ({ invoiceId: "target", expectedSourceInvoiceId: "source", expectedSourceInvoice: paper,
  expectedInvoice: paper, reference: { billNo: "NEW", externalDocumentType: "PAN_INVOICE" as const, externalBillDate: "2026-10-08" }, reason: "Correct mistaken association" });
function matches(row: any, where: any): boolean {
  return !!row && Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === "AND") return value.every((item: any) => matches(row, item));
    if (key === "OR") return value.some((item: any) => matches(row, item));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return !matches(row, { [key]: value.not });
      if ("startsWith" in value) return String(row[key]).startsWith(value.startsWith);
      if ("contains" in value) return String(row[key]).includes(value.contains);
      if ("equals" in value) return row[key] === value.equals;
    }
    return row[key] instanceof Date && value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
  });
}
function fixture(failure?: "audit" | "commit") {
  const inv = (id: string) => ({ id, invoiceNo: id, ...paper, externalBillDate: new Date("2026-10-01T00:00:00Z"),
    deletedAt: null, cancelledAt: null, status: "FINALIZED", paymentStatus: "UNPAID", netTotal: 100,
    creditNotesAsOriginal: [], creditNoteAsReplacement: null, finalizedAt: new Date(), customer: null });
  let state: any = { invoices: [inv("source"), inv("target")], audits: [], document: { id: "proof", documentType: "SALE_BILL", visibility: "ADMIN_MANAGER",
    saleRecoveryStatus: "ATTACHED", linkedEntityType: "Invoice", linkedEntityId: "source", recoveryCheckoutOperationKey: null, recoveryCheckoutPayloadHash: null,
    deletedAt: null, deletedById: null, deleteReason: null, purgeAfter: null, title: "Paper", fileName: "paper.pdf", storedPath: "proof-tests", storedFileName: "paper.pdf",
    mimeType: "application/pdf", fileSize: 10, checksum: "unchanged", thumbnailFileName: null, createdAt: new Date(), uploadedById: actor.id } };
  const dir = path.join(storage, "proof-tests"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "paper.pdf"), "test-paper");
  const saved: Array<() => void> = [], lockQueries: string[] = []; let txCount = 0, claims = 0, auditWrites = 0, reconciliations = 0;
  const replace = (obj: any, key: string, value: any) => { const old = obj[key]; saved.push(() => { obj[key] = old; }); obj[key] = value; };
  function client(local?: any): any {
    const current = () => local ?? state;
    const readInvoice = ({ where }: any) => structuredClone(current().invoices.find((row: any) => matches(row, where)) ?? null);
    const readDoc = ({ where }: any) => { if (!local) reconciliations++; return matches(current().document, where) ? structuredClone(current().document) : null; };
    const readAudits = ({ where }: any) => [...current().audits].filter((row: any) => matches(row, where)).reverse();
    return {
      invoice: { findUnique: readInvoice, findFirst: readInvoice, findMany: async () => [], update: async ({ where, data }: any) => {
        assert.ok(local); assert.ok(Object.keys(data).every((key) => Object.keys(paper).includes(key)), "metadata-only invoice writes");
        return Object.assign(local.invoices.find((row: any) => row.id === where.id), data);
      } },
      document: { findFirst: readDoc, findUnique: readDoc, findMany: async (args: any) => { const row = readDoc(args); return row ? [row] : []; },
        updateMany: async ({ where, data }: any) => { assert.ok(local); claims++; if (!matches(local.document, where)) return { count: 0 };
          Object.assign(local.document, data); return { count: 1 }; } },
      auditLog: { findFirst: async (args: any) => readAudits(args)[0] ?? null, findMany: async (args: any) => readAudits(args),
        create: async ({ data }: any) => { assert.ok(local); auditWrites++; if (failure === "audit") throw new Error("audit fault after staged mutation");
          const log = { id: `audit-${local.audits.length}`, createdAt: new Date(), ...structuredClone(data), actor: actor };
          local.audits.push(log); return log; } },
      $queryRaw: async (query: TemplateStringsArray) => { lockQueries.push(query.join("?")); return []; },
    };
  }
  for (const model of ["invoice", "document", "auditLog"]) for (const [key, value] of Object.entries(client()[model])) replace((prisma as any)[model], key, value);
  replace(prisma, "$transaction", async (work: any) => { txCount++; const local = structuredClone(state); const result = await work(client(local));
    state = local; if (failure === "commit") throw new Error("lost commit response"); return result; });
  return { get state() { return state; }, stats: () => ({ txCount, claims, auditWrites, reconciliations }), locks: lockQueries,
    restore: () => { while (saved.length) saved.pop()!(); } };
}

test("proof corrections metadata-only, deterministic locks, three audits, exact retry and private old-invoice history", async () => {
  const fx = fixture(); try {
    const result = await reassociateSaleEvidence("proof", payload(), actor, caps);
    assert.equal(result.sourceInvoice.billRecordStatus, "RECORDED"); assert.equal(result.sourceInvoice.externalBillNo, "OLD");
    assert.equal(result.invoice.billRecordStatus, "RECORDED"); assert.equal(result.document.linkedEntityId, "target");
    assert.equal(fx.state.audits.length, 3); assert.equal(fx.stats().claims, 1); assert.match(fx.locks[0], /FROM Invoice/); assert.match(fx.locks[2], /FROM Document/);
    const repeat = await reassociateSaleEvidence("proof", payload(), actor, caps); assert.equal(repeat.replayed, true); assert.equal(fx.state.audits.length, 3);
    await assert.rejects(reassociateSaleEvidence("proof", { ...payload(), reason: "different reason" }, actor, caps), (e: any) => e.code === "STALE_ASSOCIATION");
    assert.equal((await getManualBillRecord("source", actor, prisma, caps)).history.length, 1);
    fx.state.document.visibility = "ADMIN_ONLY";
    assert.equal((await getManualBillRecord("source", actor, prisma, caps)).history.length, 0);
    await assert.rejects(getSaleEvidenceHistory("proof", actor, caps), (e: any) => e.code === "NOT_FOUND");
    const history = await getSaleEvidenceHistory("proof", { ...actor, role: "ADMIN" }, caps);
    assert.ok(!JSON.stringify(history.history).match(/recoveryCheckout|decisionHash|storedPath|checksum/));
  } finally { fx.restore(); }
});
for (const failure of ["audit", "commit"] as const) test(`correction ${failure} exercises staged rollback or committed reconciliation`, async () => {
  const fx = fixture(failure); try {
    if (failure === "audit") { await assert.rejects(reassociateSaleEvidence("proof", payload(), actor, caps), /audit fault/); assert.equal(fx.state.document.linkedEntityId, "source"); assert.equal(fx.state.audits.length, 0); }
    else { assert.equal((await reassociateSaleEvidence("proof", payload(), actor, caps)).replayed, true); assert.equal(fx.state.document.linkedEntityId, "target"); assert.equal(fx.state.audits.length, 3); }
    assert.equal(fx.stats().txCount, 1); assert.ok(fx.stats().auditWrites > 0); assert.ok(fx.stats().reconciliations >= 2);
  } finally { fx.restore(); }
});
for (const [label, change, code] of [
  ["cancelled", (fx: any) => { fx.state.invoices[0].cancelledAt = new Date(); }, "INVOICE_INELIGIBLE"],
  ["replaced", (fx: any) => { fx.state.invoices[0].creditNotesAsOriginal = [{ id: "replacement" }]; }, "INVOICE_INELIGIBLE"],
  ["replacement target", (fx: any) => { fx.state.invoices[1].creditNoteAsReplacement = { id: "credit" }; }, "INVOICE_INELIGIBLE"],
  ["draft", (fx: any) => { fx.state.invoices[1].status = "DRAFT"; }, "INVOICE_INELIGIBLE"],
  ["deleted", (fx: any) => { fx.state.invoices[1].deletedAt = new Date(); }, "INVOICE_INELIGIBLE"],
  ["IRD", (fx: any) => { fx.state.invoices[1].billingChannel = "IRD_ELECTRONIC"; }, "INVOICE_INELIGIBLE"],
  ["stale target", (fx: any) => { fx.state.invoices[1].externalBillNo = "EDITED"; }, "STALE_RECORD_CONFLICT"],
  ["stale source", (fx: any) => { fx.state.invoices[0].externalBillNo = "EDITED"; }, "STALE_RECORD_CONFLICT"],
  ["private document", (fx: any) => { fx.state.document.visibility = "ADMIN_ONLY"; }, "NOT_FOUND"],
] as const) test(`correction denies ${label} without writes`, async () => {
  const fx = fixture(); try { change(fx); await assert.rejects(reassociateSaleEvidence("proof", payload(), actor, caps), (e: any) => e.code === code); assert.equal(fx.state.audits.length, 0); assert.equal(fx.stats().claims, 0); } finally { fx.restore(); }
});
test("role/capability/strict payload and missing original file reject before mutation", async () => {
  const fx = fixture(); try {
    await assert.rejects(reassociateSaleEvidence("proof", payload(), { ...actor, role: "CASHIER" }, caps), (e: any) => e.statusCode === 403);
    await assert.rejects(reassociateSaleEvidence("proof", payload(), actor, async () => ({ ...await caps(), posEnabled: false })), (e: any) => e.statusCode === 403);
    await assert.rejects(reassociateSaleEvidence("proof", { ...payload(), payments: [] } as any, actor, caps));
    fs.unlinkSync(path.join(storage, "proof-tests", "paper.pdf")); await assert.rejects(reassociateSaleEvidence("proof", payload(), actor, caps), (e: any) => e.code === "INVALID_FILE");
    assert.equal(fx.stats().txCount, 0);
  } finally { fx.restore(); }
});
for (const status of ["UNRESOLVED", "ARCHIVED"] as const) test(`retained void ${status} never resets terminal status, retries exact actor/reason`, async () => {
  const fx = fixture(); try {
    Object.assign(fx.state.document, { saleRecoveryStatus: status, linkedEntityType: null, linkedEntityId: null });
    const input = { expectedStatus: status, reason: "Mistaken upload" };
    const result = await voidSaleEvidence("proof", input, actor, caps); assert.equal(result.replayed, false);
    assert.equal(fx.state.document.saleRecoveryStatus, status); assert.ok(fx.state.document.deletedAt); assert.equal(fx.state.document.purgeAfter, null);
    assert.ok(fs.existsSync(path.join(storage, "proof-tests", "paper.pdf"))); assert.equal(fx.state.document.checksum, "unchanged");
    assert.equal((await voidSaleEvidence("proof", input, actor, caps)).replayed, true); assert.equal(fx.state.audits.length, 1);
    await assert.rejects(voidSaleEvidence("proof", { ...input, reason: "Different" }, actor, caps), (e: any) => e.code === "VOID_CONFLICT");
    assert.equal((await getSaleEvidenceHistory("proof", actor, caps)).document.retained, true);
  } finally { fx.restore(); }
});
for (const failure of ["audit", "commit"] as const) test(`void ${failure} verifies actual post-write failure`, async () => {
  const fx = fixture(failure); try {
    Object.assign(fx.state.document, { saleRecoveryStatus: "UNRESOLVED", linkedEntityType: null, linkedEntityId: null });
    const input = { expectedStatus: "UNRESOLVED" as const, reason: "Mistaken upload" };
    if (failure === "audit") { await assert.rejects(voidSaleEvidence("proof", input, actor, caps)); assert.equal(fx.state.document.deletedAt, null); }
    else { assert.equal((await voidSaleEvidence("proof", input, actor, caps)).replayed, true); assert.ok(fx.state.document.deletedAt); }
    assert.equal(fx.stats().claims, 1); assert.equal(fx.stats().auditWrites, 1);
  } finally { fx.restore(); }
});
test("void refuses attached, prepared and stale status with no mutation", async () => {
  const fx = fixture(); try {
    const input = { expectedStatus: "UNRESOLVED" as const, reason: "Mistaken upload" };
    await assert.rejects(voidSaleEvidence("proof", input, actor, caps), (e: any) => e.code === "VOID_CONFLICT");
    Object.assign(fx.state.document, { saleRecoveryStatus: "UNRESOLVED", linkedEntityType: null, linkedEntityId: null, recoveryCheckoutOperationKey: "prepared" });
    await assert.rejects(voidSaleEvidence("proof", input, actor, caps), (e: any) => e.code === "VOID_CONFLICT");
    fx.state.document.recoveryCheckoutOperationKey = null; fx.state.document.saleRecoveryStatus = "ARCHIVED";
    await assert.rejects(voidSaleEvidence("proof", input, actor, caps), (e: any) => e.code === "VOID_CONFLICT"); assert.equal(fx.stats().claims, 0);
  } finally { fx.restore(); }
});
test("generic audit/history filters rows, counts and search before pagination", async () => {
  const originals = { findMany: prisma.auditLog.findMany, count: prisma.auditLog.count };
  const rows = ["SALE_EVIDENCE_ARCHIVED", "SALE_EVIDENCE_VOIDED", "SALES_EVIDENCE_ATTACHED", "SALES_EVIDENCE_REASSOCIATED", "SALE_RECOVERY_POSTED", "MANUAL_BILL_ATTACHED", "INVOICE_FINALIZED"]
    .map((action, id) => ({ id: String(id), action, entityId: "secret-proof", entityType: "Document", meta: { documentTitle: "private" }, createdAt: new Date(), actor: actor }));
  const whereCalls: any[] = [];
  (prisma.auditLog as any).findMany = async ({ where }: any) => { whereCalls.push(where); return rows.filter((row) => matches(row, where)); };
  (prisma.auditLog as any).count = async ({ where }: any) => { whereCalls.push(where); return rows.filter((row) => matches(row, where)).length; };
  try {
    const result = await listAuditLogs({}); assert.equal(result.total, 1); assert.equal(result.logs.length, 1);
    const categorized = await listCategorizedHistory({}); assert.equal(categorized.total, 1);
    const searched = await listAuditLogs({ action: "EVIDENCE" }); assert.equal(searched.total, 0); assert.equal(searched.logs.length, 0);
    assert.deepEqual(whereCalls[0], whereCalls[1]); assert.deepEqual(whereCalls[2], whereCalls[3]);
  } finally { Object.assign(prisma.auditLog, originals); }
});
test("dedicated correction/history HTTP handlers validate payload and enforce reviewer access", async () => {
  const fx = fixture(); try {
    for (const [handler, body, role, status] of [[reassociateSaleEvidenceHandler, {}, "MANAGER", 400], [voidSaleEvidenceHandler, { expectedStatus: "UNRESOLVED", reason: "Wrong" }, "CASHIER", 403], [getSaleEvidenceHistoryHandler, {}, "CASHIER", 403]] as const) {
      let actual = 200; const res: any = { locals: { businessCapabilities: await caps() }, status(code: number) { actual = code; return this; }, json() { return this; } };
      await handler({ params: { id: "proof" }, body, user: { ...actor, role } } as any, res); assert.equal(actual, status);
    }
  } finally { fx.restore(); }
});
