import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import {
  readIdentityArguments,
  validateCleanPilotBundle,
} from "../scripts/cleanPilotBundle";

function validBundle() {
  const bytes = Buffer.from("profile-image");
  const roles = ["ADMIN", "MANAGER", "CASHIER", "STAFF"] as const;
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accounts: roles.map((role, index) => ({
      id: `user-${index}`,
      name: role,
      email: `${role.toLowerCase()}@example.com`,
      phone: `980000000${index}`,
      gender: null,
      address: null,
      passwordHash: "$2b$12$abcdefghijklmnopqrstuvwxyz1234567890123456789012",
      mustChangePassword: false,
      role,
      nagariktaNo: null,
      createdAt: new Date().toISOString(),
    })),
    profileImages: [
      {
        userId: "user-0",
        publicUrl: "/uploads/admin.png",
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        contentBase64: bytes.toString("base64"),
      },
    ],
    cashierPrivileges: [],
    settings: {
      defaultInitialStock: 30,
      defaultLowStockThreshold: 5,
      defaultWholesaleQtyThreshold: 12,
      loyaltyDiscountPercent: 2,
      returnWindowDays: 7,
      parkedBillExpiryHours: 8,
      draftRequestExpiryMinutes: 30,
    },
  };
}

test("clean pilot bundle accepts exactly one account for each pilot role", () => {
  const bundle = validateCleanPilotBundle(validBundle());
  assert.equal(bundle.accounts.length, 4);
});

test("clean pilot bundle rejects duplicate contact identities", () => {
  const input = validBundle();
  input.accounts[1].phone = input.accounts[0].phone;
  assert.throws(() => validateCleanPilotBundle(input), /duplicate phone/i);
});

test("clean pilot bundle verifies transferred profile image integrity", () => {
  const input = validBundle();
  input.profileImages[0].sha256 = "0".repeat(64);
  assert.throws(() => validateCleanPilotBundle(input), /integrity/i);
});

test("identity arguments require all four roles", () => {
  assert.throws(
    () => readIdentityArguments(["--admin", "Admin"]),
    /manager.*cashier.*staff/i,
  );
  assert.deepEqual(
    readIdentityArguments([
      "--admin=Admin",
      "--manager=Manager",
      "--cashier=Cashier",
      "--staff=Staff",
    ]),
    { admin: "Admin", manager: "Manager", cashier: "Cashier", staff: "Staff" },
  );
});
