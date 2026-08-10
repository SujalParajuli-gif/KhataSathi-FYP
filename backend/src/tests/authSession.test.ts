import test from "node:test";
import assert from "node:assert/strict";
import type { CookieOptions } from "express";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  setSessionCookies,
  signSessionToken,
  verifySignedSessionToken,
} from "../modules/auth/session";

test("signed session tokens accept authentic values and reject tampering", () => {
  const signed = signSessionToken("opaque-session-token");
  assert.equal(verifySignedSessionToken(signed), "opaque-session-token");
  assert.equal(verifySignedSessionToken(`${signed}tampered`), null);
  assert.equal(verifySignedSessionToken("unsigned-token"), null);
});

test("production cookies keep the session HttpOnly and both cookies SameSite/Secure", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "test-production-session-secret-at-least-32-chars";
  const writes: Array<{ name: string; value: string; options: CookieOptions }> = [];
  const response = {
    cookie(name: string, value: string, options: CookieOptions) {
      writes.push({ name, value, options });
      return this;
    },
  };

  try {
    setSessionCookies(response as any, {
      token: "opaque-session-token",
      csrfToken: "csrf-token",
      expiresAt: new Date(Date.now() + 60_000),
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  const session = writes.find((write) => write.name === SESSION_COOKIE_NAME)!;
  const csrf = writes.find((write) => write.name === CSRF_COOKIE_NAME)!;
  assert.equal(session.options.httpOnly, true);
  assert.equal(session.options.secure, true);
  assert.equal(session.options.sameSite, "lax");
  assert.notEqual(session.value, "opaque-session-token");
  assert.equal(csrf.options.httpOnly, false);
  assert.equal(csrf.options.secure, true);
  assert.equal(csrf.options.sameSite, "lax");
});
