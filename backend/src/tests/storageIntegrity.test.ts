import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  documentRelativePath,
  managedUploadRelativePath,
  scanStorageIntegrity,
  type StorageReference,
} from "../modules/admin/storageIntegrity";

test("storage integrity scan reports missing, orphaned, and stale files without changing them", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "khatasathi-integrity-"));
  const uploadsRoot = path.join(tempRoot, "uploads");
  const documentsRoot = path.join(tempRoot, "documents");
  const staleDate = new Date("2026-08-08T00:00:00.000Z");

  await fs.mkdir(path.join(uploadsRoot, "products"), { recursive: true });
  await fs.mkdir(path.join(documentsRoot, "documents", "2026"), { recursive: true });
  await fs.mkdir(path.join(documentsRoot, ".temp"), { recursive: true });
  await fs.writeFile(path.join(uploadsRoot, "products", "kept.webp"), "kept");
  await fs.writeFile(path.join(uploadsRoot, "orphan.webp"), "orphan");
  await fs.writeFile(path.join(documentsRoot, "documents", "2026", "bill.pdf"), "bill");
  await fs.writeFile(path.join(documentsRoot, ".temp", "old.tmp"), "temp");
  await fs.utimes(path.join(documentsRoot, ".temp", "old.tmp"), staleDate, staleDate);

  const references: StorageReference[] = [
    {
      storage: "UPLOADS",
      ownerType: "PRODUCT_IMAGE",
      ownerId: "product-1",
      ownerLabel: "Bucket",
      relativePath: "products/kept.webp",
    },
    {
      storage: "UPLOADS",
      ownerType: "PRODUCT_THUMBNAIL",
      ownerId: "product-1",
      ownerLabel: "Bucket",
      relativePath: "products/missing.webp",
    },
    {
      storage: "DOCUMENTS",
      ownerType: "DOCUMENT_ORIGINAL",
      ownerId: "document-1",
      ownerLabel: "Supplier bill",
      relativePath: "documents/2026/bill.pdf",
    },
  ];

  try {
    const report = await scanStorageIntegrity({
      uploadsRoot,
      documentStorageRoot: documentsRoot,
      references,
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.status, "ATTENTION");
    assert.equal(report.summary.missingReferences, 1);
    assert.equal(report.summary.unreferencedFiles, 1);
    assert.equal(report.summary.staleTempFiles, 1);
    assert.equal(report.issues.missingReferences[0].relativePath, "products/missing.webp");
    assert.equal(report.issues.unreferencedFiles[0].relativePath, "orphan.webp");
    assert.equal(report.issues.staleTempFiles[0].relativePath, ".temp/old.tmp");

    // The check is deliberately non-mutating.
    await fs.access(path.join(uploadsRoot, "orphan.webp"));
    await fs.access(path.join(documentsRoot, ".temp", "old.tmp"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("storage reference helpers accept managed paths and reject traversal or external URLs", () => {
  assert.equal(managedUploadRelativePath("/uploads/products/a.webp"), "products/a.webp");
  assert.equal(managedUploadRelativePath("https://example.com/a.webp"), null);
  assert.equal(managedUploadRelativePath("/uploads/../secret"), null);
  assert.equal(documentRelativePath("documents\\2026", "bill.pdf"), "documents/2026/bill.pdf");
  assert.equal(documentRelativePath("../outside", "bill.pdf"), null);
});
