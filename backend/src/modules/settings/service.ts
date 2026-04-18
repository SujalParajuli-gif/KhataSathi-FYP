import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma";

const BUSINESS_SETTINGS_ID = 1; // there is only one settings row in the database, always with ID 1

// this type allows functions to accept either the main Prisma client or a transaction client
// so the same function can be used both inside and outside of database transactions
type PrismaLike = PrismaClient | Prisma.TransactionClient;

// defining the shape of the business settings object returned from the database
export type BusinessSettingsSnapshot = {
  id: number;
  defaultLowStockThreshold: number;
  defaultWholesaleQtyThreshold: number;
  loyaltyDiscountPercent: number;
  createdAt?: Date;
  updatedAt?: Date;
};

// defining the shape of product threshold fields used when resolving which threshold to apply
type ProductThresholdShape = {
  wholesaleQtyThreshold: number;
  lowStockThreshold: number;
  usesDefaultWholesaleQtyThreshold?: boolean | null;
  usesDefaultLowStockThreshold?: boolean | null;
};

// normalizing a number to a whole number with a minimum value
// if the input is not a valid number, we fall back to the provided default
function normalizeWholeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
) {
  const normalized = Number(value ?? fallback);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.max(min, Math.floor(normalized)); // Math.floor ensures we get a whole number, Math.max ensures minimum
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

// fetching the business settings from the database
// we use upsert so that if the settings row does not exist yet (first time setup), it automatically creates one with defaults
// this way we never have to worry about the settings being missing
export async function getBusinessSettings(
  client: PrismaLike = prisma,
): Promise<BusinessSettingsSnapshot> {
  return client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: {}, // no changes if it already exists — just return the current data
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalizeBusinessSettingsInput({}), // creating with default values
    },
  });
}

// updating the business settings with new values
// we use upsert again so it works even if the settings row was never created before
export async function updateBusinessSettings(
  data: {
    defaultLowStockThreshold?: number;
    defaultWholesaleQtyThreshold?: number;
    loyaltyDiscountPercent?: number;
  },
  client: PrismaLike = prisma,
) {
  const normalized = normalizeBusinessSettingsInput(data); // normalizing input before saving

  return client.businessSettings.upsert({
    where: { id: BUSINESS_SETTINGS_ID },
    update: normalized,
    create: {
      id: BUSINESS_SETTINGS_ID,
      ...normalized,
    },
  });
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
    : normalizeWholeNumber(
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
    : normalizeWholeNumber(
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
