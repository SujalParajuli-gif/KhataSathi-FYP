import { Request, Response, NextFunction } from "express";

// this middleware checks if the logged-in user has one of the allowed roles
// we use it on routes that should only be accessible by specific roles (e.g., admin-only routes)
// it takes a list of allowed roles and returns a middleware function that enforces the check
export function requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        // if req.user is not set, it means the authGuard middleware did not run or the token was missing
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }

        // checking if the user's role is in the list of allowed roles
        // for example, requireRole("ADMIN") will block any user whose role is not "ADMIN"
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: "Access denied — insufficient role" });
            return;
        }

        next(); // user has the right role, so we let the request continue
    };
}
