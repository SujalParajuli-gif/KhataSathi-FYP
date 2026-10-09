import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import prisma from "../db/prisma";
import { createSaleEvidence, attachSaleEvidence, archiveSaleEvidence, getSaleEvidenceCandidates } from "../modules/salesEvidence/service";
import { reassociateSaleEvidence, voidSaleEvidence, getSaleEvidenceHistory } from "../modules/salesEvidence/corrections";
import { prepareAndPostSaleEvidenceRecovery, getSaleEvidenceRecoveryOutcome, verifyRecoveryCommittedProvenance } from "../modules/salesEvidence/recovery";
import { recordManualBillReference, verifyManualBillReference, getManualBillRecord } from "../modules/invoices/manualBill/service";
import { getCurrentCashDrawer } from "../modules/cash-drawers/service";
import { cancelInvoice } from "../modules/invoices/service";
import { listAuditLogs, listCategorizedHistory } from "../modules/audit/service";
import { permanentlyDeleteDocument, getDocumentFilePath } from "../modules/documents/service";
import { runDueBinPurge } from "../modules/bin/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";
import { ensureApplicationStorageReady } from "../lib/storageReadiness";

const enabled = process.env.KHATASATHI_PHASE2_MYSQL_TEST === "1";
const capabilities = async () => ({ businessMode: "FULL_POS" as const, catalogEnabled: true as const, inventoryEnabled: true,
  posEnabled: true, staffDraftRequestsEnabled: true, stockTracked: true });
const expected = (i: any) => ({ billingChannel: i.billingChannel ?? null, externalDocumentType: i.externalDocumentType ?? null,
  externalBillNo: i.externalBillNo ?? null, externalBillDate: i.externalBillDate instanceof Date ? i.externalBillDate.toISOString().slice(0, 10) : i.externalBillDate ?? null,
  billRecordStatus: i.billRecordStatus ?? null });

