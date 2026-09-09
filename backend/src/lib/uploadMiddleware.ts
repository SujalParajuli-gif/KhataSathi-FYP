import type { RequestHandler } from "express";
import multer from "multer";
import { asStorageUnavailableError, StorageUnavailableError } from "./storageReadiness";

export function safeDiskUpload(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      const normalized = asStorageUnavailableError(error);
      if (normalized instanceof StorageUnavailableError) {
        res.status(503).json({
          code: normalized.code,
          error: normalized.message,
        });
        return;
      }
      if (normalized instanceof multer.MulterError && normalized.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ code: "FILE_TOO_LARGE", error: "The selected file is too large." });
        return;
      }
      if (normalized instanceof Error && normalized.message.startsWith("File type not allowed:")) {
        res.status(400).json({ code: "BAD_REQUEST", error: normalized.message });
        return;
      }
      next(normalized);
    });
  };
}
