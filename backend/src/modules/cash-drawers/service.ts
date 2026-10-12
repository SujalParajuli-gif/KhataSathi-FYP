import { Prisma } from "@prisma/client";
import { calculateDrawerTotalsTx, projectDrawerTx } from "./projection";
import prisma from "../../db/prisma";
import {
  lockCashDrawerForUpdate,
  lockCashierForUpdate,
  runFinancialTransaction,
} from "../../lib/transactionLocks";

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

export async function summarizeDrawerTx(tx: any, drawer: any) {
  const { cashBasis, ...totals } = await calculateDrawerTotalsTx(tx, drawer);
  const updated = await tx.cashDrawer.update({
    where: { id: drawer.id },
    data: totals,
    include: {
      cashier: { select: { id: true, name: true, email: true } },
      events: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return { ...updated, cashBasis };
}

const drawerInclude = {
  cashier: { select: { id: true, name: true, email: true } },
  events: { include: { createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" as const } },
};

export async function getCurrentCashDrawer(cashierId: string) {
  return prisma.$transaction(async tx => {
    const asOf = new Date();
    const drawer = await tx.cashDrawer.findFirst({ where: { cashierId, status: "OPEN" }, orderBy: { openedAt: "desc" }, include: drawerInclude });
    return drawer ? projectDrawerTx(tx, drawer, asOf) : null;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listCashDrawers(cashierId: string, role: string) {
  return prisma.$transaction(async tx => {
    const asOf = new Date();
    const drawers = await tx.cashDrawer.findMany({ where: role === "ADMIN" || role === "MANAGER" ? {} : { cashierId }, include: drawerInclude, orderBy: { openedAt: "desc" }, take: 30 });
    const result: Awaited<ReturnType<typeof projectDrawerTx>>[] = [];
    for (const drawer of drawers) result.push(await projectDrawerTx(tx, drawer, asOf));
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Only the manager report's existing public fields, plus basis; no events or notes. */
export async function getOpenCashDrawersForReport() {
  return prisma.$transaction(async tx => {
    const asOf = new Date();
    const drawers = await tx.cashDrawer.findMany({ where: { status: "OPEN" }, include: { cashier: { select: { id: true, name: true } } }, orderBy: { openedAt: "desc" } });
    const result: Array<{ id: string; openedAt: Date; openingFloat: number; expectedTotal: number; cashSalesTotal: number; cashier: { id: string; name: string } | null; cashBasis: ReturnType<typeof import("./projection").drawerCashBasis> }> = [];
    for (const drawer of drawers) {
      const projected = await projectDrawerTx(tx, drawer, asOf);
      result.push({ id: drawer.id, openedAt: drawer.openedAt, openingFloat: drawer.openingFloat, expectedTotal: projected.expectedTotal, cashSalesTotal: projected.cashSalesTotal, cashier: drawer.cashier, cashBasis: projected.cashBasis });
    }
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function openCashDrawer(
  cashierId: string,
  openingFloat: unknown,
  note?: unknown,
) {
  const normalizedFloat = normalizeAmount(openingFloat, "Opening float", true);
  const normalizedNote = normalizeNote(note);

  return runFinancialTransaction(prisma, async (tx) => {
    await lockCashierForUpdate(tx, cashierId);
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

  return runFinancialTransaction(prisma, async (tx) => {
    await lockCashDrawerForUpdate(tx, drawerId);
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

  return runFinancialTransaction(prisma, async (tx) => {
    await lockCashDrawerForUpdate(tx, drawerId);
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
