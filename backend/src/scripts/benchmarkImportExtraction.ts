import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PDFParse } from "pdf-parse";
import { parseProductSpreadsheet } from "../modules/products/spreadsheetImport";
import { extractPdfTextLineRegions } from "../modules/products/pdfTextLocations";
import { parsePdfTextCatalogPages } from "../modules/products/pdfTextCatalogParser";

type Candidate = { name: string; prices: Record<string, number | null>; pageNumber?: number };
type Fixture = { id: string; file: string; expected: Candidate[]; sheetName?: string; headerRowNumber?: number; nameColumn?: string; priceColumns?: string[]; candidatesFile?: string };
type Score = { id: string; expectedRows: number; extractedRows: number; namesMatched: number; pricesMatched: number; expectedPriceCells: number; missingNames: string[]; unexpectedNames: string[]; durationMs: number };

// Read-only benchmark. Image/OCR candidates must be supplied explicitly; this
// command never sends supplier files to an external service or writes products.
async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("Usage: node dist/scripts/benchmarkImportExtraction.js path/to/private-manifest.json");
  const base = path.dirname(path.resolve(manifestPath));
  const manifest: { fixtures: Fixture[] } = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.fixtures) || !manifest.fixtures.length) throw new Error("The manifest must contain at least one fixture with approved expected rows.");
  const results: Array<Score | {id:string;error:string}> = [];
  for (const fixture of manifest.fixtures) {
    const started = performance.now();
    try {
      if (!Array.isArray(fixture.expected) || !fixture.expected.length) throw new Error("Approved expected rows are required.");
      let candidates: Candidate[];
      if (fixture.candidatesFile) {
        candidates = JSON.parse(await fs.readFile(path.resolve(base, fixture.candidatesFile), "utf8"));
      } else {
        const buffer = await fs.readFile(path.resolve(base, fixture.file));
        if (/\.pdf$/i.test(fixture.file)) {
          const parser = new PDFParse({ data: buffer });
          try {
            const text = await parser.getText();
            const located = await extractPdfTextLineRegions(buffer);
            candidates = parsePdfTextCatalogPages(text.pages.map((page) => ({pageNumber:page.num,text:page.text,lines:located.find((item) => item.pageNumber === page.num)?.lines}))).rows
              .map((row) => ({name:row.productName,pageNumber:row.pageNumber,prices:Object.fromEntries(row.extractedPrices.map((price) => [price.key,price.value]))}));
          } finally { await parser.destroy(); }
        } else {
          const parsed = await parseProductSpreadsheet({buffer,fileName:fixture.file,sheetName:fixture.sheetName,headerRowNumber:fixture.headerRowNumber});
          if (!fixture.nameColumn) throw new Error("Spreadsheet fixtures require an explicit nameColumn.");
          candidates = parsed.rows.map((row) => ({name:String(row[fixture.nameColumn!] ?? ""),prices:Object.fromEntries((fixture.priceColumns || []).map((column) => {
            const text = String(row[column] ?? "").replace(/,/g, "").trim();
            return [column,text && Number.isFinite(Number(text)) ? Number(text) : null];
          }))}));
        }
      }
      const remaining = [...candidates];
      let namesMatched = 0;
      let pricesMatched = 0;
      let expectedPriceCells = 0;
      const missingNames: string[] = [];
      for (const expected of fixture.expected) {
        const index = remaining.findIndex((candidate) => candidate.name === expected.name && (expected.pageNumber === undefined || candidate.pageNumber === expected.pageNumber));
        const candidate = index < 0 ? null : remaining.splice(index,1)[0];
        if (candidate) namesMatched++; else missingNames.push(expected.name);
        for (const [key,value] of Object.entries(expected.prices)) { expectedPriceCells++; if (candidate && candidate.prices[key] === value) pricesMatched++; }
      }
      results.push({id:fixture.id,expectedRows:fixture.expected.length,extractedRows:candidates.length,namesMatched,pricesMatched,expectedPriceCells,missingNames,unexpectedNames:remaining.map((row) => row.name),durationMs:Math.round(performance.now()-started)});
    } catch (error) { results.push({id:fixture.id,error:error instanceof Error ? error.message : "Extraction failed"}); }
  }
  console.log(JSON.stringify({results,processPeakMemoryKiB:process.resourceUsage().maxRSS,notes:["Exact name and expected price-cell comparisons; no fuzzy matches.","Peak memory is for the entire benchmark process.","Highlight alignment and category accuracy still require source review."]},null,2));
  if (results.some((result) => "error" in result || result.namesMatched !== result.expectedRows || result.pricesMatched !== result.expectedPriceCells || result.unexpectedNames.length)) process.exitCode = 1;
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
