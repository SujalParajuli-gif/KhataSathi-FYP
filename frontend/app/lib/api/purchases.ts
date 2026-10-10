import api from "./client";

export type Supplier = { id: string; name: string; contact: string | null; phone: string | null; panNo: string | null; address: string | null; isActive: boolean };
export type SupplierBalance = {
  supplier: Pick<Supplier, "id" | "name" | "isActive">;
  basis: "RECORDED_SUPPLIER_RECEIPTS";
  postedReceiptCount: number; unknownReceiptCount: number;
  payable: string; paid: string; due: string; recordedBalance: string | null;
};
export type PurchaseLine = { productId: string; inputUnit: string; inputQty: string; conversionFactor: string; unitAcquisitionCost: string };
export type ReceiptInput = { supplierId: string; billNumber: string; billDate: string | null; remarks: string; payable: string; lines: PurchaseLine[]; documentIds: string[]; operationKey: string };
export type PaymentInput = { amount: string; method: "CASH" | "BANK_TRANSFER" | "OTHER"; reference: string; paidAt: string; operationKey: string };
export type PurchasePayment = { id: string; amount: string; method: string; reference: string | null; paidAt: string; isVoided: boolean; voidReason: string | null };
export type ReceiptSummary = { id: string; capturedSupplierName: string | null; billNumber: string | null; billDate: string | null; payable: string | null; paid: string | null; due: string | null; paymentStatus: string; isFinancial: boolean; knownPayable: boolean };
export type PurchaseReceipt = { id: string; supplierName: string; supplier: Supplier | null; billNumber: string | null; billDate: string | null; isFinancial: boolean; payable: string | null; paidTotal: string | null; dueAmount: string | null; paymentStatus: string; items: (PurchaseLine & { id: string; productName: string; sku: string; stockQty: string; lineAmount: string })[]; payments: PurchasePayment[]; documents: { id: string; title: string | null; fileName: string }[] };
export type Page<T> = { total: number; page: number; pageSize: number; totalPages: number; items: T[] };
const root = "/api/inventory";
export async function supplierBalance(id: string, signal?: AbortSignal) {
  return (await api.get<{ balance: SupplierBalance }>(`${root}/suppliers/${encodeURIComponent(id)}/balance`, { signal })).data.balance;
}
export async function suppliers(params: { q?: string; page?: number; includeInactive?: boolean }, signal?: AbortSignal) {
  return (await api.get<{ suppliers: Supplier[]; totalPages: number }>(`${root}/suppliers`, { params: { pageSize: 20, ...params }, signal })).data;
}
export async function saveSupplier(input: Omit<Supplier, "id">, id?: string) {
  return (id ? await api.patch<{ supplier: Supplier }>(`${root}/suppliers/${id}`, input) : await api.post<{ supplier: Supplier }>(`${root}/suppliers`, input)).data.supplier;
}
export async function receipts(params: { q?: string; page: number; supplierId?: string; kind?: string }, signal?: AbortSignal) {
  return (await api.get<Page<ReceiptSummary>>(`${root}/purchases`, { params: { pageSize: 20, ...params }, signal })).data;
}
export async function receipt(id: string, signal?: AbortSignal) {
  return (await api.get<{ receipt: PurchaseReceipt }>(`${root}/purchases/${id}`, { signal })).data.receipt;
}
export async function postReceipt(input: ReceiptInput) {
  return (await api.post<{ receipt: PurchaseReceipt }>(`${root}/purchases`, input)).data.receipt;
}
export async function postPayment(id: string, input: PaymentInput) {
  return (await api.post<{ payment: PurchasePayment }>(`${root}/purchases/${id}/installments`, input)).data.payment;
}
export async function voidPayment(id: string, reason: string) {
  return (await api.post(`${root}/purchase-installments/${id}/void`, { reason })).data;
}
export async function attachDocuments(id: string, documentIds: string[]) {
  return (await api.post<{ receipt: PurchaseReceipt }>(`${root}/purchases/${id}/attachments`, { documentIds })).data.receipt;
}

export function purchaseError(error: unknown): string {
  const e = error as { response?: { status: number; data?: { error?: string; code?: string } }; message?: string };
  if (e.response?.data?.code === "PURCHASE_SCHEMA_UNAVAILABLE") return "Purchases are unavailable until the approved feature migration is applied.";
  return e.response?.data?.error || e.message || "Unable to complete this action. Your input is preserved.";
}
export function ambiguousPurchaseError(error: unknown) {
  const e = error as { response?: { status: number } };
  return !e.response || e.response.status >= 500 || e.response.status === 408;
}
