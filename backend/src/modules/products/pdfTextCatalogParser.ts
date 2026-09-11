import type { PdfTextLineRegion } from "./pdfTextLocations";

export type PdfTextCatalogPage = {
  pageNumber: number;
  text: string;
  lines?: PdfTextLineRegion[];
  // Continuation pages often omit the table header. The worker supplies the
  // first detected header so those pages can still use deterministic parsing.
  headerContext?: string;
  headerLine?: PdfTextLineRegion;
};

export type ExtractedPriceCandidate = {
  key: string;
  label: string;
  value: number;
};

export type ParsedPdfTextCatalogRow = {
  pageNumber: number;
  lineNumber: number;
  rawText: string;
  productName: string;
  productCodeVariant: string;
  category: string;
  packageQuantity: number | null;
  packageUnit: string;
  extractedPrices: ExtractedPriceCandidate[];
  region?: PdfTextLineRegion["region"];
  warnings?: string[];
};

export type ParsedPdfTextCatalog = {
  rows: ParsedPdfTextCatalogRow[];
  priceColumns: Array<{ key: string; label: string }>;
};

const UNIT_ALIASES: Record<string, string> = {
  pc: "PIECE",
  pcs: "PIECE",
  piece: "PIECE",
  pieces: "PIECE",
  no: "PIECE",
  nos: "PIECE",
  pkt: "PACK",
  pkts: "PACK",
  pack: "PACK",
  packet: "PACK",
  box: "BOX",
  set: "SET",
  sets: "SET",
  kg: "KG",
  g: "GRAM",
  gm: "GRAM",
  l: "LITER",
  ltr: "LITER",
  ltrs: "LITER",
  ml: "ML",
};

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function unitKey(value: string) {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function parsedNumber(value: string) {
  const normalized = value.replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966)).replace(/,/g, "").replace(/^(?:rs\.?|npr)\s*/i, "").trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

type Column = { kind: "name" | "code" | "unit" | "packing" | "price" | "ignore"; label: string; left?: number; right?: number };

function columnKind(label: string): Column["kind"] {
  const text = compact(label).toLowerCase();
  if (/\b(?:packing|pack(?:age)?\s*(?:qty|quantity)?|pkg|case\s*qty)\b/.test(text) && !/price|rate|mrp|wsp/.test(text)) return "packing";
  if (/\b(?:rate|price|wsp|mrp)\b/.test(text)) return "price";
  if (/\b(?:name|description|particulars|product|jar|item)\b/.test(text) && !/code/.test(text)) return "name";
  if (/\bcode\b/.test(text)) return "code";
  if (/^(?:unit|uom)$/i.test(text)) return "unit";
  return "ignore";
}

function priceLabel(label: string) {
  const labels = detectPriceLabels([{ pageNumber: 1, text: label }]);
  return labels[0] || compact(label);
}

