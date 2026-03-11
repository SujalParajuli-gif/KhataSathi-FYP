// src/middleware/auth.ts — JWT Authentication Middleware
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extend Express Request to include user info
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

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";

/**
 * Middleware: verifies JWT from Authorization header.
 * Attaches req.user = { id, role } if valid.
 * Returns 401 if missing or invalid.
 */
export function authGuard(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({ error: "No token provided" });
        return;
    }

    const token = header.split(" ")[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as {
            id: string;
            role: string;
        };
        req.user = { id: decoded.id, role: decoded.role };
        next();
    } catch {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
}
