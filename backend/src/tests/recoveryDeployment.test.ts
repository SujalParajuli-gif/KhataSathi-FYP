import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(__dirname, "../../..");
const compose = fs.readFileSync(
  path.join(repositoryRoot, "compose.production.yml"),
  "utf8",
);
const backupScript = fs.readFileSync(
  path.join(repositoryRoot, "deploy/scripts/backup.sh"),
  "utf8",
);
const verifyScript = fs.readFileSync(
  path.join(repositoryRoot, "deploy/scripts/verify-restore.sh"),
  "utf8",
);
const recoveryScript = fs.readFileSync(
  path.join(repositoryRoot, "deploy/recovery/run-backup.sh"),
  "utf8",
);

test("recovery service has read-only business storage and no Docker socket", () => {
  assert.match(compose, /profiles:\s*\["recovery"\]/);
  assert.match(compose, /uploads:\/payload\/uploads:ro/);
  assert.match(compose, /document_storage:\/payload\/documents:ro/);
  assert.match(compose, /backup_status:\/backup-status:ro/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(compose, /no-new-privileges:true/);
});

test("full recovery backup uses Restic for database, uploads, and documents", () => {
  assert.match(backupScript, /run --rm/);
  assert.match(backupScript, /recovery/);
  assert.match(recoveryScript, /mysqldump/);
  assert.match(recoveryScript, /restic backup/);
  assert.match(recoveryScript, /--keep-daily/);
  assert.match(recoveryScript, /\/payload\/uploads/);
  assert.match(recoveryScript, /\/payload\/documents/);
  assert.doesNotMatch(recoveryScript, /tar -czf/);
});

test("restore verification targets temporary storage instead of live volumes", () => {
  assert.match(verifyScript, /restic_command check/);
  assert.match(verifyScript, /restore-check/);
  assert.match(verifyScript, /docker volume create/);
  assert.match(verifyScript, /all critical tables present/);
  assert.doesNotMatch(verifyScript, /khatasathi_mysql_data/);
  assert.doesNotMatch(verifyScript, /khatasathi_uploads:\/restore/);
  assert.doesNotMatch(verifyScript, /khatasathi_document_storage:\/restore/);
});
