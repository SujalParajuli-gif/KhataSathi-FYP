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

function normalizedRequestPath(req: Request) {
  return String(req.originalUrl || req.url || "")
    .split("?", 1)[0]
    .replace(/\/+$/, "");
}

// Presence heartbeats and read-only alert refreshes are background traffic.
// Alert mutations deliberately stay in the main API budget because they are
// user actions and must not inherit the more generous polling allowance.
export function isBackgroundRateLimitRequest(req: Request) {
  const path = normalizedRequestPath(req);
  if (
    path === "/api/users/me/presence" ||
    path === "/api/users/cashiers/presence"
  ) {
    return true;
  }

  return req.method === "GET" && path.startsWith("/api/alerts");
}

// Authenticated document previews/downloads can be numerous on a document
// screen and must not exhaust the business-API allowance. They still retain a
// separate limiter rather than being left unprotected.
export function isMediaRateLimitRequest(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = normalizedRequestPath(req);
  return /^\/api\/documents\/[^/]+\/file$/.test(path);
}

export function isGeneralApiRateLimitExempt(req: Request) {
  const path = normalizedRequestPath(req);
  return (
    path === "/api/health" ||
    path === "/api/auth/login" ||
    isBackgroundRateLimitRequest(req) ||
    isMediaRateLimitRequest(req)
  );
}
