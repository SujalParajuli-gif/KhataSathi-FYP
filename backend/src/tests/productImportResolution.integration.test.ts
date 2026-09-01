import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  createCsvImportPreview,
  getProductImportBatch,
  importReviewedPdfRows,
  saveReviewedProductImportRows,
} from "../modules/products/importService";

const runDatabaseTests = process.env.RUN_DB_INTEGRATION_TESTS === "1";

function reviewedPayload(row: Awaited<ReturnType<typeof getProductImportBatch>>["rows"][number]) {
  const parsed = (row.parsed || {}) as Record<string, unknown>;
  return {
    rowId: row.id,
    name: String(parsed.name || ""),
    sku: String(parsed.sku || ""),
    barcode: parsed.barcode ? String(parsed.barcode) : undefined,
    brand: String(parsed.brand || ""),
    category: String(parsed.category || ""),
    categoryGroup: parsed.categoryGroup ? String(parsed.categoryGroup) : undefined,
    vendorSource: parsed.vendorSource ? String(parsed.vendorSource) : undefined,
    productCodeVariant: parsed.productCodeVariant ? String(parsed.productCodeVariant) : undefined,
    sizeValue: typeof parsed.sizeValue === "number" ? parsed.sizeValue : null,
    sizeUnit: parsed.sizeUnit ? String(parsed.sizeUnit) : undefined,
    ratePerPiece: typeof parsed.ratePerPiece === "number" ? parsed.ratePerPiece : null,
    packageQuantity: typeof parsed.packageQuantity === "number" ? parsed.packageQuantity : null,
    packageUnit: String(parsed.packageUnit || "PIECE"),
    saleUnit: String(parsed.saleUnit || "PIECE"),
    allowFractionalQty: Boolean(parsed.allowFractionalQty),
    quantityStep: typeof parsed.quantityStep === "number" ? parsed.quantityStep : 1,
    wholesaleEligible: parsed.wholesaleEligible !== false,
    sourceCitation: parsed.sourceCitation ? String(parsed.sourceCitation) : undefined,
    searchAliases: Array.isArray(parsed.searchAliases) ? parsed.searchAliases.map(String) : [],
    retailPrice: typeof parsed.retailPrice === "number" ? parsed.retailPrice : null,
    wholesalePrice: typeof parsed.wholesalePrice === "number" ? parsed.wholesalePrice : null,
    stock: typeof parsed.stock === "number" ? parsed.stock : 0,
  };
}

