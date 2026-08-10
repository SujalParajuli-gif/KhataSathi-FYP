import { DraftRequestItemStatus, DraftRequestStatus } from "@prisma/client";
import { toBusinessClock, toBusinessRangeEnd } from "../../lib/businessDate";
import prisma from "../../db/prisma";
import { isPresenceActive } from "../users/service";
import type {
  AcceptDraftRequestInput,
  CreateDraftRequestInput,
  ResolveAcceptedDraftRequestInput,
  UpdateDraftRequestInput,
} from "./validation";

type Actor = { id: string; role: string };
type DraftItemInput = CreateDraftRequestInput["items"][number];

const ACTIVE_DRAFT_STATUSES: DraftRequestStatus[] = [
  "PENDING",
  "MODIFIED",
];
const CASHIER_ACTIONABLE_STATUSES: DraftRequestStatus[] = [
  ...ACTIVE_DRAFT_STATUSES,
  "ACCEPTED",
  "PARTIALLY_ACCEPTED",
];
const OPEN_DRAFT_STATUSES: DraftRequestStatus[] = [
  ...CASHIER_ACTIONABLE_STATUSES,
];

const DRAFT_STATUSES = Object.values(DraftRequestStatus);

export type DraftDeliveryState =
  | "QUEUED"
  | "VIEWED"
  | "NEEDS_REASSIGNMENT"
  | "CLOSED";

export const draftRequestInclude = {
  customer: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  assignedCashier: { select: { id: true, name: true, role: true, isActive: true } },
  acceptedBy: { select: { id: true, name: true, role: true } },
  cancelledBy: { select: { id: true, name: true, role: true } },
  completedInvoice: { select: { id: true, invoiceNo: true, netTotal: true } },
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          retailPrice: true,
          wholesalePrice: true,
          stock: true,
          reservedStock: true,
          saleUnit: true,
          allowFractionalQty: true,
          quantityStep: true,
          isActive: true,
          brand: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { id: "asc" },
  },
} as const;

const draftRequestListSelect = {
  id: true,
  requestNo: true,
  status: true,
  customerName: true,
  customerPhone: true,
  customerId: true,
  notes: true,
  createdById: true,
  assignedCashierId: true,
  completedInvoiceId: true,
  expiresAt: true,
  firstViewedAt: true,
  queuedOfflineAt: true,
  acceptedAt: true,
  cancelledAt: true,
  cancelledById: true,
  cancellationReason: true,
  modifiedAt: true,
  createdAt: true,
  customer: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  assignedCashier: { select: { id: true, name: true, role: true, isActive: true } },
  acceptedBy: { select: { id: true, name: true, role: true } },
  cancelledBy: { select: { id: true, name: true, role: true } },
  completedInvoice: { select: { id: true, invoiceNo: true, netTotal: true } },
  _count: { select: { items: true } },
  items: {
    select: {
      id: true,
      productId: true,
      qty: true,
      reviewStatus: true,
      acceptedQty: true,
      rejectionReason: true,
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          retailPrice: true,
          saleUnit: true,
        },
      },
    },
    orderBy: { id: "asc" },
  },
} as const;

function normalizeOptionalText(value?: string | null) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function getBusinessDayQueueExpiry(now: Date = new Date()) {
  const businessClock = toBusinessClock(now);
  const businessDate = new Date(
    Date.UTC(
      businessClock.getUTCFullYear(),
      businessClock.getUTCMonth(),
      businessClock.getUTCDate(),
    ),
  );
  return toBusinessRangeEnd(businessDate);
}

export function getDraftDeliveryState(request: {
  status: DraftRequestStatus | string;
  firstViewedAt?: Date | string | null;
  assignedCashier?: { isActive?: boolean | null } | null;
}): DraftDeliveryState {
  if (!ACTIVE_DRAFT_STATUSES.includes(request.status as DraftRequestStatus)) {
    return "CLOSED";
  }
  if (request.assignedCashier && request.assignedCashier.isActive === false) {
    return "NEEDS_REASSIGNMENT";
  }
  return request.firstViewedAt ? "VIEWED" : "QUEUED";
}

function withDeliveryState<T extends {
  status: DraftRequestStatus | string;
  firstViewedAt?: Date | string | null;
  assignedCashier?: { isActive?: boolean | null } | null;
}>(request: T) {
  return {
    ...request,
    deliveryState: getDraftDeliveryState(request),
  };
}

