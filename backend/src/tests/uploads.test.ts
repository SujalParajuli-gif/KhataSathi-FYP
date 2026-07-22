import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { isUploadFileAvailable } from "../lib/uploads";

test("managed upload checks use the repository-level uploads folder", async () => {
  const uploadsRoot = path.resolve(__dirname, "../../../uploads");
  const filename = `upload-path-test-${process.pid}-${Date.now()}.txt`;
  const filePath = path.join(uploadsRoot, filename);

  await fs.mkdir(uploadsRoot, { recursive: true });
  await fs.writeFile(filePath, "test", "utf8");

  try {
    assert.equal(await isUploadFileAvailable(`/uploads/${filename}`), true);
    assert.equal(
      await isUploadFileAvailable(`/uploads/${filename}.missing`),
      false,
    );
    assert.equal(
      await isUploadFileAvailable("https://example.com/profile.png"),
      true,
    );
  } finally {
    await fs.rm(filePath, { force: true });
  }
});
