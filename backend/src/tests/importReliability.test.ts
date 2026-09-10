import test from "node:test";
import assert from "node:assert/strict";
import { catalogPdf } from "./fixtures/catalogPdf";
import { extractPdfTextLineRegions } from "../modules/products/pdfTextLocations";
import { parsePdfTextCatalogPages } from "../modules/products/pdfTextCatalogParser";
import { importCoverage } from "../modules/products/importExecution";
import { sameImportChanges } from "../modules/products/importService";
import { pdfPageNeedsOcr } from "../modules/products/importWorker";

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

test("partial and unvisited pages require explicit coverage acknowledgement", () => {
  const coverage = importCoverage({parser:"PAGE_PIPELINE_V1",totalPages:3,pages:[{pageNumber:1,status:"DONE"},{pageNumber:2,status:"PARTIAL"}]});
  assert.equal(coverage.completed,1);
  assert.equal(coverage.requiresAcknowledgement,true);
  assert.equal(coverage.failedPages[0].pageNumber,2);
});

test("review change comparison ignores MySQL JSON key ordering", () => {
  assert.equal(sameImportChanges([{field:"ratePerPiece",currentValue:100,incomingValue:110}], [{incomingValue:110,currentValue:100,field:"ratePerPiece"}]),true);
  assert.equal(sameImportChanges([{field:"ratePerPiece",currentValue:100,incomingValue:110}], [{field:"ratePerPiece",currentValue:105,incomingValue:110}]),false);
});
