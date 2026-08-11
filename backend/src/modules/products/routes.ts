import { Router, type RequestHandler } from "express";
import multer from "multer";
import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";
import {
  deleteProductMedia,
  PRODUCT_IMAGE_LIMIT_BYTES,
  ProductImageValidationError,
  saveProductImageVariants,
} from "../../lib/productMedia";
import {
  list,
  listForPriceLookup,
  getOne,
  getMany,
  getByCode,
  create,
  update,
  deactivate,
  categories,
  importCsv,
  importFromDocument,
  importImage,
  importPdf,
  getImportBatch,
  listImportBatches,
  deleteImportBatch,
  importReviewedBatchRows,
  saveReviewedBatchRows,
  listImportTemplates,
  saveImportTemplate,
  deleteImportTemplate,
  bulkPriceUpdate,
  deleteSafety,
  permanentDelete,
  discardStockAndPermanentDelete,
  recordSearchSelection,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireBusinessCapability } from "../settings/capabilities";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}); // import sources are parsed immediately and never written as unreviewed temp files
// Product images are held in memory only long enough to validate and create
// optimized display/thumbnail variants. Untrusted originals are never served.
const imgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRODUCT_IMAGE_LIMIT_BYTES, files: 1 },
});
const receiveProductImage: RequestHandler = (req, res, next) => {
  imgUpload.single("image")(req, res, (error: any) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "Product images must be 5 MB or smaller." });
      return;
    }
    next(error);
  });
};

router.use(authGuard); // all product routes require authentication

router.get("/", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), list); // listing products with optional filters (search, brand, category, etc.)
router.get("/categories", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), categories); // returning all unique product categories
router.get("/price-lookup", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), listForPriceLookup); // role-aware catalog used by Product Lookup
router.get("/lookup", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), getMany); // batch refresh for products already in a billing cart
router.get("/lookup-code", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), getByCode); // exact scanner lookup by SKU or barcode
router.post("/search-selections", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), recordSearchSelection); // intentional action on a stabilized search result
router.get("/import-batches", requireRole("ADMIN", "MANAGER"), listImportBatches); // recent CSV/PDF/image import batches
router.get("/import-batches/:batchId", requireRole("ADMIN", "MANAGER"), getImportBatch); // returning extracted import rows for review
router.delete("/import-batches/:batchId", requireRole("ADMIN", "MANAGER"), deleteImportBatch); // deleting import review history only, not products
router.get("/import-templates", requireRole("ADMIN", "MANAGER"), listImportTemplates); // saved supplier column mappings
router.post("/import-templates", requireRole("ADMIN", "MANAGER"), saveImportTemplate); // create/update supplier import mapping
router.delete("/import-templates/:id", requireRole("ADMIN", "MANAGER"), deleteImportTemplate); // remove supplier import mapping
router.post("/", requireRole("ADMIN", "MANAGER"), create); // admin and managers can create new products
router.post("/bulk-price-update", requireRole("ADMIN", "MANAGER"), bulkPriceUpdate); // audited seasonal/bulk price updates
router.post("/import-csv", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importCsv); // admin and managers can create CSV/XLSX review batches
router.post("/import-pdf", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importPdf); // admin and managers can create PDF import previews
router.post("/import-image", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importImage); // image rate-list import via optional AI parser
router.post("/import-documents/:documentId", requireRole("ADMIN", "MANAGER"), importFromDocument); // open an import review from an uploaded Documents inbox file
router.put("/import-batches/:batchId/rows", requireRole("ADMIN", "MANAGER"), saveReviewedBatchRows); // persist corrected review drafts before final import
router.post("/import-batches/:batchId/import", requireRole("ADMIN", "MANAGER"), importReviewedBatchRows); // admin and managers can import reviewed rows
router.get("/:id/delete-safety", requireRole("ADMIN", "MANAGER"), deleteSafety); // explains whether a product can be permanently deleted
router.post("/:id/discard-stock-and-delete", requireRole("ADMIN"), requireBusinessCapability("INVENTORY"), discardStockAndPermanentDelete); // admin-only cleanup for unreferenced products with non-zero stock
router.delete("/:id", requireRole("ADMIN"), permanentDelete); // admin-only permanent delete for safe mistake records
router.get("/:id", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), getOne); // fetching a single product with its brand info
router.put("/:id", requireRole("ADMIN", "MANAGER"), update); // admin and managers can edit product info
router.patch("/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivate); // admin and managers can deactivate products

// handling product image upload — admin uploads a new product image
// the handler is inline because it directly uses prisma and file cleanup logic
router.post("/:id/image", requireRole("ADMIN", "MANAGER"), receiveProductImage, async (req, res) => {
  let savedMedia: Awaited<ReturnType<typeof saveProductImageVariants>> | null = null;
  try {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }

    // Fetch both current variants so replacement never leaves unused media behind.
    const existingProduct = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { imageUrl: true, thumbnailUrl: true },
    });

    if (!existingProduct) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    savedMedia = await saveProductImageVariants(req.file.buffer);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: savedMedia,
      include: {
        brand: { select: { id: true, name: true } },
      },
    });
    await Promise.all([
      deleteReplacedUpload(existingProduct.imageUrl, product.imageUrl),
      deleteReplacedUpload(existingProduct.thumbnailUrl, product.thumbnailUrl),
    ]);
    res.json(product);
  } catch (err: any) {
    if (savedMedia) await deleteProductMedia(savedMedia);
    if (err instanceof ProductImageValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message || "Product image upload failed" });
  }
});

export default router;
