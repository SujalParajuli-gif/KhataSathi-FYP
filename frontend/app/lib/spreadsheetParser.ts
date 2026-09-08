// Client-side spreadsheet preview and intelligent column auto-detection
// Parses CSV and XLSX workbooks in-browser (<50ms) to provide live header and sample data previews

export type DetectedSpreadsheetColumn = {
  index: number;
  colLetter: string;
  header: string;
  sampleValue: string;
  autoMatchedField?: string;
};

export type SpreadsheetPreviewResult = {
  sheetName?: string;
  totalColumns: number;
  columns: DetectedSpreadsheetColumn[];
};

export type CanonicalImportField = {
  key: string;
  label: string;
  shortLabel: string;
  required?: boolean;
  aliases: string[];
};

export const CANONICAL_IMPORT_FIELDS: CanonicalImportField[] = [
  {
    key: "productName",
    label: "Product Name",
    shortLabel: "Name",
    required: true,
    aliases: [
      "item name", "item_name", "product name", "product_name", "productname",
      "particular", "particulars", "description", "item description", "product description",
      "items", "product", "article", "name", "item", "सामान", "विवरण",
    ],
  },
  {
    key: "wholesalePrice",
    label: "Wholesale Price (थोक)",
    shortLabel: "Wholesale",
    aliases: [
      "wholesale", "wholesale price", "wholesale_price", "wholesaleprice",
      "w/s", "w/s rate", "ws rate", "thok", "थोक",
    ],
  },
  {
    key: "retailPrice",
    label: "Retail Price (MRP / खुद्रा)",
    shortLabel: "Retail (MRP)",
    aliases: [
      "mrp", "m.r.p", "m.r.p.", "retail", "retail price", "retail_price",
      "retailprice", "sell price", "selling price", "max retail",
      "khudra", "खुद्रा", "mrp rate", "listing price",
    ],
  },
  {
    key: "ratePerPiece",
    label: "Rate",
    shortLabel: "Rate",
    aliases: [
      "rate", "rate rs", "rate per piece", "rate/pc", "दर",
      "dealer rate", "dealer price", "trade rate", "trade price",
      "cost", "cost price", "cost_price", "purchase", "purchase price",
      "purchase rate", "buying price", "landing", "landing cost",
      "kharid", "खरिद", "net rate", "net cost",
    ],
  },
  {
    key: "sku",
    label: "SKU / Item Code",
    shortLabel: "SKU",
    aliases: [
      "sku", "item code", "item_code", "itemcode", "art no", "art. no",
      "article no", "model", "model no", "product code", "code", "part no",
      "mrp code", "mrp_code", "serial",
    ],
  },
  {
    key: "barcode",
    label: "Barcode",
    shortLabel: "Barcode",
    aliases: ["barcode", "bar code", "ean", "upc", "gtin", "isbn"],
  },
  {
    key: "brand",
    label: "Brand / Company",
    shortLabel: "Brand",
    aliases: ["brand", "company", "mfg", "manufacturer", "make", "brand name", "supplier"],
  },
  {
    key: "category",
    label: "Category",
    shortLabel: "Category",
    aliases: ["category", "cat", "group", "category group", "department", "dept", "class", "section"],
  },
  {
    key: "variant",
    label: "Variant / Size / Spec",
    shortLabel: "Variant",
    aliases: ["variant", "size", "dimension", "spec", "specification", "color", "model variant", "grade"],
  },
  {
    key: "saleUnit",
    label: "Sale Unit (Pcs, Box, etc.)",
    shortLabel: "Sale Unit",
    aliases: ["sale unit", "sale_unit", "saleunit", "unit", "uom", "unit of measure", "एकाई"],
  },
  {
    key: "packageQuantity",
    label: "Pack / Case Quantity",
    shortLabel: "Pack Qty",
    aliases: ["pack qty", "pack_qty", "package qty", "package quantity", "pack quantity", "case qty", "box qty", "ctn", "carton qty", "inner", "pack"],
  },
  {
    key: "stock",
    label: "Opening Stock",
    shortLabel: "Stock",
    aliases: ["stock", "opening stock", "stock qty", "quantity", "qty", "balance", "on hand", "available qty"],
  },
];

export function toColumnLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._\-\/\\,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function autoDetectFieldKey(
  header: string,
  alreadyMatchedKeys: Set<string>,
): string | undefined {
  if (!header || !header.trim()) return undefined;
  const normalized = normalizeHeader(header);

  // exact alias match
  for (const field of CANONICAL_IMPORT_FIELDS) {
    if (alreadyMatchedKeys.has(field.key)) continue;
    for (const alias of field.aliases) {
      if (normalized === alias) {
        return field.key;
      }
    }
  }

  // token match
  const words = normalized.split(" ");
  for (const field of CANONICAL_IMPORT_FIELDS) {
    if (alreadyMatchedKeys.has(field.key)) continue;
    for (const alias of field.aliases) {
      if (words.includes(alias) || normalized.includes(alias)) {
        return field.key;
      }
    }
  }

  return undefined;
}

