import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import * as files from "../modules/documents/service";
import * as capabilities from "../modules/settings/capabilities";
import * as manual from "../modules/invoices/manualBill/service";
import { uploadInvoiceProof } from "../modules/invoices/manualBill/proofUpload";

function fixture(options: { auditFails?: boolean; responseLost?: boolean; owner?: string; status?: string } = {}) {
  const saved = { transaction: prisma.$transaction, invoice: prisma.invoice.findUnique, document: prisma.document.findUnique,
    prepare: files.prepareDocumentFile, remove: files.removePreparedDocumentFiles, capabilities: capabilities.getBusinessCapabilities, record: manual.getManualBillRecord };
  let state: any = { invoice: { id: "i", cashierId: options.owner || "cashier", status: "FINALIZED", paymentStatus: "PAID",
    billRecordStatus: options.status || "RECORDED", netTotal: 200, cancelledAt: null, deletedAt: null, creditNotesAsOriginal: [] }, documents: [], audits: [] };
  let prepares = 0; let removals = 0; let locks = 0; let tail = Promise.resolve();
  (files as any).prepareDocumentFile = async () => { prepares++; return { fileName: "bill.png", storedFileName: "prepared.png", storedPath: "fake/prepared.png",
    mimeType: "image/png", fileSize: 10, checksum: "same-original-checksum", thumbnailFileName: null, thumbnailSize: null }; };
  (files as any).removePreparedDocumentFiles = async () => { removals++; };
  (capabilities as any).getBusinessCapabilities = async () => ({ posEnabled: true, businessMode: "FULL_POS" });
  (manual as any).getManualBillRecord = async () => ({ id: "i", attachedProofs: state.documents });
  prisma.invoice.findUnique = async () => structuredClone(state.invoice);
  prisma.document.findUnique = async ({ where }: any) => state.documents.find((d: any) => d.id === where.id) || null;
  prisma.$transaction = async (work: any) => {
    let staged: any; let release: (() => void) | undefined;
    const tx = {
      $queryRaw: async () => { const previous = tail; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
        locks++; staged = structuredClone(state); return [{ id: "i" }]; },
      invoice: { findUnique: async () => staged.invoice, update: async ({ data }: any) => { assert.deepEqual(Object.keys(data), ["billRecordStatus"]); Object.assign(staged.invoice, data); } },
      document: { findFirst: async () => staged.documents.find((d: any) => d.checksum === "same-original-checksum") || null,
        create: async ({ data }: any) => { staged.documents.push(data); return data; } },
      auditLog: { create: async ({ data }: any) => { staged.audits.push(data); if (options.auditFails) throw new Error("Audit failure after staged proof"); return data; } },
    };
    try { const result = await work(tx); state = staged; if (options.responseLost) throw new Error("Commit response lost"); return result; }
    finally { release?.(); }
  };
  return { get state() { return state; }, get prepares() { return prepares; }, get removals() { return removals; }, get locks() { return locks; }, restore() {
    prisma.$transaction = saved.transaction; prisma.invoice.findUnique = saved.invoice; prisma.document.findUnique = saved.document;
    (files as any).prepareDocumentFile = saved.prepare; (files as any).removePreparedDocumentFiles = saved.remove;
    (capabilities as any).getBusinessCapabilities = saved.capabilities; (manual as any).getManualBillRecord = saved.record;
  } };
}
const source = { originalname: "bill.png", mimetype: "image/png", size: 10, path: "unused-mocked-input" };
const actor = { id: "cashier", role: "CASHIER" as const };

test("overlapping same-source uploads serialize under the invoice lock and never repost finances", async () => {
  const f = fixture();
  try {
    const results = await Promise.all([uploadInvoiceProof("i", source, actor), uploadInvoiceProof("i", source, actor)]);
    assert.equal(f.locks, 2); assert.equal(f.prepares, 2); assert.equal(f.removals, 1);
    assert.equal(f.state.documents.length, 1); assert.equal(f.state.audits.length, 1);
    assert.equal(results.filter(r => r.replayed).length, 1); assert.equal(f.state.invoice.netTotal, 200);
    assert.equal(f.state.documents[0].linkedEntityId, "i");
    assert.equal(f.state.documents[0].saleRecoveryStatus, "ATTACHED");
  } finally { f.restore(); }
});
test("cashier foreign-sale proof is rejected before file preparation", async () => {
  const f = fixture({ owner: "other" });
  try { await assert.rejects(uploadInvoiceProof("i", source, actor), /own sales/); assert.equal(f.prepares, 0); assert.equal(f.state.documents.length, 0); }
  finally { f.restore(); }
});
test("proof audit failure rolls back staged attachment and cleans completed uncommitted files", async () => {
  const f = fixture({ auditFails: true });
  try { await assert.rejects(uploadInvoiceProof("i", source, actor), /Audit failure/); assert.equal(f.state.documents.length, 0); assert.equal(f.state.audits.length, 0); assert.equal(f.removals, 1); }
  finally { f.restore(); }
});
test("ambiguous committed upload retains original source instead of deleting its files", async () => {
  const f = fixture({ responseLost: true });
  try { await assert.rejects(uploadInvoiceProof("i", source, actor), /response lost/); assert.equal(f.state.documents.length, 1); assert.equal(f.removals, 0); }
  finally { f.restore(); }
});
