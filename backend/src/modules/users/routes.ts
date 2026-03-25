import { Router } from "express";
import multer from "multer";
import path from "path";
import * as userController from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { uploadUserPhoto } from "./service";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, "../../../../uploads")),
  filename: (_req, file, cb) => cb(null, `user_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.use(authGuard);
router.use(requireRole("ADMIN"));

router.get("/", userController.list);
router.post("/", userController.create);
router.put("/:id", userController.update);

router.post("/:id/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
    const photoUrl = `/uploads/${req.file.filename}`;
    const user = await uploadUserPhoto(req.params.id, photoUrl);
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;