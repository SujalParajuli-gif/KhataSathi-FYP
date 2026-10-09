import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prisma from "../db/prisma";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "ks-manual-transactions-"));
process.env.DOCUMENT_STORAGE_ROOT = storage;
const { attachSaleEvidence, archiveSaleEvidence, getSaleEvidenceCandidates } = require("../modules/salesEvidence/service") as typeof import("../modules/salesEvidence/service");
const { recordManualBillReference, markManualBillMissing, verifyManualBillReference, withdrawManualBillReference } = require("../modules/invoices/manualBill/service") as typeof import("../modules/invoices/manualBill/service");
after(() => fs.rmSync(storage, { recursive: true, force: true }));
const { attachSaleEvidenceHandler, getSaleEvidenceCandidatesHandler } = require("../modules/salesEvidence/controller") as typeof import("../modules/salesEvidence/controller");
const actor = { id: "reviewer", role: "MANAGER" as const };
const capabilities = async () => ({ businessMode: "FULL_POS" as const, catalogEnabled: true as const,
  inventoryEnabled: true, posEnabled: true, staffDraftRequestsEnabled: true, stockTracked: true });
const expected = { billingChannel: "MANUAL_EXTERNAL" as const, externalDocumentType: null,
  externalBillNo: null, externalBillDate: null, billRecordStatus: "PENDING" as const };
const reference = { billNo: "PAPER-1", externalDocumentType: "PAN_INVOICE" as const, externalBillDate: "2026-10-04" };
const payload = (invoiceId = "sale-a") => ({ invoiceId, reference, expectedInvoice: expected, reason: "Reviewed paper" });

function matches(row: any, where: any): boolean {
  return !!row && Object.entries(where || {}).every(([key, value]: any) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
    }
    return row[key] instanceof Date && value instanceof Date
      ? row[key].getTime() === value.getTime() : row[key] === value;
  });
}

