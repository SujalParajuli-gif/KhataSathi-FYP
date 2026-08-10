import type { NextFunction, Request, Response } from "express";
import prisma from "../db/prisma";
import {
  clearSessionCookies,
  CSRF_HEADER_NAME,
  csrfTokenMatches,
  getSessionToken,
  hashSessionSecret,
} from "../modules/auth/session";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
        sessionId: string;
        mustChangePassword: boolean;
      };
    }
  }
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export async function authGuard(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const token = getSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashSessionSecret(token) },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        csrfTokenHash: true,
        user: {
          select: {
            id: true,
            role: true,
            isActive: true,
            mustChangePassword: true,
          },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.user.isActive
    ) {
      clearSessionCookies(res);
      res.status(401).json({ error: "Session expired or unavailable" });
      return;
    }

    if (
      !isSafeMethod(req.method.toUpperCase()) &&
      !csrfTokenMatches(session.csrfTokenHash, req.header(CSRF_HEADER_NAME))
    ) {
      res.status(403).json({
        code: "CSRF_INVALID",
        error: "Security token missing or invalid. Refresh the page and try again.",
      });
      return;
    }

    req.user = {
      id: session.user.id,
      role: session.user.role,
      sessionId: session.id,
      mustChangePassword: session.user.mustChangePassword,
    };
    if (session.user.mustChangePassword) {
      const path = String(req.originalUrl || req.url || "").split("?", 1)[0];
      const allowedForcedPasswordPath =
        (req.method === "GET" && path === "/api/auth/me") ||
        (req.method === "POST" && path === "/api/auth/logout") ||
        (req.method === "PATCH" && path === "/api/auth/profile");
      if (!allowedForcedPasswordPath) {
        res.status(428).json({
          code: "PASSWORD_CHANGE_REQUIRED",
          error: "Change the temporary password before continuing.",
        });
        return;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}
