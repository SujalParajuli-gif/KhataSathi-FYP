import test from "node:test";
import assert from "node:assert/strict";
import { getGatewayDisplay } from "../modules/payments/controller";

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

test("getGatewayDisplay returns SANDBOX environment for default eSewa sandbox config", async () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.ESEWA_FORM_URL;
    delete process.env.ESEWA_STATUS_CHECK_URL;

    const req: any = {};
    const res = createMockResponse();

    await getGatewayDisplay(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      esewa: {
        environment: "SANDBOX",
        label: "eSewa Sandbox / Test",
      },
    });

    // Ensure secrets and sensitive config fields are NEVER exposed
    assert.equal(res.body.secretKey, undefined);
    assert.equal(res.body.productCode, undefined);
    assert.equal(res.body.formUrl, undefined);
    assert.equal(res.body.statusCheckUrl, undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("getGatewayDisplay returns UNVERIFIED for unknown or custom production URLs", async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.ESEWA_FORM_URL = "https://epay.esewa.com.np/api/epay/main/v2/form";
    process.env.ESEWA_STATUS_CHECK_URL = "https://epay.esewa.com.np/api/epay/transaction/status/";

    const req: any = {};
    const res = createMockResponse();

    await getGatewayDisplay(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      esewa: {
        environment: "UNVERIFIED",
        label: "eSewa (Unverified Config)",
      },
    });
  } finally {
    process.env = originalEnv;
  }
});

test("getGatewayDisplay safely handles malformed URLs without throwing 500", async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.ESEWA_FORM_URL = "not-a-valid-url";
    process.env.ESEWA_STATUS_CHECK_URL = "also-invalid";

    const req: any = {};
    const res = createMockResponse();

    await getGatewayDisplay(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      esewa: {
        environment: "UNVERIFIED",
        label: "eSewa (Unverified Config)",
      },
    });
  } finally {
    process.env = originalEnv;
  }
});
