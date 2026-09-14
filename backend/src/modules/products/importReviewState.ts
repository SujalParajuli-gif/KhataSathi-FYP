// Source evidence, import setup, and product corrections have separate meanings.
export function reviewObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

const reviewFields: Record<string, string> = {
  name: "Product name", sku: "SKU", barcode: "Barcode", brand: "Brand",
  category: "Category", categoryGroup: "Category group", vendorSource: "Supplier",
  productCodeVariant: "Product code", sizeValue: "Size", sizeUnit: "Size unit",
  packageQuantity: "Package quantity", packageUnit: "Package unit", saleUnit: "Sale unit",
  ratePerPiece: "Rate", retailPrice: "Retail price", wholesalePrice: "Wholesale price",
  availabilityStatus: "Availability", allowFractionalQty: "Fractional quantity",
  quantityStep: "Quantity step", wholesaleEligible: "Wholesale eligibility",
  searchAliases: "Search terms", sourceCitation: "Source reference",
};
const numericFields = new Set(["sizeValue", "packageQuantity", "ratePerPiece", "retailPrice", "wholesalePrice", "quantityStep"]);
function normalizedField(row: Record<string, any>, key: string): unknown {
  let value = key === "name" ? row.name ?? row.productName : row[key];
  if (key === "allowFractionalQty") return value === true;
  if (key === "wholesaleEligible") return value !== false;
  if (key === "quantityStep") value ??= 1;
  if (key === "sizeUnit") value ||= "STANDARD";
  if (key === "packageUnit" || key === "saleUnit") value ||= "PIECE";
  if (key === "categoryGroup") value ||= row.category;
  if (key === "searchAliases") return [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
  if (value === undefined || value === null || value === "") return null;
  if (numericFields.has(key)) return Number(value);
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

export function importReviewChanges(parsedValue: unknown, extractedValue: unknown): string[] {
  const parsed = reviewObject(parsedValue), extracted = reviewObject(extractedValue);
  if (!Object.keys(extracted).length) return [];
  const baseline = { ...extracted, ...reviewObject(parsed.reviewSetupBaseline) };
  return Object.entries(reviewFields).filter(([key]) => {
    // Supplying an identity that extraction could not read is import setup.
    if (key === "brand" && !normalizedField(extracted, key) && !Object.prototype.hasOwnProperty.call(reviewObject(parsed.reviewSetupBaseline), key)) return false;
    if (key === "availabilityStatus" && ["PDF_TEXT_TABLE_ROW", "PDF_SCANNED_AI_ROW", "IMAGE_AI_ROW"].includes(String(parsed.sourceType)) && parsed.availabilityStatus === "COMING_SOON" && ![parsed.ratePerPiece, parsed.retailPrice, parsed.wholesalePrice].some(v => Number(v) > 0)) return false;
    // Legacy saves supplied the file reference when no source citation existed.
    if (key === "sourceCitation" && !normalizedField(extracted, key)) return false;
    return JSON.stringify(normalizedField(parsed, key)) !== JSON.stringify(normalizedField(baseline, key));
  }).map(([, label]) => label);
}

export function pendingImportWarnings(parsedValue: unknown): string[] {
  const p = reviewObject(parsedValue);
  const acknowledged = new Set(Array.isArray(p.reviewAcknowledgedWarnings) ? p.reviewAcknowledgedWarnings : []);
  return [...new Set<string>((Array.isArray(p.warnings) ? p.warnings : []).map(String))].filter(message => {
    if (acknowledged.has(message)) return false;
    if (/confirm.*brand/i.test(message) && String(p.brand || "").trim()) return false;
    if (/no price captured/i.test(message) && [p.ratePerPiece, p.retailPrice, p.wholesalePrice].some(v => Number(v) > 0)) return false;
    return true;
  });
}

export function mergeReviewedImportEvidence(storedValue: unknown, extractedValue: unknown, prepared: Record<string, any>, acknowledgeWarnings = false) {
  const stored = reviewObject(storedValue), extracted = reviewObject(extractedValue);
  const { rowId: _id, resolution: _resolution, acknowledgeWarnings: _ack, ...fields } = prepared;
  // Explicit nulls clear optional values; source prices, coordinates and warnings survive.
  const cleared = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === undefined ? null : v]));
  const result: Record<string, any> = {
    ...extracted, ...stored, ...cleared, name: prepared.name, productName: prepared.name,
    sourceType: "REVIEWED_ROW_DRAFT",
    skuWasGenerated: prepared.skuWasGenerated === true || (stored.skuWasGenerated === true && stored.sku === prepared.sku),
  };
  if (Object.keys(fields).some(key => key in reviewFields &&
      JSON.stringify(normalizedField(result, key)) !== JSON.stringify(normalizedField(stored, key)))) {
    result.reviewAcknowledgedWarnings = [];
  }
  if (!String(stored.brand || "").trim() && prepared.brand) {
    result.reviewSetupBaseline = { ...reviewObject(stored.reviewSetupBaseline), brand: prepared.brand };
  } else if (!String(extracted.brand || "").trim() && !Object.prototype.hasOwnProperty.call(reviewObject(stored.reviewSetupBaseline), "brand")) {
    // Legacy brand confirmation predates setup metadata. Preserve the saved
    // confirmed brand as baseline so subsequent corrections remain visible.
    result.reviewSetupBaseline = { ...reviewObject(stored.reviewSetupBaseline), brand: stored.brand };
  }
  if (!String(stored.sku || "").trim() && prepared.skuWasGenerated === true) {
    result.reviewSetupBaseline = { ...reviewObject(result.reviewSetupBaseline), sku: prepared.sku };
  }
  // Saving a system-derived availability value must not turn it into an edit.
  if (["PDF_TEXT_TABLE_ROW", "PDF_SCANNED_AI_ROW", "IMAGE_AI_ROW"].includes(String(stored.sourceType)) && stored.availabilityStatus === prepared.availabilityStatus) {
    result.reviewSetupBaseline = { ...reviewObject(result.reviewSetupBaseline), availabilityStatus: prepared.availabilityStatus };
  }
  if (acknowledgeWarnings) result.reviewAcknowledgedWarnings = [...new Set([
    ...(Array.isArray(result.reviewAcknowledgedWarnings) ? result.reviewAcknowledgedWarnings : []),
    ...pendingImportWarnings(result),
  ])];
  return result;
}

