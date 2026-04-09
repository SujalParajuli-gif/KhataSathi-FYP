import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma";

const BUSINESS_SETTINGS_ID = 1;

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type BusinessSettingsSnapshot = {
  id: number;
  defaultLowStockThreshold: number;
  defaultWholesaleQtyThreshold: number;
  loyaltyDiscountPercent: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type ProductThresholdShape = {
  wholesaleQtyThreshold: number;
  lowStockThreshold: number;
  usesDefaultWholesaleQtyThreshold?: boolean | null;
  usesDefaultLowStockThreshold?: boolean | null;
};

function normalizeWholeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.max(min, Math.floor(normalized));
}

function clampPercent(value: number | undefined, fallback: number) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  if (normalized < 0) return 0;
  if (normalized > 100) return 100;
  return normalized;
}

export function normalizeBusinessSettingsInput(data: {
  defaultLowStockThreshold?: number;
  defaultWholesaleQtyThreshold?: number;
  loyaltyDiscountPercent?: number;
}) {
  return {
    defaultLowStockThreshold: normalizeWholeNumber(
      data.defaultLowStockThreshold,
      5,
      0,
    ),
    defaultWholesaleQtyThreshold: normalizeWholeNumber(
      data.defaultWholesaleQtyThreshold,
      15,
      1,
    ),
    loyaltyDiscountPercent: clampPercent(data.loyaltyDiscountPercent, 2),
  };
}

export async function getBusinessSettings(
  client: PrismaLike = prisma,
): Promise<BusinessSettingsSnapshot> {
  return client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {},
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}),
    },
  });
}

export async function updateBusinessSettings(
  data: {
    defaultLowStockThreshold?: number;
    defaultWholesaleQtyThreshold?: number;
    loyaltyDiscountPercent?: number;
  },
  client: PrismaLike = prisma,
) {
  const normalized = normalizeBusinessSettingsInput(data);

  return client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: normalized,
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalized,
    },
  });
}

export function resolveWholesaleQtyThreshold(
  product: Pick<
    ProductThresholdShape,
    "wholesaleQtyThreshold" | "usesDefaultWholesaleQtyThreshold"
  >,
  settings: Pick<BusinessSettingsSnapshot, "defaultWholesaleQtyThreshold">,
) {
  return product.usesDefaultWholesaleQtyThreshold
    ? settings.defaultWholesaleQtyThreshold
    : normalizeWholeNumber(
        product.wholesaleQtyThreshold,
        settings.defaultWholesaleQtyThreshold,
        1,
      );
}

export function resolveLowStockThreshold(
  product: Pick<
    ProductThresholdShape,
    "lowStockThreshold" | "usesDefaultLowStockThreshold"
  >,
  settings: Pick<BusinessSettingsSnapshot, "defaultLowStockThreshold">,
) {
  return product.usesDefaultLowStockThreshold
    ? settings.defaultLowStockThreshold
    : normalizeWholeNumber(
        product.lowStockThreshold,
        settings.defaultLowStockThreshold,
        0,
      );
}

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
