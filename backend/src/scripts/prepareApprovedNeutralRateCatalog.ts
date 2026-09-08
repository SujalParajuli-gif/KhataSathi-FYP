import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeImportIdentity } from "../modules/products/importComparison";
import { normalizeCsvImportRow } from "../modules/products/importService";
import { parseProductSpreadsheet } from "../modules/products/spreadsheetImport";

function required(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CATALOG PREPARATION FAILED: ${message}`);
}

function sourceCell(row: Record<string, unknown>, name: string) {
  const match = Object.entries(row).find(([key]) => key.trim().toLowerCase() === name.toLowerCase());
  return String(match?.[1] ?? "").trim();
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(rows: Array<Record<string, unknown>>, headers: string[]) {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n") + "\r\n";
}

function countBy(rows: Array<Record<string, unknown>>, field: string) {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const value = String(row[field] || "Uncategorized");
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map<string, number>())]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function main() {
  const sourcePath = path.resolve(String(process.argv[2] || ""));
  const outputPath = path.resolve(String(process.argv[3] || ""));
  required(process.argv[2] && process.argv[3], "Usage: prepareApprovedNeutralRateCatalog <approved.csv> <output.csv>");
  required(fs.existsSync(sourcePath), `source file does not exist: ${sourcePath}`);
  required(sourcePath !== outputPath, "the output must not overwrite the owner-approved source file");

  const sourceBuffer = fs.readFileSync(sourcePath);
  const spreadsheet = await parseProductSpreadsheet({
    buffer: sourceBuffer,
    fileName: path.basename(sourcePath),
    mimeType: "text/csv",
  });

  const failures: Array<{ row: number; message: string }> = [];
  const prepared = spreadsheet.rows.flatMap((source, index) => {
    const rowNumber = spreadsheet.rowNumbers[index] || index + 2;
    try {
      const normalized = normalizeCsvImportRow(source, rowNumber);
      const sourcePriceCount = [
        normalized.ratePerPiece,
        normalized.retailPrice,
        normalized.wholesalePrice,
      ].filter((value) => value !== null).length;
      required(sourcePriceCount <= 1, `source row ${rowNumber} contains more than one price and needs manual review`);
      const rate = normalized.ratePerPiece ?? normalized.retailPrice ?? normalized.wholesalePrice;
      return [{
        Product_Name: normalized.name,
        SKU: normalized.sku,
        Barcode: sourceCell(source, "Barcode"),
        Brand: sourceCell(source, "Brand") || normalized.brand || "",
        Category: sourceCell(source, "Category"),
        Category_Group: sourceCell(source, "Category_Group"),
        Supplier: sourceCell(source, "Supplier"),
        Product_Code_Variant: sourceCell(source, "Product_Code_Variant"),
        Package_Quantity: sourceCell(source, "Package_Quantity"),
        Package_Unit: sourceCell(source, "Package_Unit"),
        Sale_Unit: sourceCell(source, "Sale_Unit"),
        Rate: rate ?? "",
        Retail_Price: "",
        Wholesale_Price: "",
        Availability_Status: rate === null ? "COMING_SOON" : "CATALOG_LISTED",
        Stock: 0,
        Source_Citation: sourceCell(source, "Source_Citation"),
        Search_Aliases: sourceCell(source, "Search_Aliases"),
        Owner_Approval: "APPROVED",
        Review_Status: "OWNER_APPROVED",
      }];
    } catch (error: any) {
      failures.push({ row: rowNumber, message: error?.message || String(error) });
      return [];
    }
  });

  const identities = new Set<string>();
  const skus = new Set<string>();
  for (const row of prepared) {
    const identity = `${normalizeImportIdentity(row.Brand)}::${normalizeImportIdentity(row.Product_Name)}`;
    required(!identities.has(identity), `duplicate Brand + Product name: ${row.Brand} / ${row.Product_Name}`);
    identities.add(identity);
    required(Boolean(row.SKU), `missing SKU for ${row.Product_Name}`);
    required(!skus.has(String(row.SKU)), `duplicate generated or supplied SKU: ${row.SKU}`);
    skus.add(String(row.SKU));
  }

  required(failures.length === 0, `${failures.length} rows could not be prepared`);
  required(prepared.length === 1536, `expected 1,536 rows, received ${prepared.length}`);
  required(prepared.filter((row) => row.Rate !== "").length === 1522, "expected 1,522 products with a Rate");
  required(prepared.filter((row) => row.Availability_Status === "COMING_SOON").length === 14, "expected 14 Coming soon products");
  required(prepared.every((row) => row.Retail_Price === "" && row.Wholesale_Price === ""), "selling prices must remain blank");
  required(prepared.every((row) => row.Stock === 0), "all opening stock must remain zero");

  const headers = [
    "Product_Name", "SKU", "Barcode", "Brand", "Category", "Category_Group", "Supplier",
    "Product_Code_Variant", "Package_Quantity", "Package_Unit", "Sale_Unit", "Rate",
    "Retail_Price", "Wholesale_Price", "Availability_Status", "Stock", "Source_Citation",
    "Search_Aliases", "Owner_Approval", "Review_Status",
  ];
  const output = writeCsv(prepared, headers);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");
  const sha256 = crypto.createHash("sha256").update(output).digest("hex");
  const audit = {
    generatedAt: new Date().toISOString(),
    sourceFile: sourcePath,
    outputFile: outputPath,
    sourceSha256: crypto.createHash("sha256").update(sourceBuffer).digest("hex"),
    outputSha256: sha256,
    products: prepared.length,
    rates: prepared.filter((row) => row.Rate !== "").length,
    retailPrices: 0,
    wholesalePrices: 0,
    comingSoon: prepared.filter((row) => row.Availability_Status === "COMING_SOON").length,
    zeroStock: prepared.filter((row) => row.Stock === 0).length,
    uniqueSkus: skus.size,
    uniqueBrandProductNames: identities.size,
    brands: countBy(prepared, "Brand"),
    categories: countBy(prepared, "Category"),
  };
  fs.writeFileSync(`${outputPath}.audit.json`, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
