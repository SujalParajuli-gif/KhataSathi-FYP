import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import prisma from "../db/prisma";

const testUser = async (overrides: Record<string, unknown> = {}) => ({
  id: "user-1",
  name: "Test User",
  email: null,
  phone: "+9779812345678",
  gender: null,
  address: null,
  role: "STAFF",
  isActive: true,
  lastLogin: null,
  lastPresenceAt: null,
  profileImage: null,
  nagariktaNo: null,
  createdAt: new Date(),
  passwordHash: await bcrypt.hash("correct-password", 10),
  mustChangePassword: false,
  ...overrides,
});

async function withAuthDatabaseMocks(
  findUser: (where: unknown) => Promise<any>,
  run: (attempts: any[]) => Promise<void>,
) {
  const userDelegate = prisma.user as any;
  const attemptDelegate = prisma.loginAttempt as any;
  const originalFindUnique = userDelegate.findUnique;
  const originalUpdate = userDelegate.update;
  const originalAttemptCreate = attemptDelegate.create;
  const attempts: any[] = [];

  userDelegate.findUnique = ({ where }: any) => findUser(where);
  userDelegate.update = async ({ data }: any) => ({ ...await testUser(), ...data });
  attemptDelegate.create = async ({ data }: any) => {
    attempts.push(data);
    return { id: "attempt-1", createdAt: new Date(), ...data };
  };

  try {
    await run(attempts);
  } finally {
    userDelegate.findUnique = originalFindUnique;
    userDelegate.update = originalUpdate;
    attemptDelegate.create = originalAttemptCreate;
  }
}

test("login accepts a Nepali phone and returns nullable email safely", async () => {
  const { loginUser } = await import("../modules/auth/service.js");
  let lookup: unknown;
  await withAuthDatabaseMocks(
    async (where) => {
      lookup = where;
      return testUser();
    },
    async (attempts) => {
      const result = await loginUser("00977 9812345678", "correct-password", "127.0.0.1");
      assert.equal(result.success, true);
      assert.equal(result.user?.email, null);
      assert.equal(result.user?.phone, "+9779812345678");
      assert.deepEqual(lookup, { phone: "+9779812345678" });
      assert.equal(attempts[0].email, "+9779812345678");
      assert.equal(attempts[0].success, true);
    },
  );
});

test("unknown, wrong-password, and inactive logins share one generic response", async () => {
  const { loginUser } = await import("../modules/auth/service.js");
  const messages: string[] = [];

  await withAuthDatabaseMocks(async () => null, async () => {
    const result = await loginUser("missing@example.com", "wrong");
    messages.push(String(result.error));
  });
  await withAuthDatabaseMocks(async () => testUser(), async () => {
    const result = await loginUser("9812345678", "wrong");
    messages.push(String(result.error));
  });
  await withAuthDatabaseMocks(
    async () => testUser({ isActive: false }),
    async () => {
      const result = await loginUser("9812345678", "correct-password");
      messages.push(String(result.error));
    },
  );

  assert.deepEqual(messages, [
    "Invalid phone/email or password",
    "Invalid phone/email or password",
    "Invalid phone/email or password",
  ]);
});
