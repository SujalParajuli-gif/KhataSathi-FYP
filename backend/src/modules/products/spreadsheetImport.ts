import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";

export type SpreadsheetSourceType = "CSV" | "XLSX";

export type ParsedSpreadsheet = {
  sourceType: SpreadsheetSourceType;
  rows: Array<Record<string, unknown>>;
  rowNumbers: number[];
  sheetName?: string;
};

export class SpreadsheetImportError extends Error {}

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

const HEADER_WORDS = new Set([
  "article",
  "barcode",
  "brand",
  "category",
  "code",
  "cost",
  "description",
  "item",
  "mrp",
  "name",
  "package",
  "price",
  "product",
  "qty",
  "quantity",
  "rate",
  "retail",
  "sku",
  "stock",
  "unit",
  "wholesale",
]);

function normalizedHeader(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isZipWorkbook(buffer: Buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  );
}

function headerScore(values: string[], expectedHeaders: Set<string>) {
  let score = Math.min(values.filter(Boolean).length, 12);
  for (const value of values) {
    const normalized = normalizedHeader(value);
    if (!normalized) continue;
    if (expectedHeaders.has(normalized)) score += 40;
    const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    score += words.filter((word) => HEADER_WORDS.has(word)).length * 12;
  }
  return score;
}

function makeUniqueHeaders(values: string[]) {
  const counts = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value || `Column ${index + 1}`).trim() || `Column ${index + 1}`;
    const key = base.toLowerCase();
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

async function parseXlsx(
  buffer: Buffer,
  expectedHeaders: string[],
): Promise<ParsedSpreadsheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new SpreadsheetImportError("This Excel workbook is damaged or is not a valid .xlsx file.");
  }

  const expected = new Set(expectedHeaders.map(normalizedHeader).filter(Boolean));
  let selected:
    | {
        worksheet: ExcelJS.Worksheet;
        headerRowNumber: number;
        score: number;
        populatedCells: number;
      }
    | undefined;

  for (const worksheet of workbook.worksheets) {
    const lastCandidateRow = Math.min(
      Math.max(worksheet.actualRowCount, worksheet.rowCount),
      50,
    );
    for (let rowNumber = 1; rowNumber <= lastCandidateRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const values = Array.from(
        { length: Math.min(Math.max(row.cellCount, worksheet.actualColumnCount), 200) },
        (_, index) => row.getCell(index + 1).text.trim(),
      );
      const populatedCells = values.filter(Boolean).length;
      if (populatedCells < 2) continue;
      const score = headerScore(values, expected);
      if (
        !selected ||
        score > selected.score ||
        (score === selected.score && populatedCells > selected.populatedCells)
      ) {
        selected = { worksheet, headerRowNumber: rowNumber, score, populatedCells };
      }
    }
  }

  if (!selected) {
    throw new SpreadsheetImportError("No spreadsheet table was found. Add a header row and at least one product row.");
  }

  const columnCount = Math.min(
    Math.max(
      selected.worksheet.getRow(selected.headerRowNumber).cellCount,
      selected.worksheet.actualColumnCount,
    ),
    200,
  );
  const headers = makeUniqueHeaders(
    Array.from({ length: columnCount }, (_, index) =>
      selected!.worksheet.getRow(selected!.headerRowNumber).getCell(index + 1).text.trim(),
    ),
  );
  const rows: Array<Record<string, unknown>> = [];
  const rowNumbers: number[] = [];
  const finalRow = Math.min(
    Math.max(selected.worksheet.actualRowCount, selected.worksheet.rowCount),
    selected.headerRowNumber + 5000,
  );

  for (let rowNumber = selected.headerRowNumber + 1; rowNumber <= finalRow; rowNumber += 1) {
    const row = selected.worksheet.getRow(rowNumber);
    const values = headers.map((_, index) => row.getCell(index + 1).text.trim());
    if (!values.some(Boolean)) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
    rowNumbers.push(rowNumber);
  }

  if (rows.length === 0) {
    throw new SpreadsheetImportError(`No product rows were found below the header in sheet "${selected.worksheet.name}".`);
  }

  return {
    sourceType: "XLSX",
    rows,
    rowNumbers,
    sheetName: selected.worksheet.name,
  };
}

function parseCsv(buffer: Buffer): ParsedSpreadsheet {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
    });
  } catch (error: any) {
    throw new SpreadsheetImportError(error?.message ? `CSV could not be read: ${error.message}` : "CSV could not be read.");
  }
  if (rows.length === 0) {
    throw new SpreadsheetImportError("No product rows were found below the CSV header.");
  }
  return {
    sourceType: "CSV",
    rows: rows.slice(0, 5000),
    rowNumbers: rows.slice(0, 5000).map((_, index) => index + 2),
  };
}

export async function parseProductSpreadsheet(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  expectedHeaders?: string[];
}): Promise<ParsedSpreadsheet> {
  const lowerName = input.fileName.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".")) : "";
  const workbookByName = extension === ".xlsx" || extension === ".xlsm";
  const workbookByMime = XLSX_MIME_TYPES.has(String(input.mimeType || "").toLowerCase());
  const workbookBySignature = isZipWorkbook(input.buffer);

  if (extension === ".xls") {
    throw new SpreadsheetImportError("Legacy .xls files are not supported. Save the workbook as .xlsx or CSV and upload it again.");
  }
  if (workbookByName || workbookByMime || workbookBySignature) {
    if (!workbookBySignature) {
      throw new SpreadsheetImportError("The selected file is named as Excel but is not a valid .xlsx workbook.");
    }
    return parseXlsx(input.buffer, input.expectedHeaders || []);
  }
  if (extension && extension !== ".csv") {
    throw new SpreadsheetImportError("Only .csv and .xlsx spreadsheet files are supported here.");
  }
  return parseCsv(input.buffer);
}
