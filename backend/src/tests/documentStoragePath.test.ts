import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  normalizeDocumentRelativePath,
  resolveDocumentStoragePath,
} from "../modules/documents/storagePath";

test("normalizes legacy Windows document paths for Linux storage", () => {
  assert.equal(
    normalizeDocumentRelativePath("documents\\2026\\07\\W29"),
    "documents/2026/07/W29",
  );
});

test("resolves portable and legacy paths to the same storage file", () => {
  const root = path.resolve("/document-storage");
  const fileName = "document_general.pdf";
  assert.equal(
    resolveDocumentStoragePath(root, "documents\\2026\\07\\W29", fileName),
    resolveDocumentStoragePath(root, "documents/2026/07/W29", fileName),
  );
});

test("rejects traversal and nested stored filenames", () => {
  const root = path.resolve("/document-storage");
  assert.equal(resolveDocumentStoragePath(root, "../private", "secret"), null);
  assert.equal(resolveDocumentStoragePath(root, "documents/2026", "../secret"), null);
  assert.equal(resolveDocumentStoragePath(root, "/etc", "passwd"), null);
});
