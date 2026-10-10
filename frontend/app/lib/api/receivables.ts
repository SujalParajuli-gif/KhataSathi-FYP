import api from "./client";
export type ReceivableInvoice = { invoiceId: string; invoiceNo: string; basis: "UNRESOLVED" | "ORIGINAL_SALE_DEBT_FIRST"; reason: string | null; originalPayable: number; returnAdjustment: number; recordedReceipts: number; due: number | null; retainedCredit: number | null };
export type ReceivableCustomer = { id: string; name: string; isActive: boolean; due: number | null; retainedCredit: number | null; supportedDue: number; supportedCredit: number; unresolvedCount: number; invoices: ReceivableInvoice[] };
export async function customerReceivables(q: string, page: number, signal?: AbortSignal) {
  return (await api.get<{ items: ReceivableCustomer[]; total: number; totalPages: number; basis: string }>("/api/customers/receivables", { params: { q, page, pageSize: 20 }, signal })).data;
}
