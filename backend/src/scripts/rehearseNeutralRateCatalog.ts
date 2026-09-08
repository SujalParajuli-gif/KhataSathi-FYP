import fs from "node:fs";
import path from "node:path";
import prisma from "../db/prisma";
import { addItem, createDraft } from "../modules/invoices/service";
import { normalizeImportIdentity } from "../modules/products/importComparison";
import {
  createCsvImportPreview,
  findRepeatedProductImportBatch,
  fingerprintImportFile,
  getProductImportBatch,
  importReviewedPdfRows,
  normalizeCsvImportRow,
} from "../modules/products/importService";
import { parseProductSpreadsheet } from "../modules/products/spreadsheetImport";

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
  if (!condition) throw new Error(`REHEARSAL CHECK FAILED: ${message}`);
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function sourceCell(row: Record<string, unknown>, ...names: string[]) {
  const entries = Object.entries(row);
  for (const name of names) {
    const match = entries.find(([key]) => key.trim().toLowerCase() === name.toLowerCase());
    if (match) return text(match[1]);
  }
  return "";
}

function replaceSourceCell(row: Record<string, unknown>, name: string, value: unknown) {
  const existing = Object.keys(row).find((key) => key.trim().toLowerCase() === name.toLowerCase());
  row[existing || name] = value;
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
    ratePerPiece: typeof parsed.ratePerPiece === "number" ? parsed.ratePerPiece : null,
    packageQuantity: typeof parsed.packageQuantity === "number" ? parsed.packageQuantity : null,
    packageUnit: text(parsed.packageUnit) || "PIECE",
    saleUnit: text(parsed.saleUnit) || "PIECE",
    allowFractionalQty: Boolean(parsed.allowFractionalQty),
    quantityStep: typeof parsed.quantityStep === "number" ? parsed.quantityStep : 1,
    wholesaleEligible: parsed.wholesaleEligible !== false,
    sourceCitation: text(parsed.sourceCitation) || undefined,
    searchAliases: Array.isArray(parsed.searchAliases) ? parsed.searchAliases.map(text).filter(Boolean) : [],
    retailPrice: typeof parsed.retailPrice === "number" ? parsed.retailPrice : null,
    wholesalePrice: typeof parsed.wholesalePrice === "number" ? parsed.wholesalePrice : null,
    availabilityStatus: parsed.availabilityStatus === "COMING_SOON" ? "COMING_SOON" as const : "CATALOG_LISTED" as const,
    stock: typeof parsed.stock === "number" ? parsed.stock : 0,
  };
}

