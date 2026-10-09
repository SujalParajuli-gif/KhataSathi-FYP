import { Request, Response } from "express";
import multer from "multer";
import { formatZodIssues } from "../../../lib/requestValidation";
import { getBusinessCapabilities } from "../capabilities";
import {
  createPaymentAccountSchema,
  patchPaymentAccountSchema,
  reorderPaymentAccountsSchema,
  uploadQrBodySchema,
} from "./validation";
import {
  createPaymentAccount,
  getEnabledPaymentAccounts,
  getQrAssetFile,
  listPaymentAccountAudit,
  listPaymentAccounts,
  patchPaymentAccount,
  reorderPaymentAccounts,
  uploadAndPublishQrAsset,
  PaymentAccountError,
} from "./service";
import {
  PaymentAccountStorageError,
  MAX_IMAGE_INPUT_BYTES,
  isValidUuid,
} from "./storage";
import { ZodError } from "zod";

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_INPUT_BYTES,
    files: 1,
  },
});

export const uploadQrMiddleware = memoryUpload.single("file");

export async function listPaymentAccountsHandler(req: Request, res: Response) {
  try {
    const userRole = req.user?.role;
    if (!userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }
    const accounts = await listPaymentAccounts();
    res.json(accounts);
  } catch (err: any) {
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error("List payment accounts error:", err);
    res.status(500).json({ error: "Failed to list payment accounts" });
  }
}

