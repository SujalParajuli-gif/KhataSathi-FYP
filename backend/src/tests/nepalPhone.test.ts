import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNepalMobilePhone,
  tryNormalizeNepalMobilePhone,
} from "../lib/nepalPhone";

test("Nepal phone normalizer produces one canonical value from local and international input", () => {
  assert.equal(normalizeNepalMobilePhone("9812345678"), "+9779812345678");
  assert.equal(normalizeNepalMobilePhone("+977 981-234-5678"), "+9779812345678");
  assert.equal(normalizeNepalMobilePhone("00977 9812345678"), "+9779812345678");
  assert.equal(normalizeNepalMobilePhone("9779812345678"), "+9779812345678");
});

test("Nepal phone normalizer accepts Devanagari mobile digits", () => {
  assert.equal(normalizeNepalMobilePhone("९८१२३४५६७८"), "+9779812345678");
});

test("Nepal phone normalizer rejects missing, fixed-line, short, and malformed values", () => {
  assert.throws(() => normalizeNepalMobilePhone(""), /required/i);
  assert.throws(() => normalizeNepalMobilePhone("01-5555555"), /10-digit/i);
  assert.throws(() => normalizeNepalMobilePhone("98123"), /10-digit/i);
  assert.throws(() => normalizeNepalMobilePhone("phone-number"), /10-digit/i);
  assert.equal(tryNormalizeNepalMobilePhone(null), null);
});
