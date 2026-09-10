import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  parseProductSpreadsheet,
  SpreadsheetImportError,
} from "../modules/products/spreadsheetImport";

async function supplierWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rate List");
  sheet.addRow(["PRADEEP RATE LIST 2083"]);
  sheet.addRow([]);
  sheet.addRow(["Description", "Code", "PKG", "MRP"]);
  sheet.addRow(["Bucket 25 Ltr", "BU-25", "12 PIECE", 225]);
  sheet.addRow(["Air Tight Container", "AT-48", "6 PIECE", 132]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("XLSX parser finds a table header below supplier title rows", async () => {
  const result = await parseProductSpreadsheet({
    buffer: await supplierWorkbookBuffer(),
    fileName: "pradeep-rate-list.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  assert.equal(result.sourceType, "XLSX");
  assert.equal(result.sheetName, "Rate List");
  assert.deepEqual(result.rowNumbers, [4, 5]);
  assert.deepEqual(result.rows[0], {
    Description: "Bucket 25 Ltr",
    Code: "BU-25",
    PKG: "12 PIECE",
    MRP: "225",
  });
});

test("workbook signature wins when an XLSX file has a misleading CSV name", async () => {
  const result = await parseProductSpreadsheet({
    buffer: await supplierWorkbookBuffer(),
    fileName: "supplier.csv",
    mimeType: "application/octet-stream",
  });
  assert.equal(result.sourceType, "XLSX");
  assert.equal(result.rows.length, 2);
});

test("CSV parser keeps ordinary supplier rows and source row numbers", async () => {
  const result = await parseProductSpreadsheet({
    buffer: Buffer.from("name,sku,retailPrice\nBucket,BU-1,250\nJug,JG-1,125\n"),
    fileName: "supplier.csv",
    mimeType: "text/csv",
  });
  assert.equal(result.sourceType, "CSV");
  assert.deepEqual(result.rowNumbers, [2, 3]);
  assert.equal(result.rows[1].name, "Jug");
});

test("legacy XLS receives an actionable conversion error", async () => {
  await assert.rejects(
    () =>
      parseProductSpreadsheet({
        buffer: Buffer.from("legacy-binary"),
        fileName: "supplier.xls",
        mimeType: "application/vnd.ms-excel",
      }),
    (error: unknown) =>
      error instanceof SpreadsheetImportError &&
      /Save the workbook as \.xlsx or CSV/.test(error.message),
  );
});

test("CSV rejects extra cells and limits instead of dropping prices or products", async () => {
  await assert.rejects(() => parseProductSpreadsheet({ buffer: Buffer.from("name,rate\nBucket,1,250\n"), fileName: "bad.csv" }), /line 2 contains 3 cells/);
  const csv = "name,rate\n" + Array.from({ length: 5001 }, (_, index) => `Bucket ${index},100`).join("\n");
  await assert.rejects(() => parseProductSpreadsheet({ buffer: Buffer.from(csv), fileName: "large.csv" }), /exceeds 5000/);
});

test("CSV handles semicolons, duplicate headers, blank lines and quoted commas", async () => {
  const result = await parseProductSpreadsheet({ buffer: Buffer.from('name;rate;rate\n\nBucket;"1,250";100\n'), fileName: "rates.csv" });
  assert.deepEqual(result.rows, [{ name: "Bucket", rate: "1,250", "rate (2)": "100" }]);
  assert.deepEqual(result.rowNumbers, [3]);
});

test("XLSX requires a sheet selection and preserves formatted identifiers and formula warnings", async () => {
  const workbook = new ExcelJS.Workbook();
  for (const name of ["Buckets", "Jars"]) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(["Product Name", "Barcode", "Rate"]);
    sheet.addRow([name, 123, { formula: "1+2" }]);
    sheet.getCell("B2").numFmt = "000000";
  }
  const input = { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: "multi.xlsx" };
  await assert.rejects(() => parseProductSpreadsheet(input), /several worksheets/);
  const result = await parseProductSpreadsheet({ ...input, sheetName: "Jars" });
  assert.equal(result.rows[0]["Product Name"], "Jars");
  assert.equal(result.rows[0].Barcode, "000123");
  assert.match(result.rowWarnings[2][0], /no saved result/);
});

test("duplicate headers cannot overwrite another real column", async () => {
  const result = await parseProductSpreadsheet({buffer:Buffer.from("Name,Rate,Rate,Rate (2)\nBucket,100,110,120"),fileName:"duplicates.csv"});
  assert.deepEqual(Object.values(result.rows[0]),["Bucket","100","110","120"]);
  assert.equal(new Set(result.headers).size,4);
});

test("selected CSV header determines its delimiter even after a title", async () => {
  const result = await parseProductSpreadsheet({buffer:Buffer.from("Supplier catalogue\nName;Rate\nBucket;120"),fileName:"title.csv",headerRowNumber:2});
  assert.deepEqual(result.rows,[{Name:"Bucket",Rate:"120"}]);
});

test("a workbook with only product names retains coming-soon candidates", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Coming soon"); sheet.addRow(["Product Name"]); sheet.addRow(["New planter"]);
  const parsed = await parseProductSpreadsheet({buffer:Buffer.from(await workbook.xlsx.writeBuffer()),fileName:"coming-soon.xlsx"});
  assert.deepEqual(parsed.rows,[{"Product Name":"New planter"}]);
});
