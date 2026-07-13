import { Request, Response, NextFunction } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env";

declare global {
  namespace Express {
    interface Request {
      rateLimitUserId?: string;
    }
  }
}

function getBearerToken(req: Request) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.split(" ")[1] || null;
}

export function getRateLimitUserIdFromToken(token: string, secret = JWT_SECRET) {
  try {
    const decoded = jwt.verify(token, secret) as { id?: unknown };
    return typeof decoded.id === "string" && decoded.id.trim()
      ? decoded.id
      : null;
  } catch {
    return null;
  }
}

export function attachRateLimitIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const token = getBearerToken(req);
  const userId = token ? getRateLimitUserIdFromToken(token) : null;

  if (userId) {
    req.rateLimitUserId = userId;
  }

  next();
}

export function generalApiRateLimitKey(req: Request) {
  if (req.rateLimitUserId) {
    return `user:${req.rateLimitUserId}`;
  }

  return `ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown")}`;
}
