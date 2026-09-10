import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";

export type SpreadsheetSourceType = "CSV" | "XLSX";

export type ParsedSpreadsheet = {
  sourceType: SpreadsheetSourceType;
  rows: Array<Record<string, unknown>>;
  rowNumbers: number[];
  sheetName?: string;
  headerRowNumber: number;
  sheets: string[];
  headers: string[];
  rowWarnings: Record<number, string[]>;
};

export class SpreadsheetImportError extends Error {}

const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
type SpreadsheetSelection = { sheetName?: string; headerRowNumber?: number; preview?: boolean };

function cellText(cell: ExcelJS.Cell) {
  // ExcelJS .text does not preserve a numeric identifier's zero-padding.
  if (typeof cell.value === "number" && /^0+$/.test(cell.numFmt || "")) {
    return String(cell.value).padStart(cell.numFmt.length, "0");
  }
  return cell.text.trim();
}

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
  const bases = values.map((value, index) => String(value || `Column ${index + 1}`).trim() || `Column ${index + 1}`);
  const reserved = new Set(bases.map((base) => base.toLowerCase()));
  const used = new Set<string>();
  return bases.map((base) => {
    let header = base;
    let suffix = 2;
    while (used.has(header.toLowerCase())) {
      do { header = `${base} (${suffix++})`; } while (reserved.has(header.toLowerCase()));
    }
    used.add(header.toLowerCase());
    return header;
  });
}

async function parseXlsx(
  buffer: Buffer,
  expectedHeaders: string[],
  selection: SpreadsheetSelection,
): Promise<ParsedSpreadsheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new SpreadsheetImportError("This Excel workbook is damaged or is not a valid .xlsx file.");
  }

  const expected = new Set(expectedHeaders.map(normalizedHeader).filter(Boolean));
  const sheets = workbook.worksheets.filter((sheet) => sheet.actualRowCount > 0).map((sheet) => sheet.name);
  if (selection.sheetName && !sheets.includes(selection.sheetName)) {
    throw new SpreadsheetImportError("The selected worksheet no longer exists. Choose a worksheet again.");
  }
  if (sheets.length > 1 && !selection.sheetName && !selection.preview) {
    throw new SpreadsheetImportError("This workbook contains several worksheets. Select the worksheet to import in the preview.");
  }
  let selected:
    | {
        worksheet: ExcelJS.Worksheet;
        headerRowNumber: number;
        score: number;
        populatedCells: number;
      }
    | undefined;

  for (const worksheet of workbook.worksheets) {
    if (selection.sheetName && worksheet.name !== selection.sheetName) continue;
    const lastCandidateRow = Math.min(
      Math.max(worksheet.actualRowCount, worksheet.rowCount),
      50,
    );
    for (let rowNumber = 1; rowNumber <= lastCandidateRow; rowNumber += 1) {
      if (selection.headerRowNumber && rowNumber !== selection.headerRowNumber) continue;
      const row = worksheet.getRow(rowNumber);
      const values = Array.from(
        { length: Math.min(Math.max(row.cellCount, worksheet.actualColumnCount), 200) },
        (_, index) => row.getCell(index + 1).text.trim(),
      );
      const populatedCells = values.filter(Boolean).length;
      const score = headerScore(values, expected);
      if (!populatedCells || (populatedCells < 2 && !selection.headerRowNumber && score <= 0)) continue;
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

  if (selected.worksheet.actualColumnCount > MAX_COLUMNS) {
    throw new SpreadsheetImportError(`The worksheet exceeds ${MAX_COLUMNS} columns. Remove unused columns or split the file.`);
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
  const rowWarnings: Record<number, string[]> = {};
  selected.worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= selected!.headerRowNumber) return;
    const values = headers.map((_, index) => cellText(row.getCell(index + 1)));
    const warnings: string[] = [];
    headers.forEach((header, index) => {
      const cell = row.getCell(index + 1);
      if (cell.type === ExcelJS.ValueType.Formula && (cell.result === undefined || cell.result === null)) {
        warnings.push(`${header}: the formula has no saved result. Recalculate and save the workbook in Excel, or enter the value during review.`);
      }
      if (cell.type === ExcelJS.ValueType.Error) warnings.push(`${header}: the spreadsheet cell contains an error.`);
      if (typeof cell.value === "number" && /barcode|ean|gtin|upc/i.test(header) && (!Number.isSafeInteger(cell.value) || Math.abs(cell.value) >= 1e15)) {
        warnings.push(`${header}: this numeric identifier may have lost precision. Supply it as text.`);
      }
    });
    if (!values.some(Boolean) && !warnings.length) return;
    if (rows.length >= MAX_ROWS) throw new SpreadsheetImportError(`The worksheet exceeds ${MAX_ROWS} product rows. Split it into smaller files; no rows were imported.`);
    if (warnings.length) rowWarnings[rowNumber] = warnings;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
    rowNumbers.push(rowNumber);
  });

  if (rows.length === 0 && !selection.preview) {
    throw new SpreadsheetImportError(`No product rows were found below the header in sheet "${selected.worksheet.name}".`);
  }

  return {
    sourceType: "XLSX",
    rows,
    rowNumbers,
    sheetName: selected.worksheet.name,
    headerRowNumber: selected.headerRowNumber,
    sheets,
    headers,
    rowWarnings,
  };
}

