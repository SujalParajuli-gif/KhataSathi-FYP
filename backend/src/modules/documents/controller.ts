import { Request, Response } from "express";
import path from "path";
import fs from "fs/promises";
import * as documentService from "./service";
import {
  createDocumentSchema,
  listDocumentsSchema,
  updateDocumentMetadataSchema,
  updateDocumentVisibilitySchema,
  ALLOWED_MIME_TYPES,
} from "./validation";

// uploading one or more document files with metadata
export async function uploadDocuments(req: Request, res: Response) {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one file is required" });
      return;
    }

    // validating MIME types (multer fileFilter is a first pass, this is the authoritative check)
    for (const file of files) {
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
        // cleaning up all temp files before rejecting
        await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
        res.status(400).json({
          error: `File type not allowed: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
        });
        return;
      }
    }

    // parsing and validating metadata from the request body
    const parseResult = createDocumentSchema.safeParse(req.body);
    if (!parseResult.success) {
      // cleaning up temp files on validation failure
      await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
      res.status(400).json({
        error: "Invalid document metadata",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    if (parseResult.data.titles && parseResult.data.titles.length !== files.length) {
      await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
      res.status(400).json({
        error: "Each uploaded file must have one document title",
      });
      return;
    }

    const uploadedFiles = files.map((f) => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      path: f.path,
    }));

    const documents = await documentService.createDocuments(
      uploadedFiles,
      parseResult.data,
      req.user!.id,
    );

    res.status(201).json({ documents });
  } catch (err: any) {
    // cleaning up any temp files that may remain
    const files = req.files as Express.Multer.File[] | undefined;
    if (files) {
      await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
    }

    if (err.message?.includes("storage root")) {
      res.status(503).json({ error: err.message });
      return;
    }

    console.error("Document upload error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// listing documents with filters and pagination
export async function listDocuments(req: Request, res: Response) {
  try {
    const parseResult = listDocumentsSchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const result = await documentService.listDocuments(parseResult.data, req.user!.role);
    res.json(result);
  } catch (err) {
    console.error("List documents error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// fetching a single document's metadata
export async function getDocument(req: Request, res: Response) {
  try {
    const doc = await documentService.getDocumentById(String(req.params.id), req.user!.role);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  } catch (err) {
    console.error("Get document error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// downloading or previewing the actual document file
export async function getDocumentFile(req: Request, res: Response) {
  try {
    const doc = await documentService.getDocumentById(String(req.params.id), req.user!.role);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const filePath = documentService.getDocumentFilePath(doc);
    if (!filePath) {
      res.status(404).json({ error: "Document file not found on disk" });
      return;
    }

    // setting content type and disposition for inline preview (images/PDF)
    res.setHeader("Content-Type", doc.mimeType);
    // inline for images and PDFs so they render in the browser, attachment for others
    const disposition = doc.mimeType.startsWith("image/") || doc.mimeType === "application/pdf"
      ? "inline"
      : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.sendFile(filePath);
  } catch (err) {
    console.error("Get document file error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Serving a small protected derivative keeps document lists fast without
// exposing the original file or bypassing document visibility rules.
export async function getDocumentThumbnail(req: Request, res: Response) {
  try {
    const doc = await documentService.getDocumentById(String(req.params.id), req.user!.role);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const thumbnailPath = documentService.getDocumentThumbnailFilePath(doc);
    if (!thumbnailPath) {
      res.status(404).json({ error: "Document thumbnail not available" });
      return;
    }

    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Content-Disposition", 'inline; filename="document-thumbnail.webp"');
    res.setHeader("Cache-Control", "private, max-age=300, must-revalidate");
    res.sendFile(thumbnailPath);
  } catch (err) {
    console.error("Get document thumbnail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// deleting a document (file + DB record)
export async function deleteDocumentHandler(req: Request, res: Response) {
  try {
    const deleted = await documentService.deleteDocument(String(req.params.id), req.user!.id, req.user!.role);
    res.json({ message: "Document moved to Bin", document: deleted });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("Delete document error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateDocumentVisibilityHandler(req: Request, res: Response) {
  try {
    const parseResult = updateDocumentVisibilitySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid visibility value",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const result = await documentService.updateDocumentVisibility(
      String(req.params.id),
      parseResult.data.visibility,
      req.user!.id,
    );

    res.json({
      ...result,
      message: result.changed
        ? "Document visibility updated"
        : "Document already has this visibility",
    });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("Update document visibility error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateDocumentMetadataHandler(req: Request, res: Response) {
  try {
    const parseResult = updateDocumentMetadataSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid document details",
        details: parseResult.error.issues.map((i) => i.message),
      });
      return;
    }

    const result = await documentService.updateDocumentMetadata(
      String(req.params.id),
      parseResult.data,
      req.user!.id,
    );

    res.json({
      ...result,
      message: result.changed
        ? "Document details updated"
        : "Document details already match",
    });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message?.includes("Invalid bill date")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Update document metadata error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// getting storage health and statistics
export async function getStorageInfo(_req: Request, res: Response) {
  try {
    const info = await documentService.getStorageInfo();
    res.json(info);
  } catch (err) {
    console.error("Storage info error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
