import api from "./client";
import { LONG_API_TIMEOUT_MS } from "./requestPolicy";
export type BillLine = { name: string; code: string | null; unit: string | null; quantity: string | null; cost: string | null };
export type Observations = { supplierName: string | null; billNumber: string | null; billDate: string | null; payable: string | null; lines: BillLine[] };
export type CorrectedBill = Omit<Observations, "lines"> & { supplierId: string | null; lines: (BillLine & { productId: string | null })[] };
export type Review = { revision: string; extractionId: string; operationKey: string; model: string; extractedAt: string; observations: Observations; warnings: string[]; corrected: CorrectedBill | null };
export type ReviewResponse = { document: { id: string; title: string; mimeType: string; fileUrl: string }; review: Review | null };
export type Candidate = { id: string; name: string; sku?: string; saleUnit?: string; packageUnit?: string; packageQuantity?: number | null };
export type Duplicate = { id: string; supplierName: string | null; billNumber: string | null; knownPayable: boolean; reason: string };
const path = (id: string) => `/api/inventory/purchase-sources/${encodeURIComponent(id)}`;
export async function getBillReview(id: string, signal?: AbortSignal) { return (await api.get<ReviewResponse>(`${path(id)}/review`, { signal })).data; }
export async function extractBill(id: string, operationKey: string, expectedRevision: string | null, signal?: AbortSignal) { return (await api.post<ReviewResponse>(`${path(id)}/extract`, { operationKey, expectedRevision }, { signal, timeout: LONG_API_TIMEOUT_MS })).data; }
export async function saveBillReview(id: string, expectedRevision: string, corrected: CorrectedBill, signal?: AbortSignal) { return (await api.patch<ReviewResponse>(`${path(id)}/review`, { expectedRevision, corrected }, { signal })).data; }
export async function billCandidates(id: string, q: string, kind: "supplier" | "product", signal?: AbortSignal) { return (await api.get<{ items: Candidate[] }>(`${path(id)}/candidates`, { params: { q, kind }, signal })).data.items; }
export async function billDuplicates(id: string, signal?: AbortSignal) { return (await api.get<{ items: Duplicate[] }>(`${path(id)}/duplicates`, { signal })).data.items; }
