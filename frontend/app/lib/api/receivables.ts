import api from "./client";
export type CreditApplication = { id: string; sourceInvoiceId: string; sourceInvoiceNo: string; targetInvoiceId: string; targetInvoiceNo: string; sourceReturnId: string | null; sourceCorrectionId?: string | null; amount: number; reason: string; actorId: string; createdAt: string; reversedAt: string | null; reversedById: string | null; reversalReason: string | null };
export type ReceivableInvoice = { invoiceId: string; invoiceNo: string; basis: "UNRESOLVED" | "ORIGINAL_SALE_DEBT_FIRST" | "CAPTURED_CORRECTION"; reason: string | null; originalPayable: number; returnAdjustment: number; recordedReceipts: number; due: number | null; retainedCredit: number | null; correctionCredit?: number; correction?: { sourceInvoiceId: string; targetInvoiceId: string | null; action: string; transferredCredit: number; retainedCredit: number; originalCustomerId: string | null; reason: string; actorId: string; createdAt: string } | null; appliedCredit?: number; usedCredit?: number; creditSources?: { returnId?: string; correctionId?: string; retainedCredit: number; availableCredit: number }[]; applications?: CreditApplication[] };
export type ReceivableCustomer = { id: string; name: string; isActive: boolean; due: number | null; retainedCredit: number | null; supportedDue: number; supportedCredit: number; unresolvedCount: number; invoices: ReceivableInvoice[] };
export async function customerReceivables(q: string, page: number, signal?: AbortSignal) {
  return (await api.get<{ items: ReceivableCustomer[]; total: number; totalPages: number; basis: string }>("/api/customers/receivables", { params: { q, page, pageSize: 20 }, signal })).data;
}
export async function applyCredit(input: { sourceReturnId?: string; sourceCorrectionId?: string; targetInvoiceId: string; amount: number; reason: string; operationKey: string }) {
  return (await api.post<CreditApplication>("/api/customers/credit-applications", input)).data;
}
export async function reverseCredit(id: string, input: { reason: string; operationKey: string }) {
  return (await api.post<CreditApplication>(`/api/customers/credit-applications/${encodeURIComponent(id)}/reverse`, input)).data;
}