// Simple CSV tokenizer that handles commas, semicolons, tabs, and quotes
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let insideQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (insideQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === delimiter && !insideQuote) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function detectCsvDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 5).filter(Boolean);
  if (!firstLines.length) return ",";

  const counts = { ",": 0, ";": 0, "\t": 0 };
  firstLines.forEach((line) => {
    counts[","] += (line.match(/,/g) || []).length;
    counts[";"] += (line.match(/;/g) || []).length;
    counts["\t"] += (line.match(/\t/g) || []).length;
  });

  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

export async function extractSpreadsheetPreview(
  file: File,
): Promise<SpreadsheetPreviewResult | null> {
  const isExcel =
    file.name.endsWith(".xlsx") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  try {
    if (isExcel) {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const buffer = await file.arrayBuffer();
      await workbook.xlsx.load(buffer);

      const worksheet = workbook.worksheets[0];
      if (!worksheet) return null;

      // Find first row with at least 2 non-empty text cells (avoids banner titles in row 1)
      let headerRowIndex = 1;
      const maxScan = Math.min(10, worksheet.rowCount);
      for (let r = 1; r <= maxScan; r++) {
        const row = worksheet.getRow(r);
        const nonEmp = (Array.isArray(row.values) ? row.values : [])
          .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
        if (nonEmp.length >= 2) {
          headerRowIndex = r;
          break;
        }
      }

      const headerRow = worksheet.getRow(headerRowIndex);
      const sampleRow = worksheet.getRow(headerRowIndex + 1);

      const columns: DetectedSpreadsheetColumn[] = [];
      const matchedKeys = new Set<string>();

      // Extract cells
      const colCount = Math.min(worksheet.columnCount, 30);
      for (let c = 1; c <= colCount; c++) {
        const headerCell = headerRow.getCell(c).value;
        const sampleCell = sampleRow.getCell(c).value;

        const headerText =
          headerCell !== null && headerCell !== undefined
            ? typeof headerCell === "object" && "text" in (headerCell as any)
              ? String((headerCell as any).text || "").trim()
              : String(headerCell).trim()
            : "";

        const sampleText =
          sampleCell !== null && sampleCell !== undefined
            ? typeof sampleCell === "object" && "text" in (sampleCell as any)
              ? String((sampleCell as any).text || "").trim()
              : String(sampleCell).trim()
            : "";

        if (headerText || sampleText) {
          const autoKey = autoDetectFieldKey(headerText, matchedKeys);
          if (autoKey) matchedKeys.add(autoKey);

          columns.push({
            index: c - 1,
            colLetter: toColumnLetter(c - 1),
            header: headerText || `Column ${toColumnLetter(c - 1)}`,
            sampleValue: sampleText,
            autoMatchedField: autoKey,
          });
        }
      }

      return {
        sheetName: worksheet.name,
        totalColumns: columns.length,
        columns,
      };
    } else {
      // CSV or plain text
      const slice = file.slice(0, 100000); // 100KB is plenty for the first few rows
      const text = await slice.text();
      const delimiter = detectCsvDelimiter(text);
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      if (!lines.length) return null;

      // Find candidate header row
      let headerRowIndex = 0;
      for (let i = 0; i < Math.min(10, lines.length); i++) {
        const parsed = parseCsvLine(lines[i], delimiter).filter(Boolean);
        if (parsed.length >= 2) {
          headerRowIndex = i;
          break;
        }
      }

      const headers = parseCsvLine(lines[headerRowIndex], delimiter);
      const sample = lines[headerRowIndex + 1]
        ? parseCsvLine(lines[headerRowIndex + 1], delimiter)
        : [];

      const columns: DetectedSpreadsheetColumn[] = [];
      const matchedKeys = new Set<string>();

      headers.forEach((header, index) => {
        const headerText = header.trim();
        const sampleText = (sample[index] || "").trim();

        if (headerText || sampleText) {
          const autoKey = autoDetectFieldKey(headerText, matchedKeys);
          if (autoKey) matchedKeys.add(autoKey);

          columns.push({
            index,
            colLetter: toColumnLetter(index),
            header: headerText || `Column ${toColumnLetter(index)}`,
            sampleValue: sampleText,
            autoMatchedField: autoKey,
          });
        }
      });

      return {
        totalColumns: columns.length,
        columns,
      };
    }
  } catch (error) {
    console.warn("Failed to extract spreadsheet preview:", error);
    return null;
  }
}
