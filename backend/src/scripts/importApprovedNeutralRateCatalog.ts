import fs from "node:fs";
import path from "node:path";
import prisma from "../db/prisma";
import { normalizeImportIdentity } from "../modules/products/importComparison";
import {
  createCsvImportPreview,
  fingerprintImportFile,
  getProductImportBatch,
  importReviewedPdfRows,
  normalizeCsvImportRow,
} from "../modules/products/importService";
import { parseProductSpreadsheet } from "../modules/products/spreadsheetImport";
import { hasConfirmation } from "./cleanPilotBundle";

const APPROVED_SHA256 = "487d1e463a90616eaf29b0dfce4b43016b801f31156a4bbdf9b747568a24b319";
const EXPECTED_PRODUCTS = 1536;
const EXPECTED_RATES = 1522;
const EXPECTED_COMING_SOON = 14;
const EXPECTED_BRANDS: Record<string, number> = {
  Bagmati: 686,
  SPL: 297,
  "United Plastic": 245,
  Pradeep: 140,
  "Panas Pet": 77,
  JSR: 74,
  "KI Mop": 17,
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`APPROVED CATALOG IMPORT REFUSED: ${message}`);
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function sourceCell(row: Record<string, unknown>, ...names: string[]) {
  for (const [key, value] of Object.entries(row)) {
    if (names.some((name) => key.trim().toLowerCase() === name.toLowerCase())) {
      return text(value);
    }
  }
  return "";
}

function reviewedPayload(row: Awaited<ReturnType<typeof getProductImportBatch>>["rows"][number]) {
  const parsed = (row.parsed || {}) as Record<string, unknown>;
  return {
    rowId: row.id,
    name: text(parsed.name),
    sku: text(parsed.sku),
    barcode: text(parsed.barcode) || undefined,
    brand: text(parsed.brand),
    category: text(parsed.category),
    categoryGroup: text(parsed.categoryGroup) || undefined,
    vendorSource: text(parsed.vendorSource) || undefined,
    productCodeVariant: text(parsed.productCodeVariant) || undefined,
    sizeValue: typeof parsed.sizeValue === "number" ? parsed.sizeValue : null,
    sizeUnit: text(parsed.sizeUnit) || undefined,
    ratePerPiece:
      typeof parsed.ratePerPiece === "number" ? parsed.ratePerPiece : null,
    packageQuantity: typeof parsed.packageQuantity === "number" ? parsed.packageQuantity : null,
    packageUnit: text(parsed.packageUnit) || "PIECE",
    saleUnit: text(parsed.saleUnit) || "PIECE",
    allowFractionalQty: Boolean(parsed.allowFractionalQty),
    quantityStep: typeof parsed.quantityStep === "number" ? parsed.quantityStep : 1,
    wholesaleEligible: parsed.wholesaleEligible !== false,
    sourceCitation: text(parsed.sourceCitation) || undefined,
    searchAliases: Array.isArray(parsed.searchAliases)
      ? parsed.searchAliases.map(text).filter(Boolean)
      : [],
    retailPrice: typeof parsed.retailPrice === "number" ? parsed.retailPrice : null,
    wholesalePrice:
      typeof parsed.wholesalePrice === "number" ? parsed.wholesalePrice : null,
    availabilityStatus:
      parsed.availabilityStatus === "COMING_SOON"
        ? ("COMING_SOON" as const)
        : ("CATALOG_LISTED" as const),
    stock: typeof parsed.stock === "number" ? parsed.stock : 0,
  };
}

async function assertCleanPilot() {
  const [users, products, brands, invoices, customers, batches, documents, sessions] =
    await Promise.all([
      prisma.user.findMany({
        select: { id: true, name: true, role: true, isActive: true },
      }),
      prisma.product.count(),
      prisma.brand.count(),
      prisma.invoice.count(),
      prisma.customer.count(),
      prisma.productImportBatch.count(),
      prisma.document.count(),
      prisma.authSession.count(),
    ]);
  const roleCounts = Object.fromEntries(
    ["ADMIN", "MANAGER", "CASHIER", "STAFF"].map((role) => [
      role,
      users.filter((user) => user.role === role).length,
    ]),
  );
  check(users.every((user) => user.isActive), "the pilot contains an inactive account");
  check(users.length === 5, `expected 5 active approved accounts, found ${users.length}`);
  check(
    roleCounts.ADMIN === 1 &&
      roleCounts.MANAGER === 1 &&
      roleCounts.CASHIER === 1 &&
      roleCounts.STAFF === 2,
    `approved account roles differ: ${JSON.stringify(roleCounts)}`,
  );
  check(
    [products, brands, invoices, customers, batches, documents, sessions].every(
      (count) => count === 0,
    ),
    "the isolated pilot already contains business data",
  );
  const admin = users.find((user) => user.role === "ADMIN");
  check(admin?.name === "Durga Parajuli", "the approved Admin is not Durga Parajuli");
  return admin;
}