function normalizePositiveQuantity(value: number, label: string) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return Math.round(normalized * 1000) / 1000;
}

function isQuantityStepAligned(qty: number, step?: number | null) {
  const normalizedStep = Number(step || 1);
  if (!Number.isFinite(normalizedStep) || normalizedStep <= 0) return true;
  const ratio = qty / normalizedStep;
  return Math.abs(ratio - Math.round(ratio)) < 0.000001;
}

export function normalizeDraftItems(items: DraftItemInput[]) {
  const merged = new Map<string, { productId: string; qty: number; note: string | null }>();

  for (const item of items || []) {
    const productId = String(item.productId || "").trim();
    const qty = normalizePositiveQuantity(item.qty, "Quantity");
    const note = normalizeOptionalText(item.note);

    if (!productId) {
      throw new Error("Product is required.");
    }

    const existing = merged.get(productId);
    merged.set(productId, {
      productId,
      qty: (existing?.qty || 0) + qty,
      note: existing?.note || note,
    });
  }

  const normalized = Array.from(merged.values()).map((item) => ({
    ...item,
    qty: Math.round(item.qty * 1000) / 1000,
  }));

  if (normalized.length === 0) {
    throw new Error("Add at least one product.");
  }

  return normalized;
}

export function buildDraftRequestWhereForActor(
  actor: Actor,
  filters: { status?: string; scope?: string } = {},
) {
  const normalizedStatus = String(filters.status || "").trim().toUpperCase();
  const statusFilter =
    normalizedStatus === "OPEN"
      ? { in: OPEN_DRAFT_STATUSES }
      : normalizedStatus === "ACTIVE"
      ? { in: ACTIVE_DRAFT_STATUSES }
      : normalizedStatus === "ACTIONABLE"
        ? { in: CASHIER_ACTIONABLE_STATUSES }
      : DRAFT_STATUSES.includes(normalizedStatus as DraftRequestStatus)
        ? (normalizedStatus as DraftRequestStatus)
        : undefined;
  const scope = String(filters.scope || "").trim().toLowerCase();
  const base: any = statusFilter ? { status: statusFilter } : {};

  if (actor.role === "ADMIN" || actor.role === "MANAGER") {
    return base;
  }

  if (actor.role === "STAFF") {
    return { ...base, createdById: actor.id };
  }

  if (actor.role === "CASHIER") {
    if (scope === "unassigned") {
      return { ...base, assignedCashierId: null };
    }
    return {
      ...base,
      OR: [{ assignedCashierId: actor.id }, { assignedCashierId: null }],
    };
  }

  return { ...base, id: "__denied__" };
}

export function canActorReadDraftRequest(actor: Actor, request: {
  createdById: string;
  assignedCashierId?: string | null;
}) {
  if (actor.role === "ADMIN" || actor.role === "MANAGER") return true;
  if (actor.role === "STAFF") return request.createdById === actor.id;
  if (actor.role === "CASHIER") {
    return !request.assignedCashierId || request.assignedCashierId === actor.id;
  }
  return false;
}

function assertActiveDraftStatus(status: DraftRequestStatus, action: string) {
  if (!ACTIVE_DRAFT_STATUSES.includes(status)) {
    throw new Error(`Only pending draft requests can be ${action}.`);
  }
}

async function expireDraftRequestIfDue(
  id: string,
  now: Date = new Date(),
) {
  const result = await prisma.billingDraftRequest.updateMany({
    where: {
      id,
      status: { in: ACTIVE_DRAFT_STATUSES },
      expiresAt: { not: null, lte: now },
    },
    data: {
      status: "EXPIRED",
      modifiedAt: now,
    },
  });
  return result.count > 0;
}

function assertProductQuantityAllowed(product: any, qty: number) {
  if (!product.isActive) {
    throw new Error(`"${product.name}" is inactive and cannot be requested.`);
  }
  if (!product.allowFractionalQty && !Number.isInteger(qty)) {
    throw new Error(`Quantity for "${product.name}" must be a whole number.`);
  }
  if (!isQuantityStepAligned(qty, product.quantityStep)) {
    throw new Error(
      `Quantity for "${product.name}" must use steps of ${product.quantityStep || 1}.`,
    );
  }
}

