import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env";
import prisma from "../db/prisma";

// we added a custom user field to the Express Request type
// so after verifying the token, every controller and service that runs after this can access req.user
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                role: string;
            };
        }
    }
}

// this middleware runs before any protected route
// we wrote it to verify the JWT and attach the decoded user info to the request object
export async function authGuard(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization; // grabbing the Authorization header from the incoming request

    // the expected format is "Bearer <token>"
    // during testing we noticed requests without this format were slipping through, so we block them here
    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({ error: "No token provided" });
        return;
    }

    const token = header.split(" ")[1]; // splitting on the space to isolate just the token string

    let decoded: {
        id: string;
        role: string;
    };

    try {
        // jwt.verify checks the signature and decodes the payload in one step
        // if the token is tampered with or expired, it will fail and the catch block below handles it
        decoded = jwt.verify(token, JWT_SECRET) as {
            id: string;
            role: string;
        };

        if (!decoded.id || !decoded.role) {
            res.status(401).json({ error: "Invalid or expired token" });
            return;
        }
    } catch {
        // this handles when jwt.verify fails, meaning the token is either expired or someone changed it
        // we return 401 so the frontend knows to clear auth state and send the user back to login
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }

    try {
        const liveUser = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { isActive: true, role: true },
        });

        if (!liveUser || !liveUser.isActive) {
            res.status(401).json({ error: "Account deactivated" });
            return;
        }

        if (String(liveUser.role).toUpperCase() !== String(decoded.role).toUpperCase()) {
            res.status(403).json({ error: "Role changed. Please log in again." });
            return;
        }

        req.user = { id: decoded.id, role: liveUser.role }; // attaching live user data so the next handler can use it
        next(); // passing control to the next middleware or route handler
    } catch (error) {
        next(error);
    }
}
