import prisma from "../../db/prisma";
import {
  applyBusinessThresholds,
  getBusinessSettings,
} from "../settings/service";
import { getDocumentStorageHealth } from "../documents/service";

type AlertLevel = "CRITICAL" | "WARNING" | "LOW" | "INFO";
type AlertType = "Stock" | "Invoice" | "Product" | "Return" | "Payment" | "System";

type AlertItem = {
  key: string;
  title: string;
  message: string;
  level: AlertLevel;
  type: AlertType;
  createdAt: string;
  read: boolean;
  resolved: boolean;
};

type AlertStateRow = {
  alertKey: string;
  readAt: Date | null;
  resolvedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

const ALERT_AUDIT_ACTIONS = [
  "INVOICE_FINALIZED",
  "INVOICE_PAYMENT_UPDATED",
  "INVOICE_MODIFIED_WITH_CREDIT_NOTE",
  "INVOICE_DRAFT_TRANSFERRED",
  "INVOICE_CANCELLED",
  "PAYMENT_VOIDED",
  "CASHIER_MANUAL_DISCOUNT_APPLIED",
  "CASHIER_PRICE_OVERRIDE_APPLIED",
  "RETURN_REQUEST_CREATED",
  "RETURN_REQUEST_APPROVED",
  "RETURN_REQUEST_REJECTED",
  "RETURN_REQUEST_REVERSED",
  "PRODUCT_IMPORT_COMPLETED",
  "PRODUCT_RESTOCKED",
  "STOCK_RECEIVE_BATCH_CREATED",
  "STOCK_RECEIVE_BILL_UPLOAD_FAILED",
  "STOCK_ADJUSTED",
  "PRODUCT_PRICE_UPDATED",
  "PRODUCT_PRICE_UPDATE_DIGEST",
  "MANAGER_PRODUCT_BULK_PRICE_UPDATE",
  "PRODUCT_DEACTIVATED",
  "CUSTOMER_DEACTIVATED",
  "DOCUMENT_UPLOADED",
  "DOCUMENT_DELETED",
  "CASH_DRAWER_CLOSED",
  "DATABASE_BACKUP",
  "DATABASE_BACKUP_SCHEDULED",
  "DATABASE_RESTORE",
  "SCHEDULED_BACKUP_FAILED",
  "BACKUP_SCHEDULE_UPDATED",
  "CASHIER_PRIVILEGE_UPDATED",
  "OVERRIDE_PIN_UPDATED",
  "OVERRIDE_PIN_LOCKED",
  "CUSTOMER_DISCOUNT_CREATED_BY_CASHIER",
  "CUSTOMER_DISCOUNT_REQUEST_CREATED",
  "CUSTOMER_DISCOUNT_REQUEST_APPROVED",
  "CUSTOMER_DISCOUNT_REQUEST_REJECTED",
] as const;

const CASHIER_GLOBAL_ACTIONS = new Set([
  "PRODUCT_RESTOCKED",
  "STOCK_RECEIVE_BATCH_CREATED",
  "STOCK_ADJUSTED",
  "PRODUCT_DEACTIVATED",
]);

const SELF_ALERT_ACTIONS = new Set([
  "DATABASE_RESTORE",
  "OVERRIDE_PIN_UPDATED",
  "SCHEDULED_BACKUP_FAILED",
]);

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

function humanizeAction(action: string) {
  return action.toLowerCase().replaceAll("_", " ");
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

  if (log.action === "INVOICE_MODIFIED_WITH_CREDIT_NOTE") {
    return {
      title: `Invoice edited: ${invoiceNo}`,
      message: `${actorName} edited invoice ${invoiceNo}. Credit note and replacement invoice were recorded.`,
    };
  }

  if (log.action === "INVOICE_DRAFT_TRANSFERRED") {
    return {
      title: "Held bill transferred",
      message: `${actorName} transferred a held bill to another cashier.`,
    };
  }

  return {
    title: `Invoice cancelled: ${invoiceNo}`,
    message: `${actorName} cancelled invoice ${invoiceNo}.`,
  };
}

export function buildAuditAlert(log: any): Omit<AlertItem, "key" | "createdAt" | "read" | "resolved"> | null {
  const actorName = log.actor?.name || log.meta?.actorName || "Someone";
  const actorRole = String(log.actor?.role || log.meta?.actorRole || "").toUpperCase();
  const isManagerActor = actorRole === "MANAGER";
  const isCashierActor = actorRole === "CASHIER";

  if (log.action === "INVOICE_CANCELLED" && (isCashierActor || isManagerActor)) {
    const invoiceNo = log.meta?.invoiceNo || log.entityId;
    return {
      title: `Invoice cancelled: ${invoiceNo}`,
      message: `${actorRole === "MANAGER" ? "Manager" : "Cashier"} ${actorName} cancelled invoice ${invoiceNo}. Net total ${formatCurrency(log.meta?.netTotal)}.`,
      level: "WARNING",
      type: "Invoice",
    };
  }

  if (String(log.action).startsWith("INVOICE_")) {
    const invoiceAlert = buildInvoiceMessage(log);
    return { ...invoiceAlert, level: "INFO", type: "Invoice" };
  }

  if (log.action === "PRODUCT_IMPORT_COMPLETED" && isManagerActor) {
    return {
      title: "Manager imported products",
      message: `Manager ${actorName} imported ${log.meta?.createdCount || log.meta?.importedCount || 0} products from ${log.meta?.fileName || "an import file"}.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "PRODUCT_PRICE_UPDATE_DIGEST") {
    return {
      title: "Product prices changed",
      message: `${actorName} updated prices for ${log.meta?.updatedCount || 0} products. Reason: ${log.meta?.reason || "No reason provided"}.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "PRODUCT_PRICE_UPDATED") {
    return {
      title: "Product price changed",
      message: `${actorName} updated ${log.meta?.productName || log.meta?.sku || log.entityId}. Retail ${formatCurrency(log.meta?.before?.retailPrice)} -> ${formatCurrency(log.meta?.after?.retailPrice)}.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "MANAGER_PRODUCT_BULK_PRICE_UPDATE") {
    return {
      title: "Manager updated product prices",
      message: `Manager ${actorName} updated prices for ${log.meta?.updatedCount || 0} products. Reason: ${log.meta?.reason || "No reason provided"}.`,
      level: "WARNING",
      type: "Product",
    };
  }

  if (log.action === "PRODUCT_DEACTIVATED" && !isManagerActor) {
    return {
      title: "Product removed from sale",
      message: `${actorName} deactivated product ${log.meta?.productName || log.meta?.sku || log.entityId}.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "PRODUCT_DEACTIVATED" && isManagerActor) {
    return {
      title: "Manager deactivated product",
      message: `Manager ${actorName} deactivated product ${log.meta?.productName || log.meta?.sku || log.entityId}.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "CUSTOMER_DEACTIVATED" && isManagerActor) {
    return {
      title: "Manager deactivated customer",
      message: `Manager ${actorName} deactivated customer ${log.meta?.customerName || log.entityId}.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "PAYMENT_VOIDED") {
    if (isManagerActor) {
      return {
        title: "Manager voided payment",
        message: `Manager ${actorName} voided payment ${formatCurrency(log.meta?.voidedAmount)} on Invoice ${log.meta?.invoiceNo || log.meta?.invoiceId || log.entityId}.`,
        level: "WARNING",
        type: "Payment",
      };
    }

    return {
      title: "Payment voided",
      message: `${actorName} voided a payment. Review the invoice payment history.`,
      level: "CRITICAL",
      type: "Payment",
    };
  }

  if (log.action === "CASHIER_MANUAL_DISCOUNT_APPLIED") {
    return {
      title: "Manual bill discount used",
      message: `${actorName} changed the normal customer-rule discount on invoice ${log.meta?.invoiceNo || log.entityId}.`,
      level: "CRITICAL",
      type: "Invoice",
    };
  }

  if (log.action === "CASHIER_PRICE_OVERRIDE_APPLIED") {
    return {
      title: "Product price overridden",
      message: `${actorName} changed ${log.meta?.overrideCount || 1} item price(s) on invoice ${log.meta?.invoiceNo || log.entityId}. Difference ${formatCurrency(log.meta?.totalDifference)}.`,
      level: "CRITICAL",
      type: "Invoice",
    };
  }

  if (String(log.action).startsWith("RETURN_REQUEST_")) {
    if (log.action === "RETURN_REQUEST_APPROVED" && isManagerActor) {
      return {
        title: "Manager approved return",
        message: `Manager ${actorName} approved return #${log.entityId} for ${formatCurrency(log.meta?.refundAmount)}.`,
        level: "WARNING",
        type: "Return",
      };
    }

    return {
      title: log.action === "RETURN_REQUEST_CREATED" ? "Return request created" : "Return request updated",
      message: `${actorName} ${humanizeAction(log.action)}.`,
      level: log.action === "RETURN_REQUEST_CREATED" ? "LOW" : "INFO",
      type: "Return",
    };
  }

  if (["PRODUCT_RESTOCKED", "STOCK_RECEIVE_BATCH_CREATED", "STOCK_ADJUSTED"].includes(log.action)) {
    if (
      log.action === "STOCK_ADJUSTED" &&
      isManagerActor &&
      Number(log.meta?.qtyDelta || 0) < 0
    ) {
      return {
        title: "Manager reduced stock",
        message: `Manager ${actorName} reduced stock for ${log.meta?.productName || log.entityId}: ${log.meta?.previousStock ?? "?"} -> ${log.meta?.nextStock ?? "?"}. Reason: ${log.meta?.reason || "No reason provided"}.`,
        level: "WARNING",
        type: "Product",
      };
    }

    return {
      title: log.action === "STOCK_RECEIVE_BATCH_CREATED" ? "Stock receive recorded" : "Stock updated",
      message: `${actorName} recorded stock activity. Cashiers should use the latest catalog quantities.`,
      level: "INFO",
      type: "Product",
    };
  }

  if (log.action === "STOCK_RECEIVE_BILL_UPLOAD_FAILED") {
    return {
      title: "Stock bill upload failed",
      message: `${actorName} received stock from ${log.meta?.supplierName || "a supplier"}, but the bill upload failed. ${log.meta?.error || ""}`.trim(),
      level: "WARNING",
      type: "Product",
    };
  }

  if (String(log.action).startsWith("DOCUMENT_")) {
    return {
      title: log.action === "DOCUMENT_DELETED" ? "Document moved to bin" : "Document uploaded",
      message: `${actorName} ${log.action === "DOCUMENT_DELETED" ? "moved a document to the bin" : "uploaded a document"}.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "SCHEDULED_BACKUP_FAILED") {
    return {
      title: "Scheduled backup failed",
      message: `Scheduled backup failed. ${log.meta?.error || log.meta?.message || "Review backup settings and MySQL tool paths."}`,
      level: "CRITICAL",
      type: "System",
    };
  }

  if (log.action === "CASH_DRAWER_CLOSED") {
    const difference = Number(log.meta?.difference || 0);
    if (difference === 0) return null;

    return {
      title: "Cash drawer discrepancy",
      message: `${log.meta?.cashierName || "Cashier"} closed drawer with expected ${formatCurrency(log.meta?.expectedTotal)} and actual ${formatCurrency(log.meta?.actualTotal)}. Difference ${formatCurrency(difference)}.`,
      level: "WARNING",
      type: "System",
    };
  }

  if (String(log.action).includes("BACKUP")) {
    return {
      title: "Backup activity",
      message: `${actorName} updated or ran a database backup task.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "CASHIER_PRIVILEGE_UPDATED") {
    return {
      title: "Cashier privileges updated",
      message: `${actorName} changed cashier permissions for ${log.meta?.cashierName || "a cashier"}.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "OVERRIDE_PIN_UPDATED") {
    return {
      title: "Override PIN updated",
      message: `${actorName} updated the cashier override PIN.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "OVERRIDE_PIN_LOCKED") {
    return {
      title: "Override PIN temporarily locked",
      message: `${actorName} had ${log.meta?.failedAttempts || 5} failed override PIN attempts. ${String(log.meta?.actionLabel || "Override")} is locked for this cashier.`,
      level: "CRITICAL",
      type: "System",
    };
  }

  if (log.action === "CUSTOMER_DISCOUNT_CREATED_BY_CASHIER") {
    return {
      title: "Cashier created discounted customer",
      message: `${actorName} created ${log.meta?.customerName || "a customer"} with a cashier-applied discount.`,
      level: "LOW",
      type: "System",
    };
  }

  if (log.action === "CUSTOMER_DISCOUNT_REQUEST_CREATED") {
    return {
      title: "Customer discount requested",
      message: `${actorName} requested ${log.meta?.discountPercent || 0}% ${String(log.meta?.discountType || "discount").toLowerCase()} for ${log.meta?.customerName || "a customer"}.`,
      level: "LOW",
      type: "System",
    };
  }

  if (log.action === "CUSTOMER_DISCOUNT_REQUEST_APPROVED") {
    return {
      title: "Discount request approved",
      message: `${log.meta?.customerName || "Customer"} discount request was approved.`,
      level: "INFO",
      type: "System",
    };
  }

  if (log.action === "CUSTOMER_DISCOUNT_REQUEST_REJECTED") {
    return {
      title: "Discount request rejected",
      message: `${log.meta?.customerName || "Customer"} discount request was rejected.`,
      level: "LOW",
      type: "System",
    };
  }

  return null;
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

function isReadState(row: AlertStateRow | undefined) {
  if (!row) return false;
  return !!row.readAt;
}

type AlertRole = "ADMIN" | "MANAGER" | "CASHIER";

type AlertAudienceContext = {
  cashierRecentProductIds?: Set<string>;
};

function auditLogProductIds(log: any) {
  const ids = new Set<string>();
  if (log.entityType === "Product" || log.entityType === "PRODUCT") {
    ids.add(String(log.entityId));
  }

  if (Array.isArray(log.meta?.products)) {
    log.meta.products.forEach((product: any) => {
      if (product?.id) ids.add(String(product.id));
      if (product?.productId) ids.add(String(product.productId));
    });
  }

  return ids;
}

function hasRecentCashierProductMatch(log: any, recentProductIds?: Set<string>) {
  if (!recentProductIds || recentProductIds.size === 0) return false;
  const productIds = auditLogProductIds(log);
  for (const productId of productIds) {
    if (recentProductIds.has(productId)) return true;
  }
  return false;
}

export function shouldIncludeAuditLogForRole(
  log: any,
  userId: string,
  role: AlertRole,
  context: AlertAudienceContext = {},
) {
  if (log.actorId === userId) {
    return SELF_ALERT_ACTIONS.has(log.action);
  }

  if (role === "ADMIN" || role === "MANAGER") return true;

  if (CASHIER_GLOBAL_ACTIONS.has(log.action)) return true;

  if (
    ["PRODUCT_PRICE_UPDATED", "PRODUCT_PRICE_UPDATE_DIGEST", "MANAGER_PRODUCT_BULK_PRICE_UPDATE"].includes(log.action) &&
    hasRecentCashierProductMatch(log, context.cashierRecentProductIds)
  ) {
    return true;
  }

  if (
    ["CUSTOMER_DISCOUNT_REQUEST_APPROVED", "CUSTOMER_DISCOUNT_REQUEST_REJECTED"].includes(log.action) &&
    String(log.meta?.cashierId || "") === userId
  ) {
    return true;
  }

  return false;
}

export async function listAlerts(userId: string, role: AlertRole, limit = 20) {
  const [stateRows, lowStockProducts, auditLogs, settings] = await Promise.all([
    prisma.userAlertRead.findMany({
      where: { userId },
      select: {
        alertKey: true,
        readAt: true,
        resolvedAt: true,
        deletedAt: true,
        createdAt: true,
      },
    }),
    prisma.product.findMany({
      where: { isActive: true },
      include: { brand: { select: { id: true, name: true } } },
      orderBy: { stock: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { action: { in: [...ALERT_AUDIT_ACTIONS] } },
      include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 4, 40),
    }),
    getBusinessSettings(),
  ]);

  const recentProductCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [recentSoldRows, parkedDrafts, storageHealth] = await Promise.all([
    role === "CASHIER"
      ? prisma.invoiceItem.findMany({
          where: {
            invoice: {
              cashierId: userId,
              status: "FINALIZED",
              createdAt: { gte: recentProductCutoff },
            },
          },
          select: { productId: true },
          distinct: ["productId"],
        })
      : Promise.resolve([]),
    role === "CASHIER"
      ? prisma.invoice.findMany({
          where: {
            cashierId: userId,
            status: "DRAFT",
            parkedAt: { not: null },
          },
          select: {
            id: true,
            invoiceNo: true,
            parkedLabel: true,
            parkedAt: true,
          },
          orderBy: { parkedAt: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    role === "ADMIN" ? getDocumentStorageHealth() : Promise.resolve(null),
  ]);

  const cashierRecentProductIds = new Set<string>(
    recentSoldRows.map((row: any) => String(row.productId)),
  );
  const stateByKey = new Map<string, AlertStateRow>(
    stateRows.map((row) => [row.alertKey, row]),
  );
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
      const state = stateByKey.get(key);
      if (state?.deletedAt || state?.resolvedAt) return;

      const isOutOfStock = product.stock <= 0;
      alerts.push({
        key,
        title: isOutOfStock ? `Out of stock: ${product.name}` : `Low stock: ${product.name}`,
        message: `${product.name} has ${product.stock} item(s) left. Threshold ${product.lowStockThreshold}.`,
        level: isOutOfStock ? "CRITICAL" : "LOW",
        type: "Stock",
        createdAt: product.updatedAt.toISOString(),
        read: isReadState(state),
        resolved: !!state?.resolvedAt,
      });
    });

  if (role === "ADMIN" && storageHealth && (!storageHealth.isAccessible || !storageHealth.isWritable)) {
    const key = "system-document-storage";
    const state = stateByKey.get(key);
    if (!state?.deletedAt && !state?.resolvedAt) {
      alerts.push({
        key,
        title: "Document storage unavailable",
        message: `${storageHealth.storageRoot} is ${storageHealth.isAccessible ? "not writable" : "not accessible"}. ${storageHealth.error || ""}`.trim(),
        level: "CRITICAL",
        type: "System",
        createdAt: new Date().toISOString(),
        read: isReadState(state),
        resolved: !!state?.resolvedAt,
      });
    }
  }

  if (role === "CASHIER") {
    const expiryHours = Math.max(1, Number(settings.parkedBillExpiryHours || 8));
    const expiryMs = expiryHours * 60 * 60 * 1000;
    const warnAfterMs = Math.floor(expiryMs * 0.75);
    const nowMs = Date.now();

    parkedDrafts.forEach((draft) => {
      if (!draft.parkedAt) return;
      const parkedAtMs = new Date(draft.parkedAt).getTime();
      const ageMs = nowMs - parkedAtMs;
      if (ageMs < warnAfterMs) return;

      const key = `parked-expiry-${draft.id}`;
      const state = stateByKey.get(key);
      if (state?.deletedAt || state?.resolvedAt) return;

      const expired = ageMs >= expiryMs;
      const label = draft.parkedLabel || draft.invoiceNo || "Parked bill";
      alerts.push({
        key,
        title: expired ? "Parked bill expired" : "Parked bill nearing expiry",
        message: `${label} has been parked for ${Math.floor(ageMs / (60 * 60 * 1000))} hour(s). Expiry setting is ${expiryHours} hour(s).`,
        level: expired ? "CRITICAL" : "WARNING",
        type: "Invoice",
        createdAt: new Date(parkedAtMs + warnAfterMs).toISOString(),
        read: isReadState(state),
        resolved: !!state?.resolvedAt,
      });
    });
  }

  auditLogs.forEach((log) => {
    if (!shouldIncludeAuditLogForRole(log, userId, role, { cashierRecentProductIds })) {
      return;
    }

    if (shouldSuppressFinalizedAlert(log, latestPaidLogByInvoiceId)) return;

    const key = `audit-${log.id}`;
    const state = stateByKey.get(key);
    if (state?.deletedAt || state?.resolvedAt) return;

    const auditAlert = buildAuditAlert(log);
    if (!auditAlert) return;

    alerts.push({
      key,
      ...auditAlert,
      createdAt: log.createdAt.toISOString(),
      read: isReadState(state),
      resolved: !!state?.resolvedAt,
    });
  });

  return alerts
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);
}

export async function markAsRead(userId: string, alertKey: string) {
  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: { readAt: new Date(), deletedAt: null, purgeAfter: null },
    create: { userId, alertKey, readAt: new Date() },
  });
}

export async function markAllAsRead(userId: string, alertKeys: string[]) {
  return prisma.$transaction(
    alertKeys.map((alertKey) =>
      prisma.userAlertRead.upsert({
        where: { userId_alertKey: { userId, alertKey } },
        update: { readAt: new Date(), deletedAt: null, purgeAfter: null },
        create: { userId, alertKey, readAt: new Date() },
      }),
    ),
  );
}

export async function getReadAlerts(userId: string) {
  const reads = await prisma.userAlertRead.findMany({
    where: { userId, deletedAt: null, readAt: { not: null } },
    select: { alertKey: true },
  });
  return reads.map((row) => row.alertKey);
}

export async function markAsUnread(userId: string, alertKey: string) {
  return prisma.userAlertRead.updateMany({
    where: { userId, alertKey },
    data: { readAt: null },
  });
}

export async function resolveAlert(userId: string, alertKey: string) {
  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: { resolvedAt: new Date(), readAt: new Date(), deletedAt: null, purgeAfter: null },
    create: { userId, alertKey, resolvedAt: new Date(), readAt: new Date() },
  });
}

export async function deleteAlert(userId: string, alertKey: string) {
  const purgeAfter = new Date();
  purgeAfter.setDate(purgeAfter.getDate() + 30);

  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: { deletedAt: new Date(), purgeAfter, readAt: new Date() },
    create: { userId, alertKey, deletedAt: new Date(), purgeAfter, readAt: new Date() },
  });
}
