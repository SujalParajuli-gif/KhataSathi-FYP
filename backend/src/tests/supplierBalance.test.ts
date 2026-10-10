import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import { getSupplierBalance } from "../modules/inventory/purchases";
import inventoryRoutes from "../modules/inventory/routes";
import { requireBusinessCapability } from "../modules/settings/capabilities";
import { signSessionToken, hashSessionSecret, SESSION_COOKIE_NAME } from "../modules/auth/session";

test("supplier totals use one repeatable-read snapshot, linked posted receipts and nonvoided payments", async () => {
  const original = prisma.$transaction;
  const D = Prisma.Decimal.clone({ precision: 50 });
  const supplier = { id: "s1", name: "Renamed supplier", isActive: false };
  const batches = [
    { id: "b1", supplierId: "s1", payable: "100.10", postedAt: new Date() },
    { id: "b2", supplierId: "s1", payable: "0.20", postedAt: new Date() },
    { id: "zero", supplierId: "s1", payable: "0.00", postedAt: new Date() },
    { id: "legacy", supplierId: "s1", payable: null, postedAt: null, billAmount: 500 },
    { id: "unposted", supplierId: "s1", payable: "800.00", postedAt: null },
    { id: "other", supplierId: "s2", payable: "700.00", postedAt: new Date() },
    { id: "unlinked", supplierId: null, payable: null, postedAt: null, supplierName: supplier.name },
  ];
  let livePayments = [
    { batchId: "b1", amount: "30.01", voidedAt: null },
    { batchId: "b1", amount: "20.00", voidedAt: new Date() },
    { batchId: "other", amount: "600.00", voidedAt: null },
    { batchId: "legacy", amount: "300.00", voidedAt: null },
  ];
  let reads = 0;
  try {
    prisma.$transaction = (async (work: any, options: any) => {
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.RepeatableRead);
      const snapshot = livePayments.map(p => ({ ...p }));
      const matches = (b: typeof batches[number], where: any) => b.supplierId === where.supplierId && b.payable !== null && b.postedAt !== null;
      return work({
        supplier: { findUnique: async ({ where }: any) => { reads++; assert.equal(where.id, supplier.id); return supplier; } },
        stockReceiveBatch: {
          aggregate: async ({ where }: any) => {
            reads++;
            assert.deepEqual(where, { supplierId: "s1", payable: { not: null }, postedAt: { not: null } });
            const eligible = batches.filter(b => matches(b, where));
            // Simulated concurrent commit after the receipt read. The payment read
            // must use the transaction-local snapshot, never the live delegate.
            livePayments = [...livePayments, { batchId: "b1", amount: "10.00", voidedAt: null }];
            return { _sum: { payable: eligible.reduce((v, b) => v.add(b.payable!), new D(0)) }, _count: { id: eligible.length } };
          },
          count: async ({ where }: any) => {
            reads++;
            assert.deepEqual(where, { supplierId: "s1", OR: [{ payable: null }, { postedAt: null }] });
            return batches.filter(b => b.supplierId === where.supplierId && (b.payable === null || b.postedAt === null)).length;
          },
        },
        supplierPayment: { aggregate: async ({ where }: any) => {
          reads++;
          assert.equal(where.voidedAt, null);
          assert.deepEqual(where.batch, { supplierId: "s1", payable: { not: null }, postedAt: { not: null } });
          const eligible = snapshot.filter(p => p.voidedAt === null && batches.some(b => b.id === p.batchId && matches(b, where.batch)));
          return { _sum: { amount: eligible.reduce((v, p) => v.add(p.amount), new D(0)) } };
        } },
      });
    }) as any;
    const first = await getSupplierBalance("s1", "MANAGER");
    assert.deepEqual(first, { supplier, basis: "RECORDED_SUPPLIER_RECEIPTS", postedReceiptCount: 3, unknownReceiptCount: 2, payable: "100.30", paid: "30.01", due: "70.29", recordedBalance: null });
    assert.equal(reads, 4);
    assert.equal((await getSupplierBalance("s1", "ADMIN")).paid, "40.01", "next snapshot sees the committed installment");
  } finally { prisma.$transaction = original; }
});

