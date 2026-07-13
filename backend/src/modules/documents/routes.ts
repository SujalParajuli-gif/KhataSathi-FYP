import { Router } from "express";
import multer from "multer";
import path from "path";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import {
  uploadDocuments,
  listDocuments,
  getDocument,
  getDocumentFile,
  deleteDocumentHandler,
  getStorageInfo,
  updateDocumentVisibilityHandler,
} from "./controller";
import { getTempUploadDir } from "./service";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
} from "./validation";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all document routes require authentication
router.use(denyStaff);

// configuring multer for document uploads
// files go to a .temp directory first, then the service moves them to final storage
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, getTempUploadDir());
    },
    filename: (_req, file, cb) => {
      // using a random hex prefix + timestamp to avoid temp file collisions
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
    // first-pass MIME type check — authoritative check happens in controller
    if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// uploading documents — admin and manager can upload, supports multiple files
router.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  upload.array("files", MAX_FILES_PER_UPLOAD),
  uploadDocuments,
);

// listing documents with filters — any authenticated user can browse
router.get("/", listDocuments);

// storage health and statistics — admin only
router.get("/storage-info", requireRole("ADMIN"), getStorageInfo);

// getting a single document's metadata — any authenticated user
router.patch("/:id/visibility", requireRole("ADMIN"), updateDocumentVisibilityHandler);

router.get("/:id", getDocument);

// downloading/previewing the actual file — any authenticated user
router.get("/:id/file", getDocumentFile);

// deleting a document — admin and manager can delete
router.delete("/:id", requireRole("ADMIN", "MANAGER"), deleteDocumentHandler);

export default router;