// Retain cell boundaries from the header. Never infer packing from number count.
function structuredCells(page: PdfTextCatalogPage): Array<{ text: string; columns: Column[] | null; cells: string[]; region?: PdfTextLineRegion["region"] }> {
  const located = page.lines || [];
  const headerChunks = page.headerLine?.items?.reduce<Array<{ text: string; left: number; right: number }>>((chunks, item) => {
    const last = chunks[chunks.length - 1];
    if (last && item.left - last.right < 9) { last.text += ` ${item.text}`; last.right = item.right; }
    else chunks.push({ ...item });
    return chunks;
  }, []) || [];
  let geometryColumns: Column[] | null = headerChunks.length
    ? headerChunks.map((chunk) => ({ ...chunk, label: chunk.text, kind: columnKind(chunk.text) }))
    : null;
  if (geometryColumns && (!geometryColumns.some((column) => column.kind === "name") || !geometryColumns.some((column) => column.kind === "price"))) {
    geometryColumns = null;
  }
  const output: Array<{ text: string; columns: Column[] | null; cells: string[]; region?: PdfTextLineRegion["region"] }> = [];
  for (const line of located) {
    if (!line.items?.length) continue;
    const chunks: Array<{ text: string; left: number; right: number }> = [];
    for (const item of line.items) {
      const last = chunks[chunks.length - 1];
      if (last && item.left - last.right < 9) { last.text += ` ${item.text}`; last.right = item.right; }
      else chunks.push({ ...item });
    }
    const candidate = chunks.map((chunk) => ({ ...chunk, label: chunk.text, kind: columnKind(chunk.text) }));
    if (candidate.some((column) => column.kind === "name") && candidate.some((column) => column.kind === "price") && candidate.filter((column) => column.kind !== "ignore").length >= 2) {
      // Separate side-by-side tables need layout OCR; merging them loses products.
      if (candidate.filter((column) => column.kind === "name").length > 1) return [];
      geometryColumns = candidate;
      output.push({ text: line.text, columns: null, cells: [], region: line.region });
      continue;
    }
    if (!geometryColumns) { output.push({ text: line.text, columns: null, cells: [], region: line.region }); continue; }
    const cells = geometryColumns.map(() => "");
    for (const item of line.items) {
      const center = (item.left + item.right) / 2;
      let index = geometryColumns.findIndex((column, i) => i + 1 === geometryColumns!.length || center < (column.right! + geometryColumns![i + 1].left!) / 2);
      if (index < 0) index = cells.length - 1;
      cells[index] = compact(`${cells[index]} ${item.text}`);
    }
    output.push({ text: line.text, columns: geometryColumns, cells, region: line.region });
  }
  if (geometryColumns) return output;
  let columns: Column[] | null = page.headerContext
    ? page.headerContext.split("\t").map(compact).map((label) => ({ label, kind: columnKind(label) }))
    : null;
  if (columns && (!columns.some((column) => column.kind === "name") || !columns.some((column) => column.kind === "price"))) columns = null;
  return page.text.split(/\r?\n/).map((text) => {
    const cells = text.split("\t").map(compact);
    const candidate = cells.map((label) => ({ label, kind: columnKind(label) }));
    if (candidate.some((column) => column.kind === "name") && candidate.some((column) => column.kind === "price") && cells.length > 1
        && !cells.some((cell) => /packing\s+(?:wholesale|wsp|mrp)|packing\s+wsp\s+mrp/i.test(cell))) {
      columns = candidate;
      if (candidate.filter((column) => column.kind === "name").length > 1) columns = null;
      return { text, columns: null, cells: [] };
    }
    return { text, columns, cells };
  });
}

function priceKey(label: string, index: number) {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) || [];
  const slug = words.length > 0
    ? words[0] + words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join("")
    : "";
  return slug || `price${index + 1}`;
}

function detectPriceLabels(pages: PdfTextCatalogPage[]) {
  const headerText = pages
    .flatMap((page) => page.text.split(/\r?\n/).slice(0, 12))
    .join(" ");
  const candidates: Array<{ index: number; label: string }> = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bpurchase\s+(?:rate|price|cost)\b/gi, "Rate"],
    [/\bsupplier\s+(?:rate|price)\b/gi, "Supplier rate"],
    [/\bwholesale\s+(?:rate|price)\b/gi, "Wholesale rate"],
    [/\bWSP\b/g, "WSP"],
    [/\bretail\s+(?:rate|price)\b/gi, "Retail price"],
    [/\bselling\s+price\b/gi, "Selling price"],
    [/\bMRP\b/g, "MRP"],
  ];
  for (const [pattern, label] of patterns) {
    for (const match of headerText.matchAll(pattern)) {
      candidates.push({ index: match.index || 0, label });
    }
  }
  if (candidates.length === 0) {
    const generic = headerText.match(/\b(rate|price)\s*(?:rs\.?|npr)?\b/i);
    if (generic) candidates.push({ index: generic.index || 0, label: generic[1].toLowerCase() === "rate" ? "Rate" : "Price" });
  }
  return candidates
    .sort((a, b) => a.index - b.index)
    .filter((candidate, index, all) =>
      all.findIndex((other) => other.label.toLowerCase() === candidate.label.toLowerCase()) === index,
    )
    .map((candidate) => candidate.label);
}

