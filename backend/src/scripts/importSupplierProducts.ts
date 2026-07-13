import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import prisma from "../db/prisma";
import { importProductsFromCsv } from "../modules/products/service";

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error("Usage: pnpm import:supplier -- <path-to-supplier-csv>");
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Supplier CSV not found: ${resolvedPath}`);
  }

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
  const verbose = process.env.VERBOSE_IMPORT === "1";
  const output = verbose
    ? result
    : {
        totalRows: result.totalRows,
        createdCount: result.createdCount,
        errorCount: result.errorCount,
        createdProducts: result.createdProducts.slice(0, 25),
        errors: result.errors.slice(0, 25),
        omittedCreatedRows: Math.max(0, result.createdProducts.length - 25),
        omittedErrorRows: Math.max(0, result.errors.length - 25),
      };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
