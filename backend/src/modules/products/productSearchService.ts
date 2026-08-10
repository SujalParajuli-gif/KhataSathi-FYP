import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import {
  applyBusinessThresholds,
  resolveLowStockThreshold,
  type BusinessSettingsSnapshot,
} from "../settings/service";
import { getEnabledSearchSynonymRules } from "./searchAliasService";
import {
  rankProductSearchCandidates,
  restoreRankedProductOrder,
} from "./searchRanking";
import { PRODUCT_SEARCH_TYPO_LIMITS } from "./searchTypoTolerance";

type RankedProductSearchInput = {
  query: string;
  where: Prisma.ProductWhereInput;
  page: number;
  pageSize: number;
  lowStockOnly?: boolean;
  stockStatus?: "in" | "low" | "out";
  settings: BusinessSettingsSnapshot;
};

const searchCandidateSelect = {
  id: true,
  name: true,
  productName: true,
  sku: true,
  barcode: true,
  productCodeVariant: true,
  category: true,
  categoryGroup: true,
  vendorSource: true,
  stock: true,
  reservedStock: true,
  lowStockThreshold: true,
  usesDefaultLowStockThreshold: true,
  brand: { select: { name: true } },
  searchDocument: { select: { normalizedText: true } },
  searchAliases: {
    where: { isEnabled: true },
    select: { normalizedAlias: true, isEnabled: true },
  },
} satisfies Prisma.ProductSelect;

export function matchesProductSearchStockConstraint(
  product: {
    stock: number;
    reservedStock: number;
    lowStockThreshold: number;
    usesDefaultLowStockThreshold: boolean;
  },
  input: Pick<
    RankedProductSearchInput,
    "stockStatus" | "lowStockOnly" | "settings"
  >,
) {
  if (!input.lowStockOnly && !input.stockStatus) return true;
  const availableStock = Math.max(
    0,
    Number(product.stock || 0) - Math.max(0, Number(product.reservedStock || 0)),
  );
  const threshold = resolveLowStockThreshold(product, input.settings);
  if (input.stockStatus === "in") return availableStock > threshold;
  if (input.stockStatus === "out") return availableStock <= 0;
  return availableStock > 0 && availableStock <= threshold;
}

export async function searchProductsWithDeterministicRanking(
  input: RankedProductSearchInput,
) {
  const candidateLimit = PRODUCT_SEARCH_TYPO_LIMITS.maxDocuments;
  const [candidateRows, synonymRules] = await Promise.all([
    prisma.product.findMany({
      where: input.where,
      select: searchCandidateSelect,
      orderBy: { id: "asc" },
      take: candidateLimit + 1,
    }),
    getEnabledSearchSynonymRules(),
  ]);
  const candidateLimitReached = candidateRows.length > candidateLimit;
  const eligibleCandidates = candidateRows
    .slice(0, candidateLimit)
    .filter((product) => matchesProductSearchStockConstraint(product, input));
  const ranked = rankProductSearchCandidates(
    input.query,
    eligibleCandidates,
    synonymRules,
  );
  const total = ranked.length;
  const skip = (input.page - 1) * input.pageSize;
  const rankedIds = ranked
    .slice(skip, skip + input.pageSize)
    .map((result) => result.candidate.id);
  const products = rankedIds.length
    ? await prisma.product.findMany({
        where: { id: { in: rankedIds } },
        include: { brand: { select: { id: true, name: true } } },
      })
    : [];
  const orderedProducts = restoreRankedProductOrder<(typeof products)[number]>(
    rankedIds,
    products,
  ).map(
    (product) => {
      const resolved = applyBusinessThresholds(product, input.settings);
      const reservedStock = Math.max(0, Number(resolved.reservedStock || 0));
      return {
        ...resolved,
        reservedStock,
        availableStock: Math.max(0, Number(resolved.stock || 0) - reservedStock),
      };
    },
  );

  return {
    products: orderedProducts,
    total,
    page: input.page,
    pageSize: input.pageSize,
    search: {
      candidateLimit,
      candidateLimitReached,
    },
  };
}