function fixture(options: { overlap?: boolean; fail?: "audit" | "claim" | "lock" | "commit" | "connection" } = {}) {
  const invoice = (id: string) => ({ id, invoiceNo: id, status: "FINALIZED", deletedAt: null,
    cancelledAt: null, paymentStatus: "PAID", netTotal: 500, ...expected,
    customerSnapshotCapturedAt: new Date(), customerNameSnapshot: null, customerPanSnapshot: null });
  fs.mkdirSync(path.join(storage, "documents"), { recursive: true });
  const file = path.join(storage, "documents", "paper.jpg");
  fs.writeFileSync(file, "original proof bytes");
  const state: any = { invoices: { "sale-a": invoice("sale-a"), "sale-b": invoice("sale-b") },
    document: { id: "proof", documentType: "SALE_BILL", visibility: "ADMIN_MANAGER", deletedAt: null,
      saleRecoveryStatus: "UNRESOLVED", linkedEntityType: null, linkedEntityId: null,
      recoveryCheckoutOperationKey: null, recoveryCheckoutPayloadHash: null,
      title: "Paper", fileName: "paper.jpg", storedPath: "documents", storedFileName: "paper.jpg",
      mimeType: "image/jpeg", fileSize: 20, checksum: null, thumbnailFileName: null,
      createdAt: new Date(), uploadedById: actor.id }, audits: [] };
  const saved: Array<() => void> = [];
  const replace = (object: any, key: string, value: any) => {
    const original = object[key]; saved.push(() => { object[key] = original; }); object[key] = value;
  };
  let entered = 0, completed = 0, claims = 0, reconciliations = 0, writes = 0, waits = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
  const tails = new Map<string, Promise<void>>();
  const lockQueries: string[] = [];
  function client(local?: any) {
    const readInvoice = (args: any) => structuredClone(Object.values(local?.invoices || state.invoices).find((r: any) => matches(r, args.where)) || null);
    const readDocument = (args: any) => matches(local?.document || state.document, args.where)
      ? structuredClone(local?.document || state.document) : null;
    const readAudits = (args: any) => [...state.audits, ...(local?.audits || [])].filter(r => matches(r, args.where)).reverse();
    return {
      invoice: {
        findUnique: async (args: any) => readInvoice(args), findFirst: async (args: any) => readInvoice(args),
        findMany: async (args: any) => Object.values(local?.invoices || state.invoices).filter(r => matches(r, args.where)),
        update: async ({ where, data }: any) => {
          assert.ok(local); assert.ok(Object.keys(data).every(k => Object.keys(expected).includes(k)));
          local.changedInvoices.add(where.id); return Object.assign(local.invoices[where.id], data);
        },
      },
      document: {
        findFirst: async (args: any) => readDocument(args), findUnique: async (args: any) => readDocument(args),
        findMany: async (args: any) => { const row = readDocument(args); return row ? [row] : []; },
        updateMany: async ({ where, data }: any) => {
          claims++; assert.ok(local);
          for (const key of ["saleRecoveryStatus", "linkedEntityType", "linkedEntityId", "recoveryCheckoutOperationKey", "recoveryCheckoutPayloadHash", "visibility"]) assert.ok(key in where);
          if (options.fail === "claim" || !matches(local.document, where)) return { count: 0 };
          local.changedDocument = true; Object.assign(local.document, data); return { count: 1 };
        },
      },
      auditLog: {
        findFirst: async (args: any) => { if (!local) reconciliations++; return readAudits(args)[0] || null; },
        findMany: async (args: any) => readAudits(args),
        create: async ({ data }: any) => {
          assert.ok(local); if (options.fail === "audit") throw new Error("audit fault");
          const audit = { id: `audit-${state.audits.length + local.audits.length}`, createdAt: new Date(), ...structuredClone(data) };
          local.audits.push(audit); return audit;
        },
      },
      user: { findUnique: async () => ({ id: actor.id, name: "Reviewer", role: "MANAGER" }) },
    };
  }
  const global = client();
  for (const name of ["invoice", "document", "auditLog"] as const) {
    for (const [method, fn] of Object.entries(global[name])) replace((prisma as any)[name], method, fn);
  }
  replace(prisma, "$transaction", async (work: any) => {
    entered++; if (entered === 2) releaseBarrier();
    const local: any = { invoices: {}, document: null, audits: [], changedInvoices: new Set(), changedDocument: false };
    const releases: Array<() => void> = [];
    const tx: any = client(local);
    for (const delegate of ["payment", "stockTransaction", "product", "cashDrawer", "cashDrawerEntry", "invoiceItem"]) {
      tx[delegate] = new Proxy({}, { get: () => () => { writes++; throw new Error("Financial write attempted"); } });
    }
    tx.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
      if (options.overlap) await barrier;
      const sql = strings.join("?"); lockQueries.push(sql);
      if (options.fail === "lock") throw new Error("lock fault");
      const table = sql.includes("FROM Document") ? "Document" : "Invoice";
      const key = `${table}:${values[0]}`;
      const prior = tails.get(key);
      let release!: () => void;
      tails.set(key, new Promise<void>(resolve => { release = resolve; }));
      if (prior) { waits++; await prior; }
      releases.push(release);
      if (table === "Document") local.document = structuredClone(state.document);
      else local.invoices = structuredClone(state.invoices);
      return [{ id: values[0] }];
    };
    try {
      const result = await work(tx);
      for (const id of local.changedInvoices) state.invoices[id] = local.invoices[id];
      if (local.changedDocument) state.document = local.document;
      state.audits.push(...local.audits); completed++;
      if (options.fail === "commit" || options.fail === "connection") throw new Error("committed response lost");
      return result;
    } finally { releases.reverse().forEach(release => release()); }
  });
  if (options.fail === "connection") replace(prisma.auditLog, "findFirst", async () => { reconciliations++; throw new Error("reconciliation unavailable"); });
  return { state, file, get counts() { return { entered, completed, claims, reconciliations, writes, waits }; }, lockQueries,
    restore() { saved.reverse().forEach(restore => restore()); },
    attach: (id = "sale-a") => attachSaleEvidence("proof", payload(id), actor, capabilities),
    archive: () => archiveSaleEvidence("proof", { reason: "Not an operational sale" }, actor, capabilities) };
}

test("attach returns staged record/proof/history; lost response replays without audit or financial writes", async () => {
  const f = fixture({ fail: "commit" });
  try {
    const result = await f.attach();
    assert.equal(result.replayed, true); assert.equal(result.invoice.externalBillNo, reference.billNo);
    assert.equal(result.invoice.attachedProofs[0].id, "proof"); assert.equal(result.invoice.history.length, 1);
    assert.equal(f.state.audits.length, 2); assert.equal(f.counts.reconciliations, 1);
    const replay = await f.attach(); assert.equal(replay.replayed, true);
    assert.equal(f.state.audits.length, 2); assert.equal(f.counts.writes, 0);
    assert.match(f.lockQueries[0], /FROM Invoice/); assert.match(f.lockQueries[1], /FROM Document.*FOR UPDATE/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "original proof bytes");
  } finally { f.restore(); }
});

