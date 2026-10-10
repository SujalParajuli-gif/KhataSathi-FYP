import { Request, Response } from "express";
import { z } from "zod/v4";
import {
  receiveStockBatch,
  listSuppliers,
  getSupplierBalance,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  listFinancialPurchaseReceipts,
  getFinancialPurchaseReceiptById,
  recordPurchaseInstallment,
  attachDocumentsToPurchaseReceipt,
  voidPurchaseInstallment,
  FinancialPurchaseConflictError,
} from "./service";
import { validateBillDate } from "./purchaseValidation";

/* =========================================================================
   ZOD SCHEMAS WITH STRICT FIELD REJECTION & COERCION PROHIBITION
   ========================================================================= */

const boundedStringId = z
  .string({ error: "ID is required" })
  .trim()
  .min(1, "ID cannot be empty")
  .max(120, "ID cannot exceed 120 characters");

const decimalStringRegex = /^\d+(\.\d+)?$/;

const positiveDecimalString = z
  .string({ error: "Value is required" })
  .trim()
  .min(1, "Value cannot be empty")
  .max(60, "Value cannot exceed 60 characters")
  .regex(decimalStringRegex, "Must be a valid positive decimal string")
  .refine((val) => {
    const num = Number(val);
    return Number.isFinite(num) && num > 0;
  }, "Must be greater than zero");

const nonNegativeDecimalString = z
  .string({ error: "Value is required" })
  .trim()
  .min(1, "Value cannot be empty")
  .max(60, "Value cannot exceed 60 characters")
  .regex(decimalStringRegex, "Must be a valid non-negative decimal string")
  .refine((val) => {
    const num = Number(val);
    return Number.isFinite(num) && num >= 0;
  }, "Must be non-negative");

const billDateSchema = z
  .string()
  .trim()
  .max(50)
  .refine((val) => {
    if (!val) return true;
    try {
      validateBillDate(val);
      return true;
    } catch {
      return false;
    }
  }, "Invalid bill date format. Expected real calendar date YYYY-MM-DD")
  .nullable()
  .optional();

const paidAtRegex = /^\d{4}-\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const paidAtDateSchema = z
  .string({ error: "paidAt is required" })
  .trim()
  .min(1, "paidAt cannot be empty")
  .max(50)
  .refine((val) => {
    if (!paidAtRegex.test(val)) return false;
    try {
      const datePart = val.slice(0, 10);
      validateBillDate(datePart);
      const d = new Date(val);
      return !Number.isNaN(d.getTime());
    } catch {
      return false;
    }
  }, "Invalid paidAt date. Must be a valid real calendar date (YYYY-MM-DD) or explicit timezone ISO datetime with <= 3 fractional digits");

const createSupplierBodySchema = z
  .object({
    name: z
      .string({ error: "Supplier name is required" })
      .trim()
      .min(1, "Supplier name cannot be empty")
      .max(160, "Supplier name cannot exceed 160 characters"),
    contact: z.string().trim().max(160, "Contact cannot exceed 160 characters").nullable().optional(),
    phone: z.string().trim().max(40, "Phone cannot exceed 40 characters").nullable().optional(),
    panNo: z.string().trim().max(40, "PAN number cannot exceed 40 characters").nullable().optional(),
    address: z.string().trim().max(500, "Address cannot exceed 500 characters").nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const updateSupplierBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Supplier name cannot be empty")
      .max(160, "Supplier name cannot exceed 160 characters")
      .optional(),
    contact: z.string().trim().max(160, "Contact cannot exceed 160 characters").nullable().optional(),
    phone: z.string().trim().max(40, "Phone cannot exceed 40 characters").nullable().optional(),
    panNo: z.string().trim().max(40, "PAN number cannot exceed 40 characters").nullable().optional(),
    address: z.string().trim().max(500, "Address cannot exceed 500 characters").nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).length > 0,
    "At least one field must be provided to update"
  );

const pageSchema = z
  .union([
    z
      .string()
      .regex(/^\d{1,6}$/, "page must be an integer between 1 and 100000")
      .transform(Number),
    z.number().int(),
  ])
  .refine((n) => n >= 1 && n <= 100000, "page must be between 1 and 100000")
  .optional();

const pageSizeSchema = z
  .union([
    z
      .string()
      .regex(/^\d{1,3}$/, "pageSize must be an integer between 1 and 50")
      .transform(Number),
    z.number().int(),
  ])
  .refine((n) => n >= 1 && n <= 50, "pageSize must be between 1 and 50")
  .optional();

const listSuppliersQuerySchema = z
  .object({
    q: z.string().max(160).optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
    includeInactive: z
      .union([
        z
          .enum(["true", "false"], {
            error: "includeInactive must be 'true' or 'false'",
          })
          .transform((v) => v === "true"),
        z.boolean(),
      ])
      .optional(),
  })
  .strict();

