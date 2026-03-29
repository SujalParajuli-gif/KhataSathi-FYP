import { Request, Response } from "express";
import { loginUser, getMe, updateProfile as updateProfileService, uploadProfilePhoto } from "./service";

export async function login(req: Request, res: Response) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            res.status(400).json({ error: "Email and password are required" });
            return;
        }

        const ip = req.ip || req.socket.remoteAddress;
        const result = await loginUser(email, password, ip);

        if (!result.success) {
            res.status(401).json({ error: result.error });
            return;
        }

        res.json({ token: result.token, user: result.user });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function me(req: Request, res: Response) {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }

        const user = await getMe(req.user.id);

        if (!user) {
            res.status(404).json({ error: "User not found" });
            return;
        }

        res.json({ user });
    } catch (err) {
        console.error("Me error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

export async function updateProfile(req: Request, res: Response) {
    try {
        const { name, phone, gender, address, password, profileImage } = req.body;
        const user = await updateProfileService(req.user!.id, { name, phone, gender, address, password, profileImage });
        res.json({ user });
    } catch (err: any) {
        console.error("Update profile error:", err);
        res.status(500).json({ error: err.message || "Internal server error" });
    }
}

export async function uploadPhoto(req: Request, res: Response) {
    try {
        if (!req.file) {
            res.status(400).json({ error: "No photo uploaded" });
            return;
        }
        const photoUrl = `/uploads/${req.file.filename}`;
        const user = await uploadProfilePhoto(req.user!.id, photoUrl);
        res.json({ user });
    } catch (err: any) {
        console.error("Upload photo error:", err);
        res.status(500).json({ error: err.message || "Internal server error" });
    }
}
