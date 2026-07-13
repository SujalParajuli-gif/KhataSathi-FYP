import test from "node:test";
import assert from "node:assert/strict";
import {
  checkoutBodySchema,
  finalizeBodySchema,
  priceOverrideAuthorizationBodySchema,
} from "../modules/invoices/validation";
import { voidPaymentBodySchema } from "../modules/payments/validation";
import { adjustStockBodySchema } from "../modules/inventory/validation";

function assertInvalid(result: { success: boolean }) {
  assert.equal(result.success, false);
}

test("checkout validation accepts valid split-payment payloads", () => {
  const result = checkoutBodySchema.safeParse({
    draftInvoiceId: "draft-1",
    customerId: "customer-1",
    discountAmount: 25,
    overridePin: "1234",
    notes: "Pickup after lunch",
    items: [
      {
        productId: "product-1",
        qty: 2,
        overrideUnitPrice: 95,
        overrideReason: "Owner approved",
        overrideAuthorizationToken: "token-1",
      },
    ],
    payments: [
      { method: "CASH", amount: 100, tenderedAmount: 100 },
      { method: "ESEWA", amount: 90, reference: "online" },
    ],
  });

  assert.equal(result.success, true);
});

test("checkout validation rejects numeric strings, HTML strings, and extra fields", () => {
  assertInvalid(
    checkoutBodySchema.safeParse({
      items: [{ productId: "product-1", qty: "2" }],
    }),
  );
  assertInvalid(
    checkoutBodySchema.safeParse({
      notes: "<b>discount</b>",
      items: [{ productId: "product-1", qty: 2 }],
    }),
  );
  assertInvalid(
    checkoutBodySchema.safeParse({
      items: [{ productId: "product-1", qty: 2, surprise: true }],
    }),
  );
});

test("finalization validation rejects negative discounts and extra fields", () => {
  assert.equal(finalizeBodySchema.safeParse({ discountAmount: 0 }).success, true);
  assertInvalid(finalizeBodySchema.safeParse({ discountAmount: -1 }));
  assertInvalid(finalizeBodySchema.safeParse({ discountAmount: "1" }));
  assertInvalid(finalizeBodySchema.safeParse({ discountAmount: 1, extra: true }));
});

test("price override validation rejects malformed sensitive fields", () => {
  assert.equal(
    priceOverrideAuthorizationBodySchema.safeParse({
      productId: "product-1",
      qty: 1,
      overrideUnitPrice: 90,
      overrideReason: "Shelf tag correction",
      pin: "1234",
    }).success,
    true,
  );
  assertInvalid(
    priceOverrideAuthorizationBodySchema.safeParse({
      productId: "product-1",
      qty: "1",
      overrideUnitPrice: 90,
      overrideReason: "Shelf tag correction",
    }),
  );
  assertInvalid(
    priceOverrideAuthorizationBodySchema.safeParse({
      productId: "product-1",
      qty: 1,
      overrideUnitPrice: -90,
      overrideReason: "Shelf tag correction",
    }),
  );
  assertInvalid(
    priceOverrideAuthorizationBodySchema.safeParse({
      productId: "product-1",
      qty: 1,
      overrideUnitPrice: 90,
      overrideReason: "<script>alert(1)</script>",
    }),
  );
});

test("payment void validation only accepts an optional safe override pin", () => {
  assert.equal(voidPaymentBodySchema.safeParse({}).success, true);
  assert.equal(voidPaymentBodySchema.safeParse({ overridePin: "1234" }).success, true);
  assertInvalid(voidPaymentBodySchema.safeParse({ overridePin: "<b>1234</b>" }));
  assertInvalid(voidPaymentBodySchema.safeParse({ overridePin: "1234", reason: "extra" }));
});

test("stock adjustment validation accepts signed numeric deltas but rejects strings, zero, HTML, and extras", () => {
  assert.equal(
    adjustStockBodySchema.safeParse({
      productId: "product-1",
      qtyDelta: -2,
      reason: "Damaged stock",
    }).success,
    true,
  );
  assertInvalid(
    adjustStockBodySchema.safeParse({
      productId: "product-1",
      qtyDelta: "-2",
      reason: "Damaged stock",
    }),
  );
  assertInvalid(
    adjustStockBodySchema.safeParse({
      productId: "product-1",
      qtyDelta: 0,
      reason: "No-op",
    }),
  );
  assertInvalid(
    adjustStockBodySchema.safeParse({
      productId: "product-1",
      qtyDelta: 2,
      reason: "<img src=x>",
    }),
  );
  assertInvalid(
    adjustStockBodySchema.safeParse({
      productId: "product-1",
      qtyDelta: 2,
      reason: "Count correction",
      extra: true,
    }),
  );
});