const listPurchasesQuerySchema = z
  .object({
    supplierId: boundedStringId.optional(),
    q: z.string().max(160).optional(),
    kind: z
      .enum(["ALL", "FINANCIAL", "LEGACY"], {
        error: "kind must be 'ALL', 'FINANCIAL', or 'LEGACY'",
      })
      .optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict();

const financialLineSchema = z
  .object({
    productId: boundedStringId,
    inputUnit: z
      .string({ error: "inputUnit is required" })
      .trim()
      .min(1, "inputUnit cannot be empty")
      .max(30, "inputUnit cannot exceed 30 characters"),
    inputQty: positiveDecimalString,
    conversionFactor: positiveDecimalString,
    unitAcquisitionCost: nonNegativeDecimalString,
    lineAmount: nonNegativeDecimalString.optional(),
  })
  .strict();

const createPurchaseReceiptBodySchema = z
  .object({
    supplierId: boundedStringId,
    billNumber: z.string().trim().max(100, "billNumber cannot exceed 100 characters").nullable().optional(),
    billDate: billDateSchema,
    remarks: z.string().trim().max(500, "remarks cannot exceed 500 characters").nullable().optional(),
    reason: z.string().trim().max(500, "reason cannot exceed 500 characters").nullable().optional(),
    payable: nonNegativeDecimalString,
    operationKey: boundedStringId,
    lines: z
      .array(financialLineSchema, { error: "lines array is required" })
      .min(1, "At least one purchase receipt line is required")
      .max(200, "Cannot exceed 200 purchase receipt lines"),
    documentIds: z
      .array(boundedStringId)
      .max(10, "Cannot attach more than 10 documents")
      .optional(),
  })
  .strict();

const createInstallmentBodySchema = z
  .object({
    amount: positiveDecimalString,
    method: z.enum(["CASH", "BANK_TRANSFER", "OTHER"], {
      error: "method must be CASH, BANK_TRANSFER, or OTHER",
    }),
    reference: z.string().trim().max(120, "reference cannot exceed 120 characters").nullable().optional(),
    paidAt: paidAtDateSchema,
    operationKey: boundedStringId,
  })
  .strict();

const attachDocumentsBodySchema = z
  .object({
    documentIds: z
      .array(boundedStringId, { error: "documentIds is required" })
      .min(1, "At least one document ID is required")
      .max(10, "Cannot attach more than 10 documents"),
  })
  .strict();

const voidInstallmentBodySchema = z
  .object({
    voidReason: z
      .string()
      .trim()
      .min(3, "voidReason must be at least 3 characters")
      .max(500, "voidReason cannot exceed 500 characters")
      .optional(),
    reason: z
      .string()
      .trim()
      .min(3, "reason must be at least 3 characters")
      .max(500, "reason cannot exceed 500 characters")
      .optional(),
  })
  .strict()
  .refine(
    (data) => Boolean((data.voidReason && data.voidReason.trim()) || (data.reason && data.reason.trim())),
    "Void reason is required"
  );

/* =========================================================================
   CENTRAL SAFE ERROR HANDLER
   ========================================================================= */

export function handlePurchaseError(error: unknown, res: Response): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const candidate = error as { code?: unknown; message?: string; name?: string };
  const errorCode = String(candidate?.code || "").toUpperCase();
  const errorMessage = String(candidate?.message || "");

  // Prisma schema unavailable pending migration: 503
  if (errorCode === "P2021" || errorCode === "P2022") {
    res.status(503).json({
      code: "PURCHASE_SCHEMA_UNAVAILABLE",
      error: "Purchase schema is unavailable pending migration",
    });
    return;
  }

  // Sensitive patterns: never leak SQL, raw hashes, storage paths, Prisma internals, or credentials
  const containsSensitiveData =
    /SELECT |INSERT |UPDATE |DELETE |FROM |WHERE |prisma|secret|password|bearer|hash|[\\/].*\.(ts|js|sql)/i.test(
      errorMessage
    ) || (errorCode.startsWith("P") && errorCode !== "FINANCIAL_PURCHASE_CONFLICT");

  if (containsSensitiveData) {
    res.status(500).json({ error: "An unexpected error occurred" });
    return;
  }

  // Financial purchase conflict: 409
  if (
    errorCode === "FINANCIAL_PURCHASE_CONFLICT" ||
    candidate?.name === "FinancialPurchaseConflictError" ||
    error instanceof FinancialPurchaseConflictError ||
    /operation key conflict/i.test(errorMessage) ||
    /lock conflict/i.test(errorMessage) ||
    /concurrent.*claim/i.test(errorMessage)
  ) {
    res.status(409).json({
      code: "FINANCIAL_PURCHASE_CONFLICT",
      error: "Financial purchase conflict",
    });
    return;
  }

  // Not found: 404
  if (/not found/i.test(errorMessage)) {
    res.status(404).json({ error: errorMessage });
    return;
  }

  // Known domain validation errors: 400
  const isKnownValidationError =
    /required|invalid|cannot|exceeds|must be|mismatch|reconciliation error|duplicate|unauthorized actor role|does not match|exceeding|negative/i.test(
      errorMessage
    );

  if (isKnownValidationError) {
    res.status(400).json({ error: errorMessage });
    return;
  }

  // Unexpected internal server error: 500
  res.status(500).json({ error: "An unexpected error occurred" });
}

/* =========================================================================
   CONTROLLER ACTION HANDLERS
   ========================================================================= */

// 1. GET /suppliers
export async function getSupplierBalanceHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: "Not authenticated" }); return; }
    const id = boundedStringId.safeParse(req.params.id);
    if (!id.success || !z.object({}).strict().safeParse(req.query).success) {
      res.status(400).json({ error: "Invalid supplier balance parameters" });
      return;
    }
    res.json({ balance: await getSupplierBalance(id.data, req.user.role) });
  } catch (error) { handlePurchaseError(error, res); }
}

