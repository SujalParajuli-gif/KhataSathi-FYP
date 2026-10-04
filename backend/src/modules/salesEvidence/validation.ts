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
