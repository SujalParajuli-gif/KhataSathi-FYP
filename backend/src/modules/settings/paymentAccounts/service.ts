import crypto from "node:crypto";
import fs from "node:fs/promises";
import prisma from "../../../db/prisma";
import {
  lockBusinessSettingsForUpdate,
  lockPaymentReceivingAccountForUpdate,
  lockPaymentReceivingAccountsForUpdate,
} from "../../../lib/transactionLocks";
import {
  CreatePaymentAccountInput,
  PatchPaymentAccountInput,
  ReorderPaymentAccountsInput,
  createPaymentAccountSchema,
  patchPaymentAccountSchema,
  reorderPaymentAccountsSchema,
} from "./validation";
import {
  processAndPromoteQrAsset,
  resolveAccountDir,
  resolveAssetFilePath,
  assertNoSymlinksInPath,
  isValidUuid,
  PaymentAccountStorageError,
} from "./storage";
import {
  documentStorageRoot,
  paymentAccountsDir,
  asStorageUnavailableError,
} from "../../../lib/storageReadiness";
import type {
  PaymentMethod,
  PaymentReceivingConfirmationMode,
} from "@prisma/client";

export class PaymentAccountError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = "INVALID_PAYMENT_ACCOUNT") {
    super(message);
    this.name = "PaymentAccountError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function calculateCreationPayloadHash(input: CreatePaymentAccountInput): string {
  const canonical = {
    id: input.id,
    providerLabel: input.providerLabel.trim(),
    accountHolder: input.accountHolder.trim(),
    accountIdentifier: input.accountIdentifier ? input.accountIdentifier.trim() : null,
    settlementMethod: input.settlementMethod || null,
    confirmationMode: input.confirmationMode,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface EnabledPaymentAccountDto {
  id: string;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier: string | null;
  settlementMethod: PaymentMethod | null;
  confirmationMode: PaymentReceivingConfirmationMode;
  version: number;
  activeQrAssetId: string;
  activeQrThumbnailUrl: string;
  activeQrFileUrl: string;
  supportedSettlement: boolean;
}

export interface PaymentAccountManagementDto {
  id: string;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier: string | null;
  settlementMethod: PaymentMethod | null;
  confirmationMode: PaymentReceivingConfirmationMode;
  enabled: boolean;
  sortOrder: number;
  version: number;
  activeQrAssetId: string | null;
  activeQrAsset: {
    id: string;
    width: number;
    height: number;
    sizeBytes: number;
    thumbnailSizeBytes: number;
    mimeType: string;
    checksum: string;
    createdAt: Date;
  } | null;
  createdById: string;
  createdBy: { id: string; name: string };
  updatedById: string;
  updatedBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
  totalAssetsCount: number;
  linkedPaymentsCount: number;
}

export function projectPaymentAccountManagementDto(acc: any): PaymentAccountManagementDto {
  return {
    id: acc.id,
    providerLabel: acc.providerLabel,
    accountHolder: acc.accountHolder,
    accountIdentifier: acc.accountIdentifier,
    settlementMethod: acc.settlementMethod,
    confirmationMode: acc.confirmationMode,
    enabled: acc.enabled,
    sortOrder: acc.sortOrder,
    version: acc.version,
    activeQrAssetId: acc.activeQrAssetId,
    activeQrAsset: acc.activeQrAsset
      ? {
          id: acc.activeQrAsset.id,
          width: acc.activeQrAsset.width,
          height: acc.activeQrAsset.height,
          sizeBytes: acc.activeQrAsset.sizeBytes,
          thumbnailSizeBytes: acc.activeQrAsset.thumbnailSizeBytes,
          mimeType: acc.activeQrAsset.mimeType,
          checksum: acc.activeQrAsset.checksum,
          createdAt: acc.activeQrAsset.createdAt,
        }
      : null,
    createdById: acc.createdById,
    createdBy: {
      id: acc.createdBy?.id ?? acc.createdById,
      name: acc.createdBy?.name ?? "",
    },
    updatedById: acc.updatedById,
    updatedBy: {
      id: acc.updatedBy?.id ?? acc.updatedById,
      name: acc.updatedBy?.name ?? "",
    },
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
    totalAssetsCount: acc._count?.assets ?? 0,
    linkedPaymentsCount: acc._count?.payments ?? 0,
  };
}

async function getAccountManagementDtoTx(tx: any, id: string): Promise<PaymentAccountManagementDto> {
  const row = await tx.paymentReceivingAccount.findUniqueOrThrow({
    where: { id },
    include: {
      activeQrAsset: {
        select: {
          id: true,
          width: true,
          height: true,
          sizeBytes: true,
          thumbnailSizeBytes: true,
          mimeType: true,
          checksum: true,
          createdAt: true,
        },
      },
      createdBy: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
      _count: { select: { assets: true, payments: true } },
    },
  });
  return projectPaymentAccountManagementDto(row);
}

async function listPaymentAccountsTx(tx: any): Promise<PaymentAccountManagementDto[]> {
  const accounts = await tx.paymentReceivingAccount.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      activeQrAsset: {
        select: {
          id: true,
          width: true,
          height: true,
          sizeBytes: true,
          thumbnailSizeBytes: true,
          mimeType: true,
          checksum: true,
          createdAt: true,
        },
      },
      createdBy: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
      _count: { select: { assets: true, payments: true } },
    },
  });
  return accounts.map(projectPaymentAccountManagementDto);
}