export async function getEnabledPaymentAccountsHandler(req: Request, res: Response) {
  try {
    const userRole = req.user?.role;
    if (!userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN" && userRole !== "MANAGER" && userRole !== "CASHIER") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const capabilities = res.locals.businessCapabilities || (await getBusinessCapabilities());
    if (capabilities?.posEnabled !== true) {
      res.status(403).json({ error: "POS capability is disabled in current business mode", code: "FEATURE_DISABLED" });
      return;
    }

    const accounts = await getEnabledPaymentAccounts();
    res.json(accounts);
  } catch (err: any) {
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error("Get enabled payment accounts error:", err);
    res.status(500).json({ error: "Failed to get enabled payment accounts" });
  }
}

export async function createPaymentAccountHandler(req: Request, res: Response) {
  try {
    const actorId = req.user?.id;
    const userRole = req.user?.role;
    if (!actorId || !userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const parsed = createPaymentAccountSchema.parse(req.body);
    const created = await createPaymentAccount(parsed, actorId);
    res.status(201).json(created);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", issues: formatZodIssues(err) });
      return;
    }
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("Create payment account error:", err);
    res.status(500).json({ error: "Failed to create payment account" });
  }
}

export async function patchPaymentAccountHandler(req: Request, res: Response) {
  try {
    const actorId = req.user?.id;
    const userRole = req.user?.role;
    if (!actorId || !userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = String(rawId || "").trim();
    if (!isValidUuid(id)) {
      res.status(400).json({ error: "Invalid account ID format", code: "INVALID_ACCOUNT_ID" });
      return;
    }
    const parsed = patchPaymentAccountSchema.parse(req.body);
    const updated = await patchPaymentAccount(id, parsed, actorId);
    res.json(updated);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", issues: formatZodIssues(err) });
      return;
    }
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("Patch payment account error:", err);
    res.status(500).json({ error: "Failed to update payment account" });
  }
}

export async function reorderPaymentAccountsHandler(req: Request, res: Response) {
  try {
    const actorId = req.user?.id;
    const userRole = req.user?.role;
    if (!actorId || !userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const parsed = reorderPaymentAccountsSchema.parse(req.body);
    const updatedList = await reorderPaymentAccounts(parsed.orders, actorId);
    res.json(updatedList);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", issues: formatZodIssues(err) });
      return;
    }
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("Reorder payment accounts error:", err);
    res.status(500).json({ error: "Failed to reorder payment accounts" });
  }
}

export async function uploadQrAssetHandler(req: Request, res: Response) {
  try {
    const actorId = req.user?.id;
    const userRole = req.user?.role;
    if (!actorId || !userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const rawAccountId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const accountId = String(rawAccountId || "").trim();
    if (!isValidUuid(accountId)) {
      res.status(400).json({ error: "Invalid account ID format", code: "INVALID_ACCOUNT_ID" });
      return;
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      res.status(400).json({ error: "No image file provided", code: "FILE_REQUIRED" });
      return;
    }

    const parsed = uploadQrBodySchema.parse(req.body);
    const asset = await uploadAndPublishQrAsset({
      accountId,
      uploadId: parsed.uploadId,
      expectedVersion: parsed.expectedVersion,
      fileBuffer: req.file.buffer,
      originalMimeType: req.file.mimetype,
      actorId,
    });

    res.status(201).json(asset);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", issues: formatZodIssues(err) });
      return;
    }
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("Upload QR asset error:", err);
    res.status(500).json({ error: "Failed to upload QR asset" });
  }
}

export async function getQrAssetFileHandler(req: Request, res: Response) {
  try {
    const userRole = req.user?.role;
    if (!userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (userRole !== "ADMIN" && userRole !== "MANAGER" && userRole !== "CASHIER") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const rawAccountId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawAssetId = Array.isArray(req.params.assetId) ? req.params.assetId[0] : req.params.assetId;
    const accountId = String(rawAccountId || "").trim();
    const assetId = String(rawAssetId || "").trim();

    // Validate UUID account and asset IDs BEFORE capability fetch or service/DB lookup
    if (!isValidUuid(accountId)) {
      res.status(400).json({ error: "Invalid account ID format", code: "INVALID_ACCOUNT_ID" });
      return;
    }

    if (!isValidUuid(assetId)) {
      res.status(400).json({ error: "Invalid asset ID format", code: "INVALID_ASSET_ID" });
      return;
    }

    // Do NOT fetch POS capability for ADMIN retained reads, only for POS roles (MANAGER / CASHIER)
    let posEnabled: boolean | undefined = undefined;
    if (userRole === "MANAGER" || userRole === "CASHIER") {
      const capabilities = res.locals.businessCapabilities || (await getBusinessCapabilities());
      if (capabilities?.posEnabled !== true) {
        res.status(403).json({ error: "POS capability is disabled in current business mode", code: "FEATURE_DISABLED" });
        return;
      }
      posEnabled = true;
    }

    const isThumbnail = req.path.endsWith("/thumbnail");

    const fileInfo = await getQrAssetFile({
      accountId,
      assetId,
      isThumbnail,
      userRole,
      posEnabled,
    });

    res.setHeader("Content-Type", fileInfo.mimeType);
    res.setHeader("Content-Length", String(fileInfo.sizeBytes));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, no-store");

    res.sendFile(fileInfo.absolutePath);
  } catch (err: any) {
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("Get QR asset file error:", err);
    res.status(500).json({ error: "Failed to fetch QR asset file" });
  }
}

export async function listPaymentAccountAuditHandler(req: Request, res: Response) {
  try {
    const userRole = req.user?.role;
    if (!userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (userRole !== "ADMIN") {
      res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
      return;
    }

    const rawAccountId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const accountId = String(rawAccountId || "").trim();
    if (!isValidUuid(accountId)) {
      res.status(400).json({ error: "Invalid account ID format", code: "INVALID_ACCOUNT_ID" });
      return;
    }

    const logs = await listPaymentAccountAudit(accountId);
    res.json(logs);
  } catch (err: any) {
    if (err instanceof PaymentAccountError || err instanceof PaymentAccountStorageError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.code === "STORAGE_UNAVAILABLE" || err?.statusCode === 503) {
      res.status(503).json({ error: "Document storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE" });
      return;
    }
    console.error("List payment account audit error:", err);
    res.status(500).json({ error: "Failed to fetch payment account audit logs" });
  }
}
