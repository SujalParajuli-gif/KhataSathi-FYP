import test from "node:test";
import assert from "node:assert/strict";
import {
  BusinessSettingsValidationError,
  normalizeBusinessSettingsInput,
  normalizeBusinessSettingsPatch,
} from "../modules/settings/service";

test("business defaults patch preserves omitted values instead of recreating defaults", () => {
  assert.deepEqual(normalizeBusinessSettingsPatch({ returnWindowDays: 14 }), {
    returnWindowDays: 14,
  });
});

test("business defaults accept fractional stock quantities and bounded loyalty", () => {
  assert.deepEqual(
    normalizeBusinessSettingsPatch({
      defaultInitialStock: 2.5,
      defaultLowStockThreshold: 0.5,
      defaultWholesaleQtyThreshold: 12.5,
      loyaltyDiscountPercent: 10,
    }),
    {
      defaultInitialStock: 2.5,
      defaultLowStockThreshold: 0.5,
      defaultWholesaleQtyThreshold: 12.5,
      loyaltyDiscountPercent: 10,
    },
  );
});

test("business defaults reject silent clamping and fractional duration values", () => {
  assert.throws(
    () => normalizeBusinessSettingsPatch({ loyaltyDiscountPercent: 101 }),
    BusinessSettingsValidationError,
  );
  assert.throws(
    () => normalizeBusinessSettingsPatch({ parkedBillExpiryHours: 1.5 }),
    /whole number/,
  );
});

test("complete business defaults still receive safe creation defaults", () => {
  assert.deepEqual(normalizeBusinessSettingsInput({}), {
    defaultInitialStock: 30,
    defaultLowStockThreshold: 5,
    defaultWholesaleQtyThreshold: 15,
    loyaltyDiscountPercent: 2,
    returnWindowDays: 7,
    parkedBillExpiryHours: 8,
    draftRequestExpiryMinutes: 30,
  });
});
