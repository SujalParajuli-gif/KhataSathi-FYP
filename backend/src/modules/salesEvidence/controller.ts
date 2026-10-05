import { Request, Response } from "express";
import fs from "fs/promises";
import { ZodError } from "zod/v4";
import {
  archiveSaleEvidence,
  attachSaleEvidence,
  createSaleEvidence,
  getSaleEvidenceById,
  getSaleEvidenceCandidates,
  getSaleEvidenceFile,
  getSaleEvidenceThumbnail,
  listSaleEvidence,
  SalesEvidenceAuthorizationError,
  SalesEvidenceConflictError,
} from "./service";
import {
  archiveSaleEvidenceSchema,
  createSaleEvidenceSchema,
  listSaleEvidenceSchema,
} from "./validation";

import {
  DocumentValidationError,
  type UploadedFileInfo,
} from "../documents/service";
import { StorageUnavailableError } from "../../lib/storageReadiness";
import { logger } from "../../lib/logger";

function getCapabilitiesResolver(res: Response) {
  if (res.locals?.businessCapabilities) {
    return async () => res.locals.businessCapabilities;
  }
  return undefined;
}

export async function uploadSaleEvidence(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    const parseResult = createSaleEvidenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({
        error: "Invalid sales evidence metadata",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const uploadedFile: UploadedFileInfo = {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path,
    };

    const document = await createSaleEvidence(
      uploadedFile,
      parseResult.data,
      req.user!,
      getCapabilitiesResolver(res),
    );

    res.status(201).json({ document });
  } catch (err: any) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    if (err instanceof StorageUnavailableError) {
      res.status(503).json({ code: err.code, error: err.message });
      return;
    }

    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }

    if (err instanceof DocumentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }

    logger.error("Sales evidence upload error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listSaleEvidenceHandler(req: Request, res: Response) {
  try {
    const parseResult = listSaleEvidenceSchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const result = await listSaleEvidence(
      parseResult.data,
      req.user!,
      getCapabilitiesResolver(res),
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }
    logger.error("List sales evidence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getSaleEvidenceHandler(req: Request, res: Response) {
  try {
    const doc = await getSaleEvidenceById(
      String(req.params.id),
      req.user!,
      getCapabilitiesResolver(res),
    );
    if (!doc) {
      res.status(404).json({ error: "Sales evidence not found" });
      return;
    }
    res.json(doc);
  } catch (err: any) {
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }
    logger.error("Get sales evidence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getSaleEvidenceFileHandler(req: Request, res: Response) {
  try {
    const result = await getSaleEvidenceFile(
      String(req.params.id),
      req.user!,
      getCapabilitiesResolver(res),
    );
    if (!result) {
      res.status(404).json({ error: "Sales evidence not found" });
      return;
    }

    if (!result.filePath) {
      res.status(404).json({ error: "Sales evidence file not found on disk" });
      return;
    }

    res.setHeader("Content-Type", result.doc.mimeType);
    const disposition =
      result.doc.mimeType.startsWith("image/") ||
      result.doc.mimeType === "application/pdf"
        ? "inline"
        : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(result.doc.fileName)}"`,
    );
    res.sendFile(result.filePath);
  } catch (err: any) {
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }
    logger.error("Get sales evidence file error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getSaleEvidenceThumbnailHandler(
  req: Request,
  res: Response,
) {
  try {
    const result = await getSaleEvidenceThumbnail(
      String(req.params.id),
      req.user!,
      getCapabilitiesResolver(res),
    );
    if (!result) {
      res.status(404).json({ error: "Sales evidence not found" });
      return;
    }

    if (!result.thumbnailPath) {
      res.status(404).json({ error: "Sales evidence thumbnail not available" });
      return;
    }

    res.setHeader("Content-Type", "image/webp");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="sale-evidence-thumbnail.webp"',
    );
    res.setHeader("Cache-Control", "private, max-age=300, must-revalidate");
    res.sendFile(result.thumbnailPath);
  } catch (err: any) {
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }
    logger.error("Get sales evidence thumbnail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function archiveSaleEvidenceHandler(
  req: Request,
  res: Response,
) {
  try {
    const parseResult = archiveSaleEvidenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid archive request",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const result = await archiveSaleEvidence(
      String(req.params.id),
      parseResult.data,
      req.user!,
      getCapabilitiesResolver(res),
    );

    if (!result) {
      res.status(404).json({ error: "Sales evidence not found" });
      return;
    }

    res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }

    if (err instanceof SalesEvidenceConflictError || err?.statusCode === 409) {
      const payload: Record<string, unknown> = {
        code: err.code || "CONFLICT",
        error: err.message,
      };
      if (err.document) {
        payload.document = err.document;
      }
      res.status(409).json(payload);
      return;
    }

    logger.error("Archive sales evidence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getSaleEvidenceCandidatesHandler(
  req: Request,
  res: Response,
) {
  try {
    const result = await getSaleEvidenceCandidates(
      String(req.params.id),
      req.query as any,
      req.user!,
      getCapabilitiesResolver(res),
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ code: "VALIDATION_ERROR", error: "Invalid candidate query", details: err.issues });
      return;
    }
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }

    if (err instanceof SalesEvidenceConflictError || err?.statusCode === 409 || err?.statusCode === 404) {
      if (err.code === "NOT_FOUND" || err.statusCode === 404) {
        res.status(404).json({
          code: "NOT_FOUND",
          error: err.message || "Sales evidence not found",
        });
        return;
      }

      res.status(409).json({
        code: err.code || "CONFLICT",
        error: err.message,
      });
      return;
    }

    logger.error("Get sales evidence candidates error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function attachSaleEvidenceHandler(req: Request, res: Response) {
  try {
    const result = await attachSaleEvidence(
      String(req.params.id),
      req.body,
      req.user!,
      getCapabilitiesResolver(res),
    );
    res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof ZodError) {
      res.status(400).json({ code: "VALIDATION_ERROR", error: "Invalid attachment decision", details: err.issues });
      return;
    }
    if (err instanceof SalesEvidenceAuthorizationError || err?.statusCode === 403) {
      res.status(403).json({
        code: err.code || "FORBIDDEN",
        error: err.message,
      });
      return;
    }

    if (err instanceof SalesEvidenceConflictError || err?.statusCode === 409 || err?.statusCode === 404) {
      if (err.code === "NOT_FOUND" || err.statusCode === 404) {
        res.status(404).json({
          code: "NOT_FOUND",
          error: err.message || "Sales evidence not found",
        });
        return;
      }

      const payload: Record<string, unknown> = {
        code: err.code || "CONFLICT",
        error: err.message,
      };
      if (err.document) {
        payload.document = err.document;
      }
      res.status(409).json(payload);
      return;
    }

    logger.error("Attach sales evidence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
