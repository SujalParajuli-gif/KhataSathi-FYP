import prisma from "../db/prisma";
import { backfillDocumentImageThumbnails } from "../modules/documents/service";

async function main() {
  const result = await backfillDocumentImageThumbnails();
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0 || result.missingOriginal > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Document thumbnail backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
