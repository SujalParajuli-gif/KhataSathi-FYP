import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import type { NextFunction } from "express";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

type MockResponse = {
  statusCode?: number;
  body?: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
};

function createResponse(): MockResponse {
  return {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

async function runAuthGuard(
  token: string,
  liveUser: { isActive: boolean; role: string } | null,
) {
  const [authModule, prismaModule] = await Promise.all([
    import("../middleware/auth.js"),
    import("../db/prisma.js"),
  ]);
  const { authGuard } = authModule;
  const prisma = (prismaModule as any).default?.default ?? (prismaModule as any).default;

  const originalFindUnique = prisma.user.findUnique;
  prisma.user.findUnique = async () => liveUser as any;

  const req: any = {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
  const res = createResponse();
  let nextCalled = false;
  let nextError: unknown;
  const next: NextFunction = (error?: unknown) => {
    nextCalled = true;
    nextError = error;
  };

  try {
    await authGuard(req, res as any, next);
  } finally {
    prisma.user.findUnique = originalFindUnique;
  }

  return { req, res, nextCalled, nextError };
}

function signToken(payload: { id: string; role: string }) {
  return jwt.sign(payload, process.env.JWT_SECRET!);
}

test("authGuard allows active users with matching token role", async () => {
  const result = await runAuthGuard(
    signToken({ id: "user-active", role: "CASHIER" }),
    { isActive: true, role: "CASHIER" },
  );

  assert.equal(result.nextCalled, true);
  assert.equal(result.nextError, undefined);
  assert.equal(result.res.statusCode, undefined);
  assert.deepEqual(result.req.user, { id: "user-active", role: "CASHIER" });
});

test("authGuard rejects deactivated users with valid JWTs", async () => {
  const result = await runAuthGuard(
    signToken({ id: "user-deactivated", role: "CASHIER" }),
    { isActive: false, role: "CASHIER" },
  );

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, { error: "Account deactivated" });
});

test("authGuard rejects valid JWTs when the user's live role changed", async () => {
  const result = await runAuthGuard(
    signToken({ id: "user-promoted", role: "CASHIER" }),
    { isActive: true, role: "MANAGER" },
  );

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 403);
  assert.deepEqual(result.res.body, {
    error: "Role changed. Please log in again.",
  });
});
