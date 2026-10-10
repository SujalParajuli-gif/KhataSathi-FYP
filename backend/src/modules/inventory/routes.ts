import { Router } from "express";
import multer from "multer";
import { restock, adjust, lowStock, stockTransactions, receiveBatch, receiveBatches, receiveBatchDetail } from "./controller";
import {
  getSuppliersHandler,
  getSupplierBalanceHandler,
  createSupplierHandler,
  updateSupplierHandler,
  deactivateSupplierHandler,
  listPurchasesHandler,
  createPurchaseReceiptHandler,
  getPurchaseDetailHandler,
  createPurchaseInstallmentHandler,
  attachPurchaseDocumentsHandler,
  voidPurchaseInstallmentHandler,
} from "./purchaseController";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { getTempUploadDir } from "../documents/service";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
} from "../documents/validation";
import { asStorageUnavailableError } from "../../lib/storageReadiness";
import { safeDiskUpload } from "../../lib/uploadMiddleware";
import { purchaseReviewHandler } from "./purchaseReviewController";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all inventory routes require authentication
router.use(denyStaff);
router.post("/purchase-sources/:id/confirm", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("confirm"));
router.get("/purchase-sources/:id/review", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("get"));
router.post("/purchase-sources/:id/extract", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("extract"));
router.patch("/purchase-sources/:id/review", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("save"));
router.get("/purchase-sources/:id/candidates", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("candidates"));
router.get("/purchase-sources/:id/duplicates", requireRole("ADMIN", "MANAGER"), purchaseReviewHandler("duplicates"));

// configuring multer for optional bill photo uploads during restock
const billUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, getTempUploadDir());
      } catch (error) {
        cb(asStorageUnavailableError(error) as Error, "");
      }
    },
    filename: (_req, file, cb) => {
      const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      cb(null, `${uniquePrefix}.tmp`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD,
  },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// restock now accepts optional bill photo uploads via multipart/form-data
// the bill files are linked to the stock transaction record
router.post(
  "/restock",
  requireRole("ADMIN", "MANAGER"),
  safeDiskUpload(billUpload.array("billFiles", MAX_FILES_PER_UPLOAD)),
  restock,
);

router.post(
  "/receive-batch",
  requireRole("ADMIN", "MANAGER"),
  safeDiskUpload(billUpload.array("billFiles", MAX_FILES_PER_UPLOAD)),
  receiveBatch,
);
router.get("/receive-batches", requireRole("ADMIN", "MANAGER"), receiveBatches);
router.get("/receive-batches/:id", requireRole("ADMIN", "MANAGER"), receiveBatchDetail);

router.post("/adjust", requireRole("ADMIN", "MANAGER"), adjust); // owner and managers can manually adjust stock (up or down)
router.get("/low-stock", lowStock); // any authenticated user can view products with low stock
router.get("/transactions", stockTransactions); // viewing the stock transaction history

// Financial purchase & supplier management (ADMIN & MANAGER only)
router.get("/suppliers", requireRole("ADMIN", "MANAGER"), getSuppliersHandler);
router.get("/suppliers/:id/balance", requireRole("ADMIN", "MANAGER"), getSupplierBalanceHandler);
router.post("/suppliers", requireRole("ADMIN", "MANAGER"), createSupplierHandler);
router.patch("/suppliers/:id", requireRole("ADMIN", "MANAGER"), updateSupplierHandler);
router.post("/suppliers/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivateSupplierHandler);

router.get("/purchases", requireRole("ADMIN", "MANAGER"), listPurchasesHandler);
router.post("/purchases", requireRole("ADMIN", "MANAGER"), createPurchaseReceiptHandler);
router.get("/purchases/:id", requireRole("ADMIN", "MANAGER"), getPurchaseDetailHandler);
router.post("/purchases/:id/installments", requireRole("ADMIN", "MANAGER"), createPurchaseInstallmentHandler);
router.post("/purchases/:id/attachments", requireRole("ADMIN", "MANAGER"), attachPurchaseDocumentsHandler);

router.post("/purchase-installments/:id/void", requireRole("ADMIN", "MANAGER"), voidPurchaseInstallmentHandler);

export default router;
