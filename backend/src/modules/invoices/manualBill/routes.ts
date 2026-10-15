import { Router } from "express";
import multer from "multer";
import { authGuard } from "../../../middleware/auth";
import { denyStaff, requireRole } from "../../../middleware/rbac";
import { requireBusinessCapability } from "../../settings/capabilities";
import {
  getManualBillRecordHandler,
  getProofFileHandler,
  getProofThumbnailHandler,
  listManualBillQueueHandler,
  markMissingHandler,
  recordReferenceHandler,
  scanBillPreviewHandler,
  uploadInvoiceProofHandler,
  verifyReferenceHandler,
  withdrawReferenceHandler,
} from "./controller";

const router = Router();
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)),
});

const safeBillUpload: import("express").RequestHandler = (req, res, next) => {
  memoryUpload.single("file")(req, res, error => {
    if (!error) return next();
    res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ code: "INVALID_BILL_UPLOAD", error: error.message || "Invalid bill upload" });
  });
};

router.use(authGuard);
router.use(denyStaff);
router.use(requireBusinessCapability("POS"));

// Queue list
router.get("/queue", requireRole("ADMIN", "MANAGER", "CASHIER"), listManualBillQueueHandler);

// Stateless bill scan preview (OCR observation comparison)
router.post("/scan-preview", requireRole("ADMIN", "MANAGER", "CASHIER"), safeBillUpload, scanBillPreviewHandler);

router.post("/:invoiceId/proof-upload", requireRole("ADMIN", "MANAGER", "CASHIER"), safeBillUpload, uploadInvoiceProofHandler);

// Proof file / thumbnail streaming (invoice-bound)
router.get("/:invoiceId/proofs/:documentId/file", requireRole("ADMIN", "MANAGER", "CASHIER"), getProofFileHandler);
router.get("/:invoiceId/proofs/:documentId/thumbnail", requireRole("ADMIN", "MANAGER", "CASHIER"), getProofThumbnailHandler);

// Invoice manual bill details & history
router.get("/:invoiceId", requireRole("ADMIN", "MANAGER", "CASHIER"), getManualBillRecordHandler);

// Actions
router.post("/:invoiceId/reference", requireRole("ADMIN", "MANAGER", "CASHIER"), recordReferenceHandler);
router.post("/:invoiceId/verify", requireRole("ADMIN", "MANAGER"), verifyReferenceHandler);
router.post("/:invoiceId/missing", requireRole("ADMIN", "MANAGER"), markMissingHandler);
router.post("/:invoiceId/withdraw", requireRole("ADMIN", "MANAGER"), withdrawReferenceHandler);

export default router;
