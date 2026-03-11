// src/middleware/rbac.ts — Role-Based Access Control
import { Request, Response, NextFunction } from "express";

/**
 * Middleware factory: only allows users with the given role(s).
 * Must be used AFTER authGuard so req.user is set.
 *
 * Usage: router.get("/admin-only", authGuard, requireRole("ADMIN"), handler);
 */
export function requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }

        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: "Access denied — insufficient role" });
            return;
        }

        next();
    };
}
