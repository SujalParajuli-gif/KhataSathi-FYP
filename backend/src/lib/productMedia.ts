import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { deleteUploadFile, productUploadsDir } from "./uploads";

const MAX_INPUT_PIXELS = 40_000_000;
const SUPPORTED_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);

export const PRODUCT_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

export class ProductImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductImageValidationError";
  }
}

export type ProductMediaVariants = {
  imageUrl: string;
  thumbnailUrl: string;
};

export async function buildProductImageVariants(input: Buffer) {
  if (!input.length) {
    throw new ProductImageValidationError("The selected image is empty.");
  }
  if (input.length > PRODUCT_IMAGE_LIMIT_BYTES) {
    throw new ProductImageValidationError("Product images must be 5 MB or smaller.");
  }

  let source: sharp.Sharp;
  let metadata: sharp.Metadata;
  try {
    source = sharp(input, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    });
    metadata = await source.metadata();
  } catch {
    throw new ProductImageValidationError(
      "Use a valid JPG, PNG, or WebP image up to 40 megapixels.",
    );
  }

  if (!metadata.format || !SUPPORTED_IMAGE_FORMATS.has(metadata.format)) {
    throw new ProductImageValidationError("Only JPG, PNG, and WebP product images are supported.");
  }

  try {
    const normalized = source.rotate();
    const [display, thumbnail] = await Promise.all([
      normalized
        .clone()
        .resize({
          width: 1000,
          height: 1000,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer(),
      normalized
        .clone()
        .resize({
          width: 240,
          height: 240,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 76, effort: 4 })
        .toBuffer(),
    ]);
    return { display, thumbnail };
  } catch {
    throw new ProductImageValidationError(
      "The selected image could not be processed. Try exporting it as JPG or PNG.",
    );
  }
}

export async function saveProductImageVariants(input: Buffer): Promise<ProductMediaVariants> {
  const variants = await buildProductImageVariants(input);
  await fs.mkdir(productUploadsDir, { recursive: true });

  const version = `${Date.now()}-${randomUUID()}`;
  const displayName = `prod-${version}-display.webp`;
  const thumbnailName = `prod-${version}-thumb.webp`;
  const displayPath = path.join(productUploadsDir, displayName);
  const thumbnailPath = path.join(productUploadsDir, thumbnailName);
  const imageUrl = `/uploads/products/${displayName}`;
  const thumbnailUrl = `/uploads/products/${thumbnailName}`;

  try {
    await Promise.all([
      fs.writeFile(displayPath, variants.display, { flag: "wx" }),
      fs.writeFile(thumbnailPath, variants.thumbnail, { flag: "wx" }),
    ]);
    return { imageUrl, thumbnailUrl };
  } catch (error) {
    await Promise.all([
      deleteUploadFile(imageUrl),
      deleteUploadFile(thumbnailUrl),
    ]);
    throw error;
  }
}

export async function deleteProductMedia(media: Partial<ProductMediaVariants>) {
  await Promise.all([
    deleteUploadFile(media.imageUrl),
    deleteUploadFile(media.thumbnailUrl),
  ]);
}