async function assertAssignedCashier(tx: any, cashierId?: string | null) {
  if (!cashierId) return null;

  const cashier = await tx.user.findUnique({
    where: { id: cashierId },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      lastPresenceAt: true,
    },
  });

  if (!cashier || cashier.role !== "CASHIER" || !cashier.isActive) {
    throw new Error("Select an active cashier for this draft request.");
  }

  return cashier;
}

async function assertCustomer(tx: any, customerId?: string | null) {
  if (!customerId) return null;

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, phone: true, isActive: true },
  });

  if (!customer || !customer.isActive) {
    throw new Error("Selected customer is not active.");
  }

  return customer;
}

async function buildDraftItemCreates(tx: any, rawItems: DraftItemInput[]) {
  const items = normalizeDraftItems(rawItems);
  const products = await tx.product.findMany({
    where: { id: { in: items.map((item) => item.productId) } },
    select: {
      id: true,
      name: true,
      isActive: true,
      allowFractionalQty: true,
      quantityStep: true,
    },
  });
  const productsById = new Map(products.map((product: any) => [product.id, product]));

  for (const item of items) {
    const product = productsById.get(item.productId);
    if (!product) {
      throw new Error("One or more requested products were not found.");
    }
    assertProductQuantityAllowed(product, item.qty);
  }

  return items.map((item) => ({
    productId: item.productId,
    qty: item.qty,
    note: item.note,
  }));
}

