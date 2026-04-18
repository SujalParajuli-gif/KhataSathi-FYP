import prisma from "../../db/prisma";
import {
  applyBusinessThresholds,
  getBusinessSettings,
} from "../settings/service";

// defining the alert severity levels — CRITICAL for out of stock, LOW for below threshold, INFO for invoice events
type AlertLevel = "CRITICAL" | "LOW" | "INFO";
type AlertType = "Stock" | "Invoice";

// the shape of each alert item that gets sent to the frontend
type AlertItem = {
  key: string; // unique identifier for read/unread tracking
  title: string;
  message: string;
  level: AlertLevel;
  type: AlertType;
  createdAt: string;
  read: boolean; // whether this user has already marked it as read
};

// formatting currency values for alert messages (e.g., "NPR 1,500.00")
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

// converting payment status to a shorter display format for alert messages
function normalizeStatus(value: unknown) {
  const upper = String(value || "").toUpperCase();
  if (upper === "PARTIALLY_PAID") return "PARTIAL";
  return upper || "UNPAID";
}

// building alert title and message for invoice-related audit log entries
// we check the action type to determine whether it was a finalization, payment update, or cancellation
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
    // when an invoice transitions to PAID, we use a different message to highlight it
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

  // if it is not finalized or updated, it must be a cancellation
  return {
    title: `Invoice cancelled: ${invoiceNo}`,
    message: `${actorName} cancelled invoice ${invoiceNo}.`,
  };
}

// checking if this audit log entry represents an invoice being paid immediately after finalization
function isImmediatePaidTransition(log: any) {
  return (
    log.action === "INVOICE_PAYMENT_UPDATED" &&
    normalizeStatus(log.meta?.nextStatus) === "PAID"
  );
}

// suppressing the "finalized" alert if the invoice was paid within 5 minutes of finalization
// this avoids showing two separate alerts (finalized + paid) when the cashier finalizes and
// takes payment right away — the "paid" alert is more useful so we keep that one instead
function shouldSuppressFinalizedAlert(log: any, latestPaidLogByInvoiceId: Map<string, any>) {
  if (log.action !== "INVOICE_FINALIZED") return false;

  const paidLog = latestPaidLogByInvoiceId.get(log.entityId);
  if (!paidLog) return false;

  const finalizedAt = new Date(log.createdAt).getTime();
  const paidAt = new Date(paidLog.createdAt).getTime();

  return paidAt >= finalizedAt && paidAt - finalizedAt <= 5 * 60 * 1000; // 5 minute window
}

// --

// fetching alerts for a user — combines stock alerts and invoice activity alerts
// for cashiers, we only show invoice alerts for their own invoices
// for admin, we show all alerts
export async function listAlerts(userId: string, role: "ADMIN" | "CASHIER", limit = 20) {
  // fetching all the data we need in parallel for better performance
  const [readRows, lowStockProducts, auditLogs, settings] = await Promise.all([
    // getting the list of alert keys this user has already read
    prisma.userAlertRead.findMany({
      where: { userId },
      select: { alertKey: true },
    }),
    // getting all active products to check for low stock
    prisma.product.findMany({
      where: {
        isActive: true,
      },
      include: {
        brand: { select: { id: true, name: true } },
      },
      orderBy: { stock: "asc" },
    }),
    // getting recent invoice-related audit logs for the alert feed
    prisma.auditLog.findMany({
      where: {
        action: {
          in: ["INVOICE_FINALIZED", "INVOICE_PAYMENT_UPDATED", "INVOICE_CANCELLED"],
        },
        ...(role === "CASHIER" ? { actorId: userId } : {}), // cashiers only see their own activity
      },
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 3, 20), // fetching extra to account for suppressed alerts
    }),
    getBusinessSettings(),
  ]);

  const readKeys = new Set(readRows.map((row) => row.alertKey)); // set for fast lookup
  const alerts: AlertItem[] = [];
  const latestPaidLogByInvoiceId = new Map<string, any>();

  // building a map of the latest "paid" log per invoice so we can suppress finalized alerts
  auditLogs.forEach((log) => {
    if (!isImmediatePaidTransition(log)) return;

    const existing = latestPaidLogByInvoiceId.get(log.entityId);
    if (!existing || new Date(log.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestPaidLogByInvoiceId.set(log.entityId, log);
    }
  });

  // generating stock alerts — one alert per product that is at or below its low stock threshold
  lowStockProducts
    .map((product) => applyBusinessThresholds(product, settings))
    .filter((product) => product.stock <= product.lowStockThreshold)
    .forEach((product) => {
      const key = `stock-${product.id}`; // using the product ID as part of the alert key for uniqueness
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

  // generating invoice alerts from recent audit logs
  auditLogs.forEach((log) => {
    // skipping finalized alerts that were immediately followed by a paid transition
    if (shouldSuppressFinalizedAlert(log, latestPaidLogByInvoiceId)) {
      return;
    }

    const key = `audit-${log.id}`; // using the audit log ID as the alert key
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

  // sorting by newest first and limiting to the requested number
  return alerts
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);
}

// --

// marking a single alert as read — uses upsert so calling it multiple times is safe
export async function markAsRead(userId: string, alertKey: string) {
  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: {}, // if already exists, do nothing
    create: { userId, alertKey },
  });
}

// marking multiple alerts as read at once — used by the "mark all as read" button
export async function markAllAsRead(userId: string, alertKeys: string[]) {
  const data = alertKeys.map((key) => ({ userId, alertKey: key }));
  return prisma.userAlertRead.createMany({
    data,
    skipDuplicates: true, // safely handling keys that are already marked as read
  });
}

// returning all alert keys that this user has already read
// the frontend compares this list against the current alerts to determine which ones to show as read
export async function getReadAlerts(userId: string) {
  const reads = await prisma.userAlertRead.findMany({
    where: { userId },
    select: { alertKey: true },
  });
  return reads.map((row) => row.alertKey);
}

// removing the read record for an alert — this makes it appear as unread again
export async function markAsUnread(userId: string, alertKey: string) {
  return prisma.userAlertRead.deleteMany({
    where: { userId, alertKey },
  });
}