export async function getSuppliersHandler(req: Request, res: Response): Promise<void> {
  try {
    const queryResult = listSuppliersQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: queryResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const { q, page, pageSize, includeInactive } = queryResult.data;
    const result = await listSuppliers({
      q,
      page,
      pageSize,
      includeInactive,
    });
    res.json(result);
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 2. POST /suppliers
export async function createSupplierHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const parseResult = createSupplierBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supplier = await createSupplier(parseResult.data, req.user.id);
    res.status(201).json({ supplier });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 3. PATCH /suppliers/:id
export async function updateSupplierHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid supplier ID parameter" });
      return;
    }

    const parseResult = updateSupplierBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supplier = await updateSupplier(idParam.data, parseResult.data, req.user.id);
    res.json({ supplier });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 4. POST /suppliers/:id/deactivate
export async function deactivateSupplierHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid supplier ID parameter" });
      return;
    }

    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      const bodyCheck = z.object({}).strict().safeParse(req.body);
      if (!bodyCheck.success) {
        res.status(400).json({ error: "Unexpected fields in request body" });
        return;
      }
    }

    const supplier = await deactivateSupplier(idParam.data, req.user.id);
    res.json({ supplier });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 5. GET /purchases
export async function listPurchasesHandler(req: Request, res: Response): Promise<void> {
  try {
    const queryResult = listPurchasesQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: queryResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const { supplierId, q, kind, page, pageSize } = queryResult.data;
    const result = await listFinancialPurchaseReceipts({
      supplierId,
      q,
      kind,
      page,
      pageSize,
    });
    res.json(result);
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 6. POST /purchases
export async function createPurchaseReceiptHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const parseResult = createPurchaseReceiptBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const {
      supplierId,
      billNumber,
      billDate,
      remarks,
      reason,
      payable,
      operationKey,
      lines,
      documentIds,
    } = parseResult.data;

    const receipt = await receiveStockBatch(
      {
        isFinancial: true,
        supplierId,
        billNumber: billNumber ?? undefined,
        billDate: billDate ?? undefined,
        remarks: remarks ?? undefined,
        reason: reason ?? undefined,
        payable,
        operationKey,
        financialLines: lines,
        documentIds,
      },
      req.user.id,
      req.user.role // trusted third argument
    );

    res.status(201).json({ receipt });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 7. GET /purchases/:id
export async function getPurchaseDetailHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid purchase receipt ID parameter" });
      return;
    }

    const receipt = await getFinancialPurchaseReceiptById(idParam.data, req.user.role);
    res.json({ receipt });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 8. POST /purchases/:id/installments
export async function createPurchaseInstallmentHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid purchase receipt ID parameter" });
      return;
    }

    const parseResult = createInstallmentBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const payment = await recordPurchaseInstallment(idParam.data, parseResult.data, req.user.id);
    res.status(201).json({ payment });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 9. POST /purchases/:id/attachments
export async function attachPurchaseDocumentsHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid purchase receipt ID parameter" });
      return;
    }

    const parseResult = attachDocumentsBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const receipt = await attachDocumentsToPurchaseReceipt(
      idParam.data,
      parseResult.data.documentIds,
      req.user.id,
      req.user.role
    );
    res.json({ receipt });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}

// 10. POST /purchase-installments/:id/void
export async function voidPurchaseInstallmentHandler(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const idParam = boundedStringId.safeParse(req.params.id);
    if (!idParam.success) {
      res.status(400).json({ error: "Invalid installment ID parameter" });
      return;
    }

    const parseResult = voidInstallmentBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const payment = await voidPurchaseInstallment(idParam.data, parseResult.data, req.user.id);
    res.json({ payment });
  } catch (error) {
    handlePurchaseError(error, res);
  }
}