test(
  "reviewed imports keep exact matches, explicitly update changed matches, and replay safely",
  { skip: !runDatabaseTests },
  async () => {
    const actor = await prisma.user.create({
      data: {
        name: "Import integration admin",
        email: `import-integration-${Date.now()}@example.test`,
        phone: `+97798${String(Date.now()).slice(-8)}`,
        passwordHash: "integration-test-only",
        role: "ADMIN",
      },
    });
    const brand = await prisma.brand.create({ data: { name: `Bagmati Integration ${Date.now()}` } });
    const product = await prisma.product.create({
      data: {
        name: "Bucket 13 LTR",
        productName: "Bucket",
        sku: `BAGMATI-INTEGRATION-${Date.now()}`,
        brandId: brand.id,
        category: "Bucket",
        categoryGroup: "Bucket",
        vendorSource: "Bagmati",
        ratePerPiece: 100,
        packageQuantity: 12,
        retailPrice: 150,
        wholesalePrice: 140,
        stock: 0,
      },
    });

    const exactPreview = await createCsvImportPreview({
      fileName: "bagmati-exact.xlsx",
      sourceType: "XLSX",
      createdById: actor.id,
      rows: [{
        productName: "Bucket 13 LTR",
        sku: product.sku,
        brand: brand.name,
        category: "Bucket",
        categoryGroup: "Bucket",
        supplier: "Bagmati",
        rate_per_piece: 100,
        packageQuantity: 12,
        retailPrice: 150,
        wholesalePrice: 140,
      }],
    });
    const exactBatch = await getProductImportBatch(exactPreview.batchId);
    assert.equal(exactBatch.rows[0].comparisonStatus, "EXACT_DUPLICATE");
    assert.equal(exactBatch.rows[0].resolution, "KEEP_EXISTING");
    assert.deepEqual(exactBatch.rows[0].sourceLocator, {
      kind: "SPREADSHEET",
      sheetName: null,
      rowNumber: 2,
      cells: {
        productName: "Bucket 13 LTR",
        sku: product.sku,
        brand: brand.name,
        category: "Bucket",
        categoryGroup: "Bucket",
        supplier: "Bagmati",
        rate_per_piece: 100,
        packageQuantity: 12,
        retailPrice: 150,
        wholesalePrice: 140,
      },
    });

    const keepInput = {
      ...reviewedPayload(exactBatch.rows[0]),
      resolution: "KEEP_EXISTING" as const,
    };
    const keepResult = await importReviewedPdfRows(exactBatch.id, {
      rows: [keepInput],
      actorId: actor.id,
      approved: true,
      commitToken: "keep-exact-integration",
    }) as Record<string, any>;
    assert.equal(keepResult.createdCount, 0);
    assert.equal(keepResult.updatedCount, 0);
    assert.equal(keepResult.keptCount, 1);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).ratePerPiece, 100);

    const replay = await importReviewedPdfRows(exactBatch.id, {
      rows: [keepInput],
      actorId: actor.id,
      approved: true,
      commitToken: "keep-exact-integration",
    }) as Record<string, any>;
    assert.equal(replay.replayed, true);

    const changedPreview = await createCsvImportPreview({
      fileName: "bagmati-new-rate.xlsx",
      sourceType: "XLSX",
      createdById: actor.id,
      rows: [{
        productName: "Bucket 13 LTR",
        sku: product.sku,
        brand: brand.name,
        category: "Bucket",
        categoryGroup: "Bucket",
        supplier: "Bagmati",
        rate_per_piece: 110,
        packageQuantity: 12,
        retailPrice: 999,
        wholesalePrice: 888,
      }],
    });
    let changedBatch = await getProductImportBatch(changedPreview.batchId);
    assert.equal(changedBatch.rows[0].comparisonStatus, "MATCHED_WITH_CHANGES");
    assert.equal(changedBatch.rows[0].resolution, null);

    const updateInput = {
      ...reviewedPayload(changedBatch.rows[0]),
      resolution: "UPDATE_MATCHED" as const,
    };
    await saveReviewedProductImportRows(changedBatch.id, [updateInput], actor.id);
    changedBatch = await getProductImportBatch(changedBatch.id);
    assert.equal(changedBatch.rows[0].resolution, "UPDATE_MATCHED");
    assert.equal(changedBatch.rows[0].status, "READY");

    const updateResult = await importReviewedPdfRows(changedBatch.id, {
      rows: [updateInput],
      actorId: actor.id,
      approved: true,
      commitToken: "update-match-integration",
    }) as Record<string, any>;
    assert.equal(updateResult.createdCount, 0);
    assert.equal(updateResult.updatedCount, 1);
    assert.equal(updateResult.keptCount, 0);

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(updated.ratePerPiece, 110);
    assert.equal(updated.retailPrice, 999, "an explicitly reviewed retail-price change must be applied");
    assert.equal(updated.wholesalePrice, 888, "an explicitly reviewed wholesale-price change must be applied");
    assert.equal(updated.stock, 0);
    assert.equal(updated.sku, product.sku);
    assert.equal(
      await prisma.auditLog.count({
        where: { action: "PRODUCT_IMPORT_MATCHED_UPDATE", entityId: product.id },
      }),
      1,
    );
  },
);

test.after(async () => {
  await prisma.$disconnect();
});
