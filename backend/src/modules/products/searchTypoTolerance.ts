import { isCanonicalProductSearchUnitToken } from "./searchUnitNormalization";

export const PRODUCT_SEARCH_TYPO_LIMITS = {
  maxDocuments: 2_000,
  maxCandidateTokens: 5_000,
  maxQueryTokens: 8,
  maxCorrectionsPerToken: 5,
  maxTokenLength: 48,
} as const;

/** Phase 1.6 may refine scores, but typo matches must always remain last. */
export const PRODUCT_SEARCH_MATCH_PRIORITY = {
  exact: 400,
  alias: 300,
  prefix: 200,
  typo: 100,
} as const;

export type ProductSearchTypoCandidateToken = {
  token: string;
  documentFrequency: number;
};

export type ProductSearchTypoMatch = {
  kind: "TYPO";
  queryToken: string;
  candidateToken: string;
  distance: number;
  maxDistance: 1 | 2;
  documentFrequency: number;
  score: number;
};

export type ProductSearchTypoOptions = {
  /** Exact SKU/barcode tokens supplied by the search contract remain protected. */
  protectedTokens?: ReadonlySet<string>;
  maxCandidateTokens?: number;
  maxCorrectionsPerToken?: number;
};

function characters(value: string) {
  return Array.from(value);
}

function isLettersOnly(token: string) {
  return /^\p{L}+$/u.test(token);
}

function isProtectedToken(token: string, protectedTokens?: ReadonlySet<string>) {
  return (
    protectedTokens?.has(token) === true ||
    /\d/u.test(token) ||
    isCanonicalProductSearchUnitToken(token)
  );
}

export function allowedProductSearchTypoDistance(
  token: string,
  protectedTokens?: ReadonlySet<string>,
): 0 | 1 | 2 {
  const length = characters(token).length;
  if (
    length < 5 ||
    length > PRODUCT_SEARCH_TYPO_LIMITS.maxTokenLength ||
    !isLettersOnly(token) ||
    isProtectedToken(token, protectedTokens)
  ) {
    return 0;
  }
  return length >= 8 ? 2 : 1;
}

/**
 * Bounded optimal-string-alignment distance. Adjacent transpositions count as
 * one edit, which matches common shop-entry mistakes such as `bukcet`.
 */
export function boundedProductSearchEditDistance(
  leftValue: string,
  rightValue: string,
  maximumDistance: 1 | 2,
): number | null {
  if (leftValue === rightValue) return 0;
  const left = characters(leftValue);
  const right = characters(rightValue);
  if (Math.abs(left.length - right.length) > maximumDistance) return null;

  const matrix = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + 1,
        );
      }
    }
  }

  const distance = matrix[left.length][right.length];
  return distance <= maximumDistance ? distance : null;
}

function boundedCandidateSlice(
  candidates: Iterable<ProductSearchTypoCandidateToken>,
  limit: number,
) {
  const bounded: ProductSearchTypoCandidateToken[] = [];
  for (const candidate of candidates) {
    if (bounded.length >= limit) break;
    bounded.push(candidate);
  }
  return bounded;
}

export function findProductSearchTypoMatches(
  queryToken: string,
  candidates: Iterable<ProductSearchTypoCandidateToken>,
  options: ProductSearchTypoOptions = {},
): ProductSearchTypoMatch[] {
  const maxDistance = allowedProductSearchTypoDistance(
    queryToken,
    options.protectedTokens,
  );
  if (maxDistance === 0) return [];

  const maxCandidates = Math.max(
    1,
    Math.min(
      options.maxCandidateTokens || PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
      PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
    ),
  );
  const maxResults = Math.max(
    1,
    Math.min(
      options.maxCorrectionsPerToken ||
        PRODUCT_SEARCH_TYPO_LIMITS.maxCorrectionsPerToken,
      PRODUCT_SEARCH_TYPO_LIMITS.maxCorrectionsPerToken,
    ),
  );

  const matches = new Map<string, ProductSearchTypoMatch>();
  for (const candidate of boundedCandidateSlice(candidates, maxCandidates)) {
    const candidateToken = candidate.token;
    if (
      candidateToken === queryToken ||
      allowedProductSearchTypoDistance(candidateToken, options.protectedTokens) === 0
    ) {
      continue;
    }
    const distance = boundedProductSearchEditDistance(
      queryToken,
      candidateToken,
      maxDistance,
    );
    if (distance === null || distance === 0) continue;
    const existing = matches.get(candidateToken);
    const documentFrequency = Math.max(0, candidate.documentFrequency || 0);
    if (existing && existing.documentFrequency >= documentFrequency) continue;
    matches.set(candidateToken, {
      kind: "TYPO",
      queryToken,
      candidateToken,
      distance,
      maxDistance,
      documentFrequency,
      score: PRODUCT_SEARCH_MATCH_PRIORITY.typo - distance,
    });
  }

  return [...matches.values()]
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        right.documentFrequency - left.documentFrequency ||
        left.candidateToken.localeCompare(right.candidateToken),
    )
    .slice(0, maxResults);
}

export function findProductSearchTypoCorrections(
  normalizedQuery: string,
  candidates: Iterable<ProductSearchTypoCandidateToken>,
  options: ProductSearchTypoOptions = {},
) {
  const maxCandidates = Math.max(
    1,
    Math.min(
      options.maxCandidateTokens || PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
      PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
    ),
  );
  const boundedCandidates = boundedCandidateSlice(candidates, maxCandidates);
  const queryTokens = normalizedQuery
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, PRODUCT_SEARCH_TYPO_LIMITS.maxQueryTokens);
  return queryTokens.flatMap((queryToken) =>
    findProductSearchTypoMatches(queryToken, boundedCandidates, options),
  );
}

export function buildBoundedProductSearchTypoCandidateIndex(
  normalizedDocuments: Iterable<string>,
  limits: { maxDocuments?: number; maxCandidateTokens?: number } = {},
) {
  const maxDocuments = Math.max(
    1,
    Math.min(
      limits.maxDocuments || PRODUCT_SEARCH_TYPO_LIMITS.maxDocuments,
      PRODUCT_SEARCH_TYPO_LIMITS.maxDocuments,
    ),
  );
  const maxCandidateTokens = Math.max(
    1,
    Math.min(
      limits.maxCandidateTokens || PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
      PRODUCT_SEARCH_TYPO_LIMITS.maxCandidateTokens,
    ),
  );
  const frequencies = new Map<string, number>();
  let documentsIndexed = 0;
  let truncated = false;

  for (const document of normalizedDocuments) {
    if (documentsIndexed >= maxDocuments) {
      truncated = true;
      break;
    }
    documentsIndexed += 1;
    const documentTokens = new Set(document.split(/\s+/u).filter(Boolean));
    for (const token of documentTokens) {
      if (allowedProductSearchTypoDistance(token) === 0) continue;
      if (!frequencies.has(token) && frequencies.size >= maxCandidateTokens) {
        truncated = true;
        continue;
      }
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
  }

  return {
    candidates: [...frequencies.entries()]
      .map(([token, documentFrequency]) => ({ token, documentFrequency }))
      .sort((left, right) => left.token.localeCompare(right.token)),
    documentsIndexed,
    uniqueTokenCount: frequencies.size,
    truncated,
  };
}
