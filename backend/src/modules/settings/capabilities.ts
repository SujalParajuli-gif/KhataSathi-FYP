import type { NextFunction, Request, Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma";
import {
  getBusinessSettings,
  invalidateBusinessSettingsCache,
} from "./service";

export const BUSINESS_MODES = [
  "CATALOG_ONLY",
  "INVENTORY_ONLY",
  "FULL_POS",
] as const;

export type BusinessMode = (typeof BUSINESS_MODES)[number];
export type BusinessCapability = "CATALOG" | "INVENTORY" | "POS" | "STAFF_DRAFT_REQUESTS";

export type BusinessCapabilities = {
  businessMode: BusinessMode;
  catalogEnabled: true;
  inventoryEnabled: boolean;
  posEnabled: boolean;
  staffDraftRequestsEnabled: boolean;
  stockTracked: boolean;
};

export function isBusinessMode(value: unknown): value is BusinessMode {
  return BUSINESS_MODES.includes(String(value) as BusinessMode);
}

export function resolveBusinessCapabilities(settings: {
  businessMode: BusinessMode;
  staffDraftRequestsEnabled: boolean;
}): BusinessCapabilities {
  const inventoryEnabled = settings.businessMode !== "CATALOG_ONLY";
  const posEnabled = settings.businessMode === "FULL_POS";

  return {
    businessMode: settings.businessMode,
    catalogEnabled: true,
    inventoryEnabled,
    posEnabled,
    staffDraftRequestsEnabled:
      posEnabled && Boolean(settings.staffDraftRequestsEnabled),
    stockTracked: inventoryEnabled,
  };
}

export async function getBusinessCapabilities() {
  return resolveBusinessCapabilities(await getBusinessSettings());
}

function hasCapability(
  capabilities: BusinessCapabilities,
  capability: BusinessCapability,
) {
  if (capability === "CATALOG") return capabilities.catalogEnabled;
  if (capability === "INVENTORY") return capabilities.inventoryEnabled;
  if (capability === "POS") return capabilities.posEnabled;
  return capabilities.staffDraftRequestsEnabled;
}

type BusinessCapabilityResolver = () => Promise<BusinessCapabilities>;

export function requireBusinessCapability(
  capability: BusinessCapability,
  resolveCapabilities: BusinessCapabilityResolver = getBusinessCapabilities,
) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const capabilities = await resolveCapabilities();
      if (!hasCapability(capabilities, capability)) {
        res.status(403).json({
          code: "FEATURE_DISABLED",
          error: `${capability.replaceAll("_", " ")} is disabled in ${capabilities.businessMode} mode`,
          capability,
          businessMode: capabilities.businessMode,
        });
        return;
      }
      res.locals.businessCapabilities = capabilities;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const ACTIVE_DRAFT_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "MODIFIED",
  "PARTIALLY_ACCEPTED",
] as const;

export type BusinessModePreflight = {
  currentMode: BusinessMode;
  targetMode: BusinessMode;
  allowed: boolean;
  blockers: Array<{ key: string; count: number; message: string }>;
};

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export async function getBusinessModePreflight(
  targetMode: BusinessMode,
  options?: { staffDraftRequestsEnabled?: boolean },
  client: PrismaLike = prisma,
): Promise<BusinessModePreflight> {
  const current = await getBusinessSettings(client);
  const disablesPos = targetMode !== "FULL_POS";
  const disablesDraftRequests =
    disablesPos ||
    (targetMode === "FULL_POS" &&
      current.staffDraftRequestsEnabled &&
      options?.staffDraftRequestsEnabled === false);
  if (!disablesPos && !disablesDraftRequests) {
    return {
      currentMode: current.businessMode,
      targetMode,
      allowed: true,
      blockers: [],
    };
  }

  const [openDrawers, draftInvoices, pendingPayments, pendingReturns, activeDraftRequests] =
    await Promise.all([
      client.cashDrawer.count({ where: { status: "OPEN" } }),
      client.invoice.count({ where: { status: "DRAFT", deletedAt: null } }),
      client.payment.count({ where: { status: "PENDING", voidedAt: null } }),
      client.returnRequest.count({ where: { status: "PENDING" } }),
      client.billingDraftRequest.count({
        where: { status: { in: [...ACTIVE_DRAFT_STATUSES] } },
      }),
    ]);

  const blockers = [
    {
      key: "OPEN_CASH_DRAWERS",
      count: openDrawers,
      message: "Close every open cash drawer before turning off POS.",
    },
    {
      key: "DRAFT_INVOICES",
      count: draftInvoices,
      message: "Finalize or cancel every draft invoice before turning off POS.",
    },
    {
      key: "PENDING_PAYMENTS",
      count: pendingPayments,
      message: "Resolve every pending payment before turning off POS.",
    },
    {
      key: "PENDING_RETURNS",
      count: pendingReturns,
      message: "Resolve every pending return before turning off POS.",
    },
    {
      key: "ACTIVE_STAFF_DRAFT_REQUESTS",
      count: activeDraftRequests,
      message: "Complete or cancel active staff billing requests before turning off POS.",
    },
  ].filter((blocker) => {
    if (blocker.count <= 0) return false;
    if (blocker.key === "ACTIVE_STAFF_DRAFT_REQUESTS") {
      return disablesDraftRequests;
    }
    return disablesPos;
  });

  return {
    currentMode: current.businessMode,
    targetMode,
    allowed: blockers.length === 0,
    blockers,
  };
}

export async function updateBusinessMode(input: {
  targetMode: BusinessMode;
  reason: string;
  actorId: string;
  staffDraftRequestsEnabled?: boolean;
}) {
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw Object.assign(new Error("A reason of at least 5 characters is required"), {
      statusCode: 400,
    });
  }

  const requestedDraftPreference =
    input.targetMode === "FULL_POS"
      ? input.staffDraftRequestsEnabled
      : false;
  const preflight = await getBusinessModePreflight(input.targetMode, {
    staffDraftRequestsEnabled: requestedDraftPreference,
  });
  if (!preflight.allowed) {
    throw Object.assign(
      new Error("Resolve the listed active work before changing business mode"),
      { statusCode: 409, preflight },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const lockedPreflight = await getBusinessModePreflight(
      input.targetMode,
      { staffDraftRequestsEnabled: requestedDraftPreference },
      tx,
    );
    if (!lockedPreflight.allowed) {
      throw Object.assign(
        new Error("Active work changed during the safety check. Review the blockers and try again"),
        { statusCode: 409, preflight: lockedPreflight },
      );
    }
    const currentSettings = await getBusinessSettings(tx);
    const staffDraftRequestsEnabled =
      input.targetMode === "FULL_POS"
        ? input.staffDraftRequestsEnabled ??
          currentSettings.staffDraftRequestsEnabled
        : false;
    const settings = await tx.businessSettings.upsert({
      where: { id: 1 },
      update: {
        businessMode: input.targetMode,
        staffDraftRequestsEnabled,
      },
      create: {
        id: 1,
        businessMode: input.targetMode,
        staffDraftRequestsEnabled,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "BUSINESS_MODE_CHANGED",
        entityType: "BusinessSettings",
        entityId: "1",
        meta: {
          previousMode: lockedPreflight.currentMode,
          preflightAllowed: lockedPreflight.allowed,
          businessMode: settings.businessMode,
          staffDraftRequestsEnabled: settings.staffDraftRequestsEnabled,
          reason,
        },
      },
    });
    return settings;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  invalidateBusinessSettingsCache();
  return {
    settings: updated,
    capabilities: resolveBusinessCapabilities(updated),
  };
}
