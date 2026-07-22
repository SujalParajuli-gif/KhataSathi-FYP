import type { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import prisma from "../../db/prisma";

const BUSINESS_SETTINGS_ID = 1; // there is only one settings row in the database, always with ID 1
const OVERRIDE_PIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const OVERRIDE_PIN_MAX_FAILURES = 5;
const OVERRIDE_PIN_LOCKOUT_MS = 10 * 60 * 1000;
const BUSINESS_SETTINGS_CACHE_TTL_MS = 30_000;

// this type allows functions to accept either the main Prisma client or a transaction client
// so the same function can be used both inside and outside of database transactions
type PrismaLike = PrismaClient | Prisma.TransactionClient;

// defining the shape of the business settings object returned from the database
export type BusinessSettingsSnapshot = {
  id: number;
  defaultLowStockThreshold: number;
  defaultWholesaleQtyThreshold: number;
  loyaltyDiscountPercent: number;
  returnWindowDays: number;
  parkedBillExpiryHours: number;
  draftRequestExpiryMinutes: number;
  createdAt?: Date;
  updatedAt?: Date;
};

export type OverrideAction =
  | "PRICE_OVERRIDE"
  | "MANUAL_DISCOUNT"
  | "PAYMENT_VOID";

type OverridePolicyRow = BusinessSettingsSnapshot & {
  overridePinHash?: string | null;
  overridePinUpdatedAt?: Date | null;
};

let businessSettingsCache:
  | { value: BusinessSettingsSnapshot; expiresAt: number }
  | null = null;

// defining the shape of product threshold fields used when resolving which threshold to apply
type ProductThresholdShape = {
  wholesaleQtyThreshold: number;
  lowStockThreshold: number;
  usesDefaultWholesaleQtyThreshold?: boolean | null;
  usesDefaultLowStockThreshold?: boolean | null;
};

// normalizing a number with a minimum value
// if the input is not a valid number, we fall back to the provided default
function normalizeDecimalNumber(
  value: number | undefined,
  fallback: number,
  min: number,
) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.max(min, normalized);
}

// clamping a percentage value between 0 and 100
// if the input is invalid, we use the fallback value
function clampPercent(value: number | undefined, fallback: number) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  if (normalized < 0) return 0;
  if (normalized > 100) return 100;
  return normalized;
}

// normalizing all business settings input values before saving to the database
// each field has a hardcoded default value that is used when the input is missing or invalid:
// - low stock threshold defaults to 5
// - wholesale qty threshold defaults to 15 (minimum 1 because 0 does not make sense for quantity)
// - loyalty discount percent defaults to 2%
export function normalizeBusinessSettingsInput(data: {
  defaultLowStockThreshold?: number;
  defaultWholesaleQtyThreshold?: number;
  loyaltyDiscountPercent?: number;
  returnWindowDays?: number;
  parkedBillExpiryHours?: number;
  draftRequestExpiryMinutes?: number;
}) {
  return {
    defaultLowStockThreshold: normalizeDecimalNumber(
      data.defaultLowStockThreshold,
      5,
      0,
    ),
    defaultWholesaleQtyThreshold: normalizeDecimalNumber(
      data.defaultWholesaleQtyThreshold,
      15,
      1,
    ),
    loyaltyDiscountPercent: clampPercent(data.loyaltyDiscountPercent, 2),
    returnWindowDays: Math.floor(
      normalizeDecimalNumber(data.returnWindowDays, 7, 0),
    ),
    parkedBillExpiryHours: Math.floor(
      normalizeDecimalNumber(data.parkedBillExpiryHours, 8, 1),
    ),
    draftRequestExpiryMinutes: Math.floor(
      normalizeDecimalNumber(data.draftRequestExpiryMinutes, 30, 1),
    ),
  };
}

// fetching the business settings from the database
// we use upsert so that if the settings row does not exist yet (first time setup), it automatically creates one with defaults
// this way we never have to worry about the settings being missing
export async function getBusinessSettings(
  client: PrismaLike = prisma,
): Promise<BusinessSettingsSnapshot> {
  if (client === prisma && businessSettingsCache && businessSettingsCache.expiresAt > Date.now()) {
    return businessSettingsCache.value;
  }

  const settings = await client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {}, // no changes if it already exists — just return the current data
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}), // creating with default values
    },
  });

  const { overridePinHash: _hash, overridePinUpdatedAt: _pinDate, ...safe } =
    settings as OverridePolicyRow;
  if (client === prisma) {
    businessSettingsCache = {
      value: safe,
      expiresAt: Date.now() + BUSINESS_SETTINGS_CACHE_TTL_MS,
    };
  }
  return safe;
}