function parseCsv(buffer: Buffer, selection: SpreadsheetSelection): ParsedSpreadsheet {
  let records: Array<{ record: string[]; info: { lines: number } }>;
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  // Count separators in the header, ignoring quoted fields, not in numeric data.
  const physicalLines = text.split(/\r?\n/);
  const firstLine = (selection.headerRowNumber ? physicalLines[selection.headerRowNumber - 1] : physicalLines.find((line) => line.trim())) || "";
  const unquoted = firstLine.replace(/"(?:[^"]|"")*"/g, "");
  const delimiter = [",", ";", "\t"].sort((a, b) => unquoted.split(b).length - unquoted.split(a).length)[0];
  try {
    records = parse(buffer, {
      delimiter,
      info: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      // Keep all cells until we can report an actionable physical row number.
      relax_column_count: true,
      max_record_size: 1024 * 1024,
    }) as unknown as typeof records;
  } catch (error: any) {
    throw new SpreadsheetImportError(error?.message ? `CSV could not be read: ${error.message}` : "CSV could not be read.");
  }
  const headerIndex = selection.headerRowNumber
    ? records.findIndex((record) => record.info.lines === selection.headerRowNumber)
    : 0;
  if (headerIndex < 0) throw new SpreadsheetImportError("The selected CSV header row was not found.");
  const header = records[headerIndex];
  if (!header || records.length <= headerIndex + 1) {
    throw new SpreadsheetImportError("No product rows were found below the CSV header.");
  }
  const headers = makeUniqueHeaders(header.record);
  if (headers.length > MAX_COLUMNS) throw new SpreadsheetImportError(`CSV files may contain at most ${MAX_COLUMNS} columns.`);
  const data = records.slice(headerIndex + 1);
  if (data.length > MAX_ROWS) throw new SpreadsheetImportError(`The CSV exceeds ${MAX_ROWS} product rows. Split it into smaller files; no rows were imported.`);
  for (const row of data) {
    if (row.record.length !== headers.length) {
      throw new SpreadsheetImportError(`CSV line ${row.info.lines} contains ${row.record.length} cells; the header contains ${headers.length}. Check separators and quote values containing commas, for example "1,250". No rows were imported.`);
    }
  }
  return {
    sourceType: "CSV",
    rows: data.map((row) => Object.fromEntries(headers.map((name, index) => [name, row.record[index]]))),
    rowNumbers: data.map((row) => row.info.lines),
    headerRowNumber: header.info.lines,
    headers,
    sheets: [],
    rowWarnings: {},
  };
}

export async function parseProductSpreadsheet(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  expectedHeaders?: string[];
  sheetName?: string;
  headerRowNumber?: number;
  preview?: boolean;
}): Promise<ParsedSpreadsheet> {
  if (input.headerRowNumber !== undefined && (!Number.isInteger(input.headerRowNumber) || input.headerRowNumber < 1 || input.headerRowNumber > 50)) {
    throw new SpreadsheetImportError("Choose a header row between 1 and 50.");
  }
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
    return parseXlsx(input.buffer, input.expectedHeaders || [], input);
  }
  if (extension && extension !== ".csv") {
    throw new SpreadsheetImportError("Only .csv and .xlsx spreadsheet files are supported here.");
  }
  return parseCsv(input.buffer, input);
}
