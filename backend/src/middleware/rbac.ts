import { Request, Response, NextFunction } from "express";

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
