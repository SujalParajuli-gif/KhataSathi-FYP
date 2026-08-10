import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_COOKIE_NAME, signSessionToken } from "../modules/auth/session";

async function getRateLimitHelpers() {
  return import("../lib/rateLimit.js");
}

function requestWithSession(sessionToken: string, ip = "192.168.1.20") {
  return {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSessionToken(sessionToken))}`,
    },
    ip,
  } as any;
}

test("general API rate limit keys authenticated browser sessions", async () => {
  const { attachRateLimitIdentity, generalApiRateLimitKey } =
    await getRateLimitHelpers();
  const req = requestWithSession("cashier-session-1");

  attachRateLimitIdentity(req, {} as any, () => undefined);

  assert.match(req.rateLimitUserId, /^[a-f0-9]{32}$/);
  assert.equal(generalApiRateLimitKey(req), `session:${req.rateLimitUserId}`);
});

test("general API rate limit separates users sharing the same IP", async () => {
  const { attachRateLimitIdentity, generalApiRateLimitKey } =
    await getRateLimitHelpers();
  const firstReq = requestWithSession("cashier-session-1");
  const secondReq = requestWithSession("cashier-session-2");

  attachRateLimitIdentity(firstReq, {} as any, () => undefined);
  attachRateLimitIdentity(secondReq, {} as any, () => undefined);

  assert.notEqual(
    generalApiRateLimitKey(firstReq),
    generalApiRateLimitKey(secondReq),
  );
});

test("general API rate limit falls back to IP when the session cookie is missing", async () => {
  const { attachRateLimitIdentity, generalApiRateLimitKey } =
    await getRateLimitHelpers();
  const req = {
    headers: {},
    ip: "192.168.1.20",
  } as any;

  attachRateLimitIdentity(req, {} as any, () => undefined);

  assert.equal(req.rateLimitUserId, undefined);
  assert.equal(generalApiRateLimitKey(req), "ip:192.168.1.20");
});

test("general API rate limit rejects a forged session cookie identity", async () => {
  const { attachRateLimitIdentity, generalApiRateLimitKey } =
    await getRateLimitHelpers();
  const req = {
    headers: { cookie: `${SESSION_COOKIE_NAME}=forged.signature` },
    ip: "192.168.1.20",
  } as any;

  attachRateLimitIdentity(req, {} as any, () => undefined);

  assert.equal(req.rateLimitUserId, undefined);
  assert.equal(generalApiRateLimitKey(req), "ip:192.168.1.20");
});

test("background classification includes presence and alert reads only", async () => {
  const { isBackgroundRateLimitRequest } = await getRateLimitHelpers();
  const request = (method: string, originalUrl: string) =>
    ({ method, originalUrl } as any);

  assert.equal(
    isBackgroundRateLimitRequest(request("PATCH", "/api/users/me/presence")),
    true,
  );
  assert.equal(
    isBackgroundRateLimitRequest(request("GET", "/api/alerts?limit=100")),
    true,
  );
  assert.equal(
    isBackgroundRateLimitRequest(request("PATCH", "/api/alerts/a-1/read")),
    false,
  );
  assert.equal(
    isBackgroundRateLimitRequest(request("GET", "/api/products")),
    false,
  );
});

test("media classification includes document file reads only", async () => {
  const { isMediaRateLimitRequest } = await getRateLimitHelpers();
  const request = (method: string, originalUrl: string) =>
    ({ method, originalUrl } as any);

  assert.equal(
    isMediaRateLimitRequest(request("GET", "/api/documents/doc-1/file")),
    true,
  );
  assert.equal(
    isMediaRateLimitRequest(request("HEAD", "/api/documents/doc-1/file")),
    true,
  );
  assert.equal(
    isMediaRateLimitRequest(request("GET", "/api/documents/doc-1")),
    false,
  );
  assert.equal(
    isMediaRateLimitRequest(request("DELETE", "/api/documents/doc-1/file")),
    false,
  );
});

test("general limiter exemptions match separately limited traffic", async () => {
  const { isGeneralApiRateLimitExempt } = await getRateLimitHelpers();
  const request = (method: string, originalUrl: string) =>
    ({ method, originalUrl } as any);

  assert.equal(
    isGeneralApiRateLimitExempt(request("GET", "/api/health")),
    true,
  );
  assert.equal(
    isGeneralApiRateLimitExempt(request("POST", "/api/auth/login")),
    true,
  );
  assert.equal(
    isGeneralApiRateLimitExempt(request("GET", "/api/alerts/read")),
    true,
  );
  assert.equal(
    isGeneralApiRateLimitExempt(request("GET", "/api/documents/doc-1/file")),
    true,
  );
  assert.equal(
    isGeneralApiRateLimitExempt(request("POST", "/api/invoices/checkout")),
    false,
  );
});
