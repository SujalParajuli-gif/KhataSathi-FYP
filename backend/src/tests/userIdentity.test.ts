import test from "node:test";
import assert from "node:assert/strict";
import {
  loginAttemptIdentity,
  normalizeLoginIdentity,
  normalizeOptionalUserEmail,
  normalizeRequiredUserPhone,
  satisfiesStoredUserPhonePolicy,
  UserIdentityValidationError,
  validateUserPassword,
} from "../lib/userIdentity";

test("optional user email stores blank as null and normalizes a real address", () => {
  assert.equal(normalizeOptionalUserEmail("  "), null);
  assert.equal(
    normalizeOptionalUserEmail("  Admin@KhataSathi.COM "),
    "admin@khatasathi.com",
  );
  assert.throws(
    () => normalizeOptionalUserEmail("not-an-email"),
    UserIdentityValidationError,
  );
});

test("required account phone uses the canonical Nepal mobile normalizer", () => {
  assert.equal(normalizeRequiredUserPhone("981-234-5678"), "+9779812345678");
  assert.throws(
    () => normalizeRequiredUserPhone("01-5555555"),
    UserIdentityValidationError,
  );
});

test("active accounts require canonical phones while archived history may omit one", () => {
  assert.equal(satisfiesStoredUserPhonePolicy("+9779812345678", true), true);
  assert.equal(satisfiesStoredUserPhonePolicy("9812345678", true), false);
  assert.equal(satisfiesStoredUserPhonePolicy(null, true), false);
  assert.equal(satisfiesStoredUserPhonePolicy(null, false), true);
  assert.equal(satisfiesStoredUserPhonePolicy("legacy-invalid", false), false);
  assert.equal(satisfiesStoredUserPhonePolicy("+9779812345678", false), true);
});

test("login identity accepts either canonical phone input or normalized email", () => {
  assert.deepEqual(normalizeLoginIdentity("00977 9812345678"), {
    kind: "phone",
    value: "+9779812345678",
  });
  assert.deepEqual(normalizeLoginIdentity(" Admin@KhataSathi.com "), {
    kind: "email",
    value: "admin@khatasathi.com",
  });
  assert.equal(normalizeLoginIdentity("unknown-account"), null);
});

test("login attempt audit value is bounded without storing passwords", () => {
  assert.equal(
    loginAttemptIdentity("anything", {
      kind: "phone",
      value: "+9779812345678",
    }),
    "+9779812345678",
  );
  assert.equal(loginAttemptIdentity("  UNKNOWN  ", null), "unknown");
  assert.equal(loginAttemptIdentity("x".repeat(400), null).length, 191);
});

test("temporary account passwords use a bounded length policy", () => {
  assert.equal(validateUserPassword("Admin@123"), "Admin@123");
  assert.throws(() => validateUserPassword("short"), /at least 8/);
  assert.throws(() => validateUserPassword("x".repeat(129)), /no more than 128/);
});