async function main() {
  const sourcePath = path.resolve(text(process.env.CATALOG_REHEARSAL_FILE));
  check(sourcePath && fs.existsSync(sourcePath), "CATALOG_REHEARSAL_FILE must reference the VPS-ready CSV");
  const buffer = fs.readFileSync(sourcePath);
  const fingerprint = fingerprintImportFile(buffer);
  const spreadsheet = await parseProductSpreadsheet({
    buffer,
    fileName: path.basename(sourcePath),
    mimeType: "text/csv",
  });
  check(spreadsheet.rows.length === EXPECTED_PRODUCTS, `expected ${EXPECTED_PRODUCTS} rows, received ${spreadsheet.rows.length}`);

  const normalized = spreadsheet.rows.map((row, index) => {
    check(sourceCell(row, "Owner_Approval") === "APPROVED", `row ${index + 2} lacks owner approval`);
    check(sourceCell(row, "Review_Status") === "OWNER_APPROVED", `row ${index + 2} lacks owner review status`);
    return normalizeCsvImportRow(row, spreadsheet.rowNumbers[index] || index + 2);
  });
  const identities = new Set(normalized.map((row) => `${normalizeImportIdentity(row.brand)}::${normalizeImportIdentity(row.name)}`));
  check(identities.size === EXPECTED_PRODUCTS, "Brand + Product name identities must be unique");
  check(new Set(normalized.map((row) => row.sku)).size === EXPECTED_PRODUCTS, "source SKUs must be unique");
  check(normalized.filter((row) => row.ratePerPiece !== null).length === EXPECTED_RATES, `expected ${EXPECTED_RATES} Rates`);
  check(normalized.filter((row) => row.availabilityStatus === "COMING_SOON").length === EXPECTED_COMING_SOON, `expected ${EXPECTED_COMING_SOON} Coming soon products`);
  check(normalized.every((row) => row.retailPrice === null && row.wholesalePrice === null), "Retail and Wholesale must remain blank");
  check(normalized.every((row) => row.stock === 0), "all source stock must be zero");

  const actor = await prisma.user.create({
    data: {
      name: "Catalog rehearsal admin",
      email: `catalog-rehearsal-${Date.now()}@example.test`,
      phone: `+97798${String(Date.now()).slice(-8)}`,
      passwordHash: "disposable-rehearsal-only",
      role: "ADMIN",
    },
  });
  await prisma.businessSettings.upsert({
    where: { id: 1 },
    create: { id: 1, businessMode: "CATALOG_ONLY", defaultInitialStock: 0 },
    update: { businessMode: "CATALOG_ONLY", defaultInitialStock: 0 },
  });

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
  const initialCounts = Object.fromEntries(
    [...new Set(batch.rows.map((row) => String(row.comparisonStatus)))].sort().map((status) => [
      status,
      batch.rows.filter((row) => row.comparisonStatus === status).length,
    ]),
  );
  check(batch.rows.length === EXPECTED_PRODUCTS, "every source row must be stored for review");
  check(initialCounts.READY_NEW === EXPECTED_PRODUCTS, `all clean rows must be ready: ${JSON.stringify(initialCounts)}`);

  const payloads = batch.rows.map((row) => ({ ...reviewedPayload(row), resolution: "CREATE_NEW" as const }));
  const firstCommit = await importReviewedPdfRows(batch.id, {
    rows: payloads,
    ignoredRowIds: [],
    actorId: actor.id,
    approved: true,
    commitToken: "approved-1536-neutral-rate-rehearsal",
  }) as Record<string, any>;
  check(firstCommit.createdCount === EXPECTED_PRODUCTS, `expected ${EXPECTED_PRODUCTS} creates, received ${firstCommit.createdCount}`);
  check(firstCommit.errorCount === 0, `commit returned errors: ${JSON.stringify(firstCommit.errors)}`);

  batch = await getProductImportBatch(batch.id);
  const products = await prisma.product.findMany({ include: { brand: { select: { name: true } } } });
  check(products.length === EXPECTED_PRODUCTS, "stored product count differs from the approved catalog");
  check(new Set(products.map((product) => product.sku)).size === EXPECTED_PRODUCTS, "stored SKUs must remain unique");
  check(new Set(products.map((product) => product.barcode)).size === EXPECTED_PRODUCTS, "stored barcodes must be unique");
  check(products.filter((product) => product.ratePerPiece !== null).length === EXPECTED_RATES, "stored Rate count differs");
  check(products.filter((product) => product.availabilityStatus === "COMING_SOON").length === EXPECTED_COMING_SOON, "stored Coming soon count differs");
  check(products.every((product) => product.retailPrice === null && product.wholesalePrice === null), "selling prices were invented");
  check(products.every((product) => product.stock === 0), "stored stock must remain zero");
  check(products.every((product) => product.sellingPriceStatus === "PENDING"), "selling prices must remain pending");
  for (const [brand, count] of Object.entries(EXPECTED_BRANDS)) {
    check(products.filter((product) => product.brand.name === brand).length === count, `${brand} count differs from approval`);
  }
  check(await prisma.productSearchDocument.count() === EXPECTED_PRODUCTS, "every product needs a search document");
  check(batch.importedRows === EXPECTED_PRODUCTS && batch.failedRows === 0 && batch.status === "IMPORTED", "the import batch did not complete cleanly");

  const comingSoonProduct = products.find((product) => product.availabilityStatus === "COMING_SOON");
  check(comingSoonProduct, "a Coming soon product is required for the billing guard check");
  const draft = await createDraft(actor.id);
  let billingError = "";
  try {
    await addItem(draft.id, comingSoonProduct.id, 1);
  } catch (error: any) {
    billingError = text(error?.message);
  }
  check(/coming soon/i.test(billingError), "billing must reject a Coming soon product");

  const repeated = await findRepeatedProductImportBatch(fingerprint);
  check(repeated?.id === batch.id, "the same file must reopen the existing batch");

  const changedRows = spreadsheet.rows.map((row) => ({ ...row }));
  const changedIndex = changedRows.findIndex((row) => Number(sourceCell(row, "Rate")) > 0);
  check(changedIndex >= 0, "one priced row is required for the update check");
  const originalRate = Number(sourceCell(changedRows[changedIndex], "Rate"));
  replaceSourceCell(changedRows[changedIndex], "Rate", originalRate + 1);
  const changedFingerprint = fingerprintImportFile(Buffer.from(JSON.stringify(changedRows), "utf8"));
  const changedPreview = await createCsvImportPreview({
    fileName: "approved-catalog-one-rate-changed.csv",
    rows: changedRows,
    rowNumbers: spreadsheet.rowNumbers,
    sourceType: "CSV",
    createdById: actor.id,
    fileFingerprint: changedFingerprint,
    fileSizeBytes: Buffer.byteLength(JSON.stringify(changedRows)),
  });
  let changedBatch = await getProductImportBatch(changedPreview.batchId);
  const changedMatches = changedBatch.rows.filter((row) => row.comparisonStatus === "MATCHED_WITH_CHANGES");
  const exactMatches = changedBatch.rows.filter((row) => row.comparisonStatus === "EXACT_DUPLICATE");
  check(changedMatches.length === 1, `expected one changed match, received ${changedMatches.length}`);
  check(exactMatches.length === EXPECTED_PRODUCTS - 1, `expected ${EXPECTED_PRODUCTS - 1} exact matches`);
  const changedPayloads = changedBatch.rows.map((row) => ({
    ...reviewedPayload(row),
    resolution: row.comparisonStatus === "MATCHED_WITH_CHANGES" ? "UPDATE_MATCHED" as const : "KEEP_EXISTING" as const,
  }));
  const changedCommit = await importReviewedPdfRows(changedBatch.id, {
    rows: changedPayloads,
    ignoredRowIds: [],
    actorId: actor.id,
    approved: true,
    commitToken: "approved-1536-one-change-rehearsal",
  }) as Record<string, any>;
  check(changedCommit.createdCount === 0 && changedCommit.updatedCount === 1, "repeat import must update one row without duplicates");
  check(changedCommit.keptCount === EXPECTED_PRODUCTS - 1 && changedCommit.errorCount === 0, "repeat import result is incomplete");
  check(await prisma.product.count() === EXPECTED_PRODUCTS, "repeat import changed the total product count");

  const report = {
    source: {
      file: path.basename(sourcePath),
      sha256: fingerprint,
      products: EXPECTED_PRODUCTS,
      rates: EXPECTED_RATES,
      comingSoon: EXPECTED_COMING_SOON,
      retailPrices: 0,
      wholesalePrices: 0,
      stockTotal: 0,
      brands: EXPECTED_BRANDS,
    },
    firstImport: {
      preview: initialCounts,
      created: firstCommit.createdCount,
      failed: firstCommit.errorCount,
      batchStatus: batch.status,
      searchDocuments: await prisma.productSearchDocument.count(),
    },
    safeguards: {
      sameFileReopened: repeated?.id === batch.id,
      comingSoonBillingRejected: /coming soon/i.test(billingError),
      uniqueSkus: new Set(products.map((product) => product.sku)).size,
      uniqueBarcodes: new Set(products.map((product) => product.barcode)).size,
    },
    changedFile: {
      changedMatches: changedMatches.length,
      exactMatches: exactMatches.length,
      created: changedCommit.createdCount,
      updated: changedCommit.updatedCount,
      kept: changedCommit.keptCount,
      errors: changedCommit.errorCount,
      finalProducts: await prisma.product.count(),
    },
  };
  console.log(`CATALOG_REHEARSAL_REPORT=${JSON.stringify(report)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
