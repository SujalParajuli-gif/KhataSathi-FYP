export type NormalizedProductSearchSynonym = {
  normalizedAlias: string;
  normalizedCanonicalTerm: string;
};

function tokens(value: string) {
  return value.trim() ? value.trim().split(/\s+/u) : [];
}

function tokensEqualAt(
  source: readonly string[],
  offset: number,
  expected: readonly string[],
) {
  return expected.every((token, index) => source[offset + index] === token);
}

/**
 * Expand reviewed synonyms without deleting the user's original tokens.
 * Longest aliases win, inserted canonical terms are not recursively expanded,
 * and an already expanded value remains unchanged.
 */
export function expandNormalizedProductSearchSynonyms(
  normalizedText: string,
  rules: readonly NormalizedProductSearchSynonym[],
): string {
  const sourceTokens = tokens(normalizedText);
  if (sourceTokens.length === 0 || rules.length === 0) return normalizedText.trim();

  const preparedRules = rules
    .map((rule) => ({
      aliasTokens: tokens(rule.normalizedAlias),
      canonicalTokens: tokens(rule.normalizedCanonicalTerm),
    }))
    .filter(
      (rule) =>
        rule.aliasTokens.length > 0 &&
        rule.canonicalTokens.length > 0 &&
        rule.aliasTokens.join(" ") !== rule.canonicalTokens.join(" "),
    )
    .sort(
      (left, right) =>
        right.aliasTokens.length - left.aliasTokens.length ||
        right.aliasTokens.join(" ").localeCompare(left.aliasTokens.join(" ")),
    );

  const expanded: string[] = [];
  let index = 0;
  while (index < sourceTokens.length) {
    const rule = preparedRules.find((candidate) =>
      tokensEqualAt(sourceTokens, index, candidate.aliasTokens),
    );
    if (!rule) {
      expanded.push(sourceTokens[index]);
      index += 1;
      continue;
    }

    expanded.push(...rule.aliasTokens);
    const afterAlias = index + rule.aliasTokens.length;
    if (!tokensEqualAt(sourceTokens, afterAlias, rule.canonicalTokens)) {
      expanded.push(...rule.canonicalTokens);
    }
    index = afterAlias;
  }

  return expanded.join(" ");
}