async function getDraftRequestExpiry(tx: any, now: Date = new Date()) {
  const settings = await tx.businessSettings.findUnique({
    where: { id: 1 },
    select: { draftRequestExpiryMinutes: true },
  });
  const minutes = Math.max(1, Number(settings?.draftRequestExpiryMinutes || 30));
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function buildDeliveryTiming(
  tx: any,
  assignedCashier: { lastPresenceAt?: Date | string | null } | null,
  now: Date = new Date(),
) {
  if (assignedCashier && !isPresenceActive(assignedCashier.lastPresenceAt, now)) {
    return {
      queuedOfflineAt: now,
      firstViewedAt: null,
      expiresAt: getBusinessDayQueueExpiry(now),
    };
  }

  return {
    queuedOfflineAt: null,
    firstViewedAt: null,
    expiresAt: await getDraftRequestExpiry(tx, now),
  };
}

async function generateDraftRequestNo(tx: any) {
  const now = toBusinessClock(new Date());
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");
  const prefix = `DR-${dateStr}-`;

  const latest = await tx.billingDraftRequest.findFirst({
    where: { requestNo: { startsWith: prefix } },
    orderBy: { requestNo: "desc" },
    select: { requestNo: true },
  });

  let initialSequence = 1;
  if (latest?.requestNo) {
    const parsed = parseInt(latest.requestNo.slice(prefix.length), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      initialSequence = parsed + 1;
    }
  }

  const counter = await tx.draftRequestSequence.upsert({
    where: { businessDate: dateStr },
    create: { businessDate: dateStr, lastNumber: initialSequence },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return `${prefix}${String(counter.lastNumber).padStart(4, "0")}`;
}

async function findSystemAuditActorId() {
  const actor = await prisma.user.findFirst({
    where: {
      role: { in: ["ADMIN", "MANAGER"] },
      isActive: true,
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return actor?.id || null;
}

export async function listDraftRequests(actor: Actor, filters: {
  status?: string;
  scope?: string;
  page?: number;
  pageSize?: number;
  mode?: string;
} = {}) {
  const page = Math.max(1, Math.floor(Number(filters.page || 1)));
  const maxPageSize = actor.role === "ADMIN" || actor.role === "MANAGER" ? 150 : 50;
  const pageSize = Math.min(
    maxPageSize,
    Math.max(1, Math.floor(Number(filters.pageSize || maxPageSize))),
  );
  const where = buildDraftRequestWhereForActor(actor, filters);
  const useListMode = String(filters.mode || "").trim().toLowerCase() === "list";

  const [requests, total] = await prisma.$transaction([
    prisma.billingDraftRequest.findMany({
      where,
      ...(useListMode
        ? { select: draftRequestListSelect }
        : { include: draftRequestInclude }),
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.billingDraftRequest.count({ where }),
  ]);

  const mapped = useListMode
    ? requests.map((request: any) => {
        const items = Array.isArray(request.items) ? request.items : [];
        const totalQty = items.reduce(
          (sum: number, item: any) => sum + Number(item.acceptedQty ?? item.qty ?? 0),
          0,
        );
        const estimatedTotal = items.reduce((sum: number, item: any) => {
          const qty = Number(item.acceptedQty ?? item.qty ?? 0);
          const price = Number(item.product?.retailPrice || 0);
          return sum + qty * price;
        }, 0);
        return withDeliveryState({
          ...request,
          itemCount: request._count?.items ?? items.length,
          totalQty,
          estimatedTotal,
        });
      })
    : requests.map((request: any) => withDeliveryState(request));

  return {
    requests: mapped,
    total,
    page,
    pageSize,
  };
}

export async function getDraftRequest(id: string, actor: Actor) {
  const request = await prisma.billingDraftRequest.findUnique({
    where: { id: String(id || "").trim() },
    include: draftRequestInclude,
  });

  if (!request) throw new Error("Draft request not found.");
  if (!canActorReadDraftRequest(actor, request)) {
    const error: any = new Error("You cannot view this draft request.");
    error.statusCode = 403;
    throw error;
  }

  return withDeliveryState(request);
}

export async function createDraftRequest(actor: Actor, input: CreateDraftRequestInput) {
  if (actor.role !== "STAFF") {
    const error: any = new Error("Only staff can create draft requests.");
    error.statusCode = 403;
    throw error;
  }

  return prisma.$transaction(async (tx: any) => {
    const recentDraft = await tx.billingDraftRequest.findFirst({
      where: {
        createdById: actor.id,
        createdAt: { gte: new Date(Date.now() - 5_000) },
        status: { in: ACTIVE_DRAFT_STATUSES },
      },
      select: { requestNo: true },
      orderBy: { createdAt: "desc" },
    });

    if (recentDraft) {
      throw new Error("Please wait a moment before sending another request.");
    }

    const [items, customer, assignedCashier, requestNo] = await Promise.all([
      buildDraftItemCreates(tx, input.items),
      assertCustomer(tx, input.customerId),
      assertAssignedCashier(tx, input.assignedCashierId),
      generateDraftRequestNo(tx),
    ]);
    const deliveryTiming = await buildDeliveryTiming(tx, assignedCashier);

    const request = await tx.billingDraftRequest.create({
      data: {
        requestNo,
        customerId: customer?.id || null,
        customerName:
          normalizeOptionalText(input.customerName) || customer?.name || null,
        customerPhone:
          normalizeOptionalText(input.customerPhone) || customer?.phone || null,
        notes: normalizeOptionalText(input.notes),
        createdById: actor.id,
        assignedCashierId: assignedCashier?.id || null,
        ...deliveryTiming,
        items: { create: items },
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_CREATED",
        entityType: "BillingDraftRequest",
        entityId: request.id,
        meta: {
          requestNo,
          assignedCashierId: request.assignedCashierId,
          itemCount: request.items.length,
          expiresAt: request.expiresAt,
          queuedOfflineAt: request.queuedOfflineAt,
        },
      },
    });

    return withDeliveryState(request);
  });
}

export async function updateDraftRequest(
  id: string,
  actor: Actor,
  input: UpdateDraftRequestInput,
) {
  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!request) throw new Error("Draft request not found.");
    if (request.createdById !== actor.id && actor.role !== "ADMIN" && actor.role !== "MANAGER") {
      const error: any = new Error("Only the creator can edit this draft request.");
      error.statusCode = 403;
      throw error;
    }
    assertActiveDraftStatus(request.status, "edited");

    const customer = await assertCustomer(tx, input.customerId);
    const assignedCashier =
      input.assignedCashierId === undefined
        ? undefined
        : await assertAssignedCashier(tx, input.assignedCashierId);
    const nextAssignedCashierId =
      input.assignedCashierId === undefined
        ? request.assignedCashierId
        : assignedCashier?.id || null;
    const assignmentChanged =
      input.assignedCashierId !== undefined &&
      nextAssignedCashierId !== request.assignedCashierId;
    const deliveryTiming = assignmentChanged
      ? await buildDeliveryTiming(tx, assignedCashier || null)
      : null;
    const nextItems =
      input.items === undefined ? undefined : await buildDraftItemCreates(tx, input.items);

    if (nextItems) {
      await tx.draftRequestItem.deleteMany({ where: { draftRequestId: id } });
    }

    const updated = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        status: "MODIFIED",
        modifiedAt: new Date(),
        ...(input.customerId !== undefined ? { customerId: customer?.id || null } : {}),
        ...(input.customerName !== undefined
          ? { customerName: normalizeOptionalText(input.customerName) || customer?.name || null }
          : {}),
        ...(input.customerPhone !== undefined
          ? { customerPhone: normalizeOptionalText(input.customerPhone) || customer?.phone || null }
          : {}),
        ...(input.notes !== undefined ? { notes: normalizeOptionalText(input.notes) } : {}),
        ...(input.assignedCashierId !== undefined
          ? { assignedCashierId: nextAssignedCashierId }
          : {}),
        ...(deliveryTiming || {}),
        ...(nextItems ? { items: { create: nextItems } } : {}),
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_MODIFIED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: {
          requestNo: updated.requestNo,
          itemCount: updated.items.length,
          assignedCashierId: updated.assignedCashierId,
          assignmentChanged,
          deliveryState: getDraftDeliveryState(updated),
        },
      },
    });

    return withDeliveryState(updated);
  });
}

export async function cancelDraftRequest(id: string, actor: Actor) {
  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({ where: { id } });
    if (!request) throw new Error("Draft request not found.");
    if (request.createdById !== actor.id && actor.role !== "ADMIN" && actor.role !== "MANAGER") {
      const error: any = new Error("Only the creator can cancel this draft request.");
      error.statusCode = 403;
      throw error;
    }
    assertActiveDraftStatus(request.status, "cancelled");

    const cancelled = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        status: "CANCELLED_BY_STAFF",
        modifiedAt: new Date(),
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: "Cancelled by the staff member who created the request.",
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_CANCELLED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: { requestNo: cancelled.requestNo },
      },
    });

    return withDeliveryState(cancelled);
  });
}