export async function listPaymentAccounts(): Promise<PaymentAccountManagementDto[]> {
  return listPaymentAccountsTx(prisma);
}

export async function getEnabledPaymentAccounts(): Promise<EnabledPaymentAccountDto[]> {
  const accounts = await prisma.paymentReceivingAccount.findMany({
    where: {
      enabled: true,
      activeQrAssetId: { not: null },
    },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  return accounts.map((acc) => {
    const isSupported =
      acc.confirmationMode === "MANUAL_RECEIPT" &&
      (acc.settlementMethod === "FONEPAY" || acc.settlementMethod === "BANK_TRANSFER");

    return {
      id: acc.id,
      providerLabel: acc.providerLabel,
      accountHolder: acc.accountHolder,
      accountIdentifier: acc.accountIdentifier,
      settlementMethod: acc.settlementMethod,
      confirmationMode: acc.confirmationMode,
      version: acc.version,
      activeQrAssetId: acc.activeQrAssetId!,
      activeQrThumbnailUrl: `/api/settings/payment-accounts/${acc.id}/qr/${acc.activeQrAssetId}/thumbnail`,
      activeQrFileUrl: `/api/settings/payment-accounts/${acc.id}/qr/${acc.activeQrAssetId}/file`,
      supportedSettlement: Boolean(isSupported),
    };
  });
}

export async function createPaymentAccount(
  input: CreatePaymentAccountInput,
  actorId: string,
): Promise<PaymentAccountManagementDto> {
  const parsedInput = createPaymentAccountSchema.parse(input);
  const payloadHash = calculateCreationPayloadHash(parsedInput);

  return prisma.$transaction(async (tx) => {
    // 1. Acquire collection lock FIRST before any nonlocking ORM read or count
    await lockBusinessSettingsForUpdate(tx);

    // 2. Check if account already exists under the collection lock
    const existing = await tx.paymentReceivingAccount.findUnique({
      where: { id: parsedInput.id },
    });

    if (existing) {
      if (
        existing.createdById === actorId &&
        existing.creationPayloadHash === payloadHash
      ) {
        // Idempotent replay: return current management state
        return getAccountManagementDtoTx(tx, existing.id);
      }
      throw new PaymentAccountError(
        "A payment account with this ID already exists with different creation parameters",
        409,
        "ACCOUNT_EXISTS_CONFLICT",
      );
    }

    const totalCount = await tx.paymentReceivingAccount.count();
    if (totalCount >= 100) {
      throw new PaymentAccountError(
        "Maximum limit of 100 payment accounts reached",
        400,
        "MAX_PAYMENT_ACCOUNTS_EXCEEDED",
      );
    }

    const maxSortRow = await tx.paymentReceivingAccount.findFirst({
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const nextSortOrder = (maxSortRow?.sortOrder ?? -1) + 1;

    const created = await tx.paymentReceivingAccount.create({
      data: {
        id: parsedInput.id,
        providerLabel: parsedInput.providerLabel.trim(),
        accountHolder: parsedInput.accountHolder.trim(),
        accountIdentifier: parsedInput.accountIdentifier ? parsedInput.accountIdentifier.trim() : null,
        settlementMethod: (parsedInput.settlementMethod as PaymentMethod) || null,
        confirmationMode: parsedInput.confirmationMode as PaymentReceivingConfirmationMode,
        enabled: false,
        sortOrder: nextSortOrder,
        version: 1,
        creationPayloadHash: payloadHash,
        activeQrAssetId: null,
        createdById: actorId,
        updatedById: actorId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        action: "PAYMENT_ACCOUNT_CREATED",
        entityType: "PaymentReceivingAccount",
        entityId: created.id,
        meta: {
          providerLabel: created.providerLabel,
          accountHolder: created.accountHolder,
          accountIdentifier: created.accountIdentifier,
          settlementMethod: created.settlementMethod,
          confirmationMode: created.confirmationMode,
          version: 1,
          enabled: false,
        },
      },
    });

    return getAccountManagementDtoTx(tx, created.id);
  });
}

export async function patchPaymentAccount(
  id: string,
  input: PatchPaymentAccountInput,
  actorId: string,
): Promise<PaymentAccountManagementDto> {
  const parsedInput = patchPaymentAccountSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    // Current locking read
    const locked = await lockPaymentReceivingAccountForUpdate(tx, id);
    if (!locked) {
      throw new PaymentAccountError("Payment account not found", 404, "ACCOUNT_NOT_FOUND");
    }

    if (parsedInput.expectedVersion !== locked.version) {
      throw new PaymentAccountError(
        `Version conflict: expected ${parsedInput.expectedVersion} but current version is ${locked.version}`,
        409,
        "VERSION_CONFLICT",
      );
    }

    // Determine target values
    const nextProviderLabel =
      parsedInput.providerLabel !== undefined ? parsedInput.providerLabel.trim() : locked.providerLabel;
    const nextAccountHolder =
      parsedInput.accountHolder !== undefined ? parsedInput.accountHolder.trim() : locked.accountHolder;
    const nextAccountIdentifier =
      parsedInput.accountIdentifier !== undefined
        ? (parsedInput.accountIdentifier ? parsedInput.accountIdentifier.trim() : null)
        : locked.accountIdentifier;
    const nextSettlementMethod =
      parsedInput.settlementMethod !== undefined
        ? (parsedInput.settlementMethod || null)
        : locked.settlementMethod;
    const nextConfirmationMode =
      parsedInput.confirmationMode !== undefined
        ? parsedInput.confirmationMode
        : locked.confirmationMode;
    const nextEnabled =
      parsedInput.enabled !== undefined ? parsedInput.enabled : locked.enabled;

    // Validate mode/method compatibility
    if (nextConfirmationMode === "MANUAL_RECEIPT") {
      if (nextSettlementMethod !== "FONEPAY" && nextSettlementMethod !== "BANK_TRANSFER") {
        throw new PaymentAccountError(
          "MANUAL_RECEIPT requires a supported settlement method (FONEPAY or BANK_TRANSFER)",
          400,
          "INVALID_SETTLEMENT_METHOD",
        );
      }
      if (nextSettlementMethod === "BANK_TRANSFER" && (!nextAccountIdentifier || !nextAccountIdentifier.trim())) {
        throw new PaymentAccountError(
          "Account identifier is required for Bank Transfer settlement",
          400,
          "ACCOUNT_IDENTIFIER_REQUIRED",
        );
      }
    } else if (nextConfirmationMode === "DISPLAY_ONLY") {
      if (nextSettlementMethod !== null) {
        throw new PaymentAccountError(
          "DISPLAY_ONLY confirmation mode requires null settlement method",
          400,
          "INVALID_SETTLEMENT_METHOD",
        );
      }
    }

    const identityLockedFieldsChanged =
      nextAccountIdentifier !== locked.accountIdentifier ||
      nextSettlementMethod !== locked.settlementMethod ||
      nextConfirmationMode !== locked.confirmationMode;

    if (identityLockedFieldsChanged) {
      // First consistent read after account lock to check referenced payments
      const linkedPaymentCount = await tx.payment.count({
        where: { receivingAccountId: id },
      });
      if (linkedPaymentCount > 0) {
        throw new PaymentAccountError(
          "Cannot edit account identifier, settlement method, or confirmation mode of an account with linked payments. Disable this account and create a new one instead.",
          409,
          "ACCOUNT_IDENTITY_IN_USE",
        );
      }
    }

    if (nextEnabled && !locked.activeQrAssetId) {
      throw new PaymentAccountError(
        "Cannot enable a payment account without a published active QR asset",
        400,
        "CANNOT_ENABLE_WITHOUT_QR_ASSET",
      );
    }

    if (nextEnabled && locked.activeQrAssetId) {
      const asset = await tx.paymentReceivingQrAsset.findUnique({
        where: { id: locked.activeQrAssetId },
      });
      if (!asset || asset.accountId !== id) {
        throw new PaymentAccountError(
          "Active QR asset does not belong to this account",
          400,
          "INVALID_ACTIVE_ASSET",
        );
      }
    }

    const hasEffectiveChanges =
      nextProviderLabel !== locked.providerLabel ||
      nextAccountHolder !== locked.accountHolder ||
      identityLockedFieldsChanged ||
      nextEnabled !== locked.enabled;

    if (!hasEffectiveChanges) {
      // Same-value request: no-op, no version increment or audit log
      return getAccountManagementDtoTx(tx, id);
    }

    const nextVersion = locked.version + 1;

    await tx.paymentReceivingAccount.update({
      where: { id },
      data: {
        providerLabel: nextProviderLabel,
        accountHolder: nextAccountHolder,
        accountIdentifier: nextAccountIdentifier,
        settlementMethod: nextSettlementMethod as PaymentMethod | null,
        confirmationMode: nextConfirmationMode as PaymentReceivingConfirmationMode,
        enabled: nextEnabled,
        version: nextVersion,
        updatedById: actorId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        action: "PAYMENT_ACCOUNT_UPDATED",
        entityType: "PaymentReceivingAccount",
        entityId: id,
        meta: {
          previous: {
            providerLabel: locked.providerLabel,
            accountHolder: locked.accountHolder,
            accountIdentifier: locked.accountIdentifier,
            settlementMethod: locked.settlementMethod,
            confirmationMode: locked.confirmationMode,
            enabled: locked.enabled,
            version: locked.version,
          },
          updated: {
            providerLabel: nextProviderLabel,
            accountHolder: nextAccountHolder,
            accountIdentifier: nextAccountIdentifier,
            settlementMethod: nextSettlementMethod,
            confirmationMode: nextConfirmationMode,
            enabled: nextEnabled,
            version: nextVersion,
          },
        },
      },
    });

    return getAccountManagementDtoTx(tx, id);
  });
}

export async function reorderPaymentAccounts(
  orders: { id: string; expectedVersion: number }[],
  actorId: string,
): Promise<PaymentAccountManagementDto[]> {
  const parsed = reorderPaymentAccountsSchema.parse({ orders });
  const validatedOrders = parsed.orders;

  return prisma.$transaction(async (tx) => {
    // 1. Take collection lock FIRST
    await lockBusinessSettingsForUpdate(tx);

    const totalAccounts = await tx.paymentReceivingAccount.count();
    if (validatedOrders.length !== totalAccounts) {
      throw new PaymentAccountError(
        `Reorder set must contain exactly all ${totalAccounts} existing accounts (received ${validatedOrders.length})`,
        400,
        "INCOMPLETE_REORDER_SET",
      );
    }

    // 2. Lock accounts in sorted UUID order
    const sortedIds = [...validatedOrders.map((o) => o.id)].sort();
    const lockedRowsMap = await lockPaymentReceivingAccountsForUpdate(tx, sortedIds);
    if (lockedRowsMap.size !== totalAccounts) {
      throw new PaymentAccountError(
        "Some accounts specified in reorder set were not found",
        404,
        "ACCOUNTS_NOT_FOUND",
      );
    }

    // Validate expected versions
    for (const item of validatedOrders) {
      const locked = lockedRowsMap.get(item.id);
      if (!locked) {
        throw new PaymentAccountError(`Account ${item.id} not found`, 404, "ACCOUNT_NOT_FOUND");
      }
      if (item.expectedVersion !== locked.version) {
        throw new PaymentAccountError(
          `Version conflict for account ${item.id}: expected ${item.expectedVersion} but current version is ${locked.version}`,
          409,
          "VERSION_CONFLICT",
        );
      }
    }

    // Check changes and apply 0..n-1 sort order
    const changes: { id: string; oldSortOrder: number; newSortOrder: number; newVersion: number }[] = [];

    for (let newIndex = 0; newIndex < validatedOrders.length; newIndex++) {
      const item = validatedOrders[newIndex];
      const locked = lockedRowsMap.get(item.id)!;
      if (locked.sortOrder !== newIndex) {
        const newVersion = locked.version + 1;
        await tx.paymentReceivingAccount.update({
          where: { id: item.id },
          data: {
            sortOrder: newIndex,
            version: newVersion,
            updatedById: actorId,
          },
        });
        changes.push({
          id: item.id,
          oldSortOrder: locked.sortOrder,
          newSortOrder: newIndex,
          newVersion,
        });
      }
    }

    if (changes.length > 0) {
      await tx.auditLog.create({
        data: {
          actorId,
          action: "PAYMENT_ACCOUNT_REORDERED",
          entityType: "PaymentReceivingAccountCollection",
          entityId: "1",
          meta: { changes },
        },
      });
    }

    // Return transaction-local projection, NO global prisma call while lock held!
    return listPaymentAccountsTx(tx);
  });
}

export interface PublishedQrAssetDto {
  id: string;
  accountId: string;
  publicationExpectedVersion: number;
  mimeType: string;
  sizeBytes: number;
  thumbnailSizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  createdAt: Date;
  currentAccountVersion: number;
  activeQrAssetId: string | null;
}

export async function uploadAndPublishQrAsset(params: {
  accountId: string;
  uploadId: string;
  expectedVersion: number;
  fileBuffer: Buffer;
  originalMimeType?: string;
  actorId: string;
}): Promise<PublishedQrAssetDto> {
  const { accountId, uploadId, expectedVersion, fileBuffer, originalMimeType, actorId } = params;

  // 1. Process and promote files outside DB locks
  const prepared = await processAndPromoteQrAsset({
    accountId,
    assetId: uploadId,
    inputBuffer: fileBuffer,
    originalMimeType,
  });

  // 2. Transaction for publication metadata
  return prisma.$transaction(async (tx) => {
    const locked = await lockPaymentReceivingAccountForUpdate(tx, accountId);
    if (!locked) {
      throw new PaymentAccountError("Payment account not found", 404, "ACCOUNT_NOT_FOUND");
    }

    // Check if asset record already exists (replay)
    const existingAsset = await tx.paymentReceivingQrAsset.findUnique({
      where: { id: uploadId },
    });

    if (existingAsset) {
      if (
        existingAsset.accountId === accountId &&
        existingAsset.createdById === actorId &&
        existingAsset.sourceChecksum === prepared.sourceChecksum &&
        existingAsset.publicationExpectedVersion === expectedVersion
      ) {
        // Replay: return existing asset record with safe DTO without repointing
        return {
          id: existingAsset.id,
          accountId: existingAsset.accountId,
          publicationExpectedVersion: existingAsset.publicationExpectedVersion,
          mimeType: existingAsset.mimeType,
          sizeBytes: existingAsset.sizeBytes,
          thumbnailSizeBytes: existingAsset.thumbnailSizeBytes,
          width: existingAsset.width,
          height: existingAsset.height,
          checksum: existingAsset.checksum,
          createdAt: existingAsset.createdAt,
          currentAccountVersion: locked.version,
          activeQrAssetId: locked.activeQrAssetId,
        };
      }
      throw new PaymentAccountError(
        "An asset with this upload ID already exists with different metadata",
        409,
        "ASSET_CONFLICT",
      );
    }

    if (expectedVersion !== locked.version) {
      throw new PaymentAccountError(
        `Version conflict: expected account version ${expectedVersion} but current version is ${locked.version}`,
        409,
        "VERSION_CONFLICT",
      );
    }

    const createdAsset = await tx.paymentReceivingQrAsset.create({
      data: {
        id: uploadId,
        accountId,
        publicationExpectedVersion: expectedVersion,
        storedPath: prepared.storedPath,
        fileName: prepared.fileName,
        thumbnailFileName: prepared.thumbnailFileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        thumbnailSizeBytes: prepared.thumbnailSizeBytes,
        width: prepared.width,
        height: prepared.height,
        checksum: prepared.checksum,
        sourceChecksum: prepared.sourceChecksum,
        createdById: actorId,
      },
    });

    const nextVersion = locked.version + 1;

    await tx.paymentReceivingAccount.update({
      where: { id: accountId },
      data: {
        activeQrAssetId: uploadId,
        version: nextVersion,
        updatedById: actorId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        action: "PAYMENT_ACCOUNT_QR_PUBLISHED",
        entityType: "PaymentReceivingAccount",
        entityId: accountId,
        meta: {
          assetId: uploadId,
          oldActiveAssetId: locked.activeQrAssetId,
          version: nextVersion,
          checksum: prepared.checksum,
          width: prepared.width,
          height: prepared.height,
        },
      },
    });

    return {
      id: createdAsset.id,
      accountId: createdAsset.accountId,
      publicationExpectedVersion: createdAsset.publicationExpectedVersion,
      mimeType: createdAsset.mimeType,
      sizeBytes: createdAsset.sizeBytes,
      thumbnailSizeBytes: createdAsset.thumbnailSizeBytes,
      width: createdAsset.width,
      height: createdAsset.height,
      checksum: createdAsset.checksum,
      createdAt: createdAsset.createdAt,
      currentAccountVersion: nextVersion,
      activeQrAssetId: uploadId,
    };
  });
}

export async function getQrAssetFile(params: {
  accountId: string;
  assetId: string;
  isThumbnail: boolean;
  userRole?: string;
  posEnabled?: boolean;
}) {
  const { accountId, assetId, isThumbnail, userRole, posEnabled } = params;

  // 1. Role and Capability checks BEFORE any database query:
  // Missing / unauthenticated / STAFF / unknown roles denied before DB access
  if (!userRole || userRole === "STAFF" || (userRole !== "ADMIN" && userRole !== "MANAGER" && userRole !== "CASHIER")) {
    throw new PaymentAccountError("Access denied", 403, "FORBIDDEN");
  }

  // CASHIER and MANAGER require explicit posEnabled === true BEFORE any DB query
  if (userRole === "MANAGER" || userRole === "CASHIER") {
    if (posEnabled !== true) {
      throw new PaymentAccountError("POS capability is disabled in current business mode", 403, "FEATURE_DISABLED");
    }
  }
  // ADMIN retained reads bypass POS requirement

  // Defense-in-depth UUID validation before DB queries
  if (!isValidUuid(accountId)) {
    throw new PaymentAccountError("Invalid account ID format", 400, "INVALID_ACCOUNT_ID");
  }
  if (!isValidUuid(assetId)) {
    throw new PaymentAccountError("Invalid asset ID format", 400, "INVALID_ASSET_ID");
  }

  // 2. Retrieve account & asset metadata from database
  const account = await prisma.paymentReceivingAccount.findUnique({
    where: { id: accountId },
    select: { id: true, enabled: true, activeQrAssetId: true },
  });

  if (!account) {
    throw new PaymentAccountError("Payment account not found", 404, "ACCOUNT_NOT_FOUND");
  }

  const asset = await prisma.paymentReceivingQrAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.accountId !== accountId) {
    throw new PaymentAccountError("QR asset not found", 404, "ASSET_NOT_FOUND");
  }

  // 3. POS role checks: Require matching enabled account and active asset
  if (userRole === "MANAGER" || userRole === "CASHIER") {
    if (!account.enabled || account.activeQrAssetId !== assetId) {
      throw new PaymentAccountError("Asset is not currently active or account is disabled", 404, "ASSET_NOT_ACCESSIBLE");
    }
  }

  // 4. File resolution and protected path / regular file checks
  const fileName = isThumbnail ? asset.thumbnailFileName : asset.fileName;
  const accountDir = resolveAccountDir(accountId);
  const absolutePath = resolveAssetFilePath(accountId, fileName);

  try {
    await assertNoSymlinksInPath(documentStorageRoot, documentStorageRoot);
    await assertNoSymlinksInPath(paymentAccountsDir, documentStorageRoot);
    await assertNoSymlinksInPath(accountDir, paymentAccountsDir);
    await assertNoSymlinksInPath(absolutePath, accountDir);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new PaymentAccountError("Invalid storage path", 400, "INVALID_STORAGE_PATH");
    }
    if (!stat.isFile()) {
      throw new PaymentAccountError("QR asset is not a regular file", 404, "FILE_NOT_FOUND");
    }
    return {
      absolutePath,
      mimeType: "image/png",
      sizeBytes: stat.size,
    };
  } catch (err: any) {
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      throw err;
    }
    if (err.code === "ENOENT") {
      throw new PaymentAccountError("QR asset file is missing from storage", 404, "FILE_NOT_FOUND");
    }
    throw asStorageUnavailableError(err);
  }
}

