import { normalizeProductSearchQuery } from "./searchNormalization";
import type { NormalizedProductSearchSynonym } from "./searchSynonyms";
import { isCanonicalProductSearchUnitToken } from "./searchUnitNormalization";
import {
  PRODUCT_SEARCH_MATCH_PRIORITY,
  buildBoundedProductSearchTypoCandidateIndex,
  findProductSearchTypoMatches,
  type ProductSearchTypoCandidateToken,
} from "./searchTypoTolerance";

export const PRODUCT_SEARCH_RANK_ORDER = [
  "EXACT_BARCODE",
  "EXACT_SKU",
  "EXACT_NAME",
  "EXACT_PRODUCT_ALIAS",
  "ALL_EXACT_TOKENS",
  "PREFIX_OR_MIXED_TOKENS",
  "TYPO_TOKENS",
  "PARTIAL_FALLBACK",
] as const;

export type ProductSearchRankTier = (typeof PRODUCT_SEARCH_RANK_ORDER)[number];

export type ProductSearchRankCandidate = {
  id: string;
  name: string;
  productName?: string | null;
  sku: string;
  barcode?: string | null;
  productCodeVariant?: string | null;
  category?: string | null;
  categoryGroup?: string | null;
  vendorSource?: string | null;
  brand?: { name: string } | null;
  searchDocument?: { normalizedText: string } | null;
  searchAliases?: Array<{
    normalizedAlias: string;
    isEnabled: boolean;
  }>;
};

export type RankedProductSearchCandidate<T extends ProductSearchRankCandidate> = {
  candidate: T;
  tier: ProductSearchRankTier;
  matchedGroups: number;
  totalGroups: number;
  fieldPriority: number;
  typoDistance: number;
};

type QueryTokenGroup = {
  alternatives: string[][];
  typoCandidates: ProductSearchTypoCandidateToken[];
};

type GroupMatch = {
  kind: "EXACT" | "PREFIX" | "TYPO";
  fieldPriority: number;
  typoDistance: number;
};

const tierPriority = new Map<ProductSearchRankTier, number>(
  PRODUCT_SEARCH_RANK_ORDER.map((tier, index) => [tier, index]),
);

function tokens(value: string) {
  return value.trim() ? value.trim().split(/\s+/u) : [];
}

function phraseMatchesAt(
  source: readonly string[],
  offset: number,
  phrase: readonly string[],
) {
  return phrase.every((token, index) => source[offset + index] === token);
}

function containsPhrase(source: readonly string[], phrase: readonly string[]) {
  if (phrase.length === 0 || phrase.length > source.length) return false;
  for (let offset = 0; offset <= source.length - phrase.length; offset += 1) {
    if (phraseMatchesAt(source, offset, phrase)) return true;
  }
  return false;
}

