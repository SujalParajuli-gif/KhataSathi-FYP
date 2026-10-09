import api from "./client";

export type PaymentReceivingConfirmationMode = "MANUAL_RECEIPT" | "DISPLAY_ONLY";
export type SupportedPaymentMethod = "FONEPAY" | "BANK_TRANSFER";

export interface PaymentReceivingQrAssetDto {
  id: string;
  accountId: string;
  publicationExpectedVersion: number;
  storedPath?: string;
  fileName: string;
  thumbnailFileName: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailSizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  sourceChecksum: string;
  createdById: string;
  createdAt: string;
}

export interface PaymentReceivingAccountDto {
  id: string;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier: string | null;
  settlementMethod: "FONEPAY" | "BANK_TRANSFER" | null;
  confirmationMode: PaymentReceivingConfirmationMode;
  enabled: boolean;
  sortOrder: number;
  version: number;
  activeQrAssetId: string | null;
  activeQrAsset?: PaymentReceivingQrAssetDto | null;
  createdById: string;
  createdBy?: { id: string; name: string };
  updatedById: string;
  updatedBy?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  totalAssetsCount?: number;
  linkedPaymentsCount?: number;
}

export interface EnabledPaymentAccountDto {
  id: string;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier: string | null;
  settlementMethod: "FONEPAY" | "BANK_TRANSFER" | null;
  confirmationMode: PaymentReceivingConfirmationMode;
  version: number;
  activeQrAssetId: string;
  activeQrThumbnailUrl: string;
  activeQrFileUrl: string;
  supportedSettlement: boolean;
}

export interface CreatePaymentAccountPayload {
  id: string;
  providerLabel: string;
  accountHolder: string;
  accountIdentifier?: string | null;
  settlementMethod?: "FONEPAY" | "BANK_TRANSFER" | null;
  confirmationMode: PaymentReceivingConfirmationMode;
}

export interface PatchPaymentAccountPayload {
  expectedVersion: number;
  providerLabel?: string;
  accountHolder?: string;
  accountIdentifier?: string | null;
  settlementMethod?: "FONEPAY" | "BANK_TRANSFER" | null;
  confirmationMode?: PaymentReceivingConfirmationMode;
  enabled?: boolean;
}

export interface ReorderPaymentAccountItem {
  id: string;
  expectedVersion: number;
}

export interface PaymentAccountAuditLogDto {
  id: string;
  action: string;
  actorId: string;
  actor?: { id: string; name: string; role: string };
  meta: any;
  createdAt: string;
}

export async function listPaymentAccountsApi(options?: {
  signal?: AbortSignal;
}): Promise<PaymentReceivingAccountDto[]> {
  const res = await api.get("/api/settings/payment-accounts", {
    signal: options?.signal,
  });
  return res.data;
}

export async function getEnabledPaymentAccountsApi(options?: {
  signal?: AbortSignal;
}): Promise<EnabledPaymentAccountDto[]> {
  const res = await api.get("/api/settings/payment-accounts/enabled", {
    signal: options?.signal,
  });
  return res.data;
}

export async function createPaymentAccountApi(
  payload: CreatePaymentAccountPayload,
  options?: { signal?: AbortSignal },
): Promise<PaymentReceivingAccountDto> {
  const res = await api.post("/api/settings/payment-accounts", payload, {
    signal: options?.signal,
  });
  return res.data;
}

export async function patchPaymentAccountApi(
  id: string,
  payload: PatchPaymentAccountPayload,
  options?: { signal?: AbortSignal },
): Promise<PaymentReceivingAccountDto> {
  const res = await api.patch(`/api/settings/payment-accounts/${id}`, payload, {
    signal: options?.signal,
  });
  return res.data;
}

export async function reorderPaymentAccountsApi(
  orders: ReorderPaymentAccountItem[],
  options?: { signal?: AbortSignal },
): Promise<PaymentReceivingAccountDto[]> {
  const res = await api.put("/api/settings/payment-accounts/order", { orders }, {
    signal: options?.signal,
  });
  return res.data;
}

export async function uploadQrAssetApi(
  accountId: string,
  uploadId: string,
  expectedVersion: number,
  file: File,
  options?: { signal?: AbortSignal },
): Promise<PaymentReceivingQrAssetDto> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("uploadId", uploadId);
  formData.append("expectedVersion", String(expectedVersion));

  const res = await api.post(`/api/settings/payment-accounts/${accountId}/qr`, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
    signal: options?.signal,
  });
  return res.data;
}

export async function listPaymentAccountAuditApi(
  accountId: string,
  options?: { signal?: AbortSignal },
): Promise<PaymentAccountAuditLogDto[]> {
  const res = await api.get(`/api/settings/payment-accounts/${accountId}/audit`, {
    signal: options?.signal,
  });
  return res.data;
}

export async function fetchAuthenticatedBlobUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException("The user aborted a request.", "AbortError");
  }
  if (!url.startsWith("/api/")) {
    throw new Error("Invalid protected asset URL");
  }
  const res = await api.get(url, {
    responseType: "blob",
    signal,
  });
  if (signal?.aborted) {
    throw new DOMException("The user aborted a request.", "AbortError");
  }
  if (!(res.data instanceof Blob) || res.data.type.split(";")[0] !== "image/png") {
    throw new Error("Protected QR response is not a PNG image");
  }
  return URL.createObjectURL(res.data);
}
