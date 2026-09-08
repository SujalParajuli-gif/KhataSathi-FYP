import test from "node:test";
import assert from "node:assert/strict";
import { priceFromPercentageChange } from "../modules/products/pricingMath";

test("selling prices can be increased or decreased from the neutral Rate", () => {
  assert.equal(priceFromPercentageChange(300, 18, "INCREASE"), 354);
  assert.equal(priceFromPercentageChange(300, 30, "DECREASE"), 210);
});

test("percentage changes reject unsafe values", () => {
  assert.throws(() => priceFromPercentageChange(300, 100, "DECREASE"), /below 100/);
  assert.throws(() => priceFromPercentageChange(0, 20, "INCREASE"), /Rate/);
});