test("MySQL Phase2 proof claims, correction, retained void, privacy and recovery rollback", { skip: !enabled, timeout: 120000 }, async (t) => {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.equal(target.pathname, "/ks_verify_phase2_exit_20261008");
  assert.ok(path.isAbsolute(process.env.DOCUMENT_STORAGE_ROOT || ""));
  assert.match(process.env.DOCUMENT_STORAGE_ROOT!, /ks_verify_phase2_exit_20261008/);
  ensureApplicationStorageReady();
  const suffix = randomUUID(), originalTransaction = prisma.$transaction.bind(prisma);
  const phone = () => `+97798${randomInt(10000000, 99999999)}`;
  const manager = await prisma.user.create({ data: { name: "Phase2 synthetic reviewer", phone: phone(), role: "MANAGER", passwordHash: "unusable" } });
  const admin = await prisma.user.create({ data: { name: "Phase2 synthetic admin", phone: phone(), role: "ADMIN", passwordHash: "unusable" } });
  const cashier = await prisma.user.create({ data: { name: "Phase2 synthetic cashier", phone: phone(), role: "CASHIER", passwordHash: "unusable" } });
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, loyaltyDiscountPercent: 0, defaultBillingChannel: "MANUAL_EXTERNAL" },
    update: { loyaltyDiscountPercent: 0, defaultBillingChannel: "MANUAL_EXTERNAL" } });
  invalidateBusinessSettingsCache();
  const drawer = await prisma.cashDrawer.create({ data: { cashierId: manager.id, openingFloat: 0 } });
  const brand = await prisma.brand.create({ data: { name: `Phase2 synthetic ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Phase2 synthetic item", sku: `P2-${suffix}`, brandId: brand.id, stock: 100,
    retailPrice: 100, wholesalePrice: 100, wholesaleEligible: false } });
  const png = await sharp({ create: { width: 120, height: 120, channels: 3, background: "white" } }).png().toBuffer();
  const invoiceIds: string[] = [], documentIds: string[] = [];
  async function invoice() {
    const row = await prisma.invoice.create({ data: { invoiceNo: `P2-${randomUUID()}`, cashierId: manager.id, status: "FINALIZED", finalizedAt: new Date(),
      subTotal: 100, netTotal: 100, billingChannel: "MANUAL_EXTERNAL", billRecordStatus: "PENDING" } });
    invoiceIds.push(row.id); return row;
  }
  async function proof() {
    const upload = path.join(process.env.DOCUMENT_STORAGE_ROOT!, `${randomUUID()}.png`); fs.writeFileSync(upload, png);
    const row = await createSaleEvidence({ originalname: "synthetic-proof.png", mimetype: "image/png", size: png.length, path: upload },
      { title: `Phase2 synthetic ${suffix}` }, manager, capabilities);
    documentIds.push(row.id); return row;
  }
  const reference = () => ({ billNo: `P2-${randomUUID()}`, externalDocumentType: "PAN_INVOICE" as const, externalBillDate: "2026-10-08" });
  const attach = (doc: any, inv: any, ref = reference()) => attachSaleEvidence(doc.id, { invoiceId: inv.id, reference: ref, expectedInvoice: expected(inv), reason: "Synthetic attachment" }, manager, capabilities);
  const correction = async (doc: any, source: any, destination: any, ref = reference()) => ({ invoiceId: destination.id, expectedSourceInvoiceId: source.id,
    expectedSourceInvoice: expected(await prisma.invoice.findUniqueOrThrow({ where: { id: source.id } })),
    expectedInvoice: expected(await prisma.invoice.findUniqueOrThrow({ where: { id: destination.id } })), reference: ref, reason: "Synthetic association correction" });
  const recoverInput = (ref = reference()) => ({ reference: ref, reason: "Synthetic missing-sale recovery", paymentAssessment: { type: "NOT_COLLECTED" as const, explanation: "Payment not collected" },
    checkout: { items: [{ productId: product.id, qty: 1 }], payment: { method: "NONE" as const }, confirmation: { items: [{ productId: product.id, qty: 1, appliedUnitPrice: 100 }], payableTotal: 100 } } });
  async function counters() {
    return { invoices: await prisma.invoice.count(), items: await prisma.invoiceItem.count(), payments: await prisma.payment.count(),
      drawerEvents: await prisma.cashDrawerEvent.count(), stocks: await prisma.stockTransaction.count(), operations: await prisma.checkoutOperation.count(), audits: await prisma.auditLog.count(),
      stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock, drawers: await prisma.cashDrawer.findMany({ where: { cashierId: manager.id } }) };
  }
  function barrier(table: string, id: string) {
    let calls = 0, signalHeld!: () => void, signalWaiting!: () => void, release!: () => void;
    const held = new Promise<void>((r) => { signalHeld = r; }), waiting = new Promise<void>((r) => { signalWaiting = r; }), gate = new Promise<void>((r) => { release = r; });
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async (tx) => {
      const raw = tx.$queryRaw.bind(tx);
      const queryRaw = async (query: TemplateStringsArray, ...values: any[]) => {
        const match = query.join(" ").includes(`FROM ${table}`) && query.join(" ").includes("FOR UPDATE") && values.includes(id);
        const call = match ? ++calls : 0;
        if (call === 2) signalWaiting();
        const result = await raw(query, ...values);
        if (call === 1) { signalHeld(); await gate; }
        return result;
      };
      return work(new Proxy(tx, { get(target, key) { return key === "$queryRaw" ? queryRaw : Reflect.get(target, key); } }));
    }, { ...opts, timeout: 15000 });
    return { held, waiting, release, restore: () => { (prisma as any).$transaction = originalTransaction; }, calls: () => calls };
  }
  async function fault(action: string, check: (tx: any) => Promise<void>, run: () => Promise<any>) {
    let entered = false;
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async (tx) => {
      const create = tx.auditLog.create.bind(tx.auditLog);
      const audit = new Proxy(tx.auditLog, { get(target, key) { return key === "create" ? async (args: any) => {
        if (args.data.action === action) { entered = true; await check(tx); throw new Error("PHASE2_AUDIT_FAULT"); } return create(args);
      } : Reflect.get(target, key); } });
      return work(new Proxy(tx, { get(target, key) { return key === "auditLog" ? audit : Reflect.get(target, key); } }));
    }, { ...opts, timeout: 15000 });
    try { await assert.rejects(run, /PHASE2_AUDIT_FAULT/); assert.ok(entered, "fault must enter actual post-write transaction branch"); }
    finally { (prisma as any).$transaction = originalTransaction; }
  }
  try {
    await t.test("attach/attach overlap commits one claim, matching retry and no financial posting", async () => {
      const doc = await proof(), a = await invoice(), b = await invoice(), ref = reference(), before = await counters(), race = barrier("Document", doc.id);
      const first = attach(doc, a, ref); await race.held;
      const second = attach(doc, b); const rejected = assert.rejects(second, (e: any) => e.code === "ATTACHED_CONFLICT");
      await race.waiting; race.release(); await first; await rejected; assert.ok(race.calls() >= 2); race.restore();
      const after = await counters(); assert.deepEqual({ ...after, audits: before.audits }, before); assert.equal(after.audits, before.audits + 2);
      assert.equal((await attach(doc, a, ref)).replayed, true); assert.deepEqual(await counters(), after);
    });
    await t.test("attach/archive overlap and archive winner both preserve nonposting financial state", async () => {
      for (const archiveWins of [false, true]) {
        const doc = await proof(), inv = await invoice(), before = await counters(), race = barrier("Document", doc.id);
        const first = archiveWins ? archiveSaleEvidence(doc.id, { reason: "Synthetic archive" }, manager, capabilities) : attach(doc, inv);
        await race.held;
        const second = archiveWins ? attach(doc, inv) : archiveSaleEvidence(doc.id, { reason: "Synthetic archive" }, manager, capabilities);
        const rejected = assert.rejects(second, (e: any) => ["ATTACHED_CONFLICT", "ARCHIVED_CONFLICT"].includes(e.code));
        await race.waiting; race.release(); await first; await rejected; assert.ok(race.calls() >= 2); race.restore();
        const after = await counters(); assert.deepEqual({ ...after, audits: before.audits }, before);
        assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).saleRecoveryStatus, archiveWins ? "ARCHIVED" : "ATTACHED");
      }
    });
    await t.test("recovery/archive overlap enters real posting once, lost response and changed payload cannot duplicate", async () => {
      const doc = await proof(), input = recoverInput(), before = await counters(), race = barrier("Document", doc.id);
      const first = prepareAndPostSaleEvidenceRecovery(doc.id, input, manager, capabilities); await race.held;
      const second = archiveSaleEvidence(doc.id, { reason: "Synthetic archive" }, admin, capabilities);
      const rejected = assert.rejects(second, (e: any) => ["ACTIVE_OPERATION_CONFLICT", "ATTACHED_CONFLICT"].includes(e.code));
      await race.waiting; race.release(); const saved = await first; invoiceIds.push(saved.invoice.id); await rejected; assert.ok(race.calls() >= 2); race.restore();
      const after = await counters(); assert.equal(after.invoices, before.invoices + 1); assert.equal(after.stock, before.stock - 1); assert.equal(after.operations, before.operations + 1);
      assert.equal(after.payments, before.payments); assert.equal((await getSaleEvidenceRecoveryOutcome(doc.id, admin, capabilities))!.invoice!.id, saved.invoice.id);
      assert.equal((await prepareAndPostSaleEvidenceRecovery(doc.id, input, manager, capabilities)).invoice.id, saved.invoice.id);
      await assert.rejects(prepareAndPostSaleEvidenceRecovery(doc.id, { ...input, reason: "Changed payload" }, manager, capabilities));
      await assert.rejects(prepareAndPostSaleEvidenceRecovery(doc.id, { ...input, checkout: { ...input.checkout, operationKey: "client-key" } } as any, manager, capabilities));
      assert.deepEqual(await counters(), after);
      const dest = await invoice(), move = await correction(doc, saved.invoice, dest);
      await reassociateSaleEvidence(doc.id, move, manager, capabilities);
      const movedCounts = await counters();
      const outcome = await getSaleEvidenceRecoveryOutcome(doc.id, admin, capabilities);
      assert.equal(outcome!.status, "COMMITTED"); assert.equal(outcome!.invoice!.id, saved.invoice.id); assert.equal(outcome!.document.linkedEntityId, dest.id);
      const replay = await prepareAndPostSaleEvidenceRecovery(doc.id, input, manager, capabilities);
      assert.equal(replay.invoice.id, saved.invoice.id); assert.equal(replay.document.linkedEntityId, dest.id); assert.deepEqual(await counters(), movedCounts);
      const third = await invoice(); await reassociateSaleEvidence(doc.id, await correction(doc, dest, third), manager, capabilities);
      assert.equal((await getSaleEvidenceRecoveryOutcome(doc.id, admin, capabilities))!.status, "COMMITTED");
      const chain = await prisma.auditLog.findMany({ where: { entityType: "Document", entityId: doc.id, action: "SALES_EVIDENCE_REASSOCIATED" }, orderBy: { createdAt: "asc" } });
      const originalMeta = chain[0].meta; await prisma.auditLog.update({ where: { id: chain[0].id }, data: { meta: { ...(originalMeta as any), sourceInvoiceId: "tampered" } } });
      assert.equal((await getSaleEvidenceRecoveryOutcome(doc.id, admin, capabilities))!.status, "UNCERTAIN");
      await prisma.auditLog.update({ where: { id: chain[0].id }, data: { meta: originalMeta as any } });
      assert.ok((await verifyRecoveryCommittedProvenance(prisma, await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))).valid);
    });
    await t.test("real audit failures roll back attachment, correction and recovery financial/link effects", async () => {
      const doc = await proof(), a = await invoice(), before = await counters();
      await fault("SALES_EVIDENCE_ATTACHED", async (tx) => { assert.equal((await tx.document.findUniqueOrThrow({ where: { id: doc.id } })).linkedEntityId, a.id); }, () => attach(doc, a));
      assert.deepEqual(await counters(), before); assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).saleRecoveryStatus, "UNRESOLVED");
      await attach(doc, a); const b = await invoice(), move = await correction(doc, a, b), preMove = await counters();
      await fault("SALES_EVIDENCE_REASSOCIATED", async (tx) => { assert.equal((await tx.document.findUniqueOrThrow({ where: { id: doc.id } })).linkedEntityId, b.id); }, () => reassociateSaleEvidence(doc.id, move, manager, capabilities));
      assert.deepEqual(await counters(), preMove); assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).linkedEntityId, a.id);
      const recoveryDoc = await proof(), preRecovery = await counters();
      const cashInput = { ...recoverInput(), paymentAssessment: { type: "CURRENT_DRAWER_CASH" as const, drawerId: drawer.id, collectedAt: new Date().toISOString(), alreadyAccounted: false as const, explanation: "Collected in this open drawer only" }, checkout: { ...recoverInput().checkout, payment: { method: "CASH" as const, amount: 100, tenderedAmount: 100 } } };
      await fault("SALE_RECOVERY_POSTED", async (tx) => { assert.equal(await tx.invoice.count(), preRecovery.invoices + 1); assert.equal((await tx.product.findUniqueOrThrow({ where: { id: product.id } })).stock, preRecovery.stock - 1); assert.equal(await tx.payment.count(), preRecovery.payments + 1, "actual cash Payment written before injected failure"); assert.equal(await tx.cashDrawerEvent.count(), preRecovery.drawerEvents, "checkout uses Payment accounting without duplicate manual CASH_IN"); },
        () => prepareAndPostSaleEvidenceRecovery(recoveryDoc.id, cashInput, manager, capabilities));
      const postRecovery = await counters(); assert.deepEqual({ ...postRecovery, audits: preRecovery.audits }, preRecovery); assert.equal(postRecovery.audits, preRecovery.audits + 1, "preparation audit is retained outside rolled-back financial posting");
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: recoveryDoc.id } })).saleRecoveryStatus, "UNRESOLVED");
    });
    await t.test("record verify correct, stale/duplicate rules, current historical privacy and cancellation retention", async () => {
      const doc = await proof(), a = await invoice(), b = await invoice(), ref = reference(); await attach(doc, a, ref);
      const recorded = await getManualBillRecord(a.id, manager, prisma, capabilities);
      await verifyManualBillReference(a.id, { expected: expected(recorded), reason: "Synthetic verification" }, manager, capabilities);
      const move = await correction(doc, a, b, ref), before = await counters();
      await assert.rejects(reassociateSaleEvidence(doc.id, move, manager, capabilities), (e: any) => e.code === "DUPLICATE_REVIEW_REQUIRED");
      const approvedMove = { ...move, duplicateOverrideReason: "Same physical paper associated with the wrong sale" };
      await assert.rejects(reassociateSaleEvidence(doc.id, approvedMove, cashier, capabilities), (e: any) => e.statusCode === 403);
      await assert.rejects(reassociateSaleEvidence(doc.id, approvedMove, manager, async () => ({ ...await capabilities(), posEnabled: false })), (e: any) => e.statusCode === 403);
      const corrected = await reassociateSaleEvidence(doc.id, approvedMove, manager, capabilities);
      assert.equal(corrected.sourceInvoice.billRecordStatus, "RECORDED"); assert.equal(corrected.sourceInvoice.externalBillNo, ref.billNo); assert.equal(corrected.invoice.billRecordStatus, "RECORDED");
      const after = await counters(); assert.deepEqual({ ...after, audits: before.audits }, before); assert.equal(after.audits, before.audits + 3);
      assert.equal((await reassociateSaleEvidence(doc.id, approvedMove, manager, capabilities)).replayed, true);
      await assert.rejects(reassociateSaleEvidence(doc.id, { ...approvedMove, reason: "Changed decision" }, manager, capabilities), (e: any) => e.code === "STALE_ASSOCIATION");
      const oldHistory = await getManualBillRecord(a.id, manager, prisma, capabilities); assert.ok(oldHistory.history.some((entry) => entry.action === "SALES_EVIDENCE_REASSOCIATED"));
      await prisma.document.update({ where: { id: doc.id }, data: { visibility: "ADMIN_ONLY" } });
      assert.ok(!(await getManualBillRecord(a.id, manager, prisma, capabilities)).history.some((entry) => entry.action === "SALES_EVIDENCE_REASSOCIATED"));
      await assert.rejects(getSaleEvidenceHistory(doc.id, manager, capabilities), (e: any) => e.code === "NOT_FOUND");
      const privateHistory = await getSaleEvidenceHistory(doc.id, admin, capabilities); assert.ok(!JSON.stringify(privateHistory.history).match(/recoveryCheckout|decisionHash|storedPath|checksum/));
      for (const listing of [await listAuditLogs({ action: "EVIDENCE", pageSize: 100 }), await listCategorizedHistory({ q: suffix, pageSize: 100 })]) {
        assert.ok(!JSON.stringify(listing).includes(doc.id));
      }
      await cancelInvoice(b.id, manager.id);
      const retained = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }); assert.equal(retained.linkedEntityId, b.id); assert.equal(retained.saleRecoveryStatus, "ATTACHED");
      await assert.rejects(reassociateSaleEvidence(doc.id, await correction(doc, b, a), admin, capabilities), (e: any) => e.code === "INVOICE_INELIGIBLE");
    });
    await t.test("current cash is counted once; unsupported earlier money is blocked; local eSewa intent stays pending", async () => {
      const doc = await proof(), base = recoverInput();
      const cash = { ...base, paymentAssessment: { type: "CURRENT_DRAWER_CASH" as const, drawerId: drawer.id, collectedAt: new Date().toISOString(), alreadyAccounted: false as const, explanation: "Collected in current drawer" },
        checkout: { ...base.checkout, payment: { method: "CASH" as const, amount: 100, tenderedAmount: 100 } } };
      const before = await counters(), saved = await prepareAndPostSaleEvidenceRecovery(doc.id, cash, manager, capabilities); invoiceIds.push(saved.invoice.id);
      const after = await counters(); assert.equal(after.payments, before.payments + 1); assert.equal(after.drawerEvents, before.drawerEvents, "cash Payment does not add duplicate manual CASH_IN");
      const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: saved.invoice.id } }); assert.equal(payment.status, "SUCCESS");
      assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: saved.invoice.id } })).paidTotal, 100);
      await prepareAndPostSaleEvidenceRecovery(doc.id, cash, manager, capabilities); assert.deepEqual(await counters(), after);
      const summary = await getCurrentCashDrawer(manager.id); assert.equal(summary!.cashSalesTotal, 100); assert.equal(summary!.expectedTotal, 100); assert.equal(summary!.cashInTotal, 0);
      for (const type of ["PRIOR_OR_OTHER_CASH", "PRIOR_DIGITAL", "UNKNOWN"] as const) {
        const blocked = await proof(), pre = await counters();
        await assert.rejects(prepareAndPostSaleEvidenceRecovery(blocked.id, { ...recoverInput(), paymentAssessment: { type, explanation: "Previously collected or uncertain money" } }, manager, capabilities), (e: any) => e.code === "PAYMENT_RECONCILIATION_REQUIRED");
        assert.deepEqual(await counters(), pre);
      }
      const digital = await proof(), input = recoverInput(), pre = await counters();
      // Initiation only creates a local signed form; no provider request or callback verification.
      const pending = await prepareAndPostSaleEvidenceRecovery(digital.id, { ...input, checkout: { ...input.checkout, payment: { method: "ESEWA", amount: 100 } } }, manager, capabilities);
      invoiceIds.push(pending.invoice.id);
      const intent = await prisma.payment.findFirstOrThrow({ where: { invoiceId: pending.invoice.id } }); assert.equal(intent.status, "PENDING"); assert.equal(intent.method, "ESEWA");
      const row = await prisma.invoice.findUniqueOrThrow({ where: { id: pending.invoice.id } }); assert.equal(row.paidTotal, 0); assert.equal(row.paymentStatus, "UNPAID");
      assert.equal(await prisma.cashDrawerEvent.count(), pre.drawerEvents);
    });
    await t.test("real stock, changed price and overpayment failures leave no partial recovery posting", async () => {
      for (const scenario of ["stock", "price", "payment"] as const) {
        const doc = await proof(), input = recoverInput();
        const productBefore = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
        if (scenario === "stock") await prisma.product.update({ where: { id: product.id }, data: { stock: 0 } });
        if (scenario === "price") await prisma.product.update({ where: { id: product.id }, data: { retailPrice: 110 } });
        const payload = scenario === "payment" ? { ...input, checkout: { ...input.checkout, payment: { method: "CASH" as const, amount: 101 } } } : input;
        const before = await counters();
        await assert.rejects(prepareAndPostSaleEvidenceRecovery(doc.id, payload, manager, capabilities), (e: any) => scenario === "stock" ? e.code === "STOCK_CONFLICT" : scenario === "price" ? e.code === "CHECKOUT_REVIEW_REQUIRED" : /[Oo]verpayment/.test(e.message));
        const after = await counters(); assert.deepEqual({ ...after, audits: before.audits }, before); assert.equal(after.audits, before.audits + 1, "only persistent preparation audit remains");
        const unresolved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }); assert.equal(unresolved.saleRecoveryStatus, "UNRESOLVED"); assert.equal(unresolved.linkedEntityId, null);
        await prisma.product.update({ where: { id: product.id }, data: { stock: productBefore.stock, retailPrice: productBefore.retailPrice } });
      }
    });
    await t.test("replacement retains original proof; fresh proof can attach to active replacement, correction cannot transfer it", async () => {
      const doc = await proof(), original = await invoice(), replacement = await invoice(), other = await invoice();
      await attach(doc, original);
      await cancelInvoice(original.id, manager.id);
      await prisma.creditNote.create({ data: { creditNoteNo: `P2-CN-${randomUUID()}`, originalInvoiceId: original.id, replacementInvoiceId: replacement.id,
        originalNetTotal: 100, originalPaidTotal: 0, replacementNetTotal: 100, creditedAmount: 100, createdById: manager.id, reason: "Synthetic replacement fixture" } });
      const fresh = await proof(), before = await counters();
      assert.ok((await getSaleEvidenceCandidates(fresh.id, { limit: 20, search: replacement.invoiceNo }, manager, capabilities)).candidates.some(i => i.id === replacement.id));
      await attach(fresh, replacement);
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).linkedEntityId, original.id);
      const candidates = await getSaleEvidenceCandidates(fresh.id, { limit: 20, search: replacement.invoiceNo }, manager, capabilities);
      assert.ok(!candidates.candidates.some(i => i.id === original.id || i.id === replacement.id));
      await assert.rejects(reassociateSaleEvidence(doc.id, await correction(doc, original, other), manager, capabilities), (e: any) => e.code === "INVOICE_INELIGIBLE");
      await assert.rejects(reassociateSaleEvidence(fresh.id, await correction(fresh, replacement, other), manager, capabilities), (e: any) => e.code === "INVOICE_INELIGIBLE");
      const after = await counters(); assert.deepEqual({ ...after, audits: before.audits }, before);
      assert.equal((await getManualBillRecord(original.id, manager, prisma, capabilities)).replacementInvoiceId, replacement.id);
    });
    await t.test("void/attach overlap, exact void receipt, rollback and bin/purge retain file bytes", async () => {
      for (const status of ["UNRESOLVED", "ARCHIVED"] as const) {
        const doc = await proof(); if (status === "ARCHIVED") await archiveSaleEvidence(doc.id, { reason: "Synthetic archive" }, manager, capabilities);
        const input = { expectedStatus: status, reason: "Synthetic mistaken upload" }, before = await counters();
        await fault("SALE_EVIDENCE_VOIDED", async (tx) => { assert.ok((await tx.document.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt); }, () => voidSaleEvidence(doc.id, input, manager, capabilities));
        assert.deepEqual(await counters(), before); assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt, null);
        await voidSaleEvidence(doc.id, input, manager, capabilities); assert.equal((await voidSaleEvidence(doc.id, input, manager, capabilities)).replayed, true);
        await assert.rejects(voidSaleEvidence(doc.id, { ...input, reason: "Another reason" }, manager, capabilities), (e: any) => e.code === "VOID_CONFLICT");
        const retained = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }), file = getDocumentFilePath(retained)!;
        assert.ok(fs.existsSync(file)); assert.equal(retained.saleRecoveryStatus, status); assert.equal(retained.purgeAfter, null);
        assert.equal(await prisma.softDeleteRecord.count({ where: { entityType: "Document", entityId: doc.id } }), 0);
        await assert.rejects(permanentlyDeleteDocument(doc.id), (e: any) => e.code === "SALE_EVIDENCE_PROTECTED");
        await runDueBinPurge(); assert.ok(fs.existsSync(file)); assert.ok((await getSaleEvidenceHistory(doc.id, manager, capabilities)).history.some((entry) => entry.action === "SALE_EVIDENCE_VOIDED"));
      }
      const doc = await proof(), inv = await invoice(), race = barrier("Document", doc.id);
      const first = voidSaleEvidence(doc.id, { expectedStatus: "UNRESOLVED", reason: "Synthetic mistaken upload" }, manager, capabilities); await race.held;
      const second = attach(doc, inv); const rejected = assert.rejects(second, (e: any) => e.code === "NOT_FOUND");
      await race.waiting; race.release(); await first; await rejected; assert.ok(race.calls() >= 2); race.restore();
    });
    await t.test("cancel wins overlapping reassociation and keeps proof on original", async () => {
      const doc = await proof(), source = await invoice(), dest = await invoice(); await attach(doc, source);
      const input = await correction(doc, source, dest), race = barrier("Invoice", source.id);
      const first = cancelInvoice(source.id, manager.id); await race.held;
      const second = reassociateSaleEvidence(doc.id, input, manager, capabilities), rejected = assert.rejects(second, (e: any) => e.code === "INVOICE_INELIGIBLE");
      await race.waiting; race.release(); await first; await rejected; assert.ok(race.calls() >= 2); race.restore();
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).linkedEntityId, source.id);
    });
  } finally {
    (prisma as any).$transaction = originalTransaction;
    // Fixtures intentionally remain only in this exact disposable target for
    // the controller's final authenticated startup verification and teardown.
    console.log(`Phase2 synthetic fixture evidence: ${invoiceIds.length} invoices, ${documentIds.length} proofs; target retained for controller cleanup`);
    await prisma.$disconnect();
  }
});
