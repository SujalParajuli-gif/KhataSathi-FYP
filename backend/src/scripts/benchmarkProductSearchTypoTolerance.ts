import { performance } from "node:perf_hooks";
import prisma from "../db/prisma";
import {
  PRODUCT_SEARCH_TYPO_LIMITS,
  buildBoundedProductSearchTypoCandidateIndex,
  findProductSearchTypoMatches,
} from "../modules/products/searchTypoTolerance";

const benchmarkCases = [
  { query: "lonch", expected: "lunch" },
  { query: "bukcet", expected: "bucket" },
  { query: "botle", expected: "bottle" },
  { query: "baskte", expected: "basket" },
  { query: "plantr", expected: "planter" },
] as const;

function percentile(sortedValues: readonly number[], percentileValue: number) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor(sortedValues.length * percentileValue),
  );
  return sortedValues[index];
}

async function main() {
  const documents = await prisma.productSearchDocument.findMany({
    select: { normalizedText: true },
    orderBy: { productId: "asc" },
    take: PRODUCT_SEARCH_TYPO_LIMITS.maxDocuments + 1,
  });
  const index = buildBoundedProductSearchTypoCandidateIndex(
    documents.map((document) => document.normalizedText),
  );
  for (const benchmarkCase of benchmarkCases) {
    const best = findProductSearchTypoMatches(
      benchmarkCase.query,
      index.candidates,
    )[0];
    if (best?.candidateToken !== benchmarkCase.expected) {
      throw new Error(
        `${benchmarkCase.query} expected ${benchmarkCase.expected}, received ${best?.candidateToken || "no match"}.`,
      );
    }
  }

  const timings: number[] = [];
  for (let iteration = 0; iteration < 250; iteration += 1) {
    for (const benchmarkCase of benchmarkCases) {
      const startedAt = performance.now();
      findProductSearchTypoMatches(benchmarkCase.query, index.candidates);
      timings.push(performance.now() - startedAt);
    }
  }
  timings.sort((left, right) => left - right);
  console.log(
    JSON.stringify(
      {
        catalogDocuments: documents.length,
        documentsIndexed: index.documentsIndexed,
        candidateTokens: index.uniqueTokenCount,
        truncated: index.truncated,
        comparisonsMeasured: timings.length,
        p50Milliseconds: Number(percentile(timings, 0.5).toFixed(3)),
        p95Milliseconds: Number(percentile(timings, 0.95).toFixed(3)),
        cases: benchmarkCases,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
