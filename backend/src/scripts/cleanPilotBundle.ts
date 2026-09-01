import crypto from "crypto";
import { z } from "zod";

export const CLEAN_PILOT_ROLES = [
  "ADMIN",
  "MANAGER",
  "CASHIER",
  "STAFF",
] as const;

export type CleanPilotRole = (typeof CLEAN_PILOT_ROLES)[number];

const nullableText = z.string().nullable();

const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  email: nullableText,
  phone: nullableText,
  gender: nullableText,
  address: nullableText,
  passwordHash: z.string().regex(/^\$2[aby]\$/),
  mustChangePassword: z.boolean(),
  role: z.enum(CLEAN_PILOT_ROLES),
  nagariktaNo: nullableText,
  createdAt: z.string().min(1),
});

const profileImageSchema = z.object({
  userId: z.string().min(1),
  publicUrl: z.string().startsWith("/uploads/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().min(1),
});

const cashierPrivilegeSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  canCreateDiscountedCustomer: z.boolean(),
  maxCustomerLoyaltyPercent: z.number().finite().min(0).max(100),
  maxCustomerWholesalePercent: z.number().finite().min(0).max(100),
  canRequestCustomerDiscount: z.boolean(),
  canOverrideBillingPrice: z.boolean(),
  canApplyManualDiscount: z.boolean(),
  canVoidPayment: z.boolean(),
  canViewWholesalePrice: z.boolean(),
  updatedById: nullableText,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const settingsSchema = z.object({
  defaultInitialStock: z.number().finite().min(0),
  defaultLowStockThreshold: z.number().finite().min(0),
  defaultWholesaleQtyThreshold: z.number().finite().positive(),
  loyaltyDiscountPercent: z.number().finite().min(0).max(100),
  returnWindowDays: z.number().int().positive(),
  parkedBillExpiryHours: z.number().int().positive(),
  draftRequestExpiryMinutes: z.number().int().positive(),
});

const bundleSchema = z.object({
  schemaVersion: z.literal(2),
  exportedAt: z.string().min(1),
  accounts: z.array(accountSchema).min(4).max(20),
  profileImages: z.array(profileImageSchema).max(20),
  cashierPrivileges: z.array(cashierPrivilegeSchema).max(1),
  settings: settingsSchema,
});

export type CleanPilotBundle = z.infer<typeof bundleSchema>;

function assertUnique(values: Array<string | null>, label: string) {
  const populated = values.filter((value): value is string => Boolean(value));
  if (new Set(populated).size !== populated.length) {
    throw new Error(`The clean-pilot bundle contains duplicate ${label}.`);
  }
}

export function validateCleanPilotBundle(input: unknown): CleanPilotBundle {
  const bundle = bundleSchema.parse(input);
  const roleCounts = Object.fromEntries(
    CLEAN_PILOT_ROLES.map((role) => [
      role,
      bundle.accounts.filter((account) => account.role === role).length,
    ]),
  ) as Record<CleanPilotRole, number>;
  if (
    roleCounts.ADMIN !== 1 ||
    roleCounts.MANAGER !== 1 ||
    roleCounts.CASHIER !== 1 ||
    roleCounts.STAFF < 1
  ) {
    throw new Error(
      "The clean-pilot bundle must contain exactly one active Admin, Manager, and Cashier account, plus at least one active Staff account.",
    );
  }

  assertUnique(bundle.accounts.map((account) => account.id), "account IDs");
  assertUnique(
    bundle.accounts.map((account) => account.email?.toLowerCase() || null),
    "email addresses",
  );
  assertUnique(bundle.accounts.map((account) => account.phone), "phone numbers");

  const accountIds = new Set(bundle.accounts.map((account) => account.id));
  const profileUserIds = new Set<string>();
  for (const image of bundle.profileImages) {
    if (!accountIds.has(image.userId)) {
      throw new Error("A profile image belongs to an account outside the pilot allowlist.");
    }
    if (profileUserIds.has(image.userId)) {
      throw new Error("A pilot account has more than one profile image payload.");
    }
    profileUserIds.add(image.userId);
    const bytes = Buffer.from(image.contentBase64, "base64");
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new Error("A pilot profile image is empty or exceeds the 8 MB transfer limit.");
    }
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
    if (checksum !== image.sha256) {
      throw new Error("A pilot profile image failed its SHA-256 integrity check.");
    }
  }

  for (const privilege of bundle.cashierPrivileges) {
    const account = bundle.accounts.find(
      (candidate) => candidate.id === privilege.userId,
    );
    if (!account || account.role !== "CASHIER") {
      throw new Error("Cashier permissions must belong to the preserved Cashier account.");
    }
    if (privilege.updatedById && !accountIds.has(privilege.updatedById)) {
      throw new Error("Cashier permissions reference a user outside the pilot allowlist.");
    }
  }

  return bundle;
}

export function readIdentityArguments(args: string[]) {
  const read = (name: string) => {
    const inline = args.find((argument) => argument.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3).trim();
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? String(args[index + 1] || "").trim() : "";
  };

  const readAll = (name: string) => {
    const values: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument.startsWith(`--${name}=`)) {
        const value = argument.slice(name.length + 3).trim();
        if (value) values.push(value);
      } else if (argument === `--${name}`) {
        const value = String(args[index + 1] || "").trim();
        if (value) values.push(value);
        index += 1;
      }
    }
    return values;
  };

  const references = {
    admin: read("admin"),
    manager: read("manager"),
    cashier: read("cashier"),
    staff: readAll("staff"),
  };
  const missing = [
    ...(["admin", "manager", "cashier"] as const)
      .filter((key) => !references[key])
      .map((key) => `--${key}`),
    ...(references.staff.length === 0 ? ["--staff"] : []),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing required pilot identities: ${missing.join(", ")}.`);
  }
  return references;
}

export function hasConfirmation(args: string[], expected: string) {
  const inline = args.find((argument) => argument.startsWith("--confirmation="));
  if (inline) return inline.slice("--confirmation=".length) === expected;
  const index = args.indexOf("--confirmation");
  return index >= 0 && args[index + 1] === expected;
}
