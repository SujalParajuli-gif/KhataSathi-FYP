import fs from "fs/promises";
import crypto from "crypto";
import prisma from "../db/prisma";
import { resolveUploadFilePath } from "../lib/uploads";
import {
  type CleanPilotBundle,
  type CleanPilotRole,
  readIdentityArguments,
} from "./cleanPilotBundle";

type IdentityReferences = ReturnType<typeof readIdentityArguments>;

const roleReferenceKeys: Array<[CleanPilotRole, keyof IdentityReferences]> = [
  ["ADMIN", "admin"],
  ["MANAGER", "manager"],
  ["CASHIER", "cashier"],
  ["STAFF", "staff"],
];

export async function resolvePilotAccounts(references: IdentityReferences) {
  const selected: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    gender: string | null;
    address: string | null;
    passwordHash: string;
    mustChangePassword: boolean;
    role: CleanPilotRole;
    isActive: boolean;
    lastLogin: Date | null;
    lastPresenceAt: Date | null;
    profileImage: string | null;
    nagariktaNo: string | null;
    createdAt: Date;
  }> = [];
  for (const [role, key] of roleReferenceKeys) {
    const reference = references[key];
    const matches = await prisma.user.findMany({
      where: {
        role,
        isActive: true,
        OR: [
          { id: reference },
          { name: reference },
          { email: reference.toLowerCase() },
          { phone: reference },
        ],
      },
    });
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one active ${role} matching "${reference}", found ${matches.length}.`,
      );
    }
    selected.push(matches[0]);
  }
  if (new Set(selected.map((account) => account.id)).size !== 4) {
    throw new Error("Each pilot role must resolve to a different account.");
  }
  return selected;
}

export async function collectSourceCounts() {
  const [
    users,
    activeUsers,
    products,
    brands,
    invoices,
    customers,
    productImportBatches,
    documents,
    auditLogs,
    authSessions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.product.count(),
    prisma.brand.count(),
    prisma.invoice.count(),
    prisma.customer.count(),
    prisma.productImportBatch.count(),
    prisma.document.count(),
    prisma.auditLog.count(),
    prisma.authSession.count(),
  ]);
  return {
    users,
    activeUsers,
    products,
    brands,
    invoices,
    customers,
    productImportBatches,
    documents,
    auditLogs,
    authSessions,
  };
}

export async function createCleanPilotBundle(
  references: IdentityReferences,
): Promise<CleanPilotBundle> {
  const accounts = await resolvePilotAccounts(references);
  const accountIds = accounts.map((account) => account.id);
  const [cashierPrivileges, settings] = await Promise.all([
    prisma.cashierPrivilege.findMany({ where: { userId: { in: accountIds } } }),
    prisma.businessSettings.findUnique({ where: { id: 1 } }),
  ]);
  if (!settings) throw new Error("Business settings row 1 is missing.");

  const profileImages: CleanPilotBundle["profileImages"] = [];
  for (const account of accounts) {
    if (!account.profileImage) continue;
    const absolutePath = resolveUploadFilePath(account.profileImage);
    if (!absolutePath) {
      throw new Error(`The profile image path for ${account.name} is not managed safely.`);
    }
    const bytes = await fs.readFile(absolutePath).catch((error: any) => {
      if (error?.code === "ENOENT") {
        throw new Error(`The profile image file for ${account.name} is missing on disk.`);
      }
      throw error;
    });
    if (bytes.length > 8 * 1024 * 1024) {
      throw new Error(`The profile image for ${account.name} exceeds 8 MB.`);
    }
    profileImages.push({
      userId: account.id,
      publicUrl: account.profileImage,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    });
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      phone: account.phone,
      gender: account.gender,
      address: account.address,
      passwordHash: account.passwordHash,
      mustChangePassword: account.mustChangePassword,
      role: account.role,
      nagariktaNo: account.nagariktaNo,
      createdAt: account.createdAt.toISOString(),
    })),
    profileImages,
    cashierPrivileges: cashierPrivileges.map((privilege) => ({
      id: privilege.id,
      userId: privilege.userId,
      canCreateDiscountedCustomer: privilege.canCreateDiscountedCustomer,
      maxCustomerLoyaltyPercent: privilege.maxCustomerLoyaltyPercent,
      maxCustomerWholesalePercent: privilege.maxCustomerWholesalePercent,
      canRequestCustomerDiscount: privilege.canRequestCustomerDiscount,
      canOverrideBillingPrice: privilege.canOverrideBillingPrice,
      canApplyManualDiscount: privilege.canApplyManualDiscount,
      canVoidPayment: privilege.canVoidPayment,
      canViewWholesalePrice: privilege.canViewWholesalePrice,
      updatedById:
        privilege.updatedById && accountIds.includes(privilege.updatedById)
          ? privilege.updatedById
          : null,
      createdAt: privilege.createdAt.toISOString(),
      updatedAt: privilege.updatedAt.toISOString(),
    })),
    settings: {
      defaultInitialStock: settings.defaultInitialStock,
      defaultLowStockThreshold: settings.defaultLowStockThreshold,
      defaultWholesaleQtyThreshold: settings.defaultWholesaleQtyThreshold,
      loyaltyDiscountPercent: settings.loyaltyDiscountPercent,
      returnWindowDays: settings.returnWindowDays,
      parkedBillExpiryHours: settings.parkedBillExpiryHours,
      draftRequestExpiryMinutes: settings.draftRequestExpiryMinutes,
    },
  };
}
