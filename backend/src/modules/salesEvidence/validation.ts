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

export const reassociateSaleEvidenceSchema = attachSaleEvidenceSchema.extend({
  expectedSourceInvoiceId: z.string().trim().min(1).max(191),
  expectedSourceInvoice: expectedManualBillRecordSchema,
}).strict().refine((input) => input.invoiceId !== input.expectedSourceInvoiceId, {
  message: "Select a different target invoice", path: ["invoiceId"],
});
export type ReassociateSaleEvidenceInput = z.infer<typeof reassociateSaleEvidenceSchema>;

export const voidSaleEvidenceSchema = z.object({
  expectedStatus: z.enum(["UNRESOLVED", "ARCHIVED"]),
  reason: z.string().trim().min(2).max(2000),
}).strict();
export type VoidSaleEvidenceInput = z.infer<typeof voidSaleEvidenceSchema>;

const moneyNumber = z.number().finite();
const positiveMoneyNumber = moneyNumber.positive();
const nonNegativeMoneyNumber = moneyNumber.nonnegative();
const positiveQtyNumber = z.number().finite().positive();

export const recoveryCheckoutItemSchema = z
  .object({
    productId: z.string().trim().min(1, "Product ID is required").max(120),
    qty: positiveQtyNumber,
    overrideUnitPrice: positiveMoneyNumber.optional().nullable(),
    overrideReason: z.string().trim().max(240).optional().nullable(),
    overrideAuthorizationToken: z.string().trim().max(512).optional().nullable(),
  })
  .strict();

export const recoveryCheckoutPaymentSchema = z
  .object({
    method: z.enum(["CASH", "ESEWA", "FONEPAY", "BANK_TRANSFER", "NONE"]),
    amount: positiveMoneyNumber.optional(),
    reference: z.string().trim().max(160).optional(),
    tenderedAmount: nonNegativeMoneyNumber.optional(),
  })
  .strict();

export const recoveryCheckoutConfirmationItemSchema = z
  .object({
    productId: z.string().trim().min(1, "Product ID is required").max(120),
    qty: positiveQtyNumber,
    appliedUnitPrice: nonNegativeMoneyNumber,
  })
  .strict();

export const recoveryCheckoutConfirmationSchema = z
  .object({
    items: z
      .array(recoveryCheckoutConfirmationItemSchema)
      .min(1, "Confirmation requires at least one item")
      .refine(
        (items) => {
          const seen = new Set<string>();
          for (const item of items) {
            if (seen.has(item.productId)) return false;
            seen.add(item.productId);
          }
          return true;
        },
        { message: "Confirmation items cannot contain duplicate product IDs" },
      ),
    payableTotal: z
      .number()
      .int("Confirmation payable total must be an integer (whole NPR)")
      .nonnegative("Confirmation payable total cannot be negative"),
  })
  .strict();

export const recoveryCheckoutInputSchema = z
  .object({
    customerId: z.string().trim().max(120).optional().nullable(),
    discountAmount: nonNegativeMoneyNumber.optional(),
    overridePin: z.string().trim().max(20).optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
    items: z
      .array(recoveryCheckoutItemSchema)
      .min(1, "Recovery requires at least one checkout item"),
    payment: recoveryCheckoutPaymentSchema.optional().nullable(),
    payments: z
      .array(recoveryCheckoutPaymentSchema)
      .max(10, "Too many payment rows")
      .optional()
      .nullable(),
    confirmation: recoveryCheckoutConfirmationSchema.optional().nullable(),
  })
  .strict();

export const paymentAssessmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("NOT_COLLECTED"),
      explanation: z
        .string()
        .trim()
        .min(2, "Explanation is required for uncollected payment assessment")
        .max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("CURRENT_DRAWER_CASH"),
      drawerId: z.string().trim().min(1, "Drawer ID is required").max(191),
      collectedAt: z.string().trim().min(1, "Collection timestamp is required"),
      explanation: z
        .string()
        .trim()
        .min(2, "Explanation is required for current drawer cash assessment")
        .max(2000),
      alreadyAccounted: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("PRIOR_OR_OTHER_CASH"),
      explanation: z
        .string()
        .trim()
        .min(2, "Explanation is required for prior/other cash assessment")
        .max(2000),
      collectedByActorId: z.string().trim().max(191).optional(),
      collectedDrawerId: z.string().trim().max(191).optional(),
      collectedAt: z.string().trim().optional(),
      alreadyAccounted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("PRIOR_DIGITAL"),
      explanation: z
        .string()
        .trim()
        .min(2, "Explanation is required for prior digital assessment")
        .max(2000),
      gatewayOrMethod: z.string().trim().max(50).optional(),
      externalReference: z.string().trim().max(191).optional(),
      transactionStatus: z.string().trim().max(50).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("UNKNOWN"),
      explanation: z
        .string()
        .trim()
        .min(2, "Explanation is required for unknown payment assessment")
        .max(2000),
    })
    .strict(),
]);

export type PaymentAssessment = z.infer<typeof paymentAssessmentSchema>;

export const saleEvidenceRecoverySchema = z
  .object({
    checkout: recoveryCheckoutInputSchema,
    reference: manualBillReferenceSchema,
    reason: z
      .string()
      .trim()
      .min(2, "Reason is required for missing sale recovery")
      .max(2000),
    duplicateOverrideReason: z
      .string()
      .trim()
      .min(2, "Duplicate override reason must be at least 2 characters")
      .max(2000)
      .optional(),
    paymentAssessment: paymentAssessmentSchema,
  })
  .strict();

export type SaleEvidenceRecoveryInput = z.infer<
  typeof saleEvidenceRecoverySchema
>;

export const reviseSaleEvidenceRecoverySchema = z
  .object({
    expectedAttemptId: z
      .string()
      .trim()
      .min(1, "Expected attempt ID is required")
      .max(191),
    reason: z
      .string()
      .trim()
      .min(2, "Reason is required to revise recovery attempt")
      .max(2000),
    recovery: saleEvidenceRecoverySchema,
  })
  .strict();

export type ReviseSaleEvidenceRecoveryInput = z.infer<
  typeof reviseSaleEvidenceRecoverySchema
>;
