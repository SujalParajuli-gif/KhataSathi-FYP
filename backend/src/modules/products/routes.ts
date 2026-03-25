import { Router } from "express";
import multer from "multer";
import path from "path";
import prisma from "../../db/prisma";
import { list, getOne, create, update, deactivate, categories, importCsv } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
const csvUpload = multer({ storage: multer.memoryStorage() });

const imgStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, "../../../../uploads/products")),
  filename: (_req, file, cb) => cb(null, `prod_${Date.now()}${path.extname(file.originalname)}`),
});
const imgUpload = multer({ storage: imgStorage, limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authGuard);

router.get("/", list);
router.get("/categories", categories);
router.get("/:id", getOne);
router.post("/", requireRole("ADMIN"), create);
router.post("/import-csv", requireRole("ADMIN"), csvUpload.single("file"), importCsv);
router.put("/:id", requireRole("ADMIN"), update);
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate);

router.post("/:id/image", requireRole("ADMIN"), imgUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
    const imageUrl = `/uploads/products/${req.file.filename}`;
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrl },
    });
    res.json(product);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
