export type PdfTextCatalogPage = {
  pageNumber: number;
  text: string;
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
  const normalized = value.replace(/,/g, "").replace(/^(?:rs\.?|npr)\s*/i, "").trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
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
    [/\bpurchase\s+(?:rate|price|cost)\b/gi, "Purchase rate"],
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
  return pages.some((page) => page.text.split(/\r?\n/).slice(0, 12).some((line) => {
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

  for (const page of pages) {
    const lines = String(page.text || "").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const original = lines[lineIndex];
      const rawText = compact(original);
      if (isNonProductLine(original)) continue;

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

      const cells = original.split(/\t+/).map(compact).filter(Boolean);
      const unitIndex = cells.findIndex((cell) => Boolean(UNIT_ALIASES[unitKey(cell)]));
      if (unitIndex <= 0) continue;

      const numericAfterUnit = cells
        .slice(unitIndex + 1)
        .map((cell, offset) => ({ cellIndex: unitIndex + 1 + offset, value: parsedNumber(cell) }))
        .filter((item): item is { cellIndex: number; value: number } => item.value !== null);
      if (numericAfterUnit.length === 0) continue;

      const packageQuantity = numericAfterUnit.length >= 2 ? numericAfterUnit[0].value : null;
      const priceValues = numericAfterUnit.length >= 2
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
  return { rows, priceColumns };
}
