import prisma from "../../db/prisma";

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeAmount(value: unknown, label: string, allowZero = false) {
  const normalized = roundCurrency(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0 || (!allowZero && normalized <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return normalized;
}

function normalizeNote(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

async function summarizeDrawerTx(tx: any, drawer: any) {
  const cashSales = await tx.payment.aggregate({
    _sum: { amount: true },
    where: {
      method: "CASH",
      kind: "CHARGE",
      status: "SUCCESS",
      createdById: drawer.cashierId,
      createdAt: {
        gte: drawer.openedAt,
        ...(drawer.closedAt ? { lte: drawer.closedAt } : {}),
      },
    },
  });

  const events = await tx.cashDrawerEvent.groupBy({
    by: ["type"],
    where: { drawerId: drawer.id },
    _sum: { amount: true },
  });

  const amountByType = new Map(
    events.map((event: any) => [event.type, Number(event._sum.amount || 0)]),
  );
  const cashSalesTotal = roundCurrency(Number(cashSales._sum.amount || 0));
  const cashInTotal = roundCurrency(Number(amountByType.get("CASH_IN") || 0));
  const cashOutTotal = roundCurrency(Number(amountByType.get("CASH_OUT") || 0));
  const expectedTotal = roundCurrency(
    Number(drawer.openingFloat || 0) + cashSalesTotal + cashInTotal - cashOutTotal,
  );
  const actualTotal =
    drawer.actualTotal === null || drawer.actualTotal === undefined
      ? null
      : roundCurrency(Number(drawer.actualTotal || 0));
  const difference =
    actualTotal === null ? null : roundCurrency(actualTotal - expectedTotal);

  const updated = await tx.cashDrawer.update({
    where: { id: drawer.id },
    data: {
      cashSalesTotal,
      cashInTotal,
      cashOutTotal,
      expectedTotal,
      difference,
    },
    include: {
      cashier: { select: { id: true, name: true, email: true } },
      events: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return updated;
}

export async function getCurrentCashDrawer(cashierId: string) {
  const drawer = await prisma.cashDrawer.findFirst({
    where: { cashierId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (!drawer) return null;

  return prisma.$transaction((tx) => summarizeDrawerTx(tx, drawer));
}

export async function listCashDrawers(cashierId: string, role: string) {
  const canSeeAllDrawers = role === "ADMIN" || role === "MANAGER";
  const drawers = await prisma.cashDrawer.findMany({
    where: canSeeAllDrawers ? {} : { cashierId },
    include: {
      cashier: { select: { id: true, name: true, email: true } },
      events: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { openedAt: "desc" },
    take: 30,
  });

  return drawers;
}

export async function openCashDrawer(
  cashierId: string,
  openingFloat: unknown,
  note?: unknown,
) {
  const normalizedFloat = normalizeAmount(openingFloat, "Opening float", true);
  const normalizedNote = normalizeNote(note);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.cashDrawer.findFirst({
      where: { cashierId, status: "OPEN" },
    });
    if (existing) {
      throw new Error("This cashier already has an open cash drawer");
    }

    const drawer = await tx.cashDrawer.create({
      data: {
        cashierId,
        openingFloat: normalizedFloat,
        expectedTotal: normalizedFloat,
        note: normalizedNote,
      },
    });

    await tx.cashDrawerEvent.create({
      data: {
        drawerId: drawer.id,
        type: "OPEN",
        amount: normalizedFloat,
        note: normalizedNote,
        createdById: cashierId,
      },
    });

    return summarizeDrawerTx(tx, drawer);
  });
}

export async function addCashDrawerEvent(
  drawerId: string,
  actorId: string,
  actorRole: string,
  type: "CASH_IN" | "CASH_OUT",
  amount: unknown,
  note?: unknown,
) {
  const normalizedAmount = normalizeAmount(amount, "Amount");
  const normalizedNote = normalizeNote(note);

  return prisma.$transaction(async (tx) => {
    const drawer = await tx.cashDrawer.findUnique({ where: { id: drawerId } });
    if (!drawer) throw new Error("Cash drawer not found");
    if (drawer.status !== "OPEN") throw new Error("Cash drawer is already closed");
    if (actorRole !== "ADMIN" && actorRole !== "MANAGER" && drawer.cashierId !== actorId) {
      throw new Error("You can only adjust your own cash drawer");
    }

    await tx.cashDrawerEvent.create({
      data: {
        drawerId,
        type,
        amount: normalizedAmount,
        note: normalizedNote,
        createdById: actorId,
      },
    });

    return summarizeDrawerTx(tx, drawer);
  });
}

export async function closeCashDrawer(
  drawerId: string,
  actorId: string,
  actorRole: string,
  actualTotal: unknown,
  note?: unknown,
) {
  const normalizedActual = normalizeAmount(actualTotal, "Actual cash total", true);
  const normalizedNote = normalizeNote(note);

  return prisma.$transaction(async (tx) => {
    const drawer = await tx.cashDrawer.findUnique({ where: { id: drawerId } });
    if (!drawer) throw new Error("Cash drawer not found");
    if (drawer.status !== "OPEN") throw new Error("Cash drawer is already closed");
    if (actorRole !== "ADMIN" && actorRole !== "MANAGER" && drawer.cashierId !== actorId) {
      throw new Error("You can only close your own cash drawer");
    }

    const closed = await tx.cashDrawer.update({
      where: { id: drawerId },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        actualTotal: normalizedActual,
        note: normalizedNote || drawer.note,
      },
    });

    await tx.cashDrawerEvent.create({
      data: {
        drawerId,
        type: "CLOSE",
        amount: normalizedActual,
        note: normalizedNote,
        createdById: actorId,
      },
    });

    const summarized = await summarizeDrawerTx(tx, closed);
    const difference = roundCurrency(Number(summarized.difference || 0));

    if (difference !== 0) {
      await tx.auditLog.create({
        data: {
          actorId,
          action: "CASH_DRAWER_CLOSED",
          entityType: "CashDrawer",
          entityId: drawerId,
          meta: {
            cashierId: summarized.cashierId,
            cashierName: summarized.cashier?.name || null,
            actorRole,
            expectedTotal: summarized.expectedTotal,
            actualTotal: summarized.actualTotal,
            difference,
            note: normalizedNote,
          },
        },
      });
    }

    return summarized;
  });
}