function uniquePhrases(phrases: readonly string[][]) {
  const seen = new Set<string>();
  return phrases.filter((phrase) => {
    const key = phrase.join(" ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildQueryGroups(
  normalizedQuery: string,
  synonymRules: readonly NormalizedProductSearchSynonym[],
  typoIndex: readonly ProductSearchTypoCandidateToken[],
) {
  const queryTokens = tokens(normalizedQuery);
  const preparedRules = synonymRules
    .map((rule) => ({
      aliasTokens: tokens(rule.normalizedAlias),
      canonicalTokens: tokens(rule.normalizedCanonicalTerm),
    }))
    .filter((rule) => rule.aliasTokens.length > 0 && rule.canonicalTokens.length > 0)
    .sort(
      (left, right) =>
        right.aliasTokens.length - left.aliasTokens.length ||
        left.aliasTokens.join(" ").localeCompare(right.aliasTokens.join(" ")),
    );

  const groups: QueryTokenGroup[] = [];
  let offset = 0;
  while (offset < queryTokens.length) {
    const synonym = preparedRules.find((rule) =>
      phraseMatchesAt(queryTokens, offset, rule.aliasTokens),
    );
    if (synonym) {
      groups.push({
        alternatives: uniquePhrases([
          synonym.aliasTokens,
          synonym.canonicalTokens,
        ]),
        typoCandidates: [],
      });
      offset += synonym.aliasTokens.length;
      continue;
    }

    const queryToken = queryTokens[offset];
    groups.push({
      alternatives: [[queryToken]],
      typoCandidates: findProductSearchTypoMatches(queryToken, typoIndex).map(
        (match) => ({
          token: match.candidateToken,
          documentFrequency: match.documentFrequency,
        }),
      ),
    });
    offset += 1;
  }
  return groups;
}

function normalizedCandidateFields(candidate: ProductSearchRankCandidate) {
  const normalize = (value: unknown) =>
    normalizeProductSearchQuery(String(value || ""));
  const aliasValues = (candidate.searchAliases || [])
    .filter((alias) => alias.isEnabled)
    .map((alias) => alias.normalizedAlias);
  const normalizedName = normalize(candidate.name);
  const normalizedProductName = normalize(candidate.productName);
  const normalizedSku = normalize(candidate.sku);
  const normalizedBarcode = normalize(candidate.barcode);
  const fallbackDocument = [
    candidate.name,
    candidate.productName,
    candidate.sku,
    candidate.barcode,
    candidate.productCodeVariant,
    candidate.brand?.name,
    candidate.category,
    candidate.categoryGroup,
    candidate.vendorSource,
    ...aliasValues,
  ]
    .filter(Boolean)
    .map((value) => String(value))
    .join(" ");

  return {
    normalizedName,
    normalizedProductName,
    normalizedSku,
    normalizedBarcode,
    aliases: aliasValues,
    fields: [
      [tokens(normalizedName), tokens(normalizedProductName)],
      [
        ...aliasValues.map(tokens),
        tokens(normalize(candidate.productCodeVariant)),
      ],
      [tokens(normalize(candidate.brand?.name))],
      [
        tokens(normalize(candidate.category)),
        tokens(normalize(candidate.categoryGroup)),
      ],
      [
        tokens(normalize(candidate.vendorSource)),
        tokens(
          candidate.searchDocument?.normalizedText || normalize(fallbackDocument),
        ),
      ],
    ],
  };
}

function matchGroup(
  group: QueryTokenGroup,
  fields: ReturnType<typeof normalizedCandidateFields>["fields"],
): GroupMatch | null {
  for (let priority = 0; priority < fields.length; priority += 1) {
    if (
      group.alternatives.some((phrase) =>
        fields[priority].some((fieldTokens) => containsPhrase(fieldTokens, phrase)),
      )
    ) {
      return { kind: "EXACT", fieldPriority: priority, typoDistance: 0 };
    }
  }

  const prefixTokens = group.alternatives
    .filter(
      (phrase) =>
        phrase.length === 1 &&
        /^\p{L}{3,}$/u.test(phrase[0]) &&
        !isCanonicalProductSearchUnitToken(phrase[0]),
    )
    .map((phrase) => phrase[0]);
  for (let priority = 0; priority < fields.length; priority += 1) {
    if (
      prefixTokens.some((prefix) =>
        fields[priority].some((fieldTokens) =>
          fieldTokens.some((fieldToken) => fieldToken.startsWith(prefix)),
        ),
      )
    ) {
      return { kind: "PREFIX", fieldPriority: priority, typoDistance: 0 };
    }
  }

  for (let priority = 0; priority < fields.length; priority += 1) {
    for (const typoCandidate of group.typoCandidates) {
      if (
        fields[priority].some((fieldTokens) =>
          fieldTokens.includes(typoCandidate.token),
        )
      ) {
        const original = group.alternatives[0]?.[0] || "";
        const typo = findProductSearchTypoMatches(original, [typoCandidate])[0];
        return {
          kind: "TYPO",
          fieldPriority: priority,
          typoDistance: typo?.distance || 2,
        };
      }
    }
  }
  return null;
}

function rankOne<T extends ProductSearchRankCandidate>(
  candidate: T,
  rawQuery: string,
  normalizedQuery: string,
  groups: readonly QueryTokenGroup[],
): RankedProductSearchCandidate<T> | null {
  const normalized = normalizedCandidateFields(candidate);
  const rawTrimmed = rawQuery.trim();
  const groupMatches = groups
    .map((group) => matchGroup(group, normalized.fields))
    .filter((match): match is GroupMatch => match !== null);
  const matchedGroups = groupMatches.length;
  const totalGroups = groups.length;
  const fieldPriority = groupMatches.reduce(
    (total, match) => total + match.fieldPriority,
    0,
  );
  const typoDistance = groupMatches.reduce(
    (total, match) => total + match.typoDistance,
    0,
  );

  let tier: ProductSearchRankTier;
  if (candidate.barcode && candidate.barcode.trim() === rawTrimmed) {
    tier = "EXACT_BARCODE";
  } else if (normalized.normalizedSku === normalizedQuery) {
    tier = "EXACT_SKU";
  } else if (
    normalized.normalizedName === normalizedQuery ||
    normalized.normalizedProductName === normalizedQuery
  ) {
    tier = "EXACT_NAME";
  } else if (normalized.aliases.includes(normalizedQuery)) {
    tier = "EXACT_PRODUCT_ALIAS";
  } else if (matchedGroups === 0) {
    return null;
  } else if (matchedGroups < totalGroups) {
    tier = "PARTIAL_FALLBACK";
  } else if (groupMatches.some((match) => match.kind === "TYPO")) {
    tier = "TYPO_TOKENS";
  } else if (groupMatches.some((match) => match.kind === "PREFIX")) {
    tier = "PREFIX_OR_MIXED_TOKENS";
  } else {
    tier = "ALL_EXACT_TOKENS";
  }

  return {
    candidate,
    tier,
    matchedGroups,
    totalGroups,
    fieldPriority,
    typoDistance,
  };
}

export function rankProductSearchCandidates<T extends ProductSearchRankCandidate>(
  rawQuery: string,
  candidates: readonly T[],
  synonymRules: readonly NormalizedProductSearchSynonym[],
) {
  const normalizedQuery = normalizeProductSearchQuery(rawQuery);
  if (!normalizedQuery) return [];

  const typoIndex = buildBoundedProductSearchTypoCandidateIndex(
    candidates.map(
      (candidate) =>
        candidate.searchDocument?.normalizedText ||
        normalizeProductSearchQuery(
          [candidate.name, candidate.productName, candidate.brand?.name]
            .filter(Boolean)
            .join(" "),
        ),
    ),
  );
  const groups = buildQueryGroups(
    normalizedQuery,
    synonymRules,
    typoIndex.candidates,
  );
  const ranked = candidates
    .map((candidate) => rankOne(candidate, rawQuery, normalizedQuery, groups))
    .filter(
      (candidate): candidate is RankedProductSearchCandidate<T> =>
        candidate !== null,
    );
  const hasCompleteMatch = ranked.some(
    (candidate) =>
      candidate.tier !== "PARTIAL_FALLBACK" ||
      candidate.matchedGroups === candidate.totalGroups,
  );

  return ranked
    .filter((candidate) => !hasCompleteMatch || candidate.tier !== "PARTIAL_FALLBACK")
    .sort((left, right) => {
      const tierDifference =
        (tierPriority.get(left.tier) || 0) -
        (tierPriority.get(right.tier) || 0);
      if (tierDifference !== 0) return tierDifference;
      const groupDifference = right.matchedGroups - left.matchedGroups;
      if (groupDifference !== 0) return groupDifference;
      const fieldDifference = left.fieldPriority - right.fieldPriority;
      if (fieldDifference !== 0) return fieldDifference;
      const typoDifference = left.typoDistance - right.typoDistance;
      if (typoDifference !== 0) return typoDifference;
      const nameDifference = left.candidate.name.localeCompare(
        right.candidate.name,
        "en",
        { sensitivity: "base", numeric: true },
      );
      if (nameDifference !== 0) return nameDifference;
      return left.candidate.id.localeCompare(right.candidate.id);
    });
}

export function restoreRankedProductOrder<T extends { id: string }>(
  rankedIds: readonly string[],
  products: readonly T[],
) {
  const productsById = new Map(products.map((product) => [product.id, product]));
  return rankedIds.flatMap((id) => {
    const product = productsById.get(id);
    return product ? [product] : [];
  });
}

export function productSearchMatchPriority() {
  return PRODUCT_SEARCH_MATCH_PRIORITY;
}
