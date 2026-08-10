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
