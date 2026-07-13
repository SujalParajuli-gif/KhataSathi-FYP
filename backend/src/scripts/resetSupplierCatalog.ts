import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import prisma from "../db/prisma";
import { importProductsFromCsv } from "../modules/products/service";

async function getReferencedProductIds() {
  const [invoiceItems, stockTransactions, returnItems] = await Promise.all([
    prisma.invoiceItem.findMany({ select: { productId: true } }),
    prisma.stockTransaction.findMany({ select: { productId: true } }),
    prisma.returnItem.findMany({ select: { productId: true } }),
  ]);

  return new Set([
    ...invoiceItems.map((item) => item.productId),
    ...stockTransactions.map((item) => item.productId),
    ...returnItems.map((item) => item.productId),
  ]);
}

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error("Usage: pnpm reset:supplier-catalog -- <path-to-supplier-csv>");
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Supplier CSV not found: ${resolvedPath}`);
  }

  const referencedProductIds = await getReferencedProductIds();
  const allProducts = await prisma.product.findMany({
    select: { id: true, name: true, sku: true },
  });

  const deletableProductIds = allProducts
    .filter((product) => !referencedProductIds.has(product.id))
    .map((product) => product.id);
  const historyLockedProductIds = allProducts
    .filter((product) => referencedProductIds.has(product.id))
    .map((product) => product.id);

  await prisma.$transaction(async (tx) => {
    await tx.productImportRow.deleteMany({});
    await tx.productImportBatch.deleteMany({});

    if (deletableProductIds.length > 0) {
      await tx.product.deleteMany({ where: { id: { in: deletableProductIds } } });
    }

    if (historyLockedProductIds.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: historyLockedProductIds } },
        data: { isActive: false },
      });
    }

    const brandsWithProducts = await tx.product.findMany({
      select: { brandId: true },
      distinct: ["brandId"],
    });
    const brandIdsInUse = brandsWithProducts.map((brand) => brand.brandId);
    await tx.brand.deleteMany({
      where: brandIdsInUse.length > 0 ? { id: { notIn: brandIdsInUse } } : {},
    });
  });

  const csvText = fs.readFileSync(resolvedPath, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Array<Record<string, unknown>>;

  const result = await importProductsFromCsv(rows);
  const activeProducts = await prisma.product.count({ where: { isActive: true } });
  const supplierProducts = await prisma.product.count({ where: { vendorSource: { not: null } } });
  const legacyInactiveProducts = await prisma.product.count({
    where: { vendorSource: null, isActive: false },
  });

  console.log(
    JSON.stringify(
      {
        reset: {
          deletedProducts: deletableProductIds.length,
          deactivatedHistoryLockedProducts: historyLockedProductIds.length,
        },
        import: {
          totalRows: result.totalRows,
          createdCount: result.createdCount,
          errorCount: result.errorCount,
          errors: result.errors.slice(0, 25),
          omittedErrorRows: Math.max(0, result.errors.length - 25),
        },
        catalog: {
          activeProducts,
          supplierProducts,
          legacyInactiveProducts,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
