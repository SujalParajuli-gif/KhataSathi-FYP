import test from "node:test";
import assert from "node:assert/strict";
import { priceFromGrossMargin } from "../modules/products/pricingMath";

test("gross margin calculates selling price from cost", () => {
  assert.equal(priceFromGrossMargin(300, 18), 365.85);
  assert.equal(priceFromGrossMargin(300, 30), 428.57);
});

test("gross margin rejects values at or above one hundred percent", () => {
  assert.throws(() => priceFromGrossMargin(300, 100), /between 0 and 99.99/);
});
