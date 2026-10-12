import { Router, type RequestHandler } from "express";
import multer from "multer";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { requireBusinessCapability } from "../settings/capabilities";
import { getSalesReviewHandler, extractSalesReviewHandler, saveSalesReviewHandler, salesReviewMatchesHandler } from "./reviewController";
import {
  archiveSaleEvidenceHandler,
  attachSaleEvidenceHandler,
  getSaleEvidenceCandidatesHandler,
  getSaleEvidenceFileHandler,
  getSaleEvidenceHandler,
  getSaleEvidenceRecoveryHandler,
  getSaleEvidenceThumbnailHandler,
  listSaleEvidenceHandler,
  postSaleEvidenceRecoveryHandler,
  reviseSaleEvidenceRecoveryHandler,
  uploadSaleEvidence,
  reassociateSaleEvidenceHandler,
  voidSaleEvidenceHandler,
  getSaleEvidenceHistoryHandler,
} from "./controller";
import { getTempUploadDir } from "../documents/service";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
} from "../documents/validation";
import {
  asStorageUnavailableError,
  StorageUnavailableError,
} from "../../lib/storageReadiness";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.use(requireRole("ADMIN", "MANAGER"));
router.use(requireBusinessCapability("POS"));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, getTempUploadDir());
      } catch (error) {
        cb(asStorageUnavailableError(error) as Error, "");
      }
    },
    filename: (_req, _file, cb) => {
      const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      cb(null, `${uniquePrefix}.tmp`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

function safeSingleUpload(handler: RequestHandler): RequestHandler {
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
      if (normalized instanceof multer.MulterError) {
        if (normalized.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            code: "FILE_TOO_LARGE",
            error: "The selected file is too large.",
          });
          return;
        }
        res.status(400).json({
          code: "BAD_REQUEST",
          error: normalized.message || "Invalid upload request",
        });
        return;
      }
      if (
        normalized instanceof Error &&
        normalized.message.startsWith("File type not allowed:")
      ) {
        res.status(400).json({
          code: "BAD_REQUEST",
          error: normalized.message,
        });
        return;
      }
      next(normalized);
    });
  };
}

router.post("/", safeSingleUpload(upload.single("file")), uploadSaleEvidence);
router.get("/:id/review", getSalesReviewHandler);
router.post("/:id/extract", extractSalesReviewHandler);
router.patch("/:id/review", saveSalesReviewHandler);
router.get("/:id/review-matches", salesReviewMatchesHandler);
router.post("/:id/archive", archiveSaleEvidenceHandler);
router.get("/:id/candidates", getSaleEvidenceCandidatesHandler);
router.post("/:id/attach", attachSaleEvidenceHandler);
router.post("/:id/reassociate", reassociateSaleEvidenceHandler);
router.post("/:id/void", voidSaleEvidenceHandler);
router.get("/:id/history", getSaleEvidenceHistoryHandler);
router.get("/:id/recovery", getSaleEvidenceRecoveryHandler);
router.post("/:id/recovery", postSaleEvidenceRecoveryHandler);
router.post("/:id/recovery/revise", reviseSaleEvidenceRecoveryHandler);
router.get("/", listSaleEvidenceHandler);
router.get("/:id", getSaleEvidenceHandler);
router.get("/:id/file", getSaleEvidenceFileHandler);
router.get("/:id/thumbnail", getSaleEvidenceThumbnailHandler);

export default router;
