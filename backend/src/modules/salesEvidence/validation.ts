import { z } from "zod/v4";

const saleEvidenceTitleSchema = z.string().trim().min(2).max(160);

export const createSaleEvidenceSchema = z
  .object({
    title: saleEvidenceTitleSchema.optional(),
    remarks: z.string().trim().max(2000).optional(),
  })
  .strict();

export type CreateSaleEvidenceInput = z.infer<typeof createSaleEvidenceSchema>;

export const SALE_RECOVERY_STATUSES = [
  "UNRESOLVED",
  "ATTACHED",
  "ARCHIVED",
] as const;

export const listSaleEvidenceSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(255).optional(),
    saleRecoveryStatus: z.enum(SALE_RECOVERY_STATUSES).optional(),
  })
  .strict();

export type ListSaleEvidenceInput = z.infer<typeof listSaleEvidenceSchema>;

export const archiveSaleEvidenceSchema = z
  .object({
    reason: z.string().trim().min(2).max(2000),
  })
  .strict();

export type ArchiveSaleEvidenceInput = z.infer<
  typeof archiveSaleEvidenceSchema
>;

export const candidatesQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();

export type CandidatesQueryInput = z.infer<typeof candidatesQuerySchema>;

import {
  expectedManualBillRecordSchema,
  manualBillReferenceSchema,
} from "../invoices/manualBill/validation";

export const attachSaleEvidenceSchema = z
  .object({
    invoiceId: z.string().trim().min(1, "Target invoice ID is required").max(191),
    reference: manualBillReferenceSchema,
    expectedInvoice: expectedManualBillRecordSchema,
    reason: z
      .string()
      .trim()
      .min(2, "Reason is required to attach sales evidence")
      .max(2000, "Reason cannot exceed 2000 characters"),
    duplicateOverrideReason: z
      .string()
      .trim()
      .min(2, "Duplicate override reason must be at least 2 characters")
      .max(2000, "Duplicate override reason cannot exceed 2000 characters")
      .optional(),
  })
  .strict();

export type AttachSaleEvidenceInput = z.infer<typeof attachSaleEvidenceSchema>;
