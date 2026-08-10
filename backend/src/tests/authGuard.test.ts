import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction } from "express";
import {
  CSRF_COOKIE_NAME,
  hashSessionSecret,
  SESSION_COOKIE_NAME,
  signSessionToken,
} from "../modules/auth/session";

type MockResponse = {
  statusCode?: number;
  body?: unknown;
  cleared: string[];
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
  clearCookie(name: string): MockResponse;
};

function createResponse(): MockResponse {
  return {
    cleared: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    clearCookie(name) { this.cleared.push(name); return this; },
  };
}

async function runAuthGuard(options?: {
  method?: string;
  path?: string;
  csrfHeader?: string;
  session?: any;
}) {
  const [authModule, prismaModule] = await Promise.all([
    import("../middleware/auth.js"),
    import("../db/prisma.js"),
  ]);
  const prisma = (prismaModule as any).default?.default ?? (prismaModule as any).default;
  const originalFindUnique = prisma.authSession.findUnique;
  prisma.authSession.findUnique = async () => options?.session ?? null;

  const req: any = {
    method: options?.method || "GET",
    originalUrl: options?.path || "/api/products",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSessionToken("raw-session"))}; ${CSRF_COOKIE_NAME}=raw-csrf`,
      ...(options?.csrfHeader ? { "x-csrf-token": options.csrfHeader } : {}),
    },
    header(name: string) { return this.headers[name.toLowerCase()]; },
  };
  const res = createResponse();
  let nextCalled = false;
  let nextError: unknown;
  const next: NextFunction = (error?: unknown) => {
    nextCalled = true;
    nextError = error;
  };

  try {
    await authModule.authGuard(req, res as any, next);
  } finally {
    prisma.authSession.findUnique = originalFindUnique;
  }
  return { req, res, nextCalled, nextError };
}

function validSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    csrfTokenHash: hashSessionSecret("raw-csrf"),
    user: {
      id: "user-active",
      role: "CASHIER",
      isActive: true,
      mustChangePassword: false,
    },
    ...overrides,
  };
}

test("authGuard allows an active server-side session", async () => {
  const result = await runAuthGuard({ session: validSession() });
  assert.equal(result.nextCalled, true);
  assert.equal(result.nextError, undefined);
  assert.deepEqual(result.req.user, {
    id: "user-active",
    role: "CASHIER",
    sessionId: "session-1",
    mustChangePassword: false,
  });
});

test("authGuard confines temporary-password sessions to the recovery endpoints", async () => {
  const forced = validSession({
    user: {
      id: "user-active",
      role: "CASHIER",
      isActive: true,
      mustChangePassword: true,
    },
  });
  const blocked = await runAuthGuard({ session: forced, path: "/api/products" });
  assert.equal(blocked.res.statusCode, 428);
  assert.deepEqual(blocked.res.body, {
    code: "PASSWORD_CHANGE_REQUIRED",
    error: "Change the temporary password before continuing.",
  });

  for (const request of [
    { method: "GET", path: "/api/auth/me" },
    { method: "PATCH", path: "/api/auth/profile", csrfHeader: "raw-csrf" },
    { method: "POST", path: "/api/auth/logout", csrfHeader: "raw-csrf" },
  ]) {
    const allowed = await runAuthGuard({ session: forced, ...request });
    assert.equal(allowed.nextCalled, true);
  }
});

test("authGuard rejects revoked, expired, or deactivated sessions", async () => {
  for (const session of [
    validSession({ revokedAt: new Date() }),
    validSession({ expiresAt: new Date(Date.now() - 1) }),
    validSession({ user: { id: "user-active", role: "CASHIER", isActive: false } }),
  ]) {
    const result = await runAuthGuard({ session });
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.deepEqual(result.res.cleared.sort(), [CSRF_COOKIE_NAME, SESSION_COOKIE_NAME].sort());
  }
});

test("authGuard requires the matching CSRF token for mutations", async () => {
  const missing = await runAuthGuard({ method: "POST", session: validSession() });
  assert.equal(missing.res.statusCode, 403);
  assert.deepEqual(missing.res.body, {
    code: "CSRF_INVALID",
    error: "Security token missing or invalid. Refresh the page and try again.",
  });

  const accepted = await runAuthGuard({
    method: "POST",
    csrfHeader: "raw-csrf",
    session: validSession(),
  });
  assert.equal(accepted.nextCalled, true);
});
