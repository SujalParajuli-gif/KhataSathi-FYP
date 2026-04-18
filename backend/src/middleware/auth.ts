import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret"; // pulling secret from env, fallback is only for local dev

// this middleware runs before any protected route
// we wrote it to verify the JWT and attach the decoded user info to the request object
export function authGuard(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization; // grabbing the Authorization header from the incoming request

    // the expected format is "Bearer <token>"
    // during testing we noticed requests without this format were slipping through, so we block them here
    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({ error: "No token provided" });
        return;
    }

    const token = header.split(" ")[1]; // splitting on the space to isolate just the token string

    try {
        // jwt.verify checks the signature and decodes the payload in one step
        // if the token is tampered with or expired, it will fail and the catch block below handles it
        const decoded = jwt.verify(token, JWT_SECRET) as {
            id: string;
            role: string;
        };
        req.user = { id: decoded.id, role: decoded.role }; // attaching user data so the next handler can use it
        next(); // passing control to the next middleware or route handler
    } catch {
        // this handles when jwt.verify fails, meaning the token is either expired or someone changed it
        // we return 401 so the frontend knows to clear auth state and send the user back to login
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
}
