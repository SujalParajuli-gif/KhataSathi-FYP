import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  getImportSourcePath,
  removeImportSource,
  storeImportSource,
} from "../modules/products/importSourceStorage";

test("import sources are stored under a protected relative path and can be removed", async () => {
  const contents = Buffer.from("Product_Name,Rate\nBucket 13 LTR,100\n", "utf8");
  const stored = await storeImportSource({
    batchId: `test-${Date.now()}`,
    originalName: "bagmati.csv",
    mimeType: "text/csv",
    buffer: contents,
  });

  try {
    assert.match(stored.sourceStoredPath, /^import-sources\//);
    assert.match(stored.sourceStoredFileName, /\.csv$/);
    assert.equal(stored.sourceChecksum.length, 64);
    const absolutePath = getImportSourcePath(stored);
    assert.ok(absolutePath);
    assert.deepEqual(await fs.readFile(absolutePath!), contents);
  } finally {
    await removeImportSource(stored);
  }

  assert.equal(getImportSourcePath({
    sourceStoredPath: "../outside",
    sourceStoredFileName: "catalog.csv",
  }), null);
});
