import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import prisma from "../db/prisma";
import { captureReceivingDestinationTx, checkoutInvoice } from "../modules/invoices/service";
import { addPayment } from "../modules/payments/service";
import { createPaymentAccount, patchPaymentAccount, reorderPaymentAccounts, uploadAndPublishQrAsset } from "../modules/settings/paymentAccounts/service";
import { invalidateBusinessSettingsCache } from "../modules/settings/service";
import { ensureApplicationStorageReady } from "../lib/storageReadiness";

const enabled = process.env.KHATASATHI_DISPOSABLE_MYSQL_TEST === "1";

test("MySQL receiving accounts: current reads, both lock winners, replay, collection race and financial rollback", { skip: !enabled, timeout: 60000 }, async () => {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.match(target.pathname, /^\/ks_verify_2a002_[a-z0-9_]+$/);
  assert.ok(path.isAbsolute(process.env.DOCUMENT_STORAGE_ROOT || ""));
  assert.match(process.env.DOCUMENT_STORAGE_ROOT!, /ks_verify_2a002_/);
  ensureApplicationStorageReady();
  const originalTransaction = prisma.$transaction.bind(prisma);
  const suffix = randomUUID();
  const phone = () => `+97798${randomInt(10000000, 99999999)}`;
  const cashier = await prisma.user.create({ data: { name: "Receiving test cashier", phone: phone(), passwordHash: "unusable", role: "CASHIER" } });
  const admin = await prisma.user.create({ data: { name: "Receiving test admin", phone: phone(), passwordHash: "unusable", role: "ADMIN" } });
  const other = await prisma.user.create({ data: { name: "Receiving test other", phone: phone(), passwordHash: "unusable", role: "CASHIER" } });
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, loyaltyDiscountPercent: 0 }, update: { loyaltyDiscountPercent: 0 } });
  invalidateBusinessSettingsCache();
  await prisma.cashDrawer.create({ data: { cashierId: cashier.id, openingFloat: 0 } });
  const brand = await prisma.brand.create({ data: { name: `Receiving ${suffix}` } });
  const product = await prisma.product.create({ data: { name: "Receiving test item", sku: `RECV-${suffix}`, brandId: brand.id, stock: 100, retailPrice: 100, wholesalePrice: 100, wholesaleEligible: false } });
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: "white" } }).png().toBuffer();
  async function account(method: "FONEPAY" | "BANK_TRANSFER" = "FONEPAY") {
    const created = await createPaymentAccount({ id: randomUUID(), providerLabel: "Test QR", accountHolder: "Test store", accountIdentifier: "TEST-ACCOUNT", settlementMethod: method, confirmationMode: "MANUAL_RECEIPT" }, admin.id);
    await uploadAndPublishQrAsset({ accountId: created.id, uploadId: randomUUID(), expectedVersion: 1, fileBuffer: png, actorId: admin.id });
    return patchPaymentAccount(created.id, { expectedVersion: 2, enabled: true }, admin.id);
  }
  async function invoice() {
    return prisma.invoice.create({ data: { invoiceNo: `RECV-${randomUUID()}`, cashierId: cashier.id, status: "FINALIZED", finalizedAt: new Date(), subTotal: 100, netTotal: 100, paidTotal: 0 } });
  }
  function options(a: any, key = randomUUID()) {
    return { receivingAccountId: a.id, receivingAccountVersion: a.version, manualReceiptConfirmed: true, manualOperationKey: key };
  }
  async function counts() {
    return { invoices: await prisma.invoice.count(), items: await prisma.invoiceItem.count(), payments: await prisma.payment.count(), stocks: await prisma.stockTransaction.count(), operations: await prisma.checkoutOperation.count(), audits: await prisma.auditLog.count(), stock: (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock };
  }
  // Instrument actual tagged locking queries; the competing call enters the real DB
  // while the winner holds its row lock. Every transaction still commits/rolls back in MySQL.
  function barrier(table: string) {
    let calls = 0;
    let signalHeld!: () => void, signalWaiting!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const waiting = new Promise<void>((resolve) => { signalWaiting = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (prisma as any).$transaction = (work: any, opts: any) => originalTransaction(async (tx) => {
      const raw = tx.$queryRaw.bind(tx);
      const queryRaw = async (query: TemplateStringsArray, ...values: any[]) => {
        const matches = query.join(" ").includes(`FROM ${table}`) && query.join(" ").includes("FOR UPDATE");
        const call = matches ? ++calls : 0;
        if (call === 2) signalWaiting();
        const result = await raw(query, ...values);
        if (call === 1) { signalHeld(); await gate; }
        return result;
      };
      return work(new Proxy(tx, { get(target, key) { return key === "$queryRaw" ? queryRaw : Reflect.get(target, key); } }));
    }, { ...opts, timeout: 10000 });
    return { held, waiting, release, restore: () => { (prisma as any).$transaction = originalTransaction; }, calls: () => calls };
  }
  try {
    // Disable wins; stale confirmation rolls back, including checkout stock/cash effects.
    const disabled = await account();
    const b = barrier("PaymentReceivingAccount");
    const disable = patchPaymentAccount(disabled.id, { expectedVersion: disabled.version, enabled: false }, admin.id);
    await b.held;
    const before = await counts();
    const checkout = checkoutInvoice(cashier.id, { operationKey: randomUUID(), items: [{ productId: product.id, qty: 1 }], confirmation: { items: [{ productId: product.id, qty: 1, appliedUnitPrice: 100 }], payableTotal: 100 }, payments: [{ method: "FONEPAY", amount: 100, reference: "DISABLE-RACE", ...options(disabled) }] });
    const rejectedCheckout = assert.rejects(checkout, (err: any) => err.code === "RECEIVING_ACCOUNT_CHANGED");
    await b.waiting; b.release(); await disable; await rejectedCheckout; b.restore();
    const after = await counts();
    assert.deepEqual({ ...after, audits: before.audits }, before);
    assert.equal(after.audits, before.audits + 1, "only disable audit commits");

    // Account confirmation wins; waiting identity edit must see the committed reference.
    const active = await account("BANK_TRANSFER");
    const inv = await invoice();
    const original = options(active);
    const c = barrier("PaymentReceivingAccount");
    const receipt = addPayment(inv.id, "BANK_TRANSFER", 25, "SUCCESS", cashier.id, "WINNER-RECEIPT", original);
    await c.held;
    const edit = patchPaymentAccount(active.id, { expectedVersion: active.version, accountIdentifier: "RETARGET" }, admin.id);
    const rejectedEdit = assert.rejects(edit, (err: any) => err.code === "ACCOUNT_IDENTITY_IN_USE");
    await c.waiting; c.release(); const recorded: any = await receipt; await rejectedEdit; c.restore();
    assert.equal(recorded.receivingDestinationSnapshot.accountIdentifier, "TEST-ACCOUNT");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidTotal, 25);

    // Complete replay survives disable and void; changed actor/body/key cannot post again.
    await patchPaymentAccount(active.id, { expectedVersion: active.version, enabled: false }, admin.id);
    await prisma.payment.update({ where: { id: recorded.id }, data: { voidedAt: new Date(), status: "FAILED" } });
    const beforeReplay = await counts();
    const replay: any = await addPayment(inv.id, "BANK_TRANSFER", 25, "SUCCESS", cashier.id, "WINNER-RECEIPT", original);
    assert.equal(replay.id, recorded.id); assert.equal(replay.status, "FAILED");
    assert.deepEqual(replay.receivingDestinationSnapshot, recorded.receivingDestinationSnapshot);
    await assert.rejects(addPayment(inv.id, "BANK_TRANSFER", 26, "SUCCESS", cashier.id, "WINNER-RECEIPT", original), (e: any) => e.code === "MANUAL_OPERATION_KEY_CONFLICT");
    await assert.rejects(addPayment(inv.id, "BANK_TRANSFER", 25, "SUCCESS", other.id, "WINNER-RECEIPT", original), (e: any) => e.code === "MANUAL_OPERATION_KEY_CONFLICT");
    assert.deepEqual(await counts(), beforeReplay);

    // A transaction that established a consistent snapshot still captures the newer locking tuple.
    const current = await account();
    let snapshotReady!: () => void, continueCapture!: () => void;
    const ready = new Promise<void>((r) => { snapshotReady = r; });
    const proceed = new Promise<void>((r) => { continueCapture = r; });
    const staleTx = originalTransaction(async (tx) => {
      await tx.paymentReceivingAccount.findUnique({ where: { id: current.id } });
      snapshotReady(); await proceed;
      return captureReceivingDestinationTx(tx, { method: "FONEPAY", ...options(current) }, cashier.id);
    }, { timeout: 10000 });
    const rejectedSnapshot = assert.rejects(staleTx, (e: any) => e.code === "RECEIVING_ACCOUNT_CHANGED");
    await ready;
    await uploadAndPublishQrAsset({ accountId: current.id, uploadId: randomUUID(), expectedVersion: current.version, fileBuffer: png, actorId: admin.id });
    continueCapture(); await rejectedSnapshot;

    // Two same-key requests serialize on Invoice and produce one payment and one audit.
    const concurrent = await account(); const concurrentInv = await invoice(); const shared = options(concurrent);
    const concurrentBefore = await counts();
    const d = barrier("Invoice");
    const first = addPayment(concurrentInv.id, "FONEPAY", 30, "SUCCESS", cashier.id, "SAME-RECEIPT", shared);
    await d.held;
    const second = addPayment(concurrentInv.id, "FONEPAY", 30, "SUCCESS", cashier.id, "SAME-RECEIPT", shared);
    await d.waiting; d.release(); const [one, two]: any[] = await Promise.all([first, second]); d.restore();
    assert.equal(one.id, two.id);
    const concurrentAfter = await counts();
    assert.equal(concurrentAfter.payments, concurrentBefore.payments + 1);
    assert.equal(concurrentAfter.audits, concurrentBefore.audits + 1);
    await assert.rejects(addPayment(concurrentInv.id, "FONEPAY", 30, "SUCCESS", cashier.id, "SAME-RECEIPT", options(concurrent)), (e: any) => e.code === "PAYMENT_ALREADY_RECORDED");

    // Collection locking: create commits before stale complete-set reorder can enumerate.
    const list = await prisma.paymentReceivingAccount.findMany();
    const e = barrier("BusinessSettings");
    const creation = createPaymentAccount({ id: randomUUID(), providerLabel: "Collection race", accountHolder: "Store", confirmationMode: "DISPLAY_ONLY", settlementMethod: null }, admin.id);
    await e.held;
    const reorder = reorderPaymentAccounts(list.map((a) => ({ id: a.id, expectedVersion: a.version })), admin.id);
    const rejectedReorder = assert.rejects(reorder, (err: any) => err.code === "INCOMPLETE_REORDER_SET");
    await e.waiting; e.release(); await creation; await rejectedReorder; e.restore();

    // Invalid second split destination discards all sale, stock, drawer, payment and audit writes.
    const rollbackAccount = await account(); const rollbackBefore = await counts();
    const drawerBefore = await prisma.cashDrawer.findFirstOrThrow({ where: { cashierId: cashier.id } });
    await assert.rejects(checkoutInvoice(cashier.id, { operationKey: randomUUID(), items: [{ productId: product.id, qty: 1 }], confirmation: { items: [{ productId: product.id, qty: 1, appliedUnitPrice: 100 }], payableTotal: 100 }, payments: [{ method: "CASH", amount: 20, tenderedAmount: 20 }, { method: "FONEPAY", amount: 40, reference: "FIRST-VALID", ...options(rollbackAccount) }, { method: "FONEPAY", amount: 40, reference: "SECOND-STALE", ...options(disabled) }] }), (err: any) => err.code === "RECEIVING_ACCOUNT_CHANGED");
    assert.deepEqual(await counts(), rollbackBefore);
    assert.deepEqual(await prisma.cashDrawer.findFirstOrThrow({ where: { cashierId: cashier.id } }), drawerBefore);

    // Fault after actual Payment and invoice recomputation: fatal audit failure rolls everything back.
    const faultInv = await invoice(); const faultBefore = await counts();
    let auditEntered = false;
    (prisma as any).$transaction = (work: any) => originalTransaction(async (tx) => {
      const createAudit = tx.auditLog.create.bind(tx.auditLog);
      const auditCreate = async (args: any) => {
        if (args.data.action === "INVOICE_PAYMENT_UPDATED") {
          auditEntered = true;
          assert.equal(await tx.payment.count({ where: { invoiceId: faultInv.id } }), 1);
          assert.equal((await tx.invoice.findUniqueOrThrow({ where: { id: faultInv.id } })).paidTotal, 15);
          throw new Error("INJECTED_RECEIPT_AUDIT_FAILURE");
        }
        return createAudit(args);
      };
      const audit = new Proxy(tx.auditLog, { get(target, key) { return key === "create" ? auditCreate : Reflect.get(target, key); } });
      return work(new Proxy(tx, { get(target, key) { return key === "auditLog" ? audit : Reflect.get(target, key); } }));
    });
    await assert.rejects(addPayment(faultInv.id, "FONEPAY", 15, "SUCCESS", cashier.id, "FAULT-RECEIPT", options(rollbackAccount)), /INJECTED_RECEIPT_AUDIT_FAILURE/);
    (prisma as any).$transaction = originalTransaction;
    assert.ok(auditEntered); assert.deepEqual(await counts(), faultBefore);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: faultInv.id } })).paidTotal, 0);

    // Full financial checkout commits once; replay uses saved observations even
    // after replacement/disable, without consulting live settings or exposing internals.
    const checkoutAccount = await account();
    const checkoutPayload = { operationKey: randomUUID(), items: [{ productId: product.id, qty: 1 }], confirmation: { items: [{ productId: product.id, qty: 1, appliedUnitPrice: 100 }], payableTotal: 100 }, payments: [{ method: "FONEPAY" as const, amount: 100, reference: "CHECKOUT-REPLAY", ...options(checkoutAccount) }] };
    const saved: any = await checkoutInvoice(cashier.id, checkoutPayload);
    assert.equal(saved.invoice.paidTotal, 100);
    const captured = saved.invoice.payments[0].receivingDestinationSnapshot;
    assert.equal(captured.qrAssetId, checkoutAccount.activeQrAssetId);
    await uploadAndPublishQrAsset({ accountId: checkoutAccount.id, uploadId: randomUUID(), expectedVersion: checkoutAccount.version, fileBuffer: png, actorId: admin.id });
    await patchPaymentAccount(checkoutAccount.id, { expectedVersion: checkoutAccount.version + 1, enabled: false, providerLabel: "Later label" }, admin.id);
    const checkoutBeforeReplay = await counts();
    const savedReplay: any = await checkoutInvoice(cashier.id, checkoutPayload);
    assert.equal(savedReplay.invoice.id, saved.invoice.id);
    assert.deepEqual(savedReplay.invoice.payments[0].receivingDestinationSnapshot, captured);
    assert.ok(!("manualPayloadHash" in savedReplay.invoice.payments[0]));
    assert.deepEqual(await counts(), checkoutBeforeReplay);
  } finally {
    (prisma as any).$transaction = originalTransaction;
    await prisma.$disconnect();
  }
});
