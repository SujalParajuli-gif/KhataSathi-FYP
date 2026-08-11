import fs from "node:fs/promises";
import sharp from "sharp";

const DOCUMENT_THUMBNAIL_EDGE = 480;
const MAX_INPUT_PIXELS = 60_000_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function supportsDocumentThumbnail(mimeType: string) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(String(mimeType || "").toLowerCase());
}

export function buildDocumentThumbnailFileName(documentId: string) {
  return `${documentId}_thumbnail.webp`;
}

export async function buildDocumentImageThumbnail(input: Buffer) {
  if (!input.length) throw new Error("Document image is empty");

  return sharp(input, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize({
      width: DOCUMENT_THUMBNAIL_EDGE,
      height: DOCUMENT_THUMBNAIL_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 76, effort: 4 })
    .toBuffer();
}

export async function writeDocumentImageThumbnail(
  sourcePath: string,
  thumbnailPath: string,
) {
  const source = await fs.readFile(sourcePath);
  const thumbnail = await buildDocumentImageThumbnail(source);

  try {
    await fs.writeFile(thumbnailPath, thumbnail);
    return thumbnail.length;
  } catch (error) {
    await fs.unlink(thumbnailPath).catch(() => undefined);
    throw error;
  }
}
