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

const documentTitleSchema = z.string().trim().min(2).max(160);

// schema for creating a document (metadata sent alongside the file upload)
export const createDocumentSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  titles: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
    z.array(documentTitleSchema).max(MAX_FILES_PER_UPLOAD).optional(),
  ),
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
  q: z.string().trim().max(255).optional(),
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

export const updateDocumentMetadataSchema = z.object({
  title: documentTitleSchema.optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  supplierName: z.string().max(255).nullable().optional(),
  billNumber: z.string().max(100).nullable().optional(),
  billDate: z.string().nullable().optional(),
  billAmount: z.preprocess(
    (value) => (value === "" ? null : value),
    z.union([z.coerce.number().min(0), z.null()]).optional(),
  ),
  remarks: z.string().max(2000).nullable().optional(),
});

export type UpdateDocumentMetadataInput = z.infer<
  typeof updateDocumentMetadataSchema
>;

import fs from "fs/promises";
import sharp from "sharp";

export async function detectDocumentFormat(
  filePath: string,
): Promise<{ mimeType: string; extension: string } | null> {
  // Read the file entirely once; system errors should not be swallowed.
  const fileBuffer = await fs.readFile(filePath);

  // Check if it's a valid PDF by reading the signature from the buffer
  if (fileBuffer.length >= 5 && fileBuffer.subarray(0, 5).toString("utf-8") === "%PDF-") {
    return { mimeType: "application/pdf", extension: ".pdf" };
  }

  // Check if it's a valid supported image
  try {
    const metadata = await sharp(fileBuffer).metadata();
    if (metadata.format === "jpeg") {
      return { mimeType: "image/jpeg", extension: ".jpg" };
    }
    if (metadata.format === "png") {
      return { mimeType: "image/png", extension: ".png" };
    }
    if (metadata.format === "webp") {
      return { mimeType: "image/webp", extension: ".webp" };
    }
  } catch (error) {
    // Not a valid image or unsupported format
  }

  return null;
}

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}