export type ImportReviewIssue = { field: string | null; message: string; severity: "error" | "warning" };
export function importReviewIssues(row: { parsed?: unknown; comparisonStatus?: string; error?: string | null; resolution?: string | null; changeSet?: unknown }) {
  if (row.resolution === "IGNORE") return [] as ImportReviewIssue[];
  const p = reviewObject(row.parsed);
  const issues: ImportReviewIssue[] = [];
  if (!String(p.name || p.productName || "").trim()) issues.push({ field: "name", message: "Enter the product name from the source.", severity: "error" });
  if (!String(p.brand || "").trim()) issues.push({ field: "brand", message: "Confirm the brand to check this product against the catalog.", severity: "error" });
  const fieldFor = (message: string) => /barcode/i.test(message) ? "barcode" : /sku/i.test(message) ? "sku" : /product.?code/i.test(message) ? "productCodeVariant" : /brand/i.test(message) ? "brand" : /name/i.test(message) ? "name" : /category/i.test(message) ? "category" : /size.?unit/i.test(message) ? "sizeUnit" : /size/i.test(message) ? "sizeValue" : /pack/i.test(message) ? "packageQuantity" : /sale.?unit/i.test(message) ? "saleUnit" : /retail/i.test(message) ? "retailPrice" : /wholesale/i.test(message) ? "wholesalePrice" : /price|rate|wsp|mrp/i.test(message) ? "ratePerPiece" : null;
  for (const message of pendingImportWarnings(p)) {
    if (/confirm.*brand/i.test(message)) continue;
    const uncertain = /unreadable fields/i.test(message) && Array.isArray(p.uncertainFields) ? p.uncertainFields : [];
    if (uncertain.length) for (const field of uncertain) issues.push({ field: fieldFor(String(field)), message: `Verify ${field} against the source.`, severity: "warning" });
    else issues.push({ field: fieldFor(message), message, severity: "warning" });
  }
  if (row.comparisonStatus === "IDENTIFIER_CONFLICT" && row.error) {
    const fields = [ /barcode/i.test(row.error) ? "barcode" : null, /sku/i.test(row.error) ? "sku" : null, /product.?code/i.test(row.error) ? "productCodeVariant" : null, /size/i.test(row.error) ? "sizeValue" : null,
      /ratePerPiece/i.test(row.error) ? "ratePerPiece" : null, /retailPrice/i.test(row.error) ? "retailPrice" : null,
      /wholesalePrice/i.test(row.error) ? "wholesalePrice" : null, /packageQuantity/i.test(row.error) ? "packageQuantity" : null,
    ].filter(Boolean) as string[];
    for (const field of fields.length ? fields : ["name", "brand"]) issues.push({ field, message: row.error, severity: "error" });
  } else if (row.error && issues.length === 0 && row.comparisonStatus !== "MATCHED_WITH_CHANGES") issues.push({ field: fieldFor(row.error), message: row.error, severity: "warning" });
  if (row.comparisonStatus === "MATCHED_WITH_CHANGES" && !row.resolution && Array.isArray(row.changeSet)) {
    for (const change of row.changeSet) {
      const field = fieldFor(String(change.field));
      if (field) issues.push({ field, message: `Catalog: ${change.currentValue ?? "not entered"}; incoming: ${change.incomingValue ?? "not entered"}. Choose which values to keep above.`, severity: "warning" });
    }
  }
  return issues;
}
