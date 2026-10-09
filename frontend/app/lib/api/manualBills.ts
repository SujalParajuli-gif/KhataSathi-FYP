import api from "./client";
import { API_BASE_URL } from "./baseUrl";

export type ExternalDocumentType =
  | "PAN_INVOICE"
  | "VAT_TAX_INVOICE"
  | "ABBREVIATED_TAX_INVOICE"
  | "OTHER_MANUAL_SALES_DOCUMENT";

export type BillRecordStatus =
  | "PENDING"
  | "RECORDED"
  | "VERIFIED"
  | "MISSING";

export type BillingChannel =
  | "MANUAL_EXTERNAL"
  | "IRD_ELECTRONIC";

export type SaleRecoveryStatus =
  | "UNRESOLVED"
  | "ATTACHED"
  | "ARCHIVED";

export interface AttachedProofSummary {
  id: string;
  title: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  thumbnailFileName: string | null;
  visibility: string;
  saleRecoveryStatus: SaleRecoveryStatus | null;
  createdAt: string;
  fileUrl: string;
  thumbnailUrl: string | null;
}

export interface ManualBillAuditEntry {
  id: string;
  action: string;
  actorId: string;
  actorName: string | null;
  actorRole: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface ManualBillRecord {
  id: string;
  invoiceNo: string;
  status: "DRAFT" | "FINALIZED";
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null; // YYYY-MM-DD
  billRecordStatus: BillRecordStatus | null;
  netTotal: number;
  finalizedAt: string | null;
  cancelledAt: string | null;
  paymentStatus: string;
  customerName: string | null;
  customerPan: string | null;
  replacementInvoiceId: string | null;
  originalInvoiceId: string | null;
  attachedProofs: AttachedProofSummary[];
  history: ManualBillAuditEntry[];
}

export interface ManualBillQueueItem {
  id: string;
  invoiceNo: string;
  status: "DRAFT" | "FINALIZED";
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null; // YYYY-MM-DD
  billRecordStatus: BillRecordStatus | null;
  netTotal: number;
  finalizedAt: string | null;
  paymentStatus: string;
  customerName: string | null;
  attachedProofCount: number;
}

export interface ManualBillQueueResponse {
  items: ManualBillQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ExpectedManualBillRecord {
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null;
  billRecordStatus: BillRecordStatus | null;
}

export interface RecordReferencePayload {
  reference: {
    billNo: string;
    externalDocumentType: ExternalDocumentType;
    externalBillDate: string; // YYYY-MM-DD
  };
  expected: ExpectedManualBillRecord;
  reason?: string;
  duplicateOverrideReason?: string;
}

export interface VerifyReferencePayload {
  expected: ExpectedManualBillRecord;
  reason: string;
}

export interface MarkMissingPayload {
  expected: ExpectedManualBillRecord;
  reason: string;
}

export interface WithdrawReferencePayload {
  expected: ExpectedManualBillRecord;
  targetStatus: "PENDING" | "MISSING";
  reason: string;
}

export interface SalesEvidenceRecord {
  id: string;
  documentType: "SALE_BILL";
  title: string | null;
  fileName: string;
  storedFileName: string;
  storedPath: string;
  mimeType: string;
  fileSize: number;
  checksum: string | null;
  thumbnailFileName: string | null;
  thumbnailSize: number | null;
  remarks: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  visibility: string;
  saleRecoveryStatus: SaleRecoveryStatus | null;
  canVoidMistakenUpload?: boolean;
  uploadedById: string;
  uploadedBy?: { id: string; name: string };
  createdAt: string;
}

export interface ListSalesEvidenceResponse {
  documents: SalesEvidenceRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PublicSaleCandidate {
  id: string;
  invoiceNo: string;
  netTotal: number;
  finalizedAt: string | null;
  paymentStatus: string;
  customerName: string | null;
  customerPan: string | null;
  billingChannel: string | null;
  billRecordStatus: string | null;
  externalBillNo: string | null;
  externalBillDate: string | null;
  externalDocumentType: string | null;
}

export interface AttachSaleEvidencePayload {
  invoiceId: string;
  reference: {
    billNo: string;
    externalDocumentType: ExternalDocumentType;
    externalBillDate: string;
  };
  expectedInvoice: ExpectedManualBillRecord;
  reason: string;
  duplicateOverrideReason?: string;
}

export async function reassociateSalesEvidence(id: string, data: AttachSaleEvidencePayload & {
  expectedSourceInvoiceId: string; expectedSourceInvoice: ExpectedManualBillRecord;
}) {
  return (await api.post(`/api/sales-evidence/${id}/reassociate`, data)).data;
}
export async function voidSalesEvidence(id: string, data: { expectedStatus: "UNRESOLVED" | "ARCHIVED"; reason: string }) {
  return (await api.post(`/api/sales-evidence/${id}/void`, data)).data;
}
export async function getSalesEvidenceHistory(id: string): Promise<{ document: {
  id: string; saleRecoveryStatus: SaleRecoveryStatus; linkedEntityId: string | null; voidedAt: string | null; retained: boolean;
}; history: ManualBillAuditEntry[] }> {
  return (await api.get(`/api/sales-evidence/${id}/history`)).data;
}

// Queue
export async function getManualBillQueue(params?: {
  page?: number;
  pageSize?: number;
  status?: "PENDING" | "MISSING" | "ALL";
  search?: string;
}): Promise<ManualBillQueueResponse> {
  const res = await api.get("/api/invoices/manual-bills/queue", { params });
  return res.data;
}

// Invoice manual bill details
export async function getManualBillRecord(
  invoiceId: string,
): Promise<ManualBillRecord> {
  const res = await api.get(`/api/invoices/manual-bills/${invoiceId}`);
  return res.data;
}

// Actions
export async function recordManualBillReference(
  invoiceId: string,
  data: RecordReferencePayload,
): Promise<ManualBillRecord> {
  const res = await api.post(`/api/invoices/manual-bills/${invoiceId}/reference`, data);
  return res.data;
}

export async function verifyManualBillReference(
  invoiceId: string,
  data: VerifyReferencePayload,
): Promise<ManualBillRecord> {
  const res = await api.post(`/api/invoices/manual-bills/${invoiceId}/verify`, data);
  return res.data;
}

export async function markManualBillMissing(
  invoiceId: string,
  data: MarkMissingPayload,
): Promise<ManualBillRecord> {
  const res = await api.post(`/api/invoices/manual-bills/${invoiceId}/missing`, data);
  return res.data;
}

export async function withdrawManualBillReference(
  invoiceId: string,
  data: WithdrawReferencePayload,
): Promise<ManualBillRecord> {
  const res = await api.post(`/api/invoices/manual-bills/${invoiceId}/withdraw`, data);
  return res.data;
}

// Invoice-bound proof URLs & Blobs
export function getManualBillProofFileUrl(
  invoiceId: string,
  documentId: string,
): string {
  return `${API_BASE_URL}/api/invoices/manual-bills/${invoiceId}/proofs/${documentId}/file`;
}

export function getManualBillProofThumbnailUrl(
  invoiceId: string,
  documentId: string,
): string {
  return `${API_BASE_URL}/api/invoices/manual-bills/${invoiceId}/proofs/${documentId}/thumbnail`;
}

export async function fetchManualBillProofBlob(
  invoiceId: string,
  documentId: string,
): Promise<Blob> {
  const res = await api.get<Blob>(
    `/api/invoices/manual-bills/${invoiceId}/proofs/${documentId}/file`,
    { responseType: "blob" },
  );
  return res.data;
}

// Sales Evidence reviewer endpoints
export async function getSalesEvidence(documentId: string): Promise<SalesEvidenceRecord> {
  const res = await api.get(`/api/sales-evidence/${documentId}`);
  return res.data;
}

export async function listSalesEvidence(params?: {
  page?: number;
  pageSize?: number;
  q?: string;
  saleRecoveryStatus?: SaleRecoveryStatus;
}): Promise<ListSalesEvidenceResponse> {
  const res = await api.get("/api/sales-evidence", { params });
  return res.data;
}

export async function uploadSalesEvidence(
  formData: FormData,
): Promise<{ document: SalesEvidenceRecord }> {
  const res = await api.post("/api/sales-evidence", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
}

export async function archiveSalesEvidence(
  documentId: string,
  data: { reason: string },
): Promise<{ document: SalesEvidenceRecord; replayed: boolean }> {
  const res = await api.post(`/api/sales-evidence/${documentId}/archive`, data);
  return res.data;
}

export async function getSalesEvidenceCandidates(
  documentId: string,
  search?: string,
): Promise<{ candidates: PublicSaleCandidate[] }> {
  const res = await api.get(`/api/sales-evidence/${documentId}/candidates`, {
    params: { search, limit: 15 },
  });
  return res.data;
}

export async function attachSalesEvidence(
  documentId: string,
  data: AttachSaleEvidencePayload,
): Promise<{
  document: SalesEvidenceRecord;
  invoice: ManualBillRecord;
  replayed: boolean;
}> {
  const res = await api.post(`/api/sales-evidence/${documentId}/attach`, data);
  return res.data;
}

export function getSalesEvidenceFileUrl(documentId: string): string {
  return `${API_BASE_URL}/api/sales-evidence/${documentId}/file`;
}

export function getSalesEvidenceThumbnailUrl(documentId: string): string {
  return `${API_BASE_URL}/api/sales-evidence/${documentId}/thumbnail`;
}

export async function fetchSalesEvidenceBlob(
  documentId: string,
  variant: "file" | "thumbnail" = "file",
): Promise<Blob> {
  const res = await api.get<Blob>(`/api/sales-evidence/${documentId}/${variant}`, {
    responseType: "blob",
  });
  return res.data;
}

// Missing sale recovery endpoints and types
export type PaymentAssessmentType =
  | "NOT_COLLECTED"
  | "CURRENT_DRAWER_CASH"
  | "PRIOR_OR_OTHER_CASH"
  | "PRIOR_DIGITAL"
  | "UNKNOWN";

export type PaymentAssessment =
  | {
      type: "NOT_COLLECTED";
      explanation: string;
    }
  | {
      type: "CURRENT_DRAWER_CASH";
      drawerId: string;
      collectedAt: string;
      explanation: string;
      alreadyAccounted: false;
    }
  | {
      type: "PRIOR_OR_OTHER_CASH";
      explanation: string;
      collectedByActorId?: string;
      collectedDrawerId?: string;
      collectedAt?: string;
      alreadyAccounted?: boolean;
    }
  | {
      type: "PRIOR_DIGITAL";
      explanation: string;
      gatewayOrMethod?: string;
      externalReference?: string;
      transactionStatus?: string;
    }
  | {
      type: "UNKNOWN";
      explanation: string;
    };

export interface RecoveryCheckoutItem {
  productId: string;
  qty: number;
  overrideUnitPrice?: number | null;
  overrideReason?: string | null;
  overrideAuthorizationToken?: string | null;
}

export interface RecoveryCheckoutPayment {
  method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER" | "NONE";
  amount?: number;
  reference?: string;
  tenderedAmount?: number;
}

export interface RecoveryCheckoutConfirmation {
  items: Array<{
    productId: string;
    qty: number;
    appliedUnitPrice: number;
  }>;
  payableTotal: number;
}

export interface RecoveryCheckoutInput {
  customerId?: string | null;
  items: RecoveryCheckoutItem[];
  discountAmount?: number;
  overridePin?: string | null;
  notes?: string | null;
  payment?: RecoveryCheckoutPayment | null;
  payments?: RecoveryCheckoutPayment[] | null;
  confirmation?: RecoveryCheckoutConfirmation | null;
}

export interface SaleEvidenceRecoveryPayload {
  reference: {
    billNo: string;
    externalDocumentType: ExternalDocumentType;
    externalBillDate: string; // YYYY-MM-DD
  };
  reason: string;
  duplicateOverrideReason?: string;
  paymentAssessment: PaymentAssessment;
  checkout: RecoveryCheckoutInput;
}

export interface ReviseSaleEvidenceRecoveryPayload {
  expectedAttemptId: string;
  reason: string;
  recovery: SaleEvidenceRecoveryPayload;
}

export interface SaleEvidenceRecoveryOutcome {
  status: "UNPREPARED" | "PREPARED" | "COMMITTED" | "ARCHIVED" | "UNCERTAIN";
  document: SalesEvidenceRecord;
  invoice: ManualBillRecord | null;
  esewaPaymentIntent?: any | null;
  latestAttempt?: {
    id: string;
    actorId: string;
    createdAt: string;
    reason?: string | null;
  } | null;
  retryEligible: boolean;
  blockedReason?: string | null;
  uncertainExplanation?: string | null;
}

export async function getSalesEvidenceRecoveryOutcome(
  documentId: string,
): Promise<SaleEvidenceRecoveryOutcome> {
  const res = await api.get(`/api/sales-evidence/${documentId}/recovery`);
  return res.data;
}

export async function postSalesEvidenceRecovery(
  documentId: string,
  data: SaleEvidenceRecoveryPayload,
): Promise<{
  document: SalesEvidenceRecord;
  invoice: ManualBillRecord;
  esewaPaymentIntent: any | null;
  replayed: boolean;
}> {
  const res = await api.post(`/api/sales-evidence/${documentId}/recovery`, data);
  return res.data;
}

export async function reviseSalesEvidenceRecovery(
  documentId: string,
  data: ReviseSaleEvidenceRecoveryPayload,
): Promise<{
  document: SalesEvidenceRecord;
  attemptId: string;
  status: "PREPARED";
}> {
  const res = await api.post(`/api/sales-evidence/${documentId}/recovery/revise`, data);
  return res.data;
}
