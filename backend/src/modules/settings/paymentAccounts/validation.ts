import { z } from "zod";
import { optionalSafeText, safeText } from "../../../lib/requestValidation";

export const createPaymentAccountSchema = z
  .object({
    id: z.string().uuid({ message: "ID must be a valid UUID" }),
    providerLabel: safeText("Provider label", 120).trim().min(1, "Provider label is required"),
    accountHolder: safeText("Account holder", 120).trim().min(1, "Account holder is required"),
    accountIdentifier: optionalSafeText("Account identifier", 120),
    settlementMethod: z
      .enum(["FONEPAY", "BANK_TRANSFER"])
      .optional()
      .nullable(),
    confirmationMode: z.enum(["MANUAL_RECEIPT", "DISPLAY_ONLY"]),
  })
  .strict()
  .refine(
    (data) => {
      if (data.confirmationMode === "MANUAL_RECEIPT") {
        return data.settlementMethod === "FONEPAY" || data.settlementMethod === "BANK_TRANSFER";
      }
      return data.settlementMethod === null || data.settlementMethod === undefined;
    },
    {
      message:
        "MANUAL_RECEIPT requires a supported settlement method (FONEPAY or BANK_TRANSFER); DISPLAY_ONLY requires no settlement method",
    },
  )
  .refine(
    (data) => {
      if (data.settlementMethod === "BANK_TRANSFER") {
        return Boolean(data.accountIdentifier && data.accountIdentifier.trim().length > 0);
      }
      return true;
    },
    {
      message: "Account identifier is required for Bank Transfer settlement",
    },
  );

export const patchPaymentAccountSchema = z
  .object({
    expectedVersion: z
      .number({ message: "Expected version must be a number" })
      .int("Expected version must be an integer")
      .positive("Expected version must be a positive integer"),
    providerLabel: safeText("Provider label", 120)
      .trim()
      .min(1, "Provider label cannot be empty")
      .optional(),
    accountHolder: safeText("Account holder", 120)
      .trim()
      .min(1, "Account holder cannot be empty")
      .optional(),
    accountIdentifier: optionalSafeText("Account identifier", 120),
    settlementMethod: z
      .enum(["FONEPAY", "BANK_TRANSFER"])
      .optional()
      .nullable(),
    confirmationMode: z.enum(["MANUAL_RECEIPT", "DISPLAY_ONLY"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const reorderPaymentAccountsSchema = z
  .object({
    orders: z
      .array(
        z
          .object({
            id: z.string().uuid({ message: "Account ID must be a valid UUID" }),
            expectedVersion: z
              .number({ message: "Expected version must be a number" })
              .int("Expected version must be an integer")
              .positive("Expected version must be a positive integer"),
          })
          .strict(),
      )
      .min(1, "At least one account order entry is required")
      .max(100, "Cannot reorder more than 100 accounts")
      .refine(
        (orders) => {
          const ids = new Set<string>();
          for (const item of orders) {
            if (ids.has(item.id)) return false;
            ids.add(item.id);
          }
          return true;
        },
        { message: "Reorder list cannot contain duplicate account IDs" },
      ),
  })
  .strict();

export const uploadQrBodySchema = z
  .object({
    uploadId: z.string().uuid({ message: "Upload ID must be a valid UUID" }),
    expectedVersion: z.coerce
      .number({ message: "Expected version must be a number" })
      .int("Expected version must be an integer")
      .positive("Expected version must be a positive integer"),
  })
  .strict();

export type CreatePaymentAccountInput = z.infer<typeof createPaymentAccountSchema>;
export type PatchPaymentAccountInput = z.infer<typeof patchPaymentAccountSchema>;
export type ReorderPaymentAccountsInput = z.infer<typeof reorderPaymentAccountsSchema>;
export type UploadQrBodyInput = z.infer<typeof uploadQrBodySchema>;
