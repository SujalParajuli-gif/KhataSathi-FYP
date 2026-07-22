import { z } from "zod";
import { optionalSafeText, safeText } from "../../lib/requestValidation";

const draftItemSchema = z
  .object({
    productId: safeText("Product id", 80).min(1, "Product is required"),
    qty: z.number().positive("Quantity must be greater than 0"),
    note: optionalSafeText("Item note", 500),
  })
  .strict();

export const createDraftRequestSchema = z
  .object({
    customerName: optionalSafeText("Customer name", 120),
    customerPhone: optionalSafeText("Customer phone", 40),
    customerId: optionalSafeText("Customer id", 80),
    notes: optionalSafeText("Notes", 1000),
    assignedCashierId: optionalSafeText("Cashier id", 80),
    items: z.array(draftItemSchema).min(1, "Add at least one product"),
  })
  .strict();

export const updateDraftRequestSchema = createDraftRequestSchema
  .partial()
  .extend({
    items: z.array(draftItemSchema).min(1, "Add at least one product").optional(),
  })
  .strict();

export const rejectDraftRequestSchema = z
  .object({
    note: optionalSafeText("Rejection note", 1000),
  })
  .strict();

const draftItemReviewSchema = z
  .object({
    itemId: safeText("Draft item id", 80).min(1, "Draft item is required"),
    action: z.enum(["ACCEPT", "REJECT"]),
    acceptedQty: z.number().positive("Accepted quantity must be greater than 0").optional(),
    reason: optionalSafeText("Rejection reason", 500),
  })
  .strict();

export const acceptDraftRequestSchema = z
  .object({
    items: z.array(draftItemReviewSchema).optional(),
  })
  .strict();

export const completeDraftRequestSchema = z
  .object({
    invoiceId: safeText("Invoice id", 80).min(1, "Invoice is required"),
  })
  .strict();

export type CreateDraftRequestInput = z.infer<typeof createDraftRequestSchema>;
export type UpdateDraftRequestInput = z.infer<typeof updateDraftRequestSchema>;
export type AcceptDraftRequestInput = z.infer<typeof acceptDraftRequestSchema>;
