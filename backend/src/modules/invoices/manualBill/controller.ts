import type { Request, Response } from "express";
import fs from "fs";
import { ZodError } from "zod/v4";
import {
  getManualBillProofFile,
  getManualBillRecord,
  listManualBillQueue,
  markManualBillMissing,
  recordManualBillReference,
  verifyManualBillReference,
  withdrawManualBillReference,
} from "./service";
import {
  ManualBillAuthorizationError,
  ManualBillConflictError,
  ManualBillNotFoundError,
  ManualBillValidationError,
  type ManualBillActor,
} from "./types";

function extractActor(req: Request): ManualBillActor {
  const user = req.user!;
  return {
    id: user.id,
    role: user.role as any,
    name: (user as any).name ?? undefined,
  };
}

function handleManualBillError(res: Response, err: unknown) {
  if (err instanceof ManualBillValidationError) {
    return res.status(err.statusCode).json({
      code: err.code,
      error: err.message,
    });
  }

  if (err instanceof ManualBillAuthorizationError) {
    return res.status(err.statusCode).json({
      code: err.code,
      error: err.message,
    });
  }

  if (err instanceof ManualBillConflictError) {
    return res.status(err.statusCode).json({
      code: err.code,
      error: err.message,
      currentRecord: err.currentRecord,
      duplicates: err.duplicates,
    });
  }

  if (err instanceof ManualBillNotFoundError) {
    return res.status(err.statusCode).json({
      code: err.code,
      error: err.message,
    });
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((i) => i.message).join(", ");
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      error: message,
      details: err.issues,
    });
  }

  console.error("Unhandled manual bill error:", err);
  return res.status(500).json({
    code: "INTERNAL_SERVER_ERROR",
    error: "An unexpected error occurred while processing the manual bill request.",
  });
}

export async function listManualBillQueueHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const result = await listManualBillQueue(req.query as any, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function getManualBillRecordHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const result = await getManualBillRecord(invoiceId, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function recordReferenceHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const result = await recordManualBillReference(invoiceId, req.body, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function verifyReferenceHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const result = await verifyManualBillReference(invoiceId, req.body, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function markMissingHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const result = await markManualBillMissing(invoiceId, req.body, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function withdrawReferenceHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const result = await withdrawManualBillReference(invoiceId, req.body, actor);
    return res.json(result);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function getProofFileHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const documentId = String(req.params.documentId);
    const file = await getManualBillProofFile(invoiceId, documentId, actor, false);

    if (!fs.existsSync(file.filePath)) {
      return res.status(404).json({
        code: "FILE_NOT_FOUND",
        error: "Proof file not found on disk",
      });
    }

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.fileName)}"`,
    );
    return fs.createReadStream(file.filePath).pipe(res);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}

export async function getProofThumbnailHandler(req: Request, res: Response) {
  try {
    const actor = extractActor(req);
    const invoiceId = String(req.params.invoiceId);
    const documentId = String(req.params.documentId);
    const file = await getManualBillProofFile(invoiceId, documentId, actor, true);

    if (!fs.existsSync(file.filePath)) {
      return res.status(404).json({
        code: "FILE_NOT_FOUND",
        error: "Proof thumbnail not found on disk",
      });
    }

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.fileName)}"`,
    );
    return fs.createReadStream(file.filePath).pipe(res);
  } catch (err) {
    return handleManualBillError(res, err);
  }
}
