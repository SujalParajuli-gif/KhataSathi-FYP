import assert from "node:assert/strict";
import test from "node:test";
import { productionEnvironmentProblems } from "../config/env";

const validProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "mysql://khatasathi_app:longpassword@mysql:3306/khatasathi",
  SESSION_SECRET: "a-production-session-secret-with-32-characters",
  FRONTEND_BASE_URL: "https://app.example.com",
  TZ: "Asia/Kathmandu",
  UPLOADS_ROOT: "/uploads",
  DOCUMENT_STORAGE_ROOT: "/document-storage",
  BACKUP_ROOT: "/backups",
};

test("production environment accepts HTTPS, least-privilege MySQL, and explicit storage", () => {
  assert.deepEqual(productionEnvironmentProblems(validProductionEnvironment), []);
});

test("production environment rejects root MySQL, public HTTP, weak secrets, and implicit storage", () => {
  const problems = productionEnvironmentProblems({
    NODE_ENV: "production",
    DATABASE_URL: "mysql://root:password@mysql:3306/khatasathi",
    SESSION_SECRET: "short",
    FRONTEND_BASE_URL: "http://shop.example.com",
    TZ: "UTC",
  });
  assert.match(problems.join(" "), /root account/i);
  assert.match(problems.join(" "), /HTTPS/i);
  assert.match(problems.join(" "), /32 characters/i);
  assert.match(problems.join(" "), /Asia\/Kathmandu/i);
  assert.match(problems.join(" "), /UPLOADS_ROOT/i);
});

test("local development does not require production-only settings", () => {
  assert.deepEqual(productionEnvironmentProblems({ NODE_ENV: "development" }), []);
});
