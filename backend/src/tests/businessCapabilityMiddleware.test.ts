import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import {
  requireBusinessCapability,
  resolveBusinessCapabilities,
  type BusinessCapability,
  type BusinessCapabilities,
  type BusinessMode,
} from "../modules/settings/capabilities";

type CapturedResponse = {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
};

function createResponse() {
  const captured: CapturedResponse = {
    statusCode: 200,
    body: undefined,
    locals: {},
  };
  const response = {
    locals: captured.locals,
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { response, captured };
}

async function exerciseGuard(
  capabilities: BusinessCapabilities,
  capability: BusinessCapability,
) {
  const { response, captured } = createResponse();
  let nextCalls = 0;
  let nextError: unknown;
  const next = ((error?: unknown) => {
    nextCalls += 1;
    nextError = error;
  }) as NextFunction;

  await requireBusinessCapability(
    capability,
    async () => capabilities,
  )({} as Request, response, next);

  return { ...captured, nextCalls, nextError };
}

const EXPECTED_ACCESS: Record<
  BusinessMode,
  Record<BusinessCapability, boolean>
> = {
  CATALOG_ONLY: {
    CATALOG: true,
    INVENTORY: false,
    POS: false,
    STAFF_DRAFT_REQUESTS: false,
  },
  INVENTORY_ONLY: {
    CATALOG: true,
    INVENTORY: true,
    POS: false,
    STAFF_DRAFT_REQUESTS: false,
  },
  FULL_POS: {
    CATALOG: true,
    INVENTORY: true,
    POS: true,
    STAFF_DRAFT_REQUESTS: true,
  },
};

for (const businessMode of Object.keys(EXPECTED_ACCESS) as BusinessMode[]) {
  test(`${businessMode} capability middleware enforces its direct-call matrix`, async () => {
    const capabilities = resolveBusinessCapabilities({
      businessMode,
      staffDraftRequestsEnabled: true,
    });

    for (const [capability, allowed] of Object.entries(
      EXPECTED_ACCESS[businessMode],
    ) as Array<[BusinessCapability, boolean]>) {
      const result = await exerciseGuard(capabilities, capability);
      if (allowed) {
        assert.equal(result.nextCalls, 1, `${capability} should call next()`);
        assert.equal(result.nextError, undefined);
        assert.equal(result.statusCode, 200);
        assert.equal(result.body, undefined);
        assert.deepEqual(result.locals.businessCapabilities, capabilities);
      } else {
        assert.equal(result.nextCalls, 0, `${capability} must not call next()`);
        assert.equal(result.statusCode, 403);
        assert.deepEqual(result.body, {
          code: "FEATURE_DISABLED",
          error: `${capability.replaceAll("_", " ")} is disabled in ${businessMode} mode`,
          capability,
          businessMode,
        });
      }
    }
  });
}

test("FULL_POS still blocks direct staff-draft calls when its independent toggle is off", async () => {
  const capabilities = resolveBusinessCapabilities({
    businessMode: "FULL_POS",
    staffDraftRequestsEnabled: false,
  });
  const result = await exerciseGuard(capabilities, "STAFF_DRAFT_REQUESTS");

  assert.equal(result.nextCalls, 0);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, {
    code: "FEATURE_DISABLED",
    error: "STAFF DRAFT REQUESTS is disabled in FULL_POS mode",
    capability: "STAFF_DRAFT_REQUESTS",
    businessMode: "FULL_POS",
  });
});

test("capability resolver failures are forwarded to Express error handling", async () => {
  const expectedError = new Error("settings unavailable");
  const { response, captured } = createResponse();
  let forwarded: unknown;

  await requireBusinessCapability("POS", async () => {
    throw expectedError;
  })({} as Request, response, ((error?: unknown) => {
    forwarded = error;
  }) as NextFunction);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body, undefined);
  assert.equal(forwarded, expectedError);
});

test("direct HTTP calls receive the same allow/deny capability contract", async () => {
  const app = express();
  const catalogCapabilities = resolveBusinessCapabilities({
    businessMode: "CATALOG_ONLY",
    staffDraftRequestsEnabled: false,
  });
  const fullPosCapabilities = resolveBusinessCapabilities({
    businessMode: "FULL_POS",
    staffDraftRequestsEnabled: true,
  });

  app.get(
    "/catalog/products",
    requireBusinessCapability("CATALOG", async () => catalogCapabilities),
    (_request, response) => response.json({ ok: true }),
  );
  app.get(
    "/catalog/invoices",
    requireBusinessCapability("POS", async () => catalogCapabilities),
    (_request, response) => response.json({ ok: true }),
  );
  app.get(
    "/full-pos/invoices",
    requireBusinessCapability("POS", async () => fullPosCapabilities),
    (_request, response) => response.json({ ok: true }),
  );

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const catalogResponse = await fetch(`${baseUrl}/catalog/products`);
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(await catalogResponse.json(), { ok: true });

    const blockedResponse = await fetch(`${baseUrl}/catalog/invoices`);
    assert.equal(blockedResponse.status, 403);
    assert.deepEqual(await blockedResponse.json(), {
      code: "FEATURE_DISABLED",
      error: "POS is disabled in CATALOG_ONLY mode",
      capability: "POS",
      businessMode: "CATALOG_ONLY",
    });

    const fullPosResponse = await fetch(`${baseUrl}/full-pos/invoices`);
    assert.equal(fullPosResponse.status, 200);
    assert.deepEqual(await fullPosResponse.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
