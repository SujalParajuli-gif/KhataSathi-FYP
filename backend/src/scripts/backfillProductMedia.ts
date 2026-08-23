import fs from "node:fs/promises";
import prisma from "../db/prisma";
import {
  deleteProductMedia,
  saveProductImageVariants,
} from "../lib/productMedia";
import {
  isUploadFileAvailable,
  resolveUploadFilePath,
} from "../lib/uploads";

async function main() {
  const apply = process.argv.includes("--apply");
  const products = await prisma.product.findMany({
    where: { imageUrl: { not: null } },
    select: { id: true, name: true, imageUrl: true, thumbnailUrl: true },
    orderBy: { createdAt: "asc" },
  });
  const result = {
    scanned: products.length,
    alreadyOptimized: 0,
    eligible: 0,
    converted: 0,
    missingOriginal: 0,
    unmanaged: 0,
    changedDuringRun: 0,
    failed: 0,
  };

  for (const product of products) {
    if (product.thumbnailUrl && await isUploadFileAvailable(product.thumbnailUrl)) {
      result.alreadyOptimized += 1;
      continue;
    }

    const originalPath = resolveUploadFilePath(product.imageUrl);
    if (!originalPath) {
      result.unmanaged += 1;
      continue;
    }

    try {
      await fs.access(originalPath);
    } catch {
      result.missingOriginal += 1;
      continue;
    }

    result.eligible += 1;
    if (!apply) continue;

    let media: Awaited<ReturnType<typeof saveProductImageVariants>> | null = null;
    try {
      media = await saveProductImageVariants(await fs.readFile(originalPath));
      const updated = await prisma.product.updateMany({
        where: { id: product.id, imageUrl: product.imageUrl },
        data: media,
      });
      if (updated.count !== 1) {
        await deleteProductMedia(media);
        result.changedDuringRun += 1;
        continue;
      }
      // The legacy original is intentionally retained. It can be reviewed as
      // an orphan after the new display image and thumbnail are verified.
      result.converted += 1;
    } catch (error) {
      if (media) await deleteProductMedia(media);
      result.failed += 1;
      console.error(`Could not optimize product media for ${product.id} (${product.name}).`);
    }
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...result }, null, 2));
  if (!apply && result.eligible > 0) {
    console.log("Run again with --apply to create versioned display images and thumbnails.");
  }
}

main()
  .catch((error) => {
    console.error("Product media backfill failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
