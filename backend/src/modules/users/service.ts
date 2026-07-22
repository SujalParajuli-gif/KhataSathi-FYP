import prisma from "../../db/prisma";
import { deleteReplacedUpload, deleteUploadFile } from "../../lib/uploads";
import { reconcileProfileImages } from "../../lib/profileImages";

export type ManagedUserRole = "ADMIN" | "MANAGER" | "CASHIER" | "STAFF";
export const PRESENCE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export type UserDeleteSafety = {
  userId: string;
  userName: string;
  canPermanentDelete: boolean;
  references: Array<{ label: string; count: number }>;
  supportCleanup: Array<{ label: string; count: number }>;
  safeReason: string | null;
  recommendedAction: "PERMANENT_DELETE" | "DEACTIVATE";
};

// defining the shape of data needed to create a new user
type CreateUserInput = {
  name: string;
  email: string;
  phone?: string;
  gender?: string | null;
  address?: string | null;
  role?: ManagedUserRole;
  passwordHash: string;
  isActive?: boolean;
};

// defining the shape of data needed to update an existing user
// all fields are optional because the admin might only change one or two fields at a time
type UpdateUserInput = {
  name?: string;
  email?: string;
  phone?: string | null;
  gender?: string | null;
  address?: string | null;
  role?: ManagedUserRole;
  passwordHash?: string;
  isActive?: boolean;
  profileImage?: string | null;
};

export function isPresenceActive(
  lastPresenceAt?: Date | string | null,
  now: Date = new Date(),
) {
  if (!lastPresenceAt) return false;
  const lastSeen = new Date(lastPresenceAt).getTime();
  if (!Number.isFinite(lastSeen)) return false;
  return now.getTime() - lastSeen <= PRESENCE_ACTIVE_WINDOW_MS;
}

// listing all users, with optional role filter to show only admins or only cashiers
// we exclude the passwordHash field from the results to keep it secure
export async function listUsers(query?: { role?: ManagedUserRole }) {
  const where: any = {};
  if (query?.role) where.role = query.role; // adding role filter only if it was provided

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" }, // newest users first
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      lastPresenceAt: true,
      profileImage: true,
      createdAt: true,
    },
  });

  return reconcileProfileImages(users);
}

// creating a new user record in the database
// optional fields default to null if not provided, and the role defaults to "CASHIER"
export async function createUser(data: CreateUserInput) {
  return prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      gender: data.gender || null,
      address: data.address || null,
      role: data.role || "CASHIER", // new users are cashiers by default unless admin specifies otherwise
      passwordHash: data.passwordHash,
      isActive: data.isActive ?? true, // active by default
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      lastPresenceAt: true,
      profileImage: true,
      createdAt: true,
    },
  });
}

// updating an existing user record — handles all fields including profile image changes
export async function updateUser(id: string, data: UpdateUserInput) {
  let previousProfileImage: string | null = null;

  // if the profile image is being changed, we need to save the old URL so we can delete the file later
  if (data.profileImage !== undefined) {
    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: { profileImage: true },
    });
    previousProfileImage = existingUser?.profileImage ?? null;
  }

  // updating the user in the database
  // for optional fields (phone, gender, address), we skip the update if the value is undefined
  // so those fields are only changed when the admin actually sends a new value
  const user = await prisma.user.update({
    where: { id },
    data: {
      ...data,
      phone: data.phone === undefined ? undefined : data.phone,
      gender: data.gender === undefined ? undefined : data.gender,
      address: data.address === undefined ? undefined : data.address,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      lastPresenceAt: true,
      profileImage: true,
      createdAt: true,
    },
  });

  // if the profile image was changed, we delete the old file from disk
  if (data.profileImage !== undefined) {
    await deleteReplacedUpload(previousProfileImage, user.profileImage);
  }

  return user;
}

// updating a user's profile photo — fetches the old photo URL, saves the new one, and cleans up the old file
export async function uploadUserPhoto(id: string, photoUrl: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { profileImage: true }, // only fetching the current photo URL to delete the old file
  });

  const user = await prisma.user.update({
    where: { id },
    data: { profileImage: photoUrl },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      lastPresenceAt: true,
      profileImage: true,
      createdAt: true,
    },
  });

  // deleting the previous photo file from disk now that it has been replaced
  await deleteReplacedUpload(existingUser?.profileImage, user.profileImage);

  return user;
}

export async function touchUserPresence(id: string) {
  const lastPresenceAt = new Date();
  const user = await prisma.user.update({
    where: { id },
    data: { lastPresenceAt },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      lastPresenceAt: true,
    },
  });

  return {
    ...user,
    isPresent: isPresenceActive(user.lastPresenceAt, lastPresenceAt),
  };
}

