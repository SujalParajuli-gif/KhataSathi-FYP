import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRecoveryBackupStatus } from "../modules/admin/recoveryBackupStatus";

test("recovery backup status exposes only bounded operational fields", () => {
  const status = sanitizeRecoveryBackupStatus(
    {
      schemaVersion: 1,
      status: "SUCCESS",
      stage: "complete",
      startedAt: "2026-08-11T01:00:00Z",
      completedAt: "2026-08-11T01:02:00Z",
      snapshotId: "a1b2c3d4e5f6",
      appCommit: "69187ba9",
      totalFilesProcessed: 45,
      totalBytesProcessed: 5000,
      dataAdded: 1200,
      retentionApplied: true,
      contents: ["database", "uploads", "documents", "private-secret"],
      repository: "s3:should-not-leak",
      password: "should-not-leak",
    },
    new Date("2026-08-11T01:05:00Z"),
  );

  assert.equal(status.status, "SUCCESS");
  assert.equal(status.snapshotId, "a1b2c3d4e5f6");
  assert.deepEqual(status.contents, ["database", "uploads", "documents"]);
  assert.equal("repository" in status, false);
  assert.equal("password" in status, false);
});

test("a recovery backup left running for two hours is reported as stale", () => {
  const status = sanitizeRecoveryBackupStatus(
    {
      schemaVersion: 1,
      status: "RUNNING",
      stage: "snapshot",
      startedAt: "2026-08-11T01:00:00Z",
      completedAt: null,
      contents: ["database", "uploads", "documents"],
    },
    new Date("2026-08-11T04:00:01Z"),
  );
  assert.equal(status.status, "STALE");
  assert.match(status.message, /server review/i);
});

test("malformed recovery backup status is rejected", () => {
  assert.throws(
    () => sanitizeRecoveryBackupStatus({ schemaVersion: 2, status: "SUCCESS" }),
    /unsupported/i,
  );
});
