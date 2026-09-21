import assert from "node:assert/strict";
import test from "node:test";
import { importBatchStatus } from "../app/lib/importBatchStatus.ts";

test("active jobs take precedence over stale counts and errors", () => {
  for (const status of ["QUEUED", "PROCESSING", "CANCELLING", "COMMITTING"]) {
    assert.equal(importBatchStatus({ status, totalRows: 10, importedRows: 10, failedRows: 1 }).tier, "processing");
  }
});
test("completion comes from server state, not matching counts", () => {
  assert.equal(importBatchStatus({ status: "DRAFT", totalRows: 10, importedRows: 10 }).tier, "partial");
  const completed = importBatchStatus({ status: "IMPORTED", totalRows: 10, importedRows: 7 });
  assert.equal(completed.tier, "completed");
  assert.match(completed.statsText, /7 created, updated or kept · 3 ignored/);
  assert.doesNotMatch(completed.statsText, /100%|active/);
});
test("partial failures stay actionable even after some rows were applied", () => {
  assert.equal(importBatchStatus({ status: "DRAFT", importedRows: 7, failedRows: 2 }).tier, "failed");
  assert.equal(importBatchStatus({ status: "INTERRUPTED" }).badgeLabel, "Needs attention");
});
