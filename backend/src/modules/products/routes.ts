import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import prisma from "../../db/prisma";
import { deleteReplacedUpload, deleteUploadFile } from "../../lib/uploads";
import { list, getOne, create, update, deactivate, categories, importCsv } from "./controller";
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
router.get("/:id", getOne); // fetching a single product with its brand info
router.post("/", requireRole("ADMIN"), create); // only admin can create new products
router.post("/import-csv", requireRole("ADMIN"), csvUpload.single("file"), importCsv); // only admin can bulk import products from CSV
router.put("/:id", requireRole("ADMIN"), update); // only admin can edit product info
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate); // only admin can deactivate products

// handling product image upload — admin uploads a new product image
// the handler is inline because it directly uses prisma and file cleanup logic
router.post("/:id/image", requireRole("ADMIN"), imgUpload.single("image"), async (req, res) => {
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