// updating the business settings with new values
// we use upsert again so it works even if the settings row was never created before
export async function updateBusinessSettings(
  data: {
    defaultLowStockThreshold?: number;
    defaultWholesaleQtyThreshold?: number;
    loyaltyDiscountPercent?: number;
    returnWindowDays?: number;
    parkedBillExpiryHours?: number;
    draftRequestExpiryMinutes?: number;
  },
  client: PrismaLike = prisma,
) {
  const normalized = normalizeBusinessSettingsInput(data); // normalizing input before saving

  const settings = await client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: normalized,
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalized,
    },
  });

  const { overridePinHash: _hash, overridePinUpdatedAt: _pinDate, ...safe } =
    settings as OverridePolicyRow;
  if (client === prisma) {
    businessSettingsCache = {
      value: safe,
      expiresAt: Date.now() + BUSINESS_SETTINGS_CACHE_TTL_MS,
    };
  } else {
    businessSettingsCache = null;
  }
  return safe;
}

function validateOverridePin(pin: unknown) {
  const normalized = String(pin ?? "").trim();
  if (!/^\d{4}$/.test(normalized)) {
    throw new Error("Override PIN must be exactly 4 digits");
  }
  return normalized;
}

export async function getOverridePolicy() {
  const settings = (await prisma.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {},
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}),
    },
  })) as OverridePolicyRow;

  return {
    pinConfigured: Boolean(settings.overridePinHash),
    pinUpdatedAt: settings.overridePinUpdatedAt || null,
  };
}

export async function updateOverridePin(pin: unknown, updatedById: string) {
  const normalizedPin = validateOverridePin(pin);
  const pinHash = await bcrypt.hash(normalizedPin, 10);
  const now = new Date();
  const updated = await prisma.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {
      overridePinHash: pinHash,
      overridePinUpdatedAt: now,
    },
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}),
      overridePinHash: pinHash,
      overridePinUpdatedAt: now,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: updatedById,
      action: "OVERRIDE_PIN_UPDATED",
      entityType: "BusinessSettings",
      entityId: String(BUSINESS_SETTINGS_ID),
      meta: {
        pinConfigured: true,
        pinUpdatedAt: updated.overridePinUpdatedAt,
      },
    },
  }).catch(() => undefined);

  return {
    pinConfigured: true,
    pinUpdatedAt: updated.overridePinUpdatedAt,
  };
}

function getPrivilegeFieldForAction(action: OverrideAction) {
  if (action === "PRICE_OVERRIDE") return "canOverrideBillingPrice";
  if (action === "MANUAL_DISCOUNT") return "canApplyManualDiscount";
  return "canVoidPayment";
}

function getOverrideActionLabel(action: OverrideAction) {
  if (action === "PRICE_OVERRIDE") return "price override";
  if (action === "MANUAL_DISCOUNT") return "manual discount";
  return "payment void";
}

