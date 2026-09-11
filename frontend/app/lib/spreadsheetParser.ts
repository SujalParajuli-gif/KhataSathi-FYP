// The backend owns sheet/header parsing; the browser only suggests field mappings.
import api from "~/lib/api/client";

export type DetectedSpreadsheetColumn = {
  index: number;
  colLetter: string;
  header: string;
  sampleValue: string;
  autoMatchedField?: string;
};

export type SpreadsheetPreviewResult = {
  sheetName?: string;
  sheets: string[];
  headerRowNumber: number;
  headerConfidence?: "HIGH" | "LOW";
  totalRows: number;
  warnings: string[];
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

export async function extractSpreadsheetPreview(
  file: File,
  options?: { sheetName?: string; headerRowNumber?: number; signal?: AbortSignal },
): Promise<SpreadsheetPreviewResult> {
  const form = new FormData();
  form.append("file", file);
  if (options?.sheetName) form.append("sheetName", options.sheetName);
  if (options?.headerRowNumber) form.append("headerRowNumber", String(options.headerRowNumber));
  const { data } = await api.post("/api/products/import-spreadsheet-preview", form, { signal: options?.signal, headers: { "Content-Type": undefined } });
  const matchedKeys = new Set<string>();
  const columns = (data.headers as string[]).map((header, index) => {
    const autoMatchedField = autoDetectFieldKey(header, matchedKeys);
    if (autoMatchedField) matchedKeys.add(autoMatchedField);
    return { index, colLetter: toColumnLetter(index), header, sampleValue: String(data.sample?.[header] ?? ""), autoMatchedField };
  });
  return { ...data, columns, totalColumns: columns.length };
}