export async function resolveAcceptedDraftRequest(
  id: string,
  actor: Actor,
  input: ResolveAcceptedDraftRequestInput,
) {
  const reason = normalizeOptionalText(input.reason);
  if (!reason) throw new Error("Add a reason for resolving this request.");

  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({ where: { id } });
    if (!request) throw new Error("Draft request not found.");
    assertCashierCanReview(actor, request);
    if (request.status !== "ACCEPTED" && request.status !== "PARTIALLY_ACCEPTED") {
      throw new Error("Only accepted draft requests can be returned or cancelled.");
    }

    const now = new Date();
    if (input.action === "RETURN_TO_QUEUE") {
      const deliveryTiming = await buildDeliveryTiming(tx, null, now);
      const updated = await tx.billingDraftRequest.updateMany({
        where: {
          id,
          status: { in: ["ACCEPTED", "PARTIALLY_ACCEPTED"] },
        },
        data: {
          status: "MODIFIED",
          assignedCashierId: null,
          acceptedById: null,
          acceptedAt: null,
          modifiedAt: now,
          cancelledAt: null,
          cancelledById: null,
          cancellationReason: null,
          ...deliveryTiming,
        },
      });
      if (updated.count !== 1) {
        throw new Error("This request changed while you were resolving it. Refresh and try again.");
      }
      await tx.draftRequestItem.updateMany({
        where: { draftRequestId: id },
        data: {
          reviewStatus: "PENDING",
          acceptedQty: null,
          rejectionReason: null,
          reviewedAt: null,
        },
      });
      const returned = await tx.billingDraftRequest.findUnique({
        where: { id },
        include: draftRequestInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "DRAFT_REQUEST_RETURNED_TO_QUEUE",
          entityType: "BillingDraftRequest",
          entityId: id,
          meta: { requestNo: request.requestNo, reason },
        },
      });
      return withDeliveryState(returned!);
    }

    const updated = await tx.billingDraftRequest.updateMany({
      where: {
        id,
        status: { in: ["ACCEPTED", "PARTIALLY_ACCEPTED"] },
      },
      data: {
        status: "CANCELLED_BY_CASHIER",
        modifiedAt: now,
        cancelledAt: now,
        cancelledById: actor.id,
        cancellationReason: reason,
      },
    });
    if (updated.count !== 1) {
      throw new Error("This request changed while you were resolving it. Refresh and try again.");
    }
    const cancelled = await tx.billingDraftRequest.findUnique({
      where: { id },
      include: draftRequestInclude,
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_CANCELLED_BY_CASHIER",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: { requestNo: request.requestNo, reason },
      },
    });
    return withDeliveryState(cancelled!);
  });
}