export function buildOverridePinLockedMessage(lockedUntil: Date) {
  const remainingMs = Math.max(0, lockedUntil.getTime() - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Too many invalid override PIN attempts. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}.`;
}

async function getActiveOverridePinLock(userId: string) {
  return prisma.overridePinAttempt.findFirst({
    where: {
      userId,
      success: false,
      lockedUntil: { gt: new Date() },
    },
    orderBy: { lockedUntil: "desc" },
  });
}

async function recordOverridePinAttempt(data: {
  userId: string;
  action: OverrideAction;
  success: boolean;
  failureReason?: string;
  actorName?: string | null;
}) {
  if (data.success) {
    await prisma.overridePinAttempt.create({
      data: {
        userId: data.userId,
        action: data.action,
        success: true,
      },
    });
    return null;
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - OVERRIDE_PIN_FAILURE_WINDOW_MS);
  const recentFailureCount = await prisma.overridePinAttempt.count({
    where: {
      userId: data.userId,
      success: false,
      createdAt: { gte: windowStart },
    },
  });
  const nextFailureCount = recentFailureCount + 1;
  const lockedUntil =
    nextFailureCount >= OVERRIDE_PIN_MAX_FAILURES
      ? new Date(now.getTime() + OVERRIDE_PIN_LOCKOUT_MS)
      : null;

  const attempt = await prisma.overridePinAttempt.create({
    data: {
      userId: data.userId,
      action: data.action,
      success: false,
      failureReason: data.failureReason?.slice(0, 180) || "INVALID_PIN",
      lockedUntil,
    },
  });

  if (lockedUntil) {
    await prisma.auditLog.create({
      data: {
        actorId: data.userId,
        action: "OVERRIDE_PIN_LOCKED",
        entityType: "OverridePinAttempt",
        entityId: attempt.id,
        meta: {
          actorName: data.actorName || null,
          overrideAction: data.action,
          actionLabel: getOverrideActionLabel(data.action),
          failedAttempts: nextFailureCount,
          windowMinutes: Math.round(OVERRIDE_PIN_FAILURE_WINDOW_MS / 60_000),
          lockMinutes: Math.round(OVERRIDE_PIN_LOCKOUT_MS / 60_000),
          lockedUntil,
        },
      },
    }).catch(() => undefined);
  }

  return lockedUntil;
}

export async function assertCashierOverrideAllowed(
  userId: string,
  action: OverrideAction,
  pin: unknown,
  client: PrismaLike = prisma,
) {
  const actor = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      cashierPrivilege: true,
    },
  });

  if (!actor || !actor.isActive) {
    throw new Error("User is not active");
  }

  if (actor.role === "ADMIN" || actor.role === "MANAGER") {
    return actor;
  }

  if (actor.role !== "CASHIER") {
    throw new Error("Only admin, manager, or cashier users can perform this action");
  }

  const privilege = actor.cashierPrivilege || normalizeCashierPrivilegeInput({});
  const privilegeField = getPrivilegeFieldForAction(action);
  if (!Boolean((privilege as any)[privilegeField])) {
    throw new Error(
      `This cashier is not authorized for ${getOverrideActionLabel(action)}.`,
    );
  }

  const settings = (await client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {},
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}),
    },
  })) as OverridePolicyRow;

  if (!settings.overridePinHash) {
    throw new Error("Override PIN has not been configured by admin.");
  }

  const activeLock = await getActiveOverridePinLock(userId);
  if (activeLock?.lockedUntil) {
    throw new Error(buildOverridePinLockedMessage(activeLock.lockedUntil));
  }

  let normalizedPin = "";
  try {
    normalizedPin = validateOverridePin(pin);
  } catch (error: any) {
    const lockedUntil = await recordOverridePinAttempt({
      userId,
      action,
      success: false,
      failureReason: "INVALID_FORMAT",
      actorName: actor.name,
    });
    if (lockedUntil) {
      throw new Error(buildOverridePinLockedMessage(lockedUntil));
    }
    throw error;
  }

  const valid = await bcrypt.compare(normalizedPin, settings.overridePinHash);
  if (!valid) {
    const lockedUntil = await recordOverridePinAttempt({
      userId,
      action,
      success: false,
      failureReason: "INVALID_PIN",
      actorName: actor.name,
    });
    if (lockedUntil) {
      throw new Error(buildOverridePinLockedMessage(lockedUntil));
    }
    throw new Error("Invalid override PIN.");
  }

  await recordOverridePinAttempt({
    userId,
    action,
    success: true,
    actorName: actor.name,
  });

  return actor;
}

// resolving which wholesale quantity threshold to use for a specific product
// products can either use their own custom threshold or fall back to the business-wide default
// the usesDefaultWholesaleQtyThreshold flag on the product controls which one is used
export function resolveWholesaleQtyThreshold(
  product: Pick<
    ProductThresholdShape,
    "wholesaleQtyThreshold" | "usesDefaultWholesaleQtyThreshold"
  >,
  settings: Pick<BusinessSettingsSnapshot, "defaultWholesaleQtyThreshold">,
) {
  return product.usesDefaultWholesaleQtyThreshold
    ? settings.defaultWholesaleQtyThreshold // use the global default
    : normalizeDecimalNumber(
        product.wholesaleQtyThreshold,
        settings.defaultWholesaleQtyThreshold,
        1,
      ); // use the product-specific threshold, falling back to default if invalid
}

// resolving which low stock threshold to use for a specific product
// same pattern as wholesale — either uses its own threshold or the global default
export function resolveLowStockThreshold(
  product: Pick<
    ProductThresholdShape,
    "lowStockThreshold" | "usesDefaultLowStockThreshold"
  >,
  settings: Pick<BusinessSettingsSnapshot, "defaultLowStockThreshold">,
) {
  return product.usesDefaultLowStockThreshold
    ? settings.defaultLowStockThreshold
    : normalizeDecimalNumber(
        product.lowStockThreshold,
        settings.defaultLowStockThreshold,
        0,
      );
}

// applying both resolved thresholds to a product object
// we use this when returning product data to the frontend so the product always has effective threshold values
// even if the product itself was set to use the business defaults
export function applyBusinessThresholds<T extends ProductThresholdShape>(
  product: T,
  settings: BusinessSettingsSnapshot,
) {
  return {
    ...product,
    wholesaleQtyThreshold: resolveWholesaleQtyThreshold(product, settings),
    lowStockThreshold: resolveLowStockThreshold(product, settings),
  };
}

export type CashierPrivilegeInput = {
  canCreateDiscountedCustomer?: boolean;
  maxCustomerLoyaltyPercent?: number;
  maxCustomerWholesalePercent?: number;
  canRequestCustomerDiscount?: boolean;
  canOverrideBillingPrice?: boolean;
  canApplyManualDiscount?: boolean;
  canVoidPayment?: boolean;
  canViewWholesalePrice?: boolean;
};

function normalizePrivilegePercent(value: unknown, fallback: number) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  if (normalized < 0) return 0;
  if (normalized > 100) return 100;
  return normalized;
}

function getDefaultPrivilegeInputForRole(role?: string | null): CashierPrivilegeInput {
  if (role === "MANAGER") {
    return {
      canCreateDiscountedCustomer: true,
      canRequestCustomerDiscount: true,
      canOverrideBillingPrice: true,
      canApplyManualDiscount: true,
      canVoidPayment: true,
      canViewWholesalePrice: true,
      maxCustomerLoyaltyPercent: 100,
      maxCustomerWholesalePercent: 100,
    };
  }

  if (role === "STAFF") {
    return {
      canCreateDiscountedCustomer: false,
      canRequestCustomerDiscount: false,
      canOverrideBillingPrice: false,
      canApplyManualDiscount: false,
      canVoidPayment: false,
      canViewWholesalePrice: true,
      maxCustomerLoyaltyPercent: 0,
      maxCustomerWholesalePercent: 0,
    };
  }

  return {};
}

function normalizeCashierPrivilegeInput(data: CashierPrivilegeInput = {}, role?: string | null) {
  const defaults = getDefaultPrivilegeInputForRole(role);
  const merged = { ...defaults, ...data };
  return {
    canCreateDiscountedCustomer: merged.canCreateDiscountedCustomer === true,
    maxCustomerLoyaltyPercent: normalizePrivilegePercent(
      merged.maxCustomerLoyaltyPercent,
      Number(defaults.maxCustomerLoyaltyPercent ?? 5),
    ),
    maxCustomerWholesalePercent: normalizePrivilegePercent(
      merged.maxCustomerWholesalePercent,
      Number(defaults.maxCustomerWholesalePercent ?? 10),
    ),
    canRequestCustomerDiscount: merged.canRequestCustomerDiscount !== false,
    canOverrideBillingPrice: merged.canOverrideBillingPrice === true,
    canApplyManualDiscount: merged.canApplyManualDiscount === true,
    canVoidPayment: merged.canVoidPayment === true,
    canViewWholesalePrice: merged.canViewWholesalePrice !== false,
  };
}

export async function getCashierPrivilege(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, cashierPrivilege: true },
  });

  if (user?.cashierPrivilege) return user.cashierPrivilege;

  return {
    id: "",
    userId,
    ...normalizeCashierPrivilegeInput({}, user?.role),
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function listCashierPrivileges() {
  const cashiers = await prisma.user.findMany({
    where: { role: { in: ["MANAGER", "CASHIER", "STAFF"] } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      cashierPrivilege: true,
    },
  });

  return cashiers.map((cashier) => ({
    ...cashier,
    privilege: cashier.cashierPrivilege || {
      id: "",
      userId: cashier.id,
      ...normalizeCashierPrivilegeInput({}, cashier.role),
      updatedById: null,
      createdAt: null,
      updatedAt: null,
    },
    cashierPrivilege: undefined,
  }));
}

export async function updateCashierPrivilege(
  userId: string,
  data: CashierPrivilegeInput,
  updatedById: string,
) {
  const cashier = await prisma.user.findFirst({
    where: { id: userId, role: { in: ["MANAGER", "CASHIER", "STAFF"] } },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!cashier) {
    throw new Error("User not found");
  }

  const normalized = normalizeCashierPrivilegeInput(data, cashier.role);

  const privilege = await prisma.cashierPrivilege.upsert({
    where: { userId },
    update: { ...normalized, updatedById },
    create: { userId, ...normalized, updatedById },
  });

  await prisma.auditLog.create({
    data: {
      actorId: updatedById,
      action: "CASHIER_PRIVILEGE_UPDATED",
      entityType: "CashierPrivilege",
      entityId: privilege.id,
      meta: {
        cashierId: cashier.id,
        cashierName: cashier.name,
        cashierEmail: cashier.email,
        cashierRole: cashier.role,
        privilege: normalized,
      },
    },
  }).catch(() => undefined);

  return { cashier, privilege };
}
