import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { CookieOptions, Request, Response } from "express";
import prisma from "../../db/prisma";
import { getSessionConfig } from "../../config/env";

export const SESSION_COOKIE_NAME = "khatasathi_session";
export const CSRF_COOKIE_NAME = "khatasathi_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export function hashSessionSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function signSessionToken(token: string) {
  const { sessionSecret } = getSessionConfig();
  const signature = createHmac("sha256", sessionSecret)
    .update(token)
    .digest("base64url");
  return `${token}.${signature}`;
}

export function verifySignedSessionToken(value: string) {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const token = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signSessionToken(token).slice(separator + 1);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  return token;
}

function cookieOptions(httpOnly: boolean, expires?: Date): CookieOptions {
  const { secureCookies } = getSessionConfig();
  return {
    httpOnly,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

export function parseCookieHeader(header?: string | null) {
  const cookies: Record<string, string> = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function getSessionToken(req: Request) {
  const signedToken = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME];
  return signedToken ? verifySignedSessionToken(signedToken) : null;
}

export async function createAuthSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const { ttlHours } = getSessionConfig();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashSessionSecret(token),
      csrfTokenHash: hashSessionSecret(csrfToken),
      expiresAt,
    },
    select: { id: true, userId: true, expiresAt: true },
  });
  return { ...session, token, csrfToken };
}

export function setSessionCookies(
  res: Response,
  session: { token: string; csrfToken: string; expiresAt: Date },
) {
  res.cookie(
    SESSION_COOKIE_NAME,
    signSessionToken(session.token),
    cookieOptions(true, session.expiresAt),
  );
  res.cookie(
    CSRF_COOKIE_NAME,
    session.csrfToken,
    cookieOptions(false, session.expiresAt),
  );
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(true));
  res.clearCookie(CSRF_COOKIE_NAME, cookieOptions(false));
}

export function csrfTokenMatches(storedHash: string, presentedToken: unknown) {
  if (typeof presentedToken !== "string" || !presentedToken) return false;
  const actual = Buffer.from(hashSessionSecret(presentedToken), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function revokeAuthSession(sessionId: string) {
  await prisma.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string) {
  return prisma.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

export async function purgeDeadAuthSessions(now = new Date()) {
  const revokedBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return prisma.authSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { revokedAt: { lte: revokedBefore } },
      ],
    },
  });
}