export interface PaymentAccountAuditDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actor: {
    id: string;
    name: string;
    role: string;
  } | null;
  createdAt: Date;
  meta: Record<string, any>;
}

const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

function sanitizeAuditText(value: any, maxLength = 120): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // Strip control characters (ASCII 0-31, 127-159) and HTML tags consistent with requestValidation safeText
  const cleaned = value
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLength);
  return cleaned;
}

function sanitizeSettlementMethod(val: any): "FONEPAY" | "BANK_TRANSFER" | null {
  if (val === "FONEPAY" || val === "BANK_TRANSFER") {
    return val;
  }
  return null;
}

function sanitizeConfirmationMode(val: any): "MANUAL_RECEIPT" | "DISPLAY_ONLY" | null {
  if (val === "MANUAL_RECEIPT" || val === "DISPLAY_ONLY") {
    return val;
  }
  return null;
}

function sanitizeAuditPositiveInt(val: any): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val > 0) {
    return val;
  }
  return undefined;
}

function sanitizeAuditNonNegativeInt(val: any): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
    return val;
  }
  return undefined;
}

function sanitizeAuditDimension(val: any): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val >= 128 && val <= 4096) {
    return val;
  }
  return undefined;
}

function sanitizeAuditChecksum(val: any): string | undefined {
  if (typeof val === "string" && SHA256_HEX_REGEX.test(val.trim())) {
    return val.trim().toLowerCase();
  }
  return undefined;
}

