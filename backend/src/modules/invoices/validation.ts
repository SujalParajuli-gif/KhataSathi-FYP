import { z } from "zod";
import { optionalSafeText, safeText } from "../../lib/requestValidation";

const optionalIdSchema = optionalSafeText("ID", 120);
const optionalPinSchema = optionalSafeText("Override PIN", 20);
const checkoutOperationKeySchema = safeText("Checkout operation key", 120)
  .min(16, "Checkout operation key must be at least 16 characters")
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Checkout operation key may only contain letters, numbers, underscores, and hyphens",
  );
const moneySchema = z
  .number({ message: "Must be a number" })
  .finite("Must be a finite number");
const positiveMoneySchema = moneySchema.positive("Must be greater than 0");
const nonNegativeMoneySchema = moneySchema.nonnegative("Cannot be negative");
const positiveQtySchema = z
  .number({ message: "Quantity must be a number" })
  .finite("Quantity must be a finite number")
  .positive("Quantity must be greater than 0");

export const checkoutItemSchema = z
  .object({
    productId: safeText("Product ID", 120).min(1, "Product ID is required"),
    qty: positiveQtySchema,
    overrideUnitPrice: positiveMoneySchema.optional().nullable(),
    overrideReason: optionalSafeText("Override reason", 240),
    overrideAuthorizationToken: optionalSafeText("Override authorization token", 512),
  })
  .strict();

export const checkoutPaymentSchema = z
  .object({
    method: z.enum(["CASH", "ESEWA", "FONEPAY", "BANK_TRANSFER", "NONE"]),
    amount: positiveMoneySchema.optional(),
    reference: safeText("Payment reference", 160).optional(),
    tenderedAmount: nonNegativeMoneySchema.optional(),
    receivingAccountId: z
      .string({ message: "Receiving account ID must be a valid UUID" })
      .uuid({ message: "Receiving account ID must be a valid UUID" })
      .optional(),
    receivingAccountVersion: z
      .number({ message: "Receiving account version must be a number" })
      .int("Receiving account version must be an integer")
      .positive("Receiving account version must be a positive integer")
      .optional(),
    manualReceiptConfirmed: z
      .literal(true, { message: "Manual receipt confirmation must be true" })
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasAccountId = data.receivingAccountId !== undefined;
    const hasAccountVersion = data.receivingAccountVersion !== undefined;
    const hasManualReceipt = data.manualReceiptConfirmed !== undefined;
    const hasAnyDestination = hasAccountId || hasAccountVersion || hasManualReceipt;
    const hasAllDestination = hasAccountId && hasAccountVersion && hasManualReceipt;

    if (data.method === "CASH" || data.method === "ESEWA" || data.method === "NONE") {
      if (hasAnyDestination) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Receiving destination fields are not allowed for ${data.method} payment`,
        });
      }
    } else if (data.method === "FONEPAY" || data.method === "BANK_TRANSFER") {
      if (hasAnyDestination && !hasAllDestination) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Receiving account ID, receiving account version, and manual receipt confirmation must be provided together",
        });
      }
      if (hasAllDestination) {
        if (!data.reference || !data.reference.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Payment reference is required when recording a receiving destination",
          });
        }
      }
    }
  });

export const checkoutConfirmationItemSchema = z
  .object({
    productId: safeText("Product ID", 120).min(1, "Product ID is required"),
    qty: positiveQtySchema,
    appliedUnitPrice: nonNegativeMoneySchema,
  })
  .strict();

export const checkoutConfirmationSchema = z
  .object({
    items: z
      .array(checkoutConfirmationItemSchema)
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

export const checkoutBodySchema = z
  .object({
    operationKey: checkoutOperationKeySchema,
    draftInvoiceId: optionalIdSchema,
    draftRequestId: optionalIdSchema,
    customerId: optionalIdSchema,
    discountAmount: nonNegativeMoneySchema.optional(),
    overridePin: optionalPinSchema,
    notes: optionalSafeText("Notes", 1000),
    items: z
      .array(checkoutItemSchema)
      .min(1, "Checkout requires at least one item"),
    payment: checkoutPaymentSchema.optional().nullable(),
    payments: z.array(checkoutPaymentSchema).max(10, "Too many payment rows").optional().nullable(),
    confirmation: checkoutConfirmationSchema.optional().nullable(),
  })
  .strict();

export const finalizeBodySchema = z
  .object({
    discountAmount: nonNegativeMoneySchema.optional(),
  })
  .strict();

export const priceOverrideAuthorizationBodySchema = z
  .object({
    productId: safeText("Product ID", 120).min(1, "Product is required"),
    customerId: optionalIdSchema,
    qty: positiveQtySchema,
    overrideUnitPrice: positiveMoneySchema,
    overrideReason: safeText("Override reason", 240).min(
      1,
      "Override reason is required",
    ),
    pin: optionalPinSchema,
  })
  .strict();
