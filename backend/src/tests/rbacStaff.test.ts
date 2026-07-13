import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { denyStaff, requireRole } from "../middleware/rbac";

type MockResponse = Response & {
  statusCodeValue?: number;
  jsonBody?: unknown;
};

function makeResponse(): MockResponse {
  return {
    status(code: number) {
      this.statusCodeValue = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  } as MockResponse;
}

function makeRequest(role?: string): Request {
  return {
    user: role ? { id: "user-1", role } : undefined,
  } as Request;
}

test("denyStaff blocks staff accounts from general authenticated routes", () => {
  const req = makeRequest("STAFF");
  const res = makeResponse();
  let nextCalled = false;

  denyStaff(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCodeValue, 403);
  assert.deepEqual(res.jsonBody, {
    error: "Staff access is limited to product lookup and own profile",
  });
});

test("denyStaff allows existing non-staff roles through", () => {
  const req = makeRequest("CASHIER");
  const res = makeResponse();
  let nextCalled = false;

  denyStaff(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCodeValue, undefined);
});

test("requireRole rejects staff unless a route explicitly allows it", () => {
  const req = makeRequest("STAFF");
  const res = makeResponse();
  let nextCalled = false;

  requireRole("ADMIN", "MANAGER")(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCodeValue, 403);
});