for (const fail of ["audit", "claim", "lock"] as const) {
  test(`attach ${fail} fault rolls back metadata/link/audits and retains original bytes`, async () => {
    const f = fixture({ fail }); const before = structuredClone(f.state);
    try {
      await assert.rejects(f.attach()); assert.deepEqual(f.state, before);
      assert.equal(f.counts.writes, 0); assert.equal(f.counts.completed, 0);
      if (fail !== "lock") assert.ok(f.counts.claims > 0);
      assert.equal(fs.readFileSync(f.file, "utf8"), "original proof bytes");
    } finally { f.restore(); }
  });
}

test("unknown commit with unavailable reconciliation preserves committed proof and reports failure", async () => {
  const f = fixture({ fail: "connection" });
  try {
    await assert.rejects(f.attach(), /committed response lost/);
    assert.equal(f.state.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(f.state.audits.length, 2); assert.equal(f.counts.reconciliations, 1);
    assert.equal(fs.readFileSync(f.file, "utf8"), "original proof bytes");
  } finally { f.restore(); }
});

for (const rival of ["same", "different", "archive"] as const) {
  test(`overlapping attach/${rival} decisions contend on Document and only one terminal decision commits`, async () => {
    const f = fixture({ overlap: true });
    try {
      const outcomes = await Promise.allSettled([f.attach(), rival === "archive" ? f.archive() : f.attach(rival === "same" ? "sale-a" : "sale-b")]);
      assert.equal(f.counts.entered, 2); assert.ok(f.counts.waits > 0);
      assert.equal(f.counts.claims, 1); assert.equal(f.counts.writes, 0);
      assert.equal(outcomes.filter(r => r.status === "fulfilled").length, rival === "same" ? 2 : 1);
      if (rival === "same") assert.equal(outcomes.filter(r => r.status === "fulfilled" && r.value?.replayed).length, 1);
      assert.equal(f.state.audits.filter((a: any) => a.action === "SALES_EVIDENCE_ATTACHED" || a.action === "SALE_EVIDENCE_ARCHIVED").length, 1);
      assert.equal(fs.readFileSync(f.file, "utf8"), "original proof bytes");
    } finally { f.restore(); }
  });
}

test("attachment replay rejects missing original observations and contradictory operation state; later reference is preserved", async () => {
  const f = fixture();
  try {
    const first = await f.attach(); assert.equal(first.invoice.billRecordStatus, "RECORDED");
    f.state.invoices["sale-a"].externalBillNo = "LATER-CORRECTION";
    const replay = await f.attach(); assert.equal(replay.invoice.externalBillNo, "LATER-CORRECTION");
    await assert.rejects(attachSaleEvidence("proof", { ...payload(), reason: "Changed decision" }, actor, capabilities), { code: "ATTACHED_CONFLICT" });
    const audit = f.state.audits[0]; const observation = audit.meta.previousDocument;
    delete audit.meta.previousDocument;
    await assert.rejects(f.attach(), { code: "ATTACHED_CONFLICT" });
    audit.meta.previousDocument = observation; f.state.document.recoveryCheckoutOperationKey = "synthetic-operation";
    await assert.rejects(f.attach(), { code: "ATTACHED_CONFLICT" });
    assert.equal(f.state.audits.length, 2); assert.equal(f.counts.writes, 0);
  } finally { f.restore(); }
});

test("explicit null observations do not match incomplete missing-action audit", async () => {
  const f = fixture();
  try {
    const invoice = f.state.invoices["sale-a"];
    Object.assign(invoice, { ...expected, billingChannel: null, billRecordStatus: "MISSING" });
    f.state.audits.push({ id: "old", action: "MANUAL_BILL_MARKED_MISSING", entityType: "Invoice", entityId: invoice.id,
      meta: { reason: "No paper", previous: {} } });
    await assert.rejects(markManualBillMissing(invoice.id, { expected: { ...expected, billingChannel: null, billRecordStatus: null }, reason: "No paper" }, actor, capabilities), { code: "STALE_RECORD_CONFLICT" });
    assert.equal(f.state.audits.length, 1);
  } finally { f.restore(); }
});

test("explicit first legacy reference establishes manual metadata without financial posting", async () => {
  const f = fixture();
  try {
    Object.assign(f.state.invoices["sale-a"], { billingChannel: null, billRecordStatus: null });
    const result = await recordManualBillReference("sale-a", { reference,
      expected: { ...expected, billingChannel: null, billRecordStatus: null } },
      { id: "cashier", role: "CASHIER" }, capabilities);
    assert.equal(result.billingChannel, "MANUAL_EXTERNAL"); assert.equal(result.billRecordStatus, "RECORDED");
    assert.equal(result.netTotal, 500); assert.equal(f.state.audits.length, 1);
    assert.equal(f.counts.writes, 0);
  } finally { f.restore(); }
});

for (const fail of ["audit", "commit"] as const) {
  test(`reference ${fail} branch uses staged state and validates committed provenance`, async () => {
    const f = fixture({ fail }); const before = structuredClone(f.state);
    const record = () => recordManualBillReference("sale-a", { reference, expected }, { id: "cashier", role: "CASHIER" }, capabilities);
    try {
      if (fail === "audit") { await assert.rejects(record(), /audit fault/); assert.deepEqual(f.state, before); }
      else {
        const first = await record(); assert.equal(first.externalBillNo, reference.billNo);
        assert.equal(f.counts.reconciliations, 1); assert.equal(f.state.audits.length, 1);
        await record(); assert.equal(f.state.audits.length, 1);
        const observed = { ...expected, externalBillNo: reference.billNo, externalDocumentType: reference.externalDocumentType,
          externalBillDate: reference.externalBillDate, billRecordStatus: "RECORDED" as const };
        const verified = await verifyManualBillReference("sale-a", { expected: observed, reason: "Verified paper" }, actor, capabilities);
        assert.equal(verified.billRecordStatus, "VERIFIED");
        await verifyManualBillReference("sale-a", { expected: observed, reason: "Verified paper" }, actor, capabilities);
        assert.equal(f.state.audits.length, 2);
        await assert.rejects(verifyManualBillReference("sale-a", { expected: observed, reason: "Different verification" }, actor, capabilities), { code: "STALE_RECORD_CONFLICT" });
        const withdrawn = await withdrawManualBillReference("sale-a", { expected: { ...observed, billRecordStatus: "VERIFIED" }, reason: "Wrong reference", targetStatus: "PENDING" }, actor, capabilities);
        assert.equal(withdrawn.externalBillNo, null); assert.equal(withdrawn.billRecordStatus, "PENDING");
      }
      assert.equal(f.counts.writes, 0);
    } finally { f.restore(); }
  });
}

test("direct reference/reviewer/attach boundaries deny unknown roles and disabled POS before transactions", async () => {
  const f = fixture();
  const disabled = async () => ({ ...await capabilities(), posEnabled: false });
  try {
    await assert.rejects(recordManualBillReference("sale-a", { reference, expected }, { id: "staff", role: "STAFF" } as any, capabilities), { name: "ManualBillAuthorizationError" });
    await assert.rejects(recordManualBillReference("sale-a", { reference, expected }, actor, disabled), { code: "FEATURE_DISABLED" });
    await assert.rejects(verifyManualBillReference("sale-a", { expected, reason: "Review paper" }, { id: "cashier", role: "CASHIER" }, capabilities), { name: "ManualBillAuthorizationError" });
    await assert.rejects(attachSaleEvidence("proof", payload(), { id: "cashier", role: "CASHIER" }, capabilities), { name: "SalesEvidenceAuthorizationError" });
    await assert.rejects(attachSaleEvidence("proof", payload(), actor, disabled), { name: "SalesEvidenceAuthorizationError" });
    assert.equal(f.counts.entered, 0); assert.equal(f.counts.writes, 0);
  } finally { f.restore(); }
});

test("invalid attach/candidate HTTP input returns validation400 before database decisions", async () => {
  const f = fixture();
  try {
    for (const handler of [attachSaleEvidenceHandler, getSaleEvidenceCandidatesHandler]) {
      let status = 200; let body: any;
      const res: any = { locals: { businessCapabilities: await capabilities() },
        status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
      await handler({ user: actor, params: { id: "proof" }, body: {}, query: { limit: 100 } } as any, res);
      assert.equal(status, 400); assert.equal(body.code, "VALIDATION_ERROR");
    }
    assert.equal(f.counts.entered, 0);
  } finally { f.restore(); }
});

test("candidate query explicitly includes NULL legacy channels even when searching", async () => {
  const f = fixture();
  try {
    const legacy = { ...f.state.invoices["sale-a"], billingChannel: null, billRecordStatus: null };
    (prisma.invoice as any).findMany = async ({ where }: any) => {
      assert.deepEqual(where.OR, [{ billingChannel: null }, { billingChannel: "MANUAL_EXTERNAL" }]);
      assert.ok(where.AND[0].OR.some((condition: any) => condition.invoiceNo?.contains === "sale"));
      assert.equal(where.deletedAt, null); assert.equal(where.cancelledAt, null);
      assert.equal(where.paymentStatus.not, "CANCELLED");
      return [legacy];
    };
    const result = await getSaleEvidenceCandidates("proof", { search: "sale", limit: 10 }, actor, capabilities);
    assert.equal(result.candidates[0].billingChannel, null);
    assert.equal(result.candidates[0].customerName, null);
    assert.equal(f.counts.entered, 0);
  } finally { f.restore(); }
});
