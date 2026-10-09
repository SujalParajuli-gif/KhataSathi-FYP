import { z } from "zod";
import { optionalSafeText, safeText } from "../../lib/requestValidation";

export const voidPaymentBodySchema = z
  .object({
    overridePin: optionalSafeText("Override PIN", 20),
  })
  .strict();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANUAL_OP_KEY_REGEX = /^[A-Za-z0-9_-]{16,120}$/;

export const addPaymentBodySchema = z
  .object({
    method: z.enum(["CASH", "ESEWA", "FONEPAY", "BANK_TRANSFER"]),
    amount: z.number().finite().positive("Payment amount must be greater than 0"),
    status: z.enum(["PENDING", "SUCCESS", "FAILED"]).optional(),
    reference: optionalSafeText("Reference", 160),
    manualOperationKey: z.string().optional(),
    receivingAccountId: z.string().optional(),
    receivingAccountVersion: z.number().optional(),
    manualReceiptConfirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasKey = data.manualOperationKey !== undefined;
    const hasAccountId = data.receivingAccountId !== undefined;
    const hasVersion = data.receivingAccountVersion !== undefined;
    const hasConfirmed = data.manualReceiptConfirmed !== undefined;

    const hasAnyLinked = hasKey || hasAccountId || hasVersion || hasConfirmed;

    if (hasAnyLinked) {
      if (data.method !== "FONEPAY" && data.method !== "BANK_TRANSFER") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["method"],
          message:
            "Receiving destination is only supported for Fonepay and Bank Transfer payments",
        });
      }

      if (data.status !== undefined && data.status !== "SUCCESS") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "Receiving destination can only be recorded for successful payments",
        });
      }

      if (
        !data.manualOperationKey ||
        typeof data.manualOperationKey !== "string" ||
        !MANUAL_OP_KEY_REGEX.test(data.manualOperationKey)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["manualOperationKey"],
          message:
            "Manual operation key must be 16-120 alphanumeric characters, underscores, or hyphens",
        });
      }

      if (
        !data.receivingAccountId ||
        typeof data.receivingAccountId !== "string" ||
        !UUID_REGEX.test(data.receivingAccountId.trim())
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receivingAccountId"],
          message: "Receiving account ID must be a valid UUID",
        });
      }

      if (
        typeof data.receivingAccountVersion !== "number" ||
        !Number.isInteger(data.receivingAccountVersion) ||
        data.receivingAccountVersion < 1
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receivingAccountVersion"],
          message: "Receiving account version must be a positive integer",
        });
      }

      if (data.manualReceiptConfirmed !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["manualReceiptConfirmed"],
          message:
            "Cashier manual receipt confirmation is required for receiving destination",
        });
      }

      if (
        !data.reference ||
        typeof data.reference !== "string" ||
        data.reference.trim().length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reference"],
          message: "Reference is required when recording a receiving destination",
        });
      }
    }
  });

export type AddPaymentBodyInput = z.infer<typeof addPaymentBodySchema>;
export type VoidPaymentBodyInput = z.infer<typeof voidPaymentBodySchema>;
