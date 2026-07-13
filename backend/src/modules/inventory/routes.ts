import { Router } from "express";
import multer from "multer";
import path from "path";
import { restock, adjust, lowStock, stockTransactions, receiveBatch, receiveBatches, receiveBatchDetail } from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { getTempUploadDir } from "../documents/service";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
} from "../documents/validation";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all inventory routes require authentication
router.use(denyStaff);

// configuring multer for optional bill photo uploads during restock
const billUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, getTempUploadDir());
    },
    filename: (_req, file, cb) => {
      const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uniquePrefix}${ext}`);
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
  billUpload.array("billFiles", MAX_FILES_PER_UPLOAD),
  restock,
);

router.post(
  "/receive-batch",
  requireRole("ADMIN", "MANAGER"),
  billUpload.array("billFiles", MAX_FILES_PER_UPLOAD),
  receiveBatch,
);
router.get("/receive-batches", requireRole("ADMIN", "MANAGER"), receiveBatches);
router.get("/receive-batches/:id", requireRole("ADMIN", "MANAGER"), receiveBatchDetail);

router.post("/adjust", requireRole("ADMIN", "MANAGER"), adjust); // owner and managers can manually adjust stock (up or down)
router.get("/low-stock", lowStock); // any authenticated user can view products with low stock
router.get("/transactions", stockTransactions); // viewing the stock transaction history

export default router;
