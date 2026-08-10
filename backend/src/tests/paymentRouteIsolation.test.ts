import assert from "node:assert/strict";
import test from "node:test";
import paymentRoutes from "../modules/payments/routes";

test("payment capability guards are scoped to payment routes", () => {
  const layers = (paymentRoutes as any).stack as Array<{
    route?: { path?: string };
  }>;

  assert.ok(layers.length > 0);
  assert.equal(
    layers.filter((layer) => !layer.route).length,
    0,
    "A router-wide payment middleware would intercept unrelated /api routes",
  );
  assert.deepEqual(
    [...new Set(layers.map((layer) => String(layer.route?.path)))].sort(),
    [
      "/invoices/:id/payments",
      "/invoices/:id/payments/:paymentId/void",
      "/payments/esewa/failure/:paymentId",
      "/payments/esewa/initiate",
      "/payments/esewa/verify/:paymentId",
    ].sort(),
  );
});