async function main() {
  const args = process.argv.slice(2);
  check(
    hasConfirmation(args, "IMPORT-APPROVED-1536-CATALOG"),
    "supply --confirmation IMPORT-APPROVED-1536-CATALOG",
  );
  const sourceArgument = args.find((argument) => argument.startsWith("--file="));
  const sourceValue = text(sourceArgument?.slice("--file=".length));
  check(Boolean(sourceValue), "--file must reference the approved CSV");
  const sourcePath = path.resolve(sourceValue);
  check(
    fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile(),
    "--file must reference the approved CSV",
  );

  const actor = await assertCleanPilot();
  const buffer = fs.readFileSync(sourcePath);
  const fingerprint = fingerprintImportFile(buffer);
  check(fingerprint === APPROVED_SHA256, "the catalog file does not match the approved SHA-256");

  const spreadsheet = await parseProductSpreadsheet({
    buffer,
    fileName: path.basename(sourcePath),
    mimeType: "text/csv",
  });
  check(spreadsheet.rows.length === EXPECTED_PRODUCTS, `expected ${EXPECTED_PRODUCTS} rows`);
  const normalized = spreadsheet.rows.map((row, index) => {
    check(sourceCell(row, "Owner_Approval") === "APPROVED", `row ${index + 2} is not approved`);
    check(
      sourceCell(row, "Review_Status") === "OWNER_APPROVED",
      `row ${index + 2} lacks owner review status`,
    );
    return normalizeCsvImportRow(row, spreadsheet.rowNumbers[index] || index + 2);
  });
  check(
    new Set(
      normalized.map(
        (row) =>
          `${normalizeImportIdentity(row.brand)}::${normalizeImportIdentity(row.name)}`,
      ),
    ).size === EXPECTED_PRODUCTS,
    "Brand + Product name values are not unique",
  );
  check(new Set(normalized.map((row) => row.sku)).size === EXPECTED_PRODUCTS, "SKUs are not unique");
  check(normalized.filter((row) => row.ratePerPiece !== null).length === EXPECTED_RATES, "Rate count differs");
  check(
    normalized.filter((row) => row.availabilityStatus === "COMING_SOON").length ===
      EXPECTED_COMING_SOON,
    "Coming soon count differs",
  );
  check(
    normalized.every((row) => row.retailPrice === null && row.wholesalePrice === null),
    "Retail and Wholesale must be blank",
  );
  check(normalized.every((row) => row.stock === 0), "opening stock must be zero");

  const preview = await createCsvImportPreview({
    fileName: path.basename(sourcePath),
    rows: spreadsheet.rows,
    rowNumbers: spreadsheet.rowNumbers,
    sourceType: spreadsheet.sourceType,
    createdById: actor.id,
    fileFingerprint: fingerprint,
    fileSizeBytes: buffer.byteLength,
  });
  let batch = await getProductImportBatch(preview.batchId);
  check(batch.rows.length === EXPECTED_PRODUCTS, "not every source row reached review");
  check(
    batch.rows.every((row) => row.comparisonStatus === "READY_NEW"),
    "not every approved row is ready to create",
  );

  const commit = (await importReviewedPdfRows(batch.id, {
    rows: batch.rows.map((row) => ({
      ...reviewedPayload(row),
      resolution: "CREATE_NEW" as const,
    })),
    ignoredRowIds: [],
    actorId: actor.id,
    approved: true,
    commitToken: `approved-${APPROVED_SHA256.slice(0, 16)}`,
  })) as Record<string, any>;
  check(commit.createdCount === EXPECTED_PRODUCTS, "not every approved product was created");
  check(commit.errorCount === 0, `the import reported ${commit.errorCount} errors`);

  batch = await getProductImportBatch(batch.id);
  const products = await prisma.product.findMany({
    include: { brand: { select: { name: true } } },
  });
  check(products.length === EXPECTED_PRODUCTS, "stored product count differs");
  check(new Set(products.map((product) => product.sku)).size === EXPECTED_PRODUCTS, "stored SKUs are not unique");
  check(new Set(products.map((product) => product.barcode)).size === EXPECTED_PRODUCTS, "stored barcodes are not unique");
  check(products.filter((product) => product.ratePerPiece !== null).length === EXPECTED_RATES, "stored Rate count differs");
  check(
    products.filter((product) => product.availabilityStatus === "COMING_SOON").length ===
      EXPECTED_COMING_SOON,
    "stored Coming soon count differs",
  );
  check(products.every((product) => product.retailPrice === null), "a Retail price was added");
  check(products.every((product) => product.wholesalePrice === null), "a Wholesale price was added");
  check(products.every((product) => product.stock === 0), "stored opening stock is not zero");
  check(products.every((product) => product.sellingPriceStatus === "PENDING"), "selling-price status differs");
  for (const [brand, count] of Object.entries(EXPECTED_BRANDS)) {
    check(
      products.filter((product) => product.brand.name === brand).length === count,
      `${brand} count differs`,
    );
  }
  check(await prisma.productSearchDocument.count() === EXPECTED_PRODUCTS, "search index is incomplete");
  check(
    batch.importedRows === EXPECTED_PRODUCTS &&
      batch.failedRows === 0 &&
      batch.status === "IMPORTED",
    "the approved import batch did not finish cleanly",
  );

  console.log(
    JSON.stringify(
      {
        approvedFileSha256: fingerprint,
        products: products.length,
        rates: products.filter((product) => product.ratePerPiece !== null).length,
        comingSoon: products.filter(
          (product) => product.availabilityStatus === "COMING_SOON",
        ).length,
        retailPrices: products.filter((product) => product.retailPrice !== null).length,
        wholesalePrices: products.filter((product) => product.wholesalePrice !== null).length,
        stockTotal: products.reduce((sum, product) => sum + Number(product.stock), 0),
        brands: EXPECTED_BRANDS,
        searchDocuments: await prisma.productSearchDocument.count(),
        batchStatus: batch.status,
        failedRows: batch.failedRows,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