export async function listCashierPresence() {
  const now = new Date();
  const onlineSince = new Date(now.getTime() - PRESENCE_ACTIVE_WINDOW_MS);
  const cashiers = await prisma.user.findMany({
    where: { role: "CASHIER", isActive: true },
    orderBy: [{ lastPresenceAt: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isActive: true,
      lastPresenceAt: true,
    },
  });
  const cashierIds = cashiers.map((cashier) => cashier.id);
  const [openDrawers, pendingDraftGroups] = await Promise.all([
    prisma.cashDrawer.findMany({
      where: { cashierId: { in: cashierIds }, status: "OPEN" },
      select: { id: true, cashierId: true, openedAt: true },
    }),
    prisma.billingDraftRequest.groupBy({
      by: ["assignedCashierId"],
      where: {
        assignedCashierId: { in: cashierIds },
        status: { in: ["PENDING", "MODIFIED"] },
      },
      _count: { _all: true },
    }),
  ]);
  const drawerByCashierId = new Map<
    string,
    { id: string; cashierId: string; openedAt: Date }
  >(openDrawers.map((drawer) => [drawer.cashierId, drawer]));
  const pendingByCashierId = new Map<string, number>(
    pendingDraftGroups
      .filter((group) => group.assignedCashierId)
      .map((group) => [group.assignedCashierId!, group._count._all]),
  );

  return cashiers.map((cashier) => ({
    ...cashier,
    isPresent:
      cashier.lastPresenceAt !== null && cashier.lastPresenceAt >= onlineSince,
    hasOpenDrawer: drawerByCashierId.has(cashier.id),
    openDrawerId: drawerByCashierId.get(cashier.id)?.id || null,
    openDrawerOpenedAt: drawerByCashierId.get(cashier.id)?.openedAt || null,
    pendingDraftRequestCount: pendingByCashierId.get(cashier.id) || 0,
  }));
}

export async function getUserDeleteSafety(
  id: string,
  actorId?: string,
): Promise<UserDeleteSafety> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true },
  });

  if (!user) {
    const error: any = new Error("User not found");
    error.code = "P2025";
    throw error;
  }

  const [
    invoices,
    cancelledInvoices,
    payments,
    voidedPayments,
    stockTransactions,
    invoiceItemPriceOverrides,
    auditLogs,
    creditNotes,
    createdReturnRequests,
    reviewedReturnRequests,
    backupJobs,
    productImportBatches,
    productImportTemplates,
    cashDrawers,
    cashDrawerEvents,
    documents,
    deletedDocuments,
    stockReceiveBatches,
    softDeleteRecords,
    deletedProductImportBatches,
    backupSettingsUpdates,
    updatedCashierPrivileges,
    createdCustomers,
    createdDiscountRequests,
    reviewedDiscountRequests,
    priceOverrideAuthorizations,
    createdDraftRequests,
    assignedDraftRequests,
    acceptedDraftRequests,
    cashierPrivilege,
    userAlertReads,
    overridePinAttempts,
  ] = await Promise.all([
    prisma.invoice.count({ where: { cashierId: id } }),
    prisma.invoice.count({ where: { cancelledById: id } }),
    prisma.payment.count({ where: { createdById: id } }),
    prisma.payment.count({ where: { voidedById: id } }),
    prisma.stockTransaction.count({ where: { createdById: id } }),
    prisma.invoiceItem.count({ where: { overrideById: id } }),
    prisma.auditLog.count({ where: { actorId: id } }),
    prisma.creditNote.count({ where: { createdById: id } }),
    prisma.returnRequest.count({ where: { createdById: id } }),
    prisma.returnRequest.count({ where: { reviewedById: id } }),
    prisma.backupJob.count({ where: { createdById: id } }),
    prisma.productImportBatch.count({ where: { createdById: id } }),
    prisma.productImportTemplate.count({ where: { createdById: id } }),
    prisma.cashDrawer.count({ where: { cashierId: id } }),
    prisma.cashDrawerEvent.count({ where: { createdById: id } }),
    prisma.document.count({ where: { uploadedById: id } }),
    prisma.document.count({ where: { deletedById: id } }),
    prisma.stockReceiveBatch.count({ where: { createdById: id } }),
    prisma.softDeleteRecord.count({ where: { deletedById: id } }),
    prisma.productImportBatch.count({ where: { deletedById: id } }),
    prisma.backupSettings.count({ where: { updatedById: id } }),
    prisma.cashierPrivilege.count({ where: { updatedById: id } }),
    prisma.customer.count({ where: { createdById: id } }),
    prisma.customerDiscountRequest.count({ where: { requestedById: id } }),
    prisma.customerDiscountRequest.count({ where: { reviewedById: id } }),
    prisma.priceOverrideAuthorization.count({ where: { cashierId: id } }),
    prisma.billingDraftRequest.count({ where: { createdById: id } }),
    prisma.billingDraftRequest.count({ where: { assignedCashierId: id } }),
    prisma.billingDraftRequest.count({ where: { acceptedById: id } }),
    prisma.cashierPrivilege.count({ where: { userId: id } }),
    prisma.userAlertRead.count({ where: { userId: id } }),
    prisma.overridePinAttempt.count({ where: { userId: id } }),
  ]);

  const references = [
    { label: "current signed-in admin account", count: actorId === id ? 1 : 0 },
    { label: "invoice(s) as cashier", count: invoices },
    { label: "cancelled invoice(s)", count: cancelledInvoices },
    { label: "payment(s) created", count: payments },
    { label: "payment(s) voided", count: voidedPayments },
    { label: "stock transaction(s)", count: stockTransactions },
    { label: "invoice price override(s)", count: invoiceItemPriceOverrides },
    { label: "audit log(s)", count: auditLogs },
    { label: "credit note(s)", count: creditNotes },
    { label: "return request(s) created", count: createdReturnRequests },
    { label: "return request(s) reviewed", count: reviewedReturnRequests },
    { label: "backup job(s)", count: backupJobs },
    { label: "product import batch(es)", count: productImportBatches },
    { label: "product import template(s)", count: productImportTemplates },
    { label: "cash drawer session(s)", count: cashDrawers },
    { label: "cash drawer event(s)", count: cashDrawerEvents },
    { label: "uploaded document(s)", count: documents },
    { label: "document deletion action(s)", count: deletedDocuments },
    { label: "stock receive batch(es)", count: stockReceiveBatches },
    { label: "bin deletion record(s)", count: softDeleteRecords },
    { label: "product import deletion action(s)", count: deletedProductImportBatches },
    { label: "backup setting update(s)", count: backupSettingsUpdates },
    { label: "cashier permission update(s)", count: updatedCashierPrivileges },
    { label: "customer(s) created", count: createdCustomers },
    { label: "customer discount request(s) created", count: createdDiscountRequests },
    { label: "customer discount request(s) reviewed", count: reviewedDiscountRequests },
    { label: "price override authorization(s)", count: priceOverrideAuthorizations },
    { label: "draft request(s) created", count: createdDraftRequests },
    { label: "draft request(s) assigned", count: assignedDraftRequests },
    { label: "draft request(s) accepted", count: acceptedDraftRequests },
  ].filter((item) => item.count > 0);

  const supportCleanup = [
    { label: "cashier permission row", count: cashierPrivilege },
    { label: "alert read state(s)", count: userAlertReads },
    { label: "override PIN attempt(s)", count: overridePinAttempts },
  ].filter((item) => item.count > 0);

  const canPermanentDelete = references.length === 0;

  return {
    userId: user.id,
    userName: user.name,
    canPermanentDelete,
    references,
    supportCleanup,
    safeReason: canPermanentDelete
      ? "No business, security, or audit history was found for this user."
      : null,
    recommendedAction: canPermanentDelete ? "PERMANENT_DELETE" : "DEACTIVATE",
  };
}

export async function permanentlyDeleteUser(id: string, actorId: string) {
  const safety = await getUserDeleteSafety(id, actorId);
  if (!safety.canPermanentDelete) {
    const error: any = new Error("User cannot be permanently deleted.");
    error.code = "USER_DELETE_BLOCKED";
    error.safety = safety;
    throw error;
  }

  const user = await prisma.$transaction(async (tx) => {
    await tx.cashierPrivilege.deleteMany({ where: { userId: id } });
    await tx.userAlertRead.deleteMany({ where: { userId: id } });
    await tx.overridePinAttempt.deleteMany({ where: { userId: id } });

    return tx.user.delete({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        profileImage: true,
      },
    });
  });

  await deleteUploadFile(user.profileImage);

  await prisma.auditLog.create({
    data: {
      actorId,
      action: "USER_PERMANENTLY_DELETED",
      entityType: "User",
      entityId: user.id,
      meta: {
        name: user.name,
        email: user.email,
        role: user.role,
        safeReason: safety.safeReason,
        supportCleanup: safety.supportCleanup,
      },
    },
  }).catch(() => undefined);

  return {
    deleted: true,
    user,
    safety,
    message: `${user.name} permanently deleted.`,
  };
}
