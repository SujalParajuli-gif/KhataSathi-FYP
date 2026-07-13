import { z } from "zod/v4";

// valid document types matching the Prisma DocumentType enum
export const DOCUMENT_TYPES = [
  "STOCK_BILL",
  "PRODUCT_IMPORT",
  "RETURN_PROOF",
  "PAYMENT_PROOF",
  "DISCOUNT_PROOF",
  "GENERAL",
] as const;

export const DOCUMENT_VISIBILITIES = [
  "ALL_AUTHENTICATED",
  "ADMIN_MANAGER",
  "ADMIN_ONLY",
] as const;

// allowed MIME types for document uploads
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

// maximum file size: 10MB per file
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

// maximum number of files per single upload
export const MAX_FILES_PER_UPLOAD = 5;

// schema for creating a document (metadata sent alongside the file upload)
export const createDocumentSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  supplierName: z.string().max(255).optional(),
  billNumber: z.string().max(100).optional(),
  billDate: z.string().optional(), // ISO date string, parsed in service
  billAmount: z.coerce.number().min(0).optional(),
  remarks: z.string().max(2000).optional(),
  linkedEntityType: z.string().max(100).optional(),
  linkedEntityId: z.string().max(100).optional(),
  visibility: z.enum(DOCUMENT_VISIBILITIES).optional(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

// schema for filtering documents in the list endpoint
export const listDocumentsSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  processingStatus: z.enum(["PROCESSED", "UNPROCESSED"]).optional(),
  visibility: z.enum(DOCUMENT_VISIBILITIES).optional(),
  supplierName: z.string().optional(),
  billNumber: z.string().optional(),
  linkedEntityType: z.string().optional(),
  linkedEntityId: z.string().optional(),
  from: z.string().optional(), // ISO date — filter by createdAt >= from
  to: z.string().optional(),   // ISO date — filter by createdAt <= to
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;

export const updateDocumentVisibilitySchema = z.object({
  visibility: z.enum(DOCUMENT_VISIBILITIES),
});

export type UpdateDocumentVisibilityInput = z.infer<
  typeof updateDocumentVisibilitySchema
>;
