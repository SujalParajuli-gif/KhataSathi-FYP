import { Request, Response } from "express";
import { loginUser, getMe, updateProfile as updateProfileService, uploadProfilePhoto } from "./service";
import { deleteUploadFile } from "../../lib/uploads";
import { UserIdentityValidationError } from "../../lib/userIdentity";
import {
    clearSessionCookies,
    createAuthSession,
    revokeAuthSession,
    revokeUserSessions,
    setSessionCookies,
} from "./session";

// handling the login request — validates input, calls the login service, and returns the token + user data
export async function login(req: Request, res: Response) {
    try {
        const identifier = req.body?.identifier ?? req.body?.email;
        const { password } = req.body;

        // making sure both fields are provided before attempting login
        if (!identifier || !password) {
            res.status(400).json({ error: "Phone/email and password are required" });
            return;
        }

        const ip = req.ip || req.socket.remoteAddress; // capturing the IP address for login attempt logging
        const result = await loginUser(String(identifier), String(password), ip);

        // this handles when login fails — wrong email, wrong password, or inactive account
        if (!result.success) {
            res.status(401).json({ error: result.error });
            return;
        }

        const session = await createAuthSession(result.user!.id);
        setSessionCookies(res, session);
        res.json({ user: result.user });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

// returning the currently logged-in user's profile data
// the frontend calls this after page reload to verify the token is still valid and get fresh user info
export async function me(req: Request, res: Response) {
    try {
        // req.user is set by the authGuard middleware — if it is missing, the user is not authenticated
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }

        const user = await getMe(req.user.id); // fetching user data from the database

        // this handles when the user ID in the token points to a user that no longer exists or is deactivated
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

// handling profile update — the user can change their name, phone, gender, address, or password
export async function updateProfile(req: Request, res: Response) {
    try {
        // extracting all possible profile fields from the request body
        const {
            name,
            phone,
            gender,
            address,
            currentPassword,
            newPassword,
            password,
            profileImage,
        } = req.body;
        if (req.user!.mustChangePassword && !(newPassword || password)) {
            res.status(428).json({
                code: "PASSWORD_CHANGE_REQUIRED",
                error: "Change the temporary password before updating anything else.",
            });
            return;
        }
        if (
            req.user!.mustChangePassword &&
            [name, phone, gender, address, profileImage].some(
                (value) => value !== undefined,
            )
        ) {
            res.status(400).json({
                code: "PASSWORD_CHANGE_ONLY",
                error: "Finish changing the temporary password before editing profile details.",
            });
            return;
        }
        const user = await updateProfileService(req.user!.id, {
            name,
            phone,
            gender,
            address,
            currentPassword,
            newPassword,
            password,
            profileImage,
        });
        if (newPassword || password) {
            await revokeUserSessions(req.user!.id);
            const replacementSession = await createAuthSession(req.user!.id);
            setSessionCookies(res, replacementSession);
        }
        res.json({ user }); // returning the updated user data
    } catch (err: any) {
        console.error("Update profile error:", err);
        // checking if the error is a known validation error (wrong current password or user not found)
        // these are expected errors so we return 400 instead of 500
        if (err instanceof UserIdentityValidationError) {
            res.status(400).json({ error: err.message, field: err.field });
            return;
        }
        if (err?.code === "P2002") {
            res.status(409).json({ error: "Phone number already belongs to another account", field: "phone" });
            return;
        }
        if (
            String(err?.message || "").includes("Current password") ||
            String(err?.message || "").includes("New password") ||
            String(err?.message || "").includes("User not found")
        ) {
            res.status(400).json({ error: err.message });
            return;
        }
        res.status(500).json({ error: err.message || "Internal server error" });
    }
}

export async function logout(req: Request, res: Response) {
    try {
        if (req.user?.sessionId) {
            await revokeAuthSession(req.user.sessionId);
        }
        clearSessionCookies(res);
        res.json({ success: true });
    } catch (error) {
        console.error("Logout error:", error);
        clearSessionCookies(res);
        res.status(500).json({ error: "Unable to complete logout" });
    }
}

// handling profile photo upload — saves the file and updates the user's profileImage in the database
export async function uploadPhoto(req: Request, res: Response) {
    try {
        // if no file was included in the request, we cannot proceed
        if (!req.file) {
            res.status(400).json({ error: "No photo uploaded" });
            return;
        }
        const photoUrl = `/uploads/${req.file.filename}`; // building the public URL for the uploaded file
        const user = await uploadProfilePhoto(req.user!.id, photoUrl); // updating the user record with the new photo URL
        res.json({ user });
    } catch (err: any) {
        // if something goes wrong after the file was saved, we delete the uploaded file to avoid orphaned files on disk
        if (req.file) {
            await deleteUploadFile(`/uploads/${req.file.filename}`);
        }
        console.error("Upload photo error:", err);
        res.status(500).json({ error: err.message || "Internal server error" });
    }
}
