import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  buildProductImageVariants,
  ProductImageValidationError,
} from "../lib/productMedia";

test("product media creates bounded WebP display and thumbnail variants", async () => {
  const input = await sharp({
    create: {
      width: 1200,
      height: 600,
      channels: 3,
      background: "#16a34a",
    },
  }).png().toBuffer();

  const variants = await buildProductImageVariants(input);
  const [display, thumbnail] = await Promise.all([
    sharp(variants.display).metadata(),
    sharp(variants.thumbnail).metadata(),
  ]);

  assert.equal(display.format, "webp");
  assert.equal(display.width, 1000);
  assert.equal(display.height, 500);
  assert.equal(thumbnail.format, "webp");
  assert.equal(thumbnail.width, 240);
  assert.equal(thumbnail.height, 120);
});

test("product media rejects content that is not a supported image", async () => {
  await assert.rejects(
    buildProductImageVariants(Buffer.from("not an image", "utf8")),
    ProductImageValidationError,
  );
});