function assertCashierCanReview(actor: Actor, request: {
  assignedCashierId?: string | null;
}) {
  if (actor.role === "ADMIN" || actor.role === "MANAGER") return;
  if (actor.role === "CASHIER" && (!request.assignedCashierId || request.assignedCashierId === actor.id)) {
    return;
  }
  const error: any = new Error("This draft request is assigned to another cashier.");
  error.statusCode = 403;
  throw error;
}

export async function markDraftRequestViewed(id: string, actor: Actor) {
  if (actor.role !== "CASHIER") {
    const error: any = new Error("Only the assigned cashier can mark this request as viewed.");
    error.statusCode = 403;
    throw error;
  }

  if (await expireDraftRequestIfDue(id)) {
    throw new Error("This draft request has expired.");
  }

  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({
      where: { id },
      include: draftRequestInclude,
    });
    if (!request) throw new Error("Draft request not found.");
    assertCashierCanReview(actor, request);
    assertActiveDraftStatus(request.status, "viewed");

    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw new Error("This draft request has expired.");
    }

    if (request.firstViewedAt) {
      return withDeliveryState(request);
    }

    const viewedAt = new Date();
    const responseExpiry = request.queuedOfflineAt
      ? await getDraftRequestExpiry(tx, viewedAt)
      : request.expiresAt;
    const viewed = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        firstViewedAt: viewedAt,
        expiresAt: responseExpiry,
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_VIEWED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: {
          requestNo: viewed.requestNo,
          firstViewedAt: viewedAt,
          expiresAt: responseExpiry,
        },
      },
    });

    return withDeliveryState(viewed);
  });
}

export async function acceptDraftRequest(
  id: string,
  actor: Actor,
  input: AcceptDraftRequestInput = {},
) {
  if (await expireDraftRequestIfDue(id)) {
    throw new Error("This draft request has expired.");
  }

  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                name: true,
                isActive: true,
                allowFractionalQty: true,
                quantityStep: true,
              },
            },
          },
        },
      },
    });
    if (!request) throw new Error("Draft request not found.");
    assertCashierCanReview(actor, request);
    assertActiveDraftStatus(request.status, "accepted");

    const decisionByItemId = new Map(
      (input.items || []).map((item) => [String(item.itemId), item]),
    );
    const requestItemIds = new Set(request.items.map((item: any) => item.id));

    for (const itemId of decisionByItemId.keys()) {
      if (!requestItemIds.has(itemId)) {
        throw new Error("One or more reviewed draft items do not belong to this request.");
      }
    }

    let acceptedItemCount = 0;
    let rejectedItemCount = 0;
    let partiallyAcceptedItemCount = 0;
    const reviewedAt = new Date();

    for (const item of request.items) {
      const decision = decisionByItemId.get(item.id);
      const action = decision?.action || "ACCEPT";

      if (action === "REJECT") {
        const reason = normalizeOptionalText(decision?.reason);
        if (!reason) {
          throw new Error("Add a reason for every rejected draft item.");
        }
        rejectedItemCount += 1;
        await tx.draftRequestItem.update({
          where: { id: item.id },
          data: {
            reviewStatus: DraftRequestItemStatus.REJECTED,
            acceptedQty: null,
            rejectionReason: reason,
            reviewedAt,
          },
        });
        continue;
      }

      const acceptedQty = normalizePositiveQuantity(
        Number(decision?.acceptedQty || item.qty),
        "Accepted quantity",
      );
      if (acceptedQty > item.qty) {
        throw new Error("Accepted quantity cannot be greater than requested quantity.");
      }
      assertProductQuantityAllowed(item.product, acceptedQty);
      acceptedItemCount += 1;
      if (acceptedQty < item.qty) partiallyAcceptedItemCount += 1;
      await tx.draftRequestItem.update({
        where: { id: item.id },
        data: {
          reviewStatus: DraftRequestItemStatus.ACCEPTED,
          acceptedQty,
          rejectionReason: null,
          reviewedAt,
        },
      });
    }

    const nextStatus: DraftRequestStatus =
      acceptedItemCount === 0
        ? "REJECTED"
        : rejectedItemCount > 0 || partiallyAcceptedItemCount > 0
          ? "PARTIALLY_ACCEPTED"
          : "ACCEPTED";

    const accepted = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        status: nextStatus,
        acceptedById: actor.id,
        acceptedAt: new Date(),
        ...(actor.role === "CASHIER" && !request.firstViewedAt
          ? { firstViewedAt: reviewedAt }
          : {}),
        modifiedAt: nextStatus === "PARTIALLY_ACCEPTED" || nextStatus === "REJECTED"
          ? new Date()
          : null,
        assignedCashierId:
          request.assignedCashierId || (actor.role === "CASHIER" ? actor.id : null),
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action:
          nextStatus === "REJECTED"
            ? "DRAFT_REQUEST_REJECTED"
            : nextStatus === "PARTIALLY_ACCEPTED"
              ? "DRAFT_REQUEST_PARTIALLY_ACCEPTED"
              : "DRAFT_REQUEST_ACCEPTED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: {
          requestNo: accepted.requestNo,
          status: nextStatus,
          acceptedItemCount,
          rejectedItemCount,
          partiallyAcceptedItemCount,
        },
      },
    });

    return withDeliveryState(accepted);
  });
}

