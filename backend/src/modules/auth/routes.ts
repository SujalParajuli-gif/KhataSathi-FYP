import { Router } from "express";
import { login, me, updateProfile, uploadPhoto } from "./controller";
import { authGuard } from "../../middleware/auth";
import multer from "multer";
import path from "path";
import fs from "fs";

// Ensure uploads dir exists
const uploadsDir = path.join(__dirname, "../../../../uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const router: ReturnType<typeof Router> = Router();

// POST /api/auth/login — authenticate user
router.post("/login", login);

// GET /api/auth/me — get current user from JWT
router.get("/me", authGuard, me);

// PATCH /api/auth/profile — update current user profile (name, phone, password)
router.patch("/profile", authGuard, updateProfile);

// POST /api/auth/profile/photo — upload profile image
router.post("/profile/photo", authGuard, upload.single("photo"), uploadPhoto);

export default router;