test("empty, fully paid, large exact totals and negative source due remain explicit; errors produce no summary", async () => {
  const original = prisma.$transaction;
  let payable: string | null = null, paid: string | null = null, found = true, fail = false;
  try {
    prisma.$transaction = (async (work: any) => work({
      supplier: { findUnique: async () => found ? { id: "s1", name: "Supplier", isActive: true } : null },
      stockReceiveBatch: { aggregate: async () => ({ _sum: { payable }, _count: { id: payable === null ? 0 : 2 } }), count: async () => 0 },
      supplierPayment: { aggregate: async () => { if (fail) throw new Error("read failed"); return { _sum: { amount: paid } }; } },
    })) as any;
    const empty = await getSupplierBalance("s1", "ADMIN");
    assert.equal(empty.recordedBalance, "0.00"); assert.equal(empty.postedReceiptCount, 0);
    payable = "0.30"; paid = "0.30";
    assert.equal((await getSupplierBalance("s1", "ADMIN")).due, "0.00");
    payable = "1999999999999999999.98"; paid = "0.01";
    assert.equal((await getSupplierBalance("s1", "ADMIN")).due, "1999999999999999999.97");
    payable = "1.00"; paid = "2.00";
    assert.equal((await getSupplierBalance("s1", "ADMIN")).due, "-1.00", "never hide source inconsistency by clamping");
    found = false; await assert.rejects(getSupplierBalance("s1", "ADMIN"), /Supplier not found/);
    found = true; fail = true; await assert.rejects(getSupplierBalance("s1", "ADMIN"), /read failed/);
    await assert.rejects(getSupplierBalance("s1", "CASHIER"), /role/i);
    await assert.rejects(getSupplierBalance("", "ADMIN"), /required/i);
  } finally { prisma.$transaction = original; }
});

test("balance HTTP permissions, query validation, missing supplier and sanitized schema/internal failures", async () => {
  let enabled = true, failure: unknown = null, reads = 0;
  const originalSession = prisma.authSession.findUnique, originalTx = prisma.$transaction;
  const sessions = new Map<string, any>();
  const cookies = new Map<string, string>();
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "STAFF"]) {
    const token = `supplier-balance-${role}`;
    cookies.set(role, `${SESSION_COOKIE_NAME}=${signSessionToken(token)}`);
    sessions.set(hashSessionSecret(token), { id: role, expiresAt: new Date(Date.now() + 60000), revokedAt: null, user: { id: role, role, isActive: true, mustChangePassword: false } });
  }
  const app = express();
  app.use("/api/inventory", requireBusinessCapability("INVENTORY", async () => ({ businessMode: "FULL_POS", inventoryEnabled: enabled, posEnabled: true, catalogEnabled: true, staffDraftRequestsEnabled: true, stockTracked: enabled })), inventoryRoutes);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory/suppliers/`;
  const request = (suffix: string, role?: string) => fetch(base + suffix, { headers: role ? { cookie: cookies.get(role)! } : {} });
  try {
    prisma.authSession.findUnique = (async ({ where }: any) => sessions.get(where.tokenHash) ?? null) as any;
    prisma.$transaction = (async (work: any) => {
      reads++; if (failure) throw failure;
      return work({ supplier: { findUnique: async ({ where }: any) => where.id === "missing" ? null : { id: where.id, name: "Supplier", isActive: false } }, stockReceiveBatch: { aggregate: async () => ({ _sum: { payable: "10.10" }, _count: { id: 1 } }), count: async () => 0 }, supplierPayment: { aggregate: async () => ({ _sum: { amount: "1.01" } }) } });
    }) as any;
    assert.equal((await request("s1/balance")).status, 401);
    for (const role of ["CASHIER", "STAFF"]) assert.equal((await request("s1/balance", role)).status, 403);
    enabled = false; const disabled = await request("s1/balance", "ADMIN"); assert.equal(disabled.status, 403); assert.equal((await disabled.json()).code, "FEATURE_DISABLED"); enabled = true;
    assert.equal(reads, 0, "no summary read before access checks");
    for (const role of ["ADMIN", "MANAGER"]) {
      const response = await request("s1/balance", role); assert.equal(response.status, 200); assert.equal((await response.json()).balance.due, "9.09");
    }
    const allowedReads = reads;
    for (const suffix of ["s1/balance?page=2", "s1/balance?role=ADMIN", `${"s".repeat(121)}/balance`]) assert.equal((await request(suffix, "ADMIN")).status, 400);
    assert.equal(reads, allowedReads);
    assert.equal((await request("missing/balance", "MANAGER")).status, 404);
    failure = { code: "P2022", message: "private SQL details" };
    const unavailable = await request("s1/balance", "ADMIN"); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, "PURCHASE_SCHEMA_UNAVAILABLE");
    failure = new Error("SELECT private FROM internal");
    const internal = await request("s1/balance", "ADMIN"); assert.equal(internal.status, 500); assert.deepEqual(await internal.json(), { error: "An unexpected error occurred" });
  } finally { prisma.authSession.findUnique = originalSession; prisma.$transaction = originalTx; await new Promise<void>(resolve => server.close(() => resolve())); }
});
