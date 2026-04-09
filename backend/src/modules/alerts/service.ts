import prisma from "../../db/prisma";
import {
  applyBusinessThresholds,
  getBusinessSettings,
} from "../settings/service";

type AlertLevel = "CRITICAL" | "LOW" | "INFO";
type AlertType = "Stock" | "Invoice";

type AlertItem = {
  key: string;
  title: string;
  message: string;
  level: AlertLevel;
  type: AlertType;
  createdAt: string;
  read: boolean;
};

function formatCurrency(value: unknown) {
  const amount = Number(value ?? 0);
  const normalized = Math.round(amount * 100) / 100;
  const rendered =
    normalized % 1 === 0
      ? normalized.toLocaleString()
      : normalized.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  return `NPR ${rendered}`;
}

function normalizeStatus(value: unknown) {
  const upper = String(value || "").toUpperCase();
  if (upper === "PARTIALLY_PAID") return "PARTIAL";
  return upper || "UNPAID";
}

function buildInvoiceMessage(log: any) {
  const actorName = log.actor?.name || "Someone";
  const invoiceNo = log.meta?.invoiceNo || log.entityId;

  if (log.action === "INVOICE_FINALIZED") {
    return {
      title: `Invoice generated: ${invoiceNo}`,
      message: `${actorName} generated invoice ${invoiceNo}. Net total ${formatCurrency(log.meta?.netTotal)}.`,
    };
  }

  if (log.action === "INVOICE_PAYMENT_UPDATED") {
    const previousStatus = normalizeStatus(log.meta?.previousStatus);
    const nextStatus = normalizeStatus(log.meta?.nextStatus);
    if (nextStatus === "PAID" && previousStatus !== "PAID") {
      return {
        title: `Invoice paid: ${invoiceNo}`,
        message: `${actorName} updated invoice ${invoiceNo} from ${previousStatus} to PAID.`,
      };
    }

    return {
      title: `Invoice updated: ${invoiceNo}`,
      message: `${actorName} updated invoice ${invoiceNo}. Added ${formatCurrency(log.meta?.amountAdded)}. Remaining due ${formatCurrency(log.meta?.remainingDue)}.`,
    };
  }

  return {
    title: `Invoice cancelled: ${invoiceNo}`,
    message: `${actorName} cancelled invoice ${invoiceNo}.`,
  };
}

function isImmediatePaidTransition(log: any) {
  return (
    log.action === "INVOICE_PAYMENT_UPDATED" &&
    normalizeStatus(log.meta?.nextStatus) === "PAID"
  );
}

function shouldSuppressFinalizedAlert(log: any, latestPaidLogByInvoiceId: Map<string, any>) {
  if (log.action !== "INVOICE_FINALIZED") return false;

  const paidLog = latestPaidLogByInvoiceId.get(log.entityId);
  if (!paidLog) return false;

  const finalizedAt = new Date(log.createdAt).getTime();
  const paidAt = new Date(paidLog.createdAt).getTime();

  return paidAt >= finalizedAt && paidAt - finalizedAt <= 5 * 60 * 1000;
}

export async function listAlerts(userId: string, role: "ADMIN" | "CASHIER", limit = 20) {
  const [readRows, lowStockProducts, auditLogs, settings] = await Promise.all([
    prisma.userAlertRead.findMany({
      where: { userId },
      select: { alertKey: true },
    }),
    prisma.product.findMany({
      where: {
        isActive: true,
      },
      include: {
        brand: { select: { id: true, name: true } },
      },
      orderBy: { stock: "asc" },
    }),
    prisma.auditLog.findMany({
      where: {
        action: {
          in: ["INVOICE_FINALIZED", "INVOICE_PAYMENT_UPDATED", "INVOICE_CANCELLED"],
        },
        ...(role === "CASHIER" ? { actorId: userId } : {}),
      },
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 3, 20),
    }),
    getBusinessSettings(),
  ]);

  const readKeys = new Set(readRows.map((row) => row.alertKey));
  const alerts: AlertItem[] = [];
  const latestPaidLogByInvoiceId = new Map<string, any>();

  auditLogs.forEach((log) => {
    if (!isImmediatePaidTransition(log)) return;

    const existing = latestPaidLogByInvoiceId.get(log.entityId);
    if (!existing || new Date(log.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestPaidLogByInvoiceId.set(log.entityId, log);
    }
  });

  lowStockProducts
    .map((product) => applyBusinessThresholds(product, settings))
    .filter((product) => product.stock <= product.lowStockThreshold)
    .forEach((product) => {
      const key = `stock-${product.id}`;
      const isOutOfStock = product.stock <= 0;
      alerts.push({
        key,
        title: isOutOfStock
          ? `Out of stock: ${product.name}`
          : `Low stock: ${product.name}`,
        message: `${product.name} has ${product.stock} item(s) left. Threshold ${product.lowStockThreshold}.`,
        level: isOutOfStock ? "CRITICAL" : "LOW",
        type: "Stock",
        createdAt: product.updatedAt.toISOString(),
        read: readKeys.has(key),
      });
    });

  auditLogs.forEach((log) => {
    if (shouldSuppressFinalizedAlert(log, latestPaidLogByInvoiceId)) {
      return;
    }

    const key = `audit-${log.id}`;
    const invoiceAlert = buildInvoiceMessage(log);
    alerts.push({
      key,
      title: invoiceAlert.title,
      message: invoiceAlert.message,
      level: "INFO",
      type: "Invoice",
      createdAt: log.createdAt.toISOString(),
      read: readKeys.has(key),
    });
  });

  return alerts
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);
}

export async function markAsRead(userId: string, alertKey: string) {
  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: {},
    create: { userId, alertKey },
  });
}

export async function markAllAsRead(userId: string, alertKeys: string[]) {
  const data = alertKeys.map((key) => ({ userId, alertKey: key }));
  return prisma.userAlertRead.createMany({
    data,
    skipDuplicates: true,
  });
}

export async function getReadAlerts(userId: string) {
  const reads = await prisma.userAlertRead.findMany({
    where: { userId },
    select: { alertKey: true },
  });
  return reads.map((row) => row.alertKey);
}

export async function markAsUnread(userId: string, alertKey: string) {
  return prisma.userAlertRead.deleteMany({
    where: { userId, alertKey },
  });
}
