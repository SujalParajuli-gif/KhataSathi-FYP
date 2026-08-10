import { Request, Response, NextFunction } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import {
  getSessionToken,
  hashSessionSecret,
} from "../modules/auth/session";

declare global {
  namespace Express {
    interface Request {
      rateLimitUserId?: string;
    }
  }
}

export function getRateLimitSessionIdentity(req: Request) {
  const token = getSessionToken(req);
  return token ? hashSessionSecret(token).slice(0, 32) : null;
}

export function attachRateLimitIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const sessionIdentity = getRateLimitSessionIdentity(req);

  if (sessionIdentity) {
    req.rateLimitUserId = sessionIdentity;
  }

  next();
}

export function generalApiRateLimitKey(req: Request) {
  if (req.rateLimitUserId) {
    return `session:${req.rateLimitUserId}`;
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
