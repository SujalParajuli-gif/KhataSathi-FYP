import { Router } from "express";
import { login, logout, me, updateProfile, uploadPhoto } from "./controller";
import { authGuard } from "../../middleware/auth";
import multer from "multer";
import path from "path";
import fs from "fs";

// making sure the uploads directory exists before multer tries to save files there
// if it does not exist, we create it recursively (including any parent folders)
const uploadsDir = path.join(__dirname, "../../../../uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// configuring multer to save uploaded files to the uploads directory
// each file gets a unique name using a timestamp + random number to avoid name collisions
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname)); // keeping the original file extension
    }
});
const upload = multer({ storage });

const router: ReturnType<typeof Router> = Router();

router.post("/login", login); // public route — no auth needed for logging in

router.post("/logout", authGuard, logout);

router.get("/me", authGuard, me); // protected — returns the currently logged-in user's profile data

router.patch("/profile", authGuard, updateProfile); // protected — lets the user update their own profile info

// protected — handles profile photo upload using multer to process the file
// "photo" is the field name expected in the multipart form data from the frontend
router.post("/profile/photo", authGuard, upload.single("photo"), uploadPhoto);

export default router;
