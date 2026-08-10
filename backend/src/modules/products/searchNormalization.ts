/**
 * Increment this whenever normalization output changes. Persisted search
 * documents can use the version to decide whether they must be rebuilt.
 */
import {
  canonicalizeAttachedProductSearchUnit,
  canonicalizeProductSearchUnits,
} from "./searchUnitNormalization";

export const PRODUCT_SEARCH_TOKEN_NORMALIZER_VERSION = 1 as const;
export const PRODUCT_SEARCH_NORMALIZER_VERSION = 2 as const;

export type ProductSearchDocumentSource = {
  name: string;
  productName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  productCodeVariant?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  packageQuantity?: number | null;
  packageUnit?: string | null;
  saleUnit?: string | null;
  brand?: string | null;
  category?: string | null;
  categoryGroup?: string | null;
  vendorSource?: string | null;
  aliases?: readonly string[];
};

const DEVANAGARI_ZERO = 0x0966;
const DEVANAGARI_NINE = 0x096f;

// These forms are used only to find an unambiguous boundary in strings such
// as "12lit". Canonical unit aliases belong to the separate unit-normalizing
// phase; this list does not translate or otherwise equate the unit forms.
const SAFE_ATTACHED_UNIT_FORMS = [
  "millilitres?",
  "milliliters?",
  "kilograms?",
  "centimetres?",
  "centimeters?",
  "millimetres?",
  "millimeters?",
  "litres?",
  "liters?",
  "metres?",
  "meters?",
  "pieces?",
  "ltrs?",
  "lit",
  "ml",
  "kgs?",
  "grams?",
  "gms?",
  "pcs?",
  "cm",
  "mm",
  "लिटर",
  "मिलिलिटर",
  "किलो",
  "किलोग्राम",
  "ग्राम",
  "वटा",
  "गोटा",
  "मिटर",
  "सेन्टिमिटर",
  "मिलिमिटर",
  "इन्च",
  "दर्जन",
  "बन्डल",
  "बक्स",
  "in",
  "l",
  "g",
  "m",
] as const;

const ATTACHED_NUMBER_UNIT = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}])(\\d+(?:\\.\\d+)?)(${SAFE_ATTACHED_UNIT_FORMS.join("|")})(?![\\p{L}\\p{M}\\p{N}])`,
  "giu",
);

const LETTER_NUMBER_OR_MARK = /[\p{L}\p{N}\p{M}]/u;
const ASCII_DIGIT = /[0-9]/;
const SEARCH_INVISIBLE_FORMATS = /[\u200B-\u200D\u2060\uFEFF]/gu;

function convertDevanagariDigits(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint >= DEVANAGARI_ZERO &&
      codePoint <= DEVANAGARI_NINE
    ) {
      return String(codePoint - DEVANAGARI_ZERO);
    }
    return character;
  }).join("");
}

function normalizeSearchSeparators(value: string) {
  const characters = Array.from(value);
  return characters
    .map((character, index) => {
      if (LETTER_NUMBER_OR_MARK.test(character)) return character;

      // A period between digits is part of a decimal size or code value. All
      // other punctuation and symbols form searchable token boundaries.
      if (
        character === "." &&
        ASCII_DIGIT.test(characters[index - 1] || "") &&
        ASCII_DIGIT.test(characters[index + 1] || "")
      ) {
        return character;
      }
      return " ";
    })
    .join("");
}

/**
 * Locale-independent, deterministic product-search normalization.
 *
 * No stop words are removed: short words, numbers, and code fragments can be
 * business-significant in a shop catalog. Unit equivalence, aliases, typo
 * tolerance, and ranking intentionally live in later, reviewable stages.
 */
export function normalizeProductSearchText(input: string): string {
  const unicodeNormalized = String(input || "")
    .normalize("NFKC")
    .replace(SEARCH_INVISIBLE_FORMATS, "")
    .toLowerCase();
  const digitNormalized = convertDevanagariDigits(unicodeNormalized);
  const numberUnitSplit = digitNormalized.replace(
    ATTACHED_NUMBER_UNIT,
    (_match, quantity: string, unit: string) =>
      `${quantity} ${canonicalizeAttachedProductSearchUnit(unit)}`,
  );

  return normalizeSearchSeparators(numberUnitSplit)
    .trim()
    .replace(/\s+/gu, " ");
}

/** Normalize an incoming query through the same implementation as indexing. */
export function normalizeProductSearchQuery(query: string): string {
  return canonicalizeProductSearchUnits(normalizeProductSearchText(query));
}

/**
 * Build the normalized text that a later indexed-search phase can persist.
 * Field order is fixed so rebuilding the same product is stable.
 */
export function buildProductSearchDocument(
  source: ProductSearchDocumentSource,
): string {
  const size =
    Number.isFinite(source.sizeValue) && Number(source.sizeValue) > 0 && source.sizeUnit
      ? `${source.sizeValue} ${source.sizeUnit}`
      : "";
  const packageSize =
    Number.isFinite(source.packageQuantity) &&
    Number(source.packageQuantity) > 0 &&
    source.packageUnit
      ? `${source.packageQuantity} ${source.packageUnit}`
      : "";

  return canonicalizeProductSearchUnits(normalizeProductSearchText(
    [
      source.name,
      source.productName,
      source.sku,
      source.barcode,
      source.productCodeVariant,
      size,
      packageSize,
      source.saleUnit,
      source.brand,
      source.category,
      source.categoryGroup,
      source.vendorSource,
      ...(source.aliases || []),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  ));
}

export function tokenizeNormalizedProductSearchText(
  normalizedText: string,
): string[] {
  const normalized = normalizeProductSearchText(normalizedText);
  return normalized ? normalized.split(" ") : [];
}
