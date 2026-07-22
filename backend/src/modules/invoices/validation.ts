import { z } from "zod";
import { optionalSafeText, safeText } from "../../lib/requestValidation";

const optionalIdSchema = optionalSafeText("ID", 120);
const optionalPinSchema = optionalSafeText("Override PIN", 20);
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
  })
  .strict();

export const checkoutBodySchema = z
  .object({
    draftInvoiceId: optionalIdSchema,
    customerId: optionalIdSchema,
    discountAmount: nonNegativeMoneySchema.optional(),
    overridePin: optionalPinSchema,
    notes: optionalSafeText("Notes", 1000),
    items: z
      .array(checkoutItemSchema)
      .min(1, "Checkout requires at least one item"),
    payment: checkoutPaymentSchema.optional().nullable(),
    payments: z.array(checkoutPaymentSchema).max(10, "Too many payment rows").optional().nullable(),
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
