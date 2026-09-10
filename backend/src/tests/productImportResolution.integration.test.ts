import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  createCsvImportPreview,
  getProductImportBatch,
  importReviewedPdfRows,
  importSavedProductImportBatch,
  saveReviewedProductImportRows,
  setProductImportRowResolution,
  setProductImportPriceMapping,
} from "../modules/products/importService";
import { importExecution, persistImportPreview, importCoverage } from "../modules/products/importExecution";
import { enqueueImport, runImportWorkerOnce, controlImport } from "../modules/products/importWorker";
import { catalogPdf } from "./fixtures/catalogPdf";
import { updateProduct } from "../modules/products/service";

const runDatabaseTests = process.env.RUN_DB_INTEGRATION_TESTS === "1";
if (runDatabaseTests && !/test/i.test(new URL(process.env.DATABASE_URL || "mysql://localhost/missing").pathname)) throw new Error("Use an isolated test database for import integration tests.");

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
    assert.ok(updated.rateUpdatedAt);
    await updateProduct(product.id, { category: "Updated category" }, { id: actor.id });
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).rateUpdatedAt?.toISOString(), updated.rateUpdatedAt?.toISOString(), "unrelated edits must not renew the rate date");
    assert.equal(
      await prisma.auditLog.count({
        where: { action: "PRODUCT_IMPORT_MATCHED_UPDATE", entityId: product.id },
      }),
      1,
    );

    const savedReplay = await importSavedProductImportBatch({batchId: changedBatch.id,actorId:actor.id,approved:true,commitToken:"update-match-integration"}) as Record<string,any>;
    assert.equal(savedReplay.replayed,true, "a lost response must be recoverable through the saved-review endpoint");
    const committedSnapshot = (await getProductImportBatch(changedBatch.id)).rows[0];
    await setProductImportPriceMapping({batchId:changedBatch.id,actorId:actor.id,mapping:{sourceRatePerPiece:"retailPrice",sourceRetailPrice:"ratePerPiece",sourceWholesalePrice:"wholesalePrice"}});
    const mappedAfterCommit = (await getProductImportBatch(changedBatch.id)).rows[0];
    assert.equal(mappedAfterCommit.status,"UPDATED");
    assert.deepEqual(mappedAfterCommit.parsed,committedSnapshot.parsed,"mapping changes must never rewrite committed evidence or values");
    const ignoredPreview = await createCsvImportPreview({fileName:"ignored.csv",createdById:actor.id, rows:[{name:"Ignore me",brand:brand.name,rate:12}]});
    const ignoredBatch = await getProductImportBatch(ignoredPreview.batchId);
    await setProductImportRowResolution({batchId:ignoredBatch.id,rowId:ignoredBatch.rows[0].id,resolution:"IGNORE",actorId:actor.id});
    await importSavedProductImportBatch({batchId:ignoredBatch.id,actorId:actor.id,approved:true,commitToken:"ignore-only-test"});
    assert.equal((await getProductImportBatch(ignoredBatch.id)).status,"IMPORTED", "ignore-only commits must release their batch lock");

    const createPreview = await createCsvImportPreview({fileName:"create.csv",createdById:actor.id,rows:[{name:"Retail only test",brand:brand.name,retailPrice:175}]});
    const newBatch = await getProductImportBatch(createPreview.batchId);
    const evidence = newBatch.rows[0].extracted;
    const createInput = {...reviewedPayload(newBatch.rows[0]),resolution:"CREATE_NEW" as const};
    await saveReviewedProductImportRows(newBatch.id,[createInput],actor.id);
    const attempts = await Promise.allSettled(["concurrent-attempt-one","concurrent-attempt-two"].map((commitToken) => importSavedProductImportBatch({batchId:newBatch.id,actorId:actor.id,approved:true,commitToken})));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length,1);
    const committedRow = (await getProductImportBatch(newBatch.id)).rows[0];
    assert.equal(committedRow.status,"IMPORTED");
    assert.deepEqual(committedRow.extracted,evidence);
    assert.ok(committedRow.matchedProductId,"product and row completion must be saved together");
    await updateProduct(committedRow.matchedProductId!, { ratePerPiece:null,retailPrice:180 }, {id:actor.id});
    assert.equal(await prisma.product.count({where:{brandId:brand.id,name:"Retail only test"}}),1);

    const stalePreview = await createCsvImportPreview({fileName:"stale.csv",createdById:actor.id,rows:[{name:product.name,sku:product.sku,brand:brand.name,rate:120}]});
    const staleBatch = await getProductImportBatch(stalePreview.batchId);
    const staleInput = {...reviewedPayload(staleBatch.rows[0]),resolution:"UPDATE_MATCHED" as const};
    await saveReviewedProductImportRows(staleBatch.id,[staleInput],actor.id);
    await prisma.product.update({where:{id:product.id},data:{ratePerPiece:115}});
    await assert.rejects(importSavedProductImportBatch({batchId:staleBatch.id,actorId:actor.id,approved:true,commitToken:"stale-review-attempt"}),/catalog changed after review/);
    assert.equal((await prisma.product.findUniqueOrThrow({where:{id:product.id}})).ratePerPiece,115);

    // No external OCR calls: exercise an actual mixed-page PDF with OCR deliberately unavailable.
    process.env.GEMINI_API_KEY = ""; process.env.GOOGLE_GENERATIVE_AI_API_KEY = ""; process.env.GOOGLE_AI_API_KEY = "";
    const pdf = catalogPdf([[{text:"Product Name",x:40,y:700},{text:"Rate",x:400,y:700},{text:"Native bucket",x:40,y:675},{text:"123",x:400,y:675}],
      [{text:"Supplier catalogue - page 2",x:40,y:40}]]);
    const queued = await enqueueImport({fileName:"mixed-test.pdf",mimeType:"application/pdf",buffer:pdf,createdById:actor.id,supplier:brand.name});
    await runImportWorkerOnce();
    const mixedBatch = await getProductImportBatch(queued.batchId);
    assert.equal(mixedBatch.rows.length,1);
    assert.equal(mixedBatch.rows[0].status,"READY");
    assert.equal(importCoverage(mixedBatch.extractionMeta).completed,1);
    assert.equal(importCoverage(mixedBatch.extractionMeta).requiresAcknowledgement,true);
    const corrected = {...reviewedPayload(mixedBatch.rows[0]),name:"Corrected native bucket",resolution:"CREATE_NEW" as const};
    await saveReviewedProductImportRows(mixedBatch.id,[corrected],actor.id);
    await controlImport(mixedBatch.id,"retry");
    await runImportWorkerOnce();
    const resumedBatch = await getProductImportBatch(mixedBatch.id);
    assert.equal(resumedBatch.rows.length,1);
    assert.equal(resumedBatch.rows[0].id,mixedBatch.rows[0].id);
    assert.equal((resumedBatch.rows[0].parsed as Record<string,unknown>).name,"Corrected native bucket");
    await assert.rejects(importSavedProductImportBatch({batchId:mixedBatch.id,actorId:actor.id,approved:true,commitToken:"incomplete-not-approved"}),/Acknowledge/);
    // A commit attempt intentionally prevents extraction retries; it cannot race catalog writes.
    await assert.rejects(controlImport(mixedBatch.id,"retry"),/already has an import attempt/);
    const acknowledged = await importSavedProductImportBatch({batchId:mixedBatch.id,actorId:actor.id,approved:true,acknowledgeIncomplete:true,commitToken:"incomplete-approved"}) as Record<string,any>;
    assert.equal(acknowledged.createdCount,1);
    const cancelled = await enqueueImport({fileName:"cancelled.pdf",mimeType:"application/pdf",buffer:pdf,createdById:actor.id});
    await controlImport(cancelled.batchId,"cancel");
    assert.equal((await getProductImportBatch(cancelled.batchId)).status,"INTERRUPTED");
    await controlImport(cancelled.batchId,"retry");
    assert.equal((await getProductImportBatch(cancelled.batchId)).status,"QUEUED");
    await controlImport(cancelled.batchId,"cancel");

    const partial = await prisma.productImportBatch.create({data:{sourceType:"PDF",status:"PROCESSING",createdById:actor.id,extractionMeta:{parser:"PAGE_PIPELINE_V1",totalPages:2,pages:[]}}});
    const execution = {batchId:partial.id,pageNumber:1,supplier:brand.name,signal:new AbortController().signal,deadline:Date.now()+5000,startedAt:Date.now(),extractor:"TEST"};
    const pageData = {data:{sourceType:"PDF",createdById:actor.id,rows:{create:[{rowNumber:1,status:"READY",parsed:{name:"Saved candidate"}},{rowNumber:2,status:"FAILED",error:"Missing part"}]}}};
    await importExecution.run(execution,() => persistImportPreview(pageData));
    const partialRow = await prisma.productImportRow.findFirstOrThrow({where:{batchId:partial.id}});
    await prisma.productImportRow.update({where:{id:partialRow.id},data:{parsed:{name:"Operator correction"}}});
    await importExecution.run(execution,() => persistImportPreview(pageData));
    const retained = await getProductImportBatch(partial.id);
    assert.equal(retained.rows.length,1);
    assert.equal((retained.rows[0].parsed as Record<string,unknown>).name,"Operator correction");
    assert.equal(importCoverage(retained.extractionMeta).failedPages.length,1);
    await prisma.productImportBatch.update({where:{id:partial.id},data:{status:"DRAFT"}});
  },
);

test.after(async () => {
  await prisma.$disconnect();
});
