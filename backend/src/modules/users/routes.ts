import { Router } from "express";
import multer from "multer";
import path from "path";
import * as userController from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { uploadUserPhoto } from "./service";
import { deleteUploadFile } from "../../lib/uploads";

// configuring multer to save user photos to the uploads directory
// each file gets a "user_" prefix followed by a timestamp to avoid name collisions
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, "../../../../uploads")),
  filename: (_req, file, cb) => cb(null, `user_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // limiting upload size to 5 MB

const router = Router();

router.use(authGuard); // all user management routes require authentication
router.use(requireRole("ADMIN")); // only admin can manage users (cashiers)

router.get("/", userController.list); // listing all users, optionally filtered by role
router.post("/", userController.create); // creating a new user (cashier account)
router.put("/:id", userController.update); // updating an existing user's info

// handling user photo upload — admin can upload a photo for any user
// the handler is defined inline because it is simple and only used by this route
router.post("/:id/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
    const photoUrl = `/uploads/${req.file.filename}`; // building the public URL for the uploaded file
    const user = await uploadUserPhoto(String(req.params.id), photoUrl); // updating the user record with the new photo
    res.json(user);
  } catch (err: any) {
    // if the database update fails after the file was saved, we delete the orphaned file
    if (req.file) {
      await deleteUploadFile(`/uploads/${req.file.filename}`);
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
