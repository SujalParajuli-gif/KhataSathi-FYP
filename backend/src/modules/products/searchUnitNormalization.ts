export const PRODUCT_SEARCH_UNIT_NORMALIZER_VERSION = 1 as const;

export type CanonicalProductSearchUnit =
  | "ltr"
  | "ml"
  | "kg"
  | "gram"
  | "piece"
  | "meter"
  | "cm"
  | "mm"
  | "inch"
  | "dozen"
  | "bundle"
  | "box";

export type ProductSearchUnitDefinition = {
  canonical: CanonicalProductSearchUnit;
  aliases: readonly string[];
  /** These aliases are units only when the preceding token is numeric. */
  numericContextAliases?: readonly string[];
  /** These aliases are safe only when attached to the numeric quantity. */
  attachedNumericAliases?: readonly string[];
};

/**
 * Explicit and reviewable aliases for units KhataSathi currently stores in
 * product size, sale-unit, or package-unit fields.
 */
export const PRODUCT_SEARCH_UNIT_DICTIONARY: readonly ProductSearchUnitDefinition[] = [
  {
    canonical: "ltr",
    aliases: ["ltr", "ltrs", "lit", "liter", "liters", "litre", "litres", "लिटर"],
    numericContextAliases: ["l"],
  },
  {
    canonical: "ml",
    aliases: ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "मिलिलिटर"],
  },
  {
    canonical: "kg",
    aliases: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms", "किलो", "किलोग्राम"],
  },
  {
    canonical: "gram",
    aliases: ["gram", "grams", "gm", "gms", "ग्राम"],
    numericContextAliases: ["g"],
  },
  {
    canonical: "piece",
    aliases: ["piece", "pieces", "pc", "pcs", "pce", "pces", "वटा", "गोटा"],
  },
  {
    canonical: "meter",
    aliases: ["meter", "meters", "metre", "metres", "mtr", "mtrs", "मिटर"],
    numericContextAliases: ["m"],
  },
  {
    canonical: "cm",
    aliases: ["cm", "cms", "centimeter", "centimeters", "centimetre", "centimetres", "सेन्टिमिटर"],
  },
  {
    canonical: "mm",
    aliases: ["mm", "mms", "millimeter", "millimeters", "millimetre", "millimetres", "मिलिमिटर"],
  },
  {
    canonical: "inch",
    aliases: ["inch", "inches", "इन्च"],
    attachedNumericAliases: ["in"],
  },
  {
    canonical: "dozen",
    aliases: ["dozen", "dozens", "dz", "dzn", "दर्जन"],
  },
  {
    canonical: "bundle",
    aliases: ["bundle", "bundles", "बन्डल"],
  },
  {
    canonical: "box",
    aliases: ["box", "boxes", "बक्स"],
  },
] as const;

const unambiguousAliases = new Map<string, CanonicalProductSearchUnit>();
const numericContextAliases = new Map<string, CanonicalProductSearchUnit>();
const attachedNumericAliases = new Map<string, CanonicalProductSearchUnit>();
const canonicalUnitTokens = new Set<CanonicalProductSearchUnit>();

for (const definition of PRODUCT_SEARCH_UNIT_DICTIONARY) {
  canonicalUnitTokens.add(definition.canonical);
  for (const alias of definition.aliases) {
    unambiguousAliases.set(alias, definition.canonical);
  }
  for (const alias of definition.numericContextAliases || []) {
    numericContextAliases.set(alias, definition.canonical);
  }
  for (const alias of definition.attachedNumericAliases || []) {
    attachedNumericAliases.set(alias, definition.canonical);
  }
}

export function isCanonicalProductSearchUnitToken(
  token: string,
): token is CanonicalProductSearchUnit {
  return canonicalUnitTokens.has(token as CanonicalProductSearchUnit);
}

export function canonicalizeAttachedProductSearchUnit(alias: string): string {
  return attachedNumericAliases.get(alias) || alias;
}

function isNumericSearchToken(token: string) {
  return /^\d+(?:\.\d+)?$/u.test(token);
}

/**
 * Canonicalize unit tokens in already token-normalized search text.
 * Quantities are intentionally not converted: `1 kg` and `1000 gram` retain
 * their original numbers so later matching remains explainable and exact.
 */
export function canonicalizeProductSearchUnits(normalizedText: string): string {
  const tokens = normalizedText.trim() ? normalizedText.trim().split(/\s+/u) : [];
  return tokens
    .map((token, index) => {
      const canonical = unambiguousAliases.get(token);
      if (canonical) return canonical;

      const contextualCanonical = numericContextAliases.get(token);
      if (
        contextualCanonical &&
        index > 0 &&
        isNumericSearchToken(tokens[index - 1])
      ) {
        return contextualCanonical;
      }
      return token;
    })
    .join(" ");
}
