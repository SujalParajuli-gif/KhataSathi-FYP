import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import { calculateDrawerTotalsTx, projectDrawerTx } from "../modules/cash-drawers/projection";
import { getCurrentCashDrawer, listCashDrawers, getOpenCashDrawersForReport } from "../modules/cash-drawers/service";

test("drawer projection excludes refund/credit/OPEN/CLOSE duplication and retains closed captures", async () => {
  const drawer = { id: "d", cashierId: "c", status: "OPEN", openingFloat: 100, openedAt: new Date(0), actualTotal: null };
  const at = new Date(1000);
  const tx = {
    payment: { aggregate: async (q: any) => { assert.deepEqual(q.where, { method: "CASH", kind: "CHARGE", status: "SUCCESS", createdById: "c", createdAt: { gte: drawer.openedAt, lte: at } }); return { _sum: { amount: 40.25 } }; }, count: async (q: any) => { assert.equal(q.where.kind, "REFUND"); return 1; } },
    cashDrawerEvent: { groupBy: async (q: any) => { assert.deepEqual(q.where, { drawerId: "d" }); return [{ type: "CASH_IN", _sum: { amount: 20 } }, { type: "CASH_OUT", _sum: { amount: 10 } }, { type: "OPEN", _sum: { amount: 100 } }, { type: "CLOSE", _sum: { amount: 999 } }]; } },
  };
  const result = await calculateDrawerTotalsTx(tx, drawer, at, true);
  assert.deepEqual([result.cashSalesTotal, result.cashInTotal, result.cashOutTotal, result.expectedTotal, result.difference], [40.25, 20, 10, 150.25, null]);
  assert.equal(result.cashBasis.legacyCashRefundCount, 1);
  const closed = { ...drawer, status: "CLOSED", closedAt: at, expectedTotal: 999, difference: 2 };
  const captured = await projectDrawerTx({}, closed, new Date(2000));
  assert.equal(captured.expectedTotal, 999); assert.equal(captured.difference, 2); assert.equal(captured.cashBasis.kind, "CLOSED_CAPTURE"); assert.equal(captured.cashBasis.asOf, at.toISOString()); assert.equal(captured.cashBasis.legacyCashRefundCount, null);
  await assert.rejects(calculateDrawerTotalsTx({ ...tx, payment: { ...tx.payment, aggregate: async () => { throw Error("source read failed"); } } }, drawer, at), /source read failed/);
  await assert.rejects(calculateDrawerTotalsTx(tx, { ...drawer, openingFloat: NaN }, at), /could not be reconciled/);
});

test("current/list/report reads share repeatable-read sources without writes and retain actor/report privacy", async () => {
  const original = prisma.$transaction;
  const d = { id: "d", cashierId: "c", status: "OPEN", openedAt: new Date(0), openingFloat: 100, expectedTotal: 0, actualTotal: null, note: "private", events: [], cashier: { id: "c", name: "Actor" } };
  const queries: any[] = [];
  prisma.$transaction = (async (work: any, options: any) => {
    assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.RepeatableRead);
    return work({ cashDrawer: { findFirst: async (q: any) => { queries.push(q); return d; }, findMany: async (q: any) => { queries.push(q); return [d]; } }, payment: { aggregate: async () => ({ _sum: { amount: 50 } }), count: async () => 0 }, cashDrawerEvent: { groupBy: async () => [] } });
  }) as any;
  try {
    assert.equal((await getCurrentCashDrawer("c")).expectedTotal, 150);
    assert.equal((await listCashDrawers("c", "CASHIER"))[0].expectedTotal, 150);
    assert.deepEqual(queries[1].where, { cashierId: "c" });
    const report = (await getOpenCashDrawersForReport())[0]; assert.equal(report.expectedTotal, 150); assert.ok(!("note" in report) && !("events" in report));
    assert.deepEqual(queries[2].where, { status: "OPEN" });
    await listCashDrawers("manager", "MANAGER"); assert.deepEqual(queries[3].where, {});
  } finally { prisma.$transaction = original; }
});