export function sanitizePaymentAccountAuditMeta(action: string, rawMeta: any): Record<string, any> {
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    return {};
  }

  if (action === "PAYMENT_ACCOUNT_CREATED") {
    return {
      providerLabel: sanitizeAuditText(rawMeta.providerLabel, 120) ?? "",
      accountHolder: sanitizeAuditText(rawMeta.accountHolder, 120) ?? "",
      accountIdentifier: sanitizeAuditText(rawMeta.accountIdentifier, 120) || null,
      settlementMethod: sanitizeSettlementMethod(rawMeta.settlementMethod),
      confirmationMode: sanitizeConfirmationMode(rawMeta.confirmationMode),
      version: sanitizeAuditPositiveInt(rawMeta.version) ?? 1,
      enabled: rawMeta.enabled === true,
    };
  }

  if (action === "PAYMENT_ACCOUNT_UPDATED") {
    const sanitizeState = (s: any) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
      const res: Record<string, any> = {};
      if (typeof s.providerLabel === "string") {
        res.providerLabel = sanitizeAuditText(s.providerLabel, 120) ?? "";
      }
      if (typeof s.accountHolder === "string") {
        res.accountHolder = sanitizeAuditText(s.accountHolder, 120) ?? "";
      }
      if (s.accountIdentifier !== undefined) {
        res.accountIdentifier = typeof s.accountIdentifier === "string" ? (sanitizeAuditText(s.accountIdentifier, 120) || null) : null;
      }
      if (s.settlementMethod !== undefined) {
        res.settlementMethod = sanitizeSettlementMethod(s.settlementMethod);
      }
      if (s.confirmationMode !== undefined) {
        res.confirmationMode = sanitizeConfirmationMode(s.confirmationMode);
      }
      if (typeof s.enabled === "boolean") {
        res.enabled = s.enabled;
      }
      const version = sanitizeAuditPositiveInt(s.version);
      if (version !== undefined) {
        res.version = version;
      }
      return res;
    };

    return {
      previous: sanitizeState(rawMeta.previous),
      updated: sanitizeState(rawMeta.updated),
    };
  }

  if (action === "PAYMENT_ACCOUNT_QR_PUBLISHED") {
    let oldActiveAssetId: string | null | undefined = undefined;
    if (rawMeta.oldActiveAssetId === null) {
      oldActiveAssetId = null;
    } else if (typeof rawMeta.oldActiveAssetId === "string" && isValidUuid(rawMeta.oldActiveAssetId)) {
      oldActiveAssetId = rawMeta.oldActiveAssetId.trim();
    }

    return {
      assetId: typeof rawMeta.assetId === "string" && isValidUuid(rawMeta.assetId) ? rawMeta.assetId.trim() : undefined,
      oldActiveAssetId,
      version: sanitizeAuditPositiveInt(rawMeta.version),
      checksum: sanitizeAuditChecksum(rawMeta.checksum),
      width: sanitizeAuditDimension(rawMeta.width),
      height: sanitizeAuditDimension(rawMeta.height),
    };
  }

  if (action === "PAYMENT_ACCOUNT_REORDERED") {
    const changes: Array<{ id: string; oldSortOrder: number; newSortOrder: number; newVersion: number }> = [];
    if (Array.isArray(rawMeta.changes)) {
      for (const c of rawMeta.changes.slice(0, 100)) {
        if (!c || typeof c !== "object" || Array.isArray(c)) {
          continue;
        }
        const id = typeof c.id === "string" ? (sanitizeAuditText(c.id, 120) ?? "") : "";
        const oldSortOrder = sanitizeAuditNonNegativeInt(c.oldSortOrder) ?? 0;
        const newSortOrder = sanitizeAuditNonNegativeInt(c.newSortOrder) ?? 0;
        const newVersion = sanitizeAuditPositiveInt(c.newVersion) ?? 1;
        changes.push({
          id,
          oldSortOrder,
          newSortOrder,
          newVersion,
        });
      }
    }
    return { changes };
  }

  return {};
}

export async function listPaymentAccountAudit(accountId: string): Promise<PaymentAccountAuditDto[]> {
  if (!isValidUuid(accountId)) {
    throw new PaymentAccountError("Invalid account ID format", 400, "INVALID_ACCOUNT_ID");
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      action: { startsWith: "PAYMENT_ACCOUNT_" },
      OR: [
        { entityId: accountId },
        { entityType: "PaymentReceivingAccountCollection" },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorId: true,
      createdAt: true,
      meta: true,
      actor: {
        select: {
          id: true,
          name: true,
          role: true,
        },
      },
    },
  });

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    actorId: log.actorId,
    actor: log.actor
      ? {
          id: log.actor.id,
          name: log.actor.name,
          role: log.actor.role,
        }
      : null,
    createdAt: log.createdAt,
    meta: sanitizePaymentAccountAuditMeta(log.action, log.meta),
  }));
}
