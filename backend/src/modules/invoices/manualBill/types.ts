import type {
  BillingChannel,
  BillRecordStatus,
  DocumentVisibility,
  ExternalDocumentType,
  InvoiceStatus,
  PaymentStatusInvoice,
  Role,
  SaleRecoveryStatus,
} from "@prisma/client";

export interface ManualBillActor {
  id: string;
  role: Role;
  name?: string;
}

export interface AttachedProofSummary {
  id: string;
  title: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  thumbnailFileName: string | null;
  visibility: DocumentVisibility;
  saleRecoveryStatus: SaleRecoveryStatus | null;
  createdAt: Date;
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
  createdAt: Date;
}

export interface PublicManualBillRecord {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null; // YYYY-MM-DD
  billRecordStatus: BillRecordStatus | null;
  netTotal: number;
  finalizedAt: Date | null;
  cancelledAt: Date | null;
  paymentStatus: PaymentStatusInvoice;
  customerName: string | null;
  customerPan: string | null;
  replacementInvoiceId: string | null;
  originalInvoiceId: string | null;
  attachedProofs: AttachedProofSummary[];
  history: ManualBillAuditEntry[];
}

export type ExpectedManualBillRecord = {
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null; // YYYY-MM-DD
  billRecordStatus: BillRecordStatus | null;
  [key: string]: unknown;
};

export interface ManualBillReferenceInput {
  billNo: string;
  externalDocumentType: ExternalDocumentType;
  externalBillDate: string; // YYYY-MM-DD
}

export interface RecordReferenceInput {
  reference: ManualBillReferenceInput;
  expected: ExpectedManualBillRecord;
  reason?: string;
  duplicateOverrideReason?: string;
}

export interface VerifyReferenceInput {
  expected: ExpectedManualBillRecord;
  reason: string;
}

export interface MarkMissingInput {
  expected: ExpectedManualBillRecord;
  reason: string;
}

export interface WithdrawReferenceInput {
  expected: ExpectedManualBillRecord;
  targetStatus: "PENDING" | "MISSING";
  reason: string;
}

export interface ListManualBillQueueInput {
  page?: number;
  pageSize?: number;
  status?: "PENDING" | "MISSING" | "ALL";
  search?: string;
}

export interface ManualBillQueueItem {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  billingChannel: BillingChannel | null;
  externalDocumentType: ExternalDocumentType | null;
  externalBillNo: string | null;
  externalBillDate: string | null; // YYYY-MM-DD
  billRecordStatus: BillRecordStatus | null;
  netTotal: number;
  finalizedAt: Date | null;
  paymentStatus: PaymentStatusInvoice;
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

export interface DuplicateReferenceWarning {
  invoiceId: string;
  invoiceNo: string;
  externalBillNo: string;
  externalBillDate: string;
  externalDocumentType: ExternalDocumentType;
  finalizedAt: Date | null;
}

export class ManualBillValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ManualBillValidationError";
  }
}

export class ManualBillAuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code: string;

  constructor(message: string, code = "FORBIDDEN") {
    super(message);
    this.name = "ManualBillAuthorizationError";
    this.code = code;
  }
}

export class ManualBillConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  readonly currentRecord?: PublicManualBillRecord | null;
  readonly duplicates?: DuplicateReferenceWarning[];

  constructor(
    message: string,
    code = "CONFLICT",
    options?: {
      currentRecord?: PublicManualBillRecord | null;
      duplicates?: DuplicateReferenceWarning[];
    },
  ) {
    super(message);
    this.name = "ManualBillConflictError";
    this.code = code;
    this.currentRecord = options?.currentRecord;
    this.duplicates = options?.duplicates;
  }
}

export class ManualBillNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";

  constructor(message = "Manual bill record not found") {
    super(message);
    this.name = "ManualBillNotFoundError";
  }
}
