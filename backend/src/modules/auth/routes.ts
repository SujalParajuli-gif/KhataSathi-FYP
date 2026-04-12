import { Router } from "express";
import { login, me, updateProfile, uploadPhoto } from "./controller";
import { authGuard } from "../../middleware/auth";
import multer from "multer";
import path from "path";
import fs from "fs";

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

router.post("/login", login);

router.get("/me", authGuard, me);

router.patch("/profile", authGuard, updateProfile);

router.post("/profile/photo", authGuard, upload.single("photo"), uploadPhoto);

export default router;
