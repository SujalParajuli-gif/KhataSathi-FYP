import api from "./client";
import { LONG_API_TIMEOUT_MS } from "./requestPolicy";
import type { SalesEvidenceRecord, PublicSaleCandidate } from "./manualBills";
export type SalesLine = { name: string; code: string | null; unit: string | null; quantity: string | null; unitPrice: string | null };
export type SalesObservations = { billNumber: string | null; customerName: string | null; billDate: string | null; total: string | null; lines: SalesLine[] };
export type CorrectedSale = Omit<SalesObservations, "lines"> & { lines: (SalesLine & { productId: string | null })[] };
export type SalesReview = { revision: string; model: string; extractedAt: string; observations: SalesObservations; corrected: CorrectedSale | null };
export type ReviewResponse = { document: SalesEvidenceRecord; review: SalesReview | null };
export type SalesMatch = PublicSaleCandidate & { eligible: boolean; warning: string; differences: string[] };
export type ProductSuggestion = { id: string; name: string; sku: string | null; saleUnit: string; packageUnit: string; packageQuantity: number | null; brand: { name: string } };
export type Matches = { products: ProductSuggestion[]; candidates: SalesMatch[]; duplicates: { id: string; title: string | null; fileName: string; saleRecoveryStatus: string; linkedEntityId: string | null }[]; searched: boolean; limit: number; warning: string };
const path = (id: string) => `/api/sales-evidence/${encodeURIComponent(id)}`;
export async function getSalesReview(id: string, signal?: AbortSignal) { return (await api.get<ReviewResponse>(`${path(id)}/review`, { signal })).data; }
export async function extractSalesReview(id: string, input: { operationKey: string; expectedRevision: string | null }) { return (await api.post<ReviewResponse>(`${path(id)}/extract`, input, { timeout: LONG_API_TIMEOUT_MS })).data; }
export async function saveSalesReview(id: string, expectedRevision: string | null, corrected: CorrectedSale) { return (await api.patch<ReviewResponse>(`${path(id)}/review`, { expectedRevision, corrected })).data; }
export async function salesMatches(id: string, q?: string) { return (await api.get<Matches>(`${path(id)}/review-matches`, { params: q ? { q } : {} })).data; }
