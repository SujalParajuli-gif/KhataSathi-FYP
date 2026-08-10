import prisma from "../db/prisma";
import { rebuildAllProductSearchDocuments } from "../modules/products/searchAliasService";

async function main() {
  const result = await rebuildAllProductSearchDocuments();
  console.log(
    `Rebuilt ${result.rebuiltCount} product search documents at normalizer version ${result.normalizerVersion}.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