export async function rejectDraftRequest(
  id: string,
  actor: Actor,
  note?: string | null,
) {
  if (await expireDraftRequestIfDue(id)) {
    throw new Error("This draft request has expired.");
  }

  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({ where: { id } });
    if (!request) throw new Error("Draft request not found.");
    assertCashierCanReview(actor, request);
    assertActiveDraftStatus(request.status, "rejected");

    const rejectionNote = normalizeOptionalText(note);
    const rejected = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        modifiedAt: new Date(),
        acceptedById: actor.id,
        acceptedAt: new Date(),
        ...(actor.role === "CASHIER" && !request.firstViewedAt
          ? { firstViewedAt: new Date() }
          : {}),
        ...(rejectionNote
          ? {
              notes: request.notes
                ? `${request.notes}\n\nRejection: ${rejectionNote}`
                : `Rejection: ${rejectionNote}`,
            }
          : {}),
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_REJECTED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: { requestNo: rejected.requestNo, note: rejectionNote },
      },
    });

    return withDeliveryState(rejected);
  });
}

export async function completeDraftRequest(
  id: string,
  actor: Actor,
  invoiceId: string,
) {
  return prisma.$transaction(async (tx: any) => {
    const request = await tx.billingDraftRequest.findUnique({ where: { id } });
    if (!request) throw new Error("Draft request not found.");
    assertCashierCanReview(actor, request);
    if (request.status !== "ACCEPTED" && request.status !== "PARTIALLY_ACCEPTED") {
      throw new Error("Only accepted draft requests can be completed.");
    }

    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, invoiceNo: true, status: true },
    });
    if (!invoice || invoice.status !== "FINALIZED") {
      throw new Error("Completed draft requests must link to a finalized invoice.");
    }

    const completed = await tx.billingDraftRequest.update({
      where: { id },
      data: {
        status: "COMPLETED",
        completedInvoiceId: invoice.id,
        modifiedAt: new Date(),
      },
      include: draftRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DRAFT_REQUEST_COMPLETED",
        entityType: "BillingDraftRequest",
        entityId: id,
        meta: { requestNo: completed.requestNo, invoiceId, invoiceNo: invoice.invoiceNo },
      },
    });

    return withDeliveryState(completed);
  });
}

export async function expireDueDraftRequests(now: Date = new Date()) {
  const dueRequests = await prisma.billingDraftRequest.findMany({
    where: {
      status: { in: ["PENDING", "MODIFIED"] },
      expiresAt: { not: null, lte: now },
    },
    select: {
      id: true,
      requestNo: true,
      createdById: true,
      assignedCashierId: true,
      expiresAt: true,
    },
    take: 250,
  });

  if (dueRequests.length === 0) {
    return { expired: 0, requestNos: [] as string[] };
  }

  const requestIds = dueRequests.map((request) => request.id);
  const updated = await prisma.billingDraftRequest.updateMany({
    where: {
      id: { in: requestIds },
      status: { in: ["PENDING", "MODIFIED"] },
    },
    data: {
      status: "EXPIRED",
      modifiedAt: now,
    },
  });

  const actorId = await findSystemAuditActorId();
  if (actorId && updated.count > 0) {
    await prisma.auditLog.create({
      data: {
        actorId,
        action: "DRAFT_REQUESTS_EXPIRED",
        entityType: "BillingDraftRequest",
        entityId: "draft-request-expiry",
        meta: {
          ranAt: now.toISOString(),
          expiredCount: updated.count,
          requestIds,
          requestNos: dueRequests.map((request) => request.requestNo),
        },
      },
    });
  }

  return {
    expired: updated.count,
    requestNos: dueRequests.map((request) => request.requestNo),
  };
}
