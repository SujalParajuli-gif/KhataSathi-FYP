import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import prisma from "../../db/prisma";
import { deleteReplacedUpload, deleteUploadFile } from "../../lib/uploads";
import {
  list,
  getOne,
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
  listImportTemplates,
  saveImportTemplate,
  deleteImportTemplate,
  bulkPriceUpdate,
  deleteSafety,
  permanentDelete,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
const csvUpload = multer({ storage: multer.memoryStorage() }); // storing CSV in memory since we parse it immediately
const productUploadsDir = path.join(__dirname, "../../../../uploads/products");

// making sure the product uploads directory exists before multer tries to save image files there
if (!fs.existsSync(productUploadsDir)) {
  fs.mkdirSync(productUploadsDir, { recursive: true });
}

// configuring multer for product image uploads
// each file gets a "prod_" prefix followed by a timestamp for unique naming
const imgStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, productUploadsDir),
  filename: (_req, file, cb) => cb(null, `prod_${Date.now()}${path.extname(file.originalname)}`),
});
const imgUpload = multer({ storage: imgStorage, limits: { fileSize: 5 * 1024 * 1024 } }); // limiting image size to 5 MB

router.use(authGuard); // all product routes require authentication

router.get("/", list); // listing products with optional filters (search, brand, category, etc.)
router.get("/categories", categories); // returning all unique product categories
router.get("/import-batches", requireRole("ADMIN", "MANAGER"), listImportBatches); // recent CSV/PDF/image import batches
router.get("/import-batches/:batchId", requireRole("ADMIN", "MANAGER"), getImportBatch); // returning extracted import rows for review
router.delete("/import-batches/:batchId", requireRole("ADMIN", "MANAGER"), deleteImportBatch); // deleting import review history only, not products
router.get("/import-templates", requireRole("ADMIN", "MANAGER"), listImportTemplates); // saved supplier column mappings
router.post("/import-templates", requireRole("ADMIN", "MANAGER"), saveImportTemplate); // create/update supplier import mapping
router.delete("/import-templates/:id", requireRole("ADMIN", "MANAGER"), deleteImportTemplate); // remove supplier import mapping
router.post("/", requireRole("ADMIN", "MANAGER"), create); // admin and managers can create new products
router.post("/bulk-price-update", requireRole("ADMIN", "MANAGER"), bulkPriceUpdate); // audited seasonal/bulk price updates
router.post("/import-csv", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importCsv); // admin and managers can bulk import products from CSV
router.post("/import-pdf", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importPdf); // admin and managers can create PDF import previews
router.post("/import-image", requireRole("ADMIN", "MANAGER"), csvUpload.single("file"), importImage); // image rate-list import via optional AI parser
router.post("/import-documents/:documentId", requireRole("ADMIN", "MANAGER"), importFromDocument); // open an import review from an uploaded Documents inbox file
router.post("/import-batches/:batchId/import", requireRole("ADMIN", "MANAGER"), importReviewedBatchRows); // admin and managers can import reviewed rows
router.get("/:id/delete-safety", requireRole("ADMIN", "MANAGER"), deleteSafety); // explains whether a product can be permanently deleted
router.delete("/:id", requireRole("ADMIN"), permanentDelete); // admin-only permanent delete for safe mistake records
router.get("/:id", getOne); // fetching a single product with its brand info
router.put("/:id", requireRole("ADMIN", "MANAGER"), update); // admin and managers can edit product info
router.patch("/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivate); // admin and managers can deactivate products

// handling product image upload — admin uploads a new product image
// the handler is inline because it directly uses prisma and file cleanup logic
router.post("/:id/image", requireRole("ADMIN", "MANAGER"), imgUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
    const imageUrl = `/uploads/products/${req.file.filename}`; // building the public URL for the new image

    // fetching the product's current image URL so we can delete the old file after updating
    const existingProduct = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { imageUrl: true },
    });

    // if the product does not exist, we delete the just-uploaded file and return 404
    if (!existingProduct) {
      await deleteUploadFile(imageUrl);
      res.status(404).json({ error: "Product not found" });
      return;
    }

    // updating the product's image URL in the database
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrl },
      include: {
        brand: { select: { id: true, name: true } },
      },
    });
    await deleteReplacedUpload(existingProduct.imageUrl, product.imageUrl); // deleting the old image file from disk
    res.json(product);
  } catch (err: any) {
    // if anything goes wrong after the file was saved, we clean up the orphaned file
    if (req.file) {
      await deleteUploadFile(`/uploads/products/${req.file.filename}`);
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