function hasSerialCodePriceTable(pages: PdfTextCatalogPage[]) {
  return pages.some((page) => [page.headerContext || "", ...page.text.split(/\r?\n/).slice(0, 12)].some((line) => {
    const header = compact(line).toLowerCase();
    return /\b(?:s\.?\s*n\.?|serial)\b/.test(header)
      && /\b(?:product|jar)\s*(?:name)?\b/.test(header)
      && /\b(?:product\s*)?code\b/.test(header)
      && /\b(?:rate|price)\b/.test(header);
  }));
}

function parseSerialCodePriceLine(line: string) {
  const normalized = compact(line);
  const serialMatch = normalized.match(/^(\d+)\s+(.+)$/);
  if (!serialMatch) return null;
  const serial = serialMatch[1];
  const remainder = serialMatch[2];
  const priceMatch = remainder.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
  if (!priceMatch) return null;
  let nameAndCode = compact(priceMatch[1]);
  const price = Number(priceMatch[2]);
  if (!nameAndCode || !Number.isFinite(price)) return null;

  let productCodeVariant = "";
  const codeMatch = nameAndCode.match(/^(.*?)\s+(\d+)$/);
  if (codeMatch && compact(codeMatch[1])) {
    nameAndCode = compact(codeMatch[1]);
    productCodeVariant = codeMatch[2];
  }
  if (!nameAndCode || /^\d+$/.test(nameAndCode)) return null;
  return { serial, productName: nameAndCode, productCodeVariant, price };
}

