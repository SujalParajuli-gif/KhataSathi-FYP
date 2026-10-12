/** Recorded cash basis only; legacy refund entries do not establish cash handover. */
export function drawerCashBasis(drawer: any, asOf: Date, legacyCashRefundCount: number | null) {
  return {
    kind: drawer.status === "CLOSED" ? "CLOSED_CAPTURE" : "CURRENT_SOURCE_ROWS",
    asOf: asOf.toISOString(),
    legacyCashRefundCount,
  };
}

export async function calculateDrawerTotalsTx(tx: any, drawer: any, asOf = new Date(), inspectLegacyRefunds = false) {
  const period = { gte: drawer.openedAt, lte: drawer.closedAt || asOf };
  const cashSales = await tx.payment.aggregate({
    _sum: { amount: true },
    where: { method: "CASH", kind: "CHARGE", status: "SUCCESS", createdById: drawer.cashierId, createdAt: period },
  });
  const events = await tx.cashDrawerEvent.groupBy({ by: ["type"], where: { drawerId: drawer.id }, _sum: { amount: true } });
  const legacyCashRefundCount = inspectLegacyRefunds ? await tx.payment.count({
    where: { method: "CASH", kind: "REFUND", status: "SUCCESS", createdById: drawer.cashierId, createdAt: period },
  }) : null;
  const round = (n: number) => Math.round(n * 100) / 100;
  const amounts = new Map(events.map((e: any) => [e.type, Number(e._sum.amount || 0)]));
  const cashSalesTotal = round(Number(cashSales._sum.amount || 0));
  const cashInTotal = round(Number(amounts.get("CASH_IN") || 0));
  const cashOutTotal = round(Number(amounts.get("CASH_OUT") || 0));
  const expectedTotal = round(Number(drawer.openingFloat) + cashSalesTotal + cashInTotal - cashOutTotal);
  const actual = drawer.actualTotal == null ? null : Number(drawer.actualTotal);
  const difference = actual == null ? null : round(actual - expectedTotal);
  if (![cashSalesTotal, cashInTotal, cashOutTotal, expectedTotal, ...(difference == null ? [] : [difference])].every(Number.isFinite)) {
    throw new Error("Cash drawer source totals could not be reconciled");
  }
  return { cashSalesTotal, cashInTotal, cashOutTotal, expectedTotal, difference, cashBasis: drawerCashBasis(drawer, asOf, legacyCashRefundCount) };
}

export async function projectDrawerTx(tx: any, drawer: any, asOf: Date) {
  if (drawer.status === "CLOSED") {
    return { ...drawer, cashBasis: drawerCashBasis(drawer, drawer.closedAt || asOf, null) };
  }
  return { ...drawer, ...await calculateDrawerTotalsTx(tx, drawer, asOf, true) };
}
