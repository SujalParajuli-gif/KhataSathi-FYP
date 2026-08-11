import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  buildDocumentImageThumbnail,
  buildDocumentThumbnailFileName,
  supportsDocumentThumbnail,
} from "../modules/documents/documentMedia";

test("document image thumbnails are bounded WebP derivatives", async () => {
  const source = await sharp({
    create: {
      width: 1600,
      height: 800,
      channels: 3,
      background: "#facc15",
    },
  }).png().toBuffer();

  const thumbnail = await buildDocumentImageThumbnail(source);
  const metadata = await sharp(thumbnail).metadata();

  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 240);
});

test("document thumbnail policy is limited to supported image documents", () => {
  assert.equal(supportsDocumentThumbnail("image/jpeg"), true);
  assert.equal(supportsDocumentThumbnail("image/png"), true);
  assert.equal(supportsDocumentThumbnail("image/webp"), true);
  assert.equal(supportsDocumentThumbnail("application/pdf"), false);
  assert.equal(buildDocumentThumbnailFileName("doc-1"), "doc-1_thumbnail.webp");
});
