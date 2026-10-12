import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import prisma from "../db/prisma";
import { getCurrentCashDrawer, listCashDrawers, getOpenCashDrawersForReport } from "../modules/cash-drawers/service";

test("MySQL drawer source snapshot keeps reads side-effect free across actual event/closure commits", { skip: process.env.KHATASATHI_DRAWER_PROJECTION_MYSQL_TEST !== "1", timeout: 60000 }, async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && (url.port || "3306") === "3306" && url.pathname === "/ks_verify_mixed_credit_20261011");
  const writer = new PrismaClient(), original = prisma.$transaction.bind(prisma);
  const actor = await prisma.user.create({ data: { name: "Owned drawer read actor", phone: `+97796${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "CASHIER" } });
  const invoice = await prisma.invoice.create({ data: { invoiceNo: "DRAWER-" + randomUUID(), cashierId: actor.id, status: "FINALIZED", finalizedAt: new Date(), netTotal: 500, paidTotal: 50.25, correctionCredit: 300,
    payments: { create: [{ method: "CASH", kind: "CHARGE", status: "SUCCESS", amount: 50.25, createdById: actor.id }, { method: "CASH", kind: "REFUND", status: "SUCCESS", amount: 20, createdById: actor.id }, { method: "ESEWA", kind: "CHARGE", status: "SUCCESS", amount: 100, createdById: actor.id }, { method: "CASH", kind: "CHARGE", status: "PENDING", amount: 200, createdById: actor.id }] } } });
  const drawer = await prisma.cashDrawer.create({ data: { cashierId: actor.id, status: "OPEN", openedAt: new Date(Date.now() - 10000), openingFloat: 100, expectedTotal: 0,
    events: { create: [{ type: "OPEN", amount: 100, createdById: actor.id }, { type: "CASH_IN", amount: 10, createdById: actor.id }, { type: "CASH_OUT", amount: 20, createdById: actor.id }] } } });
  try {
    const before = await prisma.cashDrawer.findUniqueOrThrow({ where: { id: drawer.id } });
    const expected = 140.25;
    const current = await getCurrentCashDrawer(actor.id); assert.equal(current.expectedTotal, expected); assert.equal(current.cashBasis.legacyCashRefundCount, 1);
    const list = await listCashDrawers(actor.id, "CASHIER"); assert.equal(list.length, 1); assert.equal(list[0].expectedTotal, expected);
    const report = (await getOpenCashDrawersForReport()).find(d => d.id === drawer.id)!; assert.equal(report.expectedTotal, expected); assert.ok(!("events" in report) && !("note" in report));
    assert.deepEqual(await prisma.cashDrawer.findUniqueOrThrow({ where: { id: drawer.id } }), before);
    // A real independent transaction commits after the first consistent read,
    // before subsequent source aggregates. The reader must retain its snapshot.
    let entered = 0;
    prisma.$transaction = ((work: any, opts: any) => original(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key === "cashDrawer") return { ...tx.cashDrawer, findMany: async (q: any) => {
        const rows = await tx.cashDrawer.findMany(q); entered++;
        await writer.$transaction(async wt => {
          await wt.cashDrawerEvent.create({ data: { drawerId: drawer.id, type: "CASH_IN", amount: 50, createdById: actor.id } });
          await wt.cashDrawer.update({ where: { id: drawer.id }, data: { status: "CLOSED", closedAt: new Date(), expectedTotal: 777, difference: 3, actualTotal: 780 } });
        });
        assert.equal((await writer.cashDrawer.findUniqueOrThrow({ where: { id: drawer.id } })).status, "CLOSED");
        return rows;
      } }; return Reflect.get(target, key);
    } })), opts)) as any;
    const snapshot = await listCashDrawers(actor.id, "CASHIER"); prisma.$transaction = original;
    assert.equal(entered, 1); assert.equal(snapshot[0].status, "OPEN"); assert.equal(snapshot[0].expectedTotal, expected); assert.equal(snapshot[0].cashBasis.kind, "CURRENT_SOURCE_ROWS");
    const saved = (await listCashDrawers(actor.id, "CASHIER"))[0]; assert.equal(saved.expectedTotal, 777); assert.equal(saved.difference, 3); assert.equal(saved.cashBasis.kind, "CLOSED_CAPTURE"); assert.equal(saved.cashBasis.legacyCashRefundCount, null);
    assert.equal(await getCurrentCashDrawer(actor.id), null); assert.ok(!(await getOpenCashDrawersForReport()).some(d => d.id === drawer.id));
    assert.equal((await prisma.cashDrawer.findUniqueOrThrow({ where: { id: drawer.id } })).expectedTotal, 777);
  } finally {
    prisma.$transaction = original;
    await prisma.cashDrawerEvent.deleteMany({ where: { drawerId: drawer.id } }); await prisma.cashDrawer.delete({ where: { id: drawer.id } });
    await prisma.payment.deleteMany({ where: { invoiceId: invoice.id } }); await prisma.invoice.delete({ where: { id: invoice.id } }); await prisma.user.delete({ where: { id: actor.id } });
    await writer.$disconnect(); await prisma.$disconnect();
  }
});