function categoryFromLine(line: string) {
  if (line.includes("\t")) return "";
  const match = compact(line).match(/^\d{1,3}[.)\s-]+(.+)$/);
  if (!match) return "";
  return compact(match[1]).replace(/["']/g, "");
}

function isNonProductLine(line: string) {
  const normalized = compact(line).toLowerCase();
  return !normalized
    || /^(price\s*list|rate\s*list)$/i.test(normalized)
    || /^(s\.?\s*no\.?|serial\s+no\.?).*product.*(?:unit|rate|price)/i.test(normalized)
    || /(?:industries|suppliers?|traders?|distributors?|pvt\.?\s*ltd\.?|private\s+limited)$/i.test(normalized)
    || /^\((?:w\.?e\.?f|effective|note)/i.test(normalized)
    || /^note\s*:/i.test(normalized);
}

export function parsePdfTextCatalogPages(
  pages: PdfTextCatalogPage[],
): ParsedPdfTextCatalog {
  const detectedLabels = detectPriceLabels(pages);
  const serialCodePriceTable = hasSerialCodePriceTable(pages);
  const rows: ParsedPdfTextCatalogRow[] = [];
  let currentCategory = "Uncategorized";
  let maximumPriceCount = 0;
  const allPriceColumns = new Map<string, { key: string; label: string }>();

  for (const page of pages) {
    const inputs = structuredCells(page);
    const lines = inputs.map((line) => line.text);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const original = lines[lineIndex];
      const rawText = compact(original);
      if (isNonProductLine(original)) continue;

      const mapped = inputs[lineIndex];
      if (mapped.columns && mapped.cells.length > 1) {
        const nameIndex = mapped.columns.findIndex((column) => column.kind === "name");
        const productName = compact(mapped.cells[nameIndex] || "").replace(/^\([a-z]\)\s*/i, "");
        if (productName && !/^\d+$/.test(productName) && !/^(?:total|note|remarks)\b/i.test(productName)) {
          const warnings: string[] = [];
          const extractedPrices: ExtractedPriceCandidate[] = [];
          let packageQuantity: number | null = null;
          let packageUnit = "PIECE";
          let productCodeVariant = "";
          mapped.columns.forEach((column, index) => {
            const cell = mapped.cells[index] || "";
            if (column.kind === "code") productCodeVariant = cell;
            if (column.kind === "unit") packageUnit = UNIT_ALIASES[unitKey(cell)] || "PIECE";
            if (column.kind === "packing") packageQuantity = parsedNumber(cell);
            if (column.kind === "price") {
              const label = priceLabel(column.label);
              const key = priceKey(label, index);
              allPriceColumns.set(key, { key, label });
              const value = parsedNumber(cell);
              if (value !== null) extractedPrices.push({ key, label, value });
              else if (cell && !/coming soon|tba|n\/?a|^[-–—]$/i.test(cell)) warnings.push(`${label}: could not read "${cell}". Check the source.`);
              if (/\b(?:dozen|pack|box|set|case|carton)\b|\/\s*(?:doz|pkt|box)/i.test(column.label)) warnings.push(`${column.label}: confirm the price basis before using a per-piece rate.`);
            }
          });
          if (!extractedPrices.length) warnings.push("No price captured. Check whether the supplier left it unannounced or extraction missed it.");
          if (mapped.cells.every((cell, index) => index === nameIndex || !cell)) warnings.push("This may be a heading or part of a wrapped product name. Check the source before creating a product.");
          rows.push({ pageNumber: page.pageNumber, lineNumber: lineIndex + 1, rawText, productName, productCodeVariant, category: currentCategory, packageQuantity, packageUnit, extractedPrices, ...("region" in mapped && mapped.region ? { region: mapped.region } : {}), ...(warnings.length ? { warnings } : {}) });
          continue;
        }
      }

      if (serialCodePriceTable) {
        const tableRow = parseSerialCodePriceLine(original);
        if (tableRow) {
          const label = detectedLabels[0] || "Extracted price 1";
          maximumPriceCount = Math.max(maximumPriceCount, 1);
          rows.push({
            pageNumber: Math.max(1, Number(page.pageNumber || 1)),
            lineNumber: lineIndex + 1,
            rawText,
            productName: tableRow.productName,
            productCodeVariant: tableRow.productCodeVariant,
            category: currentCategory,
            packageQuantity: null,
            packageUnit: "PIECE",
            extractedPrices: [{ key: priceKey(label, 0), label, value: tableRow.price }],
          });
          continue;
        }
      }

      const category = categoryFromLine(original);
      if (category) {
        currentCategory = category;
        continue;
      }

      const cells = original.split(/\t/).map(compact);
      const unitIndex = cells.findIndex((cell) => Boolean(UNIT_ALIASES[unitKey(cell)]));
      if (unitIndex <= 0) continue;

      const numericAfterUnit = cells
        .slice(unitIndex + 1)
        .map((cell, offset) => ({ cellIndex: unitIndex + 1 + offset, value: parsedNumber(cell) }))
        .filter((item): item is { cellIndex: number; value: number } => item.value !== null);
      const hasPackingColumn = /\b(?:packing|pack(?:age)?\s*(?:qty|quantity)|pkg)\b/i.test(page.text.split(/\r?\n/).slice(0, 12).join(" "));
      const packageQuantity = hasPackingColumn && numericAfterUnit[0]?.cellIndex === unitIndex + 1 ? numericAfterUnit[0].value : null;
      const priceValues = packageQuantity !== null
        ? numericAfterUnit.slice(1).map((item) => item.value)
        : numericAfterUnit.map((item) => item.value);
      maximumPriceCount = Math.max(maximumPriceCount, priceValues.length);

      const productName = compact(
        cells
          .slice(0, unitIndex)
          .join(" ")
          .replace(/^\([a-z]\)\s*/i, ""),
      );
      if (!productName || /^\d+$/.test(productName)) continue;

      rows.push({
        pageNumber: Math.max(1, Number(page.pageNumber || 1)),
        lineNumber: lineIndex + 1,
        rawText,
        productName,
        productCodeVariant: "",
        category: currentCategory,
        packageQuantity,
        packageUnit: UNIT_ALIASES[unitKey(cells[unitIndex])] || "PIECE",
        ...(!priceValues.length ? { warnings: ["No price captured. Check the source before marking this product as coming soon."] } : {}),
        extractedPrices: priceValues.map((value, priceIndex) => {
          const label = detectedLabels[priceIndex] || `Extracted price ${priceIndex + 1}`;
          return { key: priceKey(label, priceIndex), label, value };
        }),
      });
    }
  }

  const priceColumns = Array.from({ length: maximumPriceCount }, (_unused, index) => {
    const label = detectedLabels[index] || `Extracted price ${index + 1}`;
    return { key: priceKey(label, index), label };
  });
  for (const column of priceColumns) allPriceColumns.set(column.key, column);
  return { rows, priceColumns: [...allPriceColumns.values()] };
}
