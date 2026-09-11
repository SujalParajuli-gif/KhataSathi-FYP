import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { catalogPdf } from "./fixtures/catalogPdf";
import { extractPdfTextLineRegions } from "../modules/products/pdfTextLocations";
import { parsePdfTextCatalogPages } from "../modules/products/pdfTextCatalogParser";
import { importCoverage } from "../modules/products/importExecution";
import { detectVerticalCatalogPanelSplit, hasUsableAiProductShape, importReviewChanges, parseAiPrintedPrice, parseJsonFromAiText, sameImportChanges } from "../modules/products/importService";
import { pdfPageHasMeaningfulContent, pdfPageNeedsOcr, renderedPdfPageIsBlank } from "../modules/products/importWorker";

test("physical PDF columns preserve a blank WSP cell and original coordinates", async () => {
  const buffer = catalogPdf([[{text:"Product Name", x:40,y:700}, {text:"WSP",x:350,y:700}, {text:"MRP",x:450,y:700},
    {text:"Bucket 13 LTR",x:40,y:675}, {text:"150",x:450,y:675}]]);
  const [page] = await extractPdfTextLineRegions(buffer);
  const parsed = parsePdfTextCatalogPages([{ ...page, text: page.lines.map((line) => line.text).join("\n") }]);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].extractedPrices, [{key:"mrp",label:"MRP",value:150}]);
  assert.ok(parsed.rows[0].region);
  assert.ok(parsed.rows[0].region!.top < parsed.rows[0].region!.bottom);
});

test("a footer does not make a scanned page native-readable", () => {
  assert.equal(pdfPageNeedsOcr({pageNumber:2,text:"Supplier catalogue September 2026 - page 2"}), true);
  assert.equal(pdfPageNeedsOcr({pageNumber:1,text:"Product Name\tRate\nBucket\t150"}), false);
});

test("page numbers and blank PDF pages do not trigger OCR", () => {
  assert.equal(pdfPageHasMeaningfulContent({ pageNumber: 3, text: "0" }), false);
  assert.equal(pdfPageHasMeaningfulContent({ pageNumber: 3, text: "Page 3 of 3" }), false);
  assert.equal(pdfPageHasMeaningfulContent({ pageNumber: 2, text: "53 Plastic jug 68" }), true);
});

test("rendered blankness distinguishes an empty page from image content", async () => {
  const blank = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
  const scan = await sharp(Buffer.from(`<svg width="800" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="1000" fill="white"/><rect x="80" y="100" width="640" height="700" fill="#333"/></svg>`)).png().toBuffer();
  assert.equal(await renderedPdfPageIsBlank(blank), true);
  assert.equal(await renderedPdfPageIsBlank(scan), false);
});

test("AI JSON parsing preserves arrays and punctuation inside product names", () => {
  assert.deepEqual(parseJsonFromAiText('[{"name":"Box, {large}"},{"name":"Tray"},]'), [
    { name: "Box, {large}" },
    { name: "Tray" },
  ]);
  assert.deepEqual(parseJsonFromAiText('Result:\n```json\n{"products":[{"name":"Jug, 2L"}]}\n```'), {
    products: [{ name: "Jug, 2L" }],
  });
  assert.throws(() => parseJsonFromAiText('{"products":['), /incomplete data/);
});

test("AI response validation accepts name-only candidates but rejects empty and wrong shapes", () => {
  assert.equal(hasUsableAiProductShape([{ name: "Coming Soon item" }]), true);
  assert.equal(hasUsableAiProductShape({ products: [{ productName: "Bucket" }] }), true);
  assert.equal(hasUsableAiProductShape({ products: [] }), false);
  assert.equal(hasUsableAiProductShape({ message: "done" }), false);
});

test("two-panel catalog images detect the quiet center gutter", async () => {
  const horizontalRules = Array.from({ length: 18 }, (_, index) =>
    `<line x1="0" y1="${30 + index * 36}" x2="1000" y2="${30 + index * 36}" stroke="#111" stroke-width="3"/>`,
  ).join("");
  const image = await sharp(Buffer.from(`<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="700" fill="#8dcc58"/>${horizontalRules}
    <rect x="494" width="12" height="700" fill="#fff"/>
  </svg>`)).jpeg().toBuffer();

  const split = await detectVerticalCatalogPanelSplit(image);
  assert.ok(split !== null && split >= 495 && split <= 505);
});

test("printed Nepali decimal prices override a lossy AI numeric value", () => {
  assert.equal(parseAiPrintedPrice("६०।००", 60100), 60);
  assert.equal(parseAiPrintedPrice("१,०८०।००", 1080100), 1080);
  assert.equal(parseAiPrintedPrice("७०१०0", 70100), null);
  assert.equal(parseAiPrintedPrice("", 65), 65);
  assert.equal(parseAiPrintedPrice("unreadable", null), null);
});

test("partial and unvisited pages require explicit coverage acknowledgement", () => {
  const coverage = importCoverage({parser:"PAGE_PIPELINE_V1",totalPages:3,pages:[{pageNumber:1,status:"DONE"},{pageNumber:2,status:"PARTIAL"}]});
  assert.equal(coverage.completed,1);
  assert.equal(coverage.requiresAcknowledgement,true);
  assert.equal(coverage.failedPages[0].pageNumber,2);
  assert.deepEqual(coverage.retryablePages, [3]);
  assert.equal(coverage.outcome, "PARTIAL");
  const partialOnly = importCoverage({parser:"PAGE_PIPELINE_V1",totalPages:2,pages:[{pageNumber:1,status:"DONE",rows:1},{pageNumber:2,status:"PARTIAL",rows:2}]}, "DRAFT");
  assert.equal(partialOnly.outcome, "PARTIAL");
  assert.equal(partialOnly.canRetry, false);
});

test("review change comparison ignores MySQL JSON key ordering", () => {
  assert.equal(sameImportChanges([{field:"ratePerPiece",currentValue:100,incomingValue:110}], [{incomingValue:110,currentValue:100,field:"ratePerPiece"}]),true);
  assert.equal(sameImportChanges([{field:"ratePerPiece",currentValue:100,incomingValue:110}], [{field:"ratePerPiece",currentValue:105,incomingValue:110}]),false);
});

test("saved import edits expose the changed fields used by the Edited filter", () => {
  const extracted = { productName: "Bucket 10 Ltr", ratePerPiece: 200, packageQuantity: 12 };
  const parsed = { ...extracted, ratePerPiece: 220, packageQuantity: 6 };
  assert.deepEqual(importReviewChanges(parsed, extracted), ["Package quantity", "Rate"]);
  assert.deepEqual(importReviewChanges(extracted, extracted), []);
});
