import { z } from "zod/v4";
import { parseBusinessDate } from "../../../lib/businessDate";

export const EXTERNAL_DOCUMENT_TYPES = [
  "PAN_INVOICE",
  "VAT_TAX_INVOICE",
  "ABBREVIATED_TAX_INVOICE",
  "OTHER_MANUAL_SALES_DOCUMENT",
] as const;

export const BILL_RECORD_STATUSES = [
  "PENDING",
  "RECORDED",
  "VERIFIED",
  "MISSING",
] as const;

export const BILLING_CHANNELS = [
  "MANUAL_EXTERNAL",
  "IRD_ELECTRONIC",
] as const;

export const manualBillReferenceSchema = z
  .object({
    billNo: z
      .string()
      .trim()
      .min(1, "Paper bill number cannot be empty")
      .max(100, "Paper bill number cannot exceed 100 characters"),
    externalDocumentType: z.enum(EXTERNAL_DOCUMENT_TYPES),
    externalBillDate: z
      .string()
      .trim()
      .refine((val) => {
        try {
          parseBusinessDate(val, "externalBillDate");
          return true;
        } catch {
          return false;
        }
      }, "A valid calendar date in YYYY-MM-DD format is required"),
  })
  .strict();

export const expectedManualBillRecordSchema = z
  .object({
    billingChannel: z.enum(BILLING_CHANNELS).nullable(),
    externalDocumentType: z.enum(EXTERNAL_DOCUMENT_TYPES).nullable(),
    externalBillNo: z.string().max(100).nullable(),
    externalBillDate: z
      .string()
      .nullable()
      .refine((val) => {
        if (val === null) return true;
        try {
          parseBusinessDate(val, "externalBillDate");
          return true;
        } catch {
          return false;
        }
      }, "Expected externalBillDate must be a valid calendar date in YYYY-MM-DD format or null"),
    billRecordStatus: z.enum(BILL_RECORD_STATUSES).nullable(),
  })
  .strict();

export const recordReferenceSchema = z
  .object({
    reference: manualBillReferenceSchema,
    expected: expectedManualBillRecordSchema,
    reason: z
      .string()
      .trim()
      .min(2, "Reason must be at least 2 characters")
      .max(2000, "Reason cannot exceed 2000 characters")
      .optional(),
    duplicateOverrideReason: z
      .string()
      .trim()
      .min(2, "Duplicate override reason must be at least 2 characters")
      .max(2000, "Duplicate override reason cannot exceed 2000 characters")
      .optional(),
  })
  .strict();

export const verifyReferenceSchema = z
  .object({
    expected: expectedManualBillRecordSchema,
    reason: z
      .string()
      .trim()
      .min(2, "Reason must be at least 2 characters")
      .max(2000, "Reason cannot exceed 2000 characters"),
  })
  .strict();

export const markMissingSchema = z
  .object({
    expected: expectedManualBillRecordSchema,
    reason: z
      .string()
      .trim()
      .min(2, "Reason must be at least 2 characters")
      .max(2000, "Reason cannot exceed 2000 characters"),
  })
  .strict();

export const withdrawReferenceSchema = z
  .object({
    expected: expectedManualBillRecordSchema,
    targetStatus: z.enum(["PENDING", "MISSING"] as const),
    reason: z
      .string()
      .trim()
      .min(2, "Reason must be at least 2 characters")
      .max(2000, "Reason cannot exceed 2000 characters"),
  })
  .strict();

export const listManualBillQueueSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    status: z.enum(["PENDING", "MISSING", "ALL"] as const).optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict();
