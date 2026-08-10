import { createHash } from "crypto";
import prisma from "../../db/prisma";
import { normalizeProductSearchQuery } from "./searchNormalization";

export const PRODUCT_SEARCH_LOG_RETENTION_DAYS = 90;
export const PRODUCT_SEARCH_NO_RESULT_DEDUPE_MS = 5 * 60 * 1000;
export const PRODUCT_SEARCH_RESULT_DEDUPE_MS = 15 * 1000;

export type ProductSearchSource = "PRODUCTS" | "PRODUCT_LOOKUP";
export type ProductSearchSelectionAction =
  | "VIEW_DETAILS"
  | "VIEW_IMAGE"
  | "EDIT_PRODUCT"
  | "ADD_TO_DRAFT";

type SearchFilters = {
  brand?: string;
  category?: string;
  isActive?: boolean;
  lowStockOnly?: boolean;
  stockStatus?: "in" | "low" | "out";
};

const allowedSources = new Set<ProductSearchSource>([
  "PRODUCTS",
  "PRODUCT_LOOKUP",
]);
const allowedSelectionActions = new Set<ProductSearchSelectionAction>([
  "VIEW_DETAILS",
  "VIEW_IMAGE",
  "EDIT_PRODUCT",
  "ADD_TO_DRAFT",
]);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeLoggedProductSearchQuery(value: unknown) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

export function normalizeLoggedSearchFilters(filters: SearchFilters) {
  return {
    brand: String(filters.brand || "").trim() || null,
    category: String(filters.category || "").trim() || null,
    isActive:
      typeof filters.isActive === "boolean" ? filters.isActive : null,
    lowStockOnly: filters.lowStockOnly === true,
    stockStatus: filters.stockStatus || null,
  };
}

export function fingerprintProductSearchFilters(filters: SearchFilters) {
  return sha256(JSON.stringify(normalizeLoggedSearchFilters(filters)));
}

export function hashProductSearchSession(
  sessionId: unknown,
  actorId: string | undefined,
) {
  const cleanSessionId = String(sessionId || "").trim().slice(0, 128);
  if (!cleanSessionId) return null;
  return sha256(`${actorId || "anonymous"}:${cleanSessionId}`);
}

export function productSearchLogExpiry(now = new Date()) {
  return new Date(
    now.getTime() + PRODUCT_SEARCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export async function recordProductSearchQuery(input: {
  rawQuery: unknown;
  source: ProductSearchSource;
  filters: SearchFilters;
  resultCount: number;
  durationMs: number;
  actorId?: string;
  sessionId?: unknown;
  page?: number;
  now?: Date;
}) {
  const rawQuery = sanitizeLoggedProductSearchQuery(input.rawQuery);
  if (rawQuery.length < 2 || input.page !== 1) return null;
  if (!allowedSources.has(input.source)) return null;

  const normalizedQuery = normalizeProductSearchQuery(rawQuery).slice(0, 160);
  if (!normalizedQuery) return null;

  const now = input.now || new Date();
  const normalizedFilters = normalizeLoggedSearchFilters(input.filters);
  const filterFingerprint = fingerprintProductSearchFilters(input.filters);
  const sessionHash = hashProductSearchSession(input.sessionId, input.actorId);
  const resultCount = Math.max(0, Math.floor(Number(input.resultCount) || 0));
  const durationMs = Math.max(0, Math.min(60_000, Math.round(Number(input.durationMs) || 0)));

  if (sessionHash) {
    const windowMs =
      resultCount === 0
        ? PRODUCT_SEARCH_NO_RESULT_DEDUPE_MS
        : PRODUCT_SEARCH_RESULT_DEDUPE_MS;
    const duplicate = await prisma.productSearchQueryLog.findFirst({
      where: {
        normalizedQuery,
        source: input.source,
        filterFingerprint,
        sessionHash,
        resultCount: resultCount === 0 ? 0 : { gt: 0 },
        lastSearchedAt: { gte: new Date(now.getTime() - windowMs) },
      },
      orderBy: { lastSearchedAt: "desc" },
      select: { id: true },
    });

    if (duplicate) {
      return prisma.productSearchQueryLog.update({
        where: { id: duplicate.id },
        data: {
          rawQuery,
          resultCount,
          durationMs,
          lastSearchedAt: now,
          expiresAt: productSearchLogExpiry(now),
          occurrenceCount: { increment: 1 },
        },
        select: { id: true },
      });
    }
  }

  return prisma.productSearchQueryLog.create({
    data: {
      rawQuery,
      normalizedQuery,
      source: input.source,
      filters: normalizedFilters,
      filterFingerprint,
      resultCount,
      durationMs,
      sessionHash,
      actorId: input.actorId || null,
      lastSearchedAt: now,
      expiresAt: productSearchLogExpiry(now),
    },
    select: { id: true },
  });
}

export async function recordProductSearchSelection(input: {
  searchLogId: unknown;
  productId: unknown;
  action: unknown;
  actorId: string;
}) {
  const searchLogId = String(input.searchLogId || "").trim();
  const productId = String(input.productId || "").trim();
  const action = String(input.action || "").trim() as ProductSearchSelectionAction;
  if (!searchLogId || !productId || !allowedSelectionActions.has(action)) {
    const error = new Error("A valid search, product, and selection action are required.") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  const searchLog = await prisma.productSearchQueryLog.findFirst({
    where: {
      id: searchLogId,
      actorId: input.actorId,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!searchLog) {
    const error = new Error("That search event is unavailable or does not belong to this user.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  return prisma.productSearchSelection.upsert({
    where: {
      searchLogId_productId_action: { searchLogId, productId, action },
    },
    create: { searchLogId, productId, action, actorId: input.actorId },
    update: {},
    select: { id: true },
  });
}

type InsightAccumulator = {
  rawQuery: string;
  normalizedQuery: string;
  filters: unknown;
  searches: number;
  resultCount: number;
  selectedSearches: number;
  sources: Set<string>;
  lastSearchedAt: Date;
  totalDurationMs: number;
};

function aggregateSearchInsights(
  rows: Array<{
    rawQuery: string;
    normalizedQuery: string;
    filterFingerprint: string;
    filters: unknown;
    source: string;
    resultCount: number;
    durationMs: number;
    occurrenceCount: number;
    lastSearchedAt: Date;
    selections: Array<{ id: string }>;
  }>,
) {
  const grouped = new Map<string, InsightAccumulator>();
  for (const row of rows) {
    const key = `${row.normalizedQuery}:${row.filterFingerprint}:${row.resultCount === 0 ? "ZERO" : "RESULTS"}`;
    const current = grouped.get(key) || {
      rawQuery: row.rawQuery,
      normalizedQuery: row.normalizedQuery,
      filters: row.filters,
      searches: 0,
      resultCount: row.resultCount,
      selectedSearches: 0,
      sources: new Set<string>(),
      lastSearchedAt: row.lastSearchedAt,
      totalDurationMs: 0,
    };
    current.searches += row.occurrenceCount;
    current.totalDurationMs += row.durationMs * row.occurrenceCount;
    current.sources.add(row.source);
    if (row.selections.length > 0) current.selectedSearches += 1;
    if (row.lastSearchedAt > current.lastSearchedAt) {
      current.rawQuery = row.rawQuery;
      current.lastSearchedAt = row.lastSearchedAt;
    }
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((item) => ({
      rawQuery: item.rawQuery,
      normalizedQuery: item.normalizedQuery,
      filters: item.filters,
      searches: item.searches,
      resultCount: item.resultCount,
      selectedSearches: item.selectedSearches,
      selectionRate:
        item.searches > 0
          ? Math.round((item.selectedSearches / item.searches) * 100)
          : 0,
      sources: [...item.sources].sort(),
      averageDurationMs: Math.round(item.totalDurationMs / Math.max(1, item.searches)),
      lastSearchedAt: item.lastSearchedAt,
    }))
    .sort(
      (left, right) =>
        right.searches - left.searches ||
        right.lastSearchedAt.getTime() - left.lastSearchedAt.getTime(),
    );
}

export function excludeReviewedNoResultQueries<T extends { normalizedQuery: string }>(
  insights: readonly T[],
  reviewedAliases: ReadonlySet<string>,
) {
  return insights.filter((item) => !reviewedAliases.has(item.normalizedQuery));
}

export async function getProductSearchInsights(input?: {
  days?: number;
  limit?: number;
}) {
  const days = Math.max(1, Math.min(PRODUCT_SEARCH_LOG_RETENTION_DAYS, Math.floor(Number(input?.days) || 30)));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(input?.limit) || 30)));
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.productSearchQueryLog.findMany({
    where: { lastSearchedAt: { gte: since }, expiresAt: { gt: now } },
    orderBy: { lastSearchedAt: "desc" },
    take: 5000,
    select: {
      rawQuery: true,
      normalizedQuery: true,
      filterFingerprint: true,
      filters: true,
      source: true,
      resultCount: true,
      durationMs: true,
      occurrenceCount: true,
      lastSearchedAt: true,
      selections: { select: { id: true }, take: 1 },
    },
  });
  const insights = aggregateSearchInsights(rows);
  const noResultInsights = insights.filter((item) => item.resultCount === 0);
  const unmatchedTerms = [...new Set(noResultInsights.map((item) => item.normalizedQuery))];
  const [productAliases, synonyms] = unmatchedTerms.length
    ? await Promise.all([
        prisma.productSearchAlias.findMany({
          where: { isEnabled: true, normalizedAlias: { in: unmatchedTerms } },
          select: { normalizedAlias: true },
        }),
        prisma.productSearchSynonym.findMany({
          where: { isEnabled: true, normalizedAlias: { in: unmatchedTerms } },
          select: { normalizedAlias: true },
        }),
      ])
    : [[], []];
  const reviewedAliases = new Set([
    ...productAliases.map((item) => item.normalizedAlias),
    ...synonyms.map((item) => item.normalizedAlias),
  ]);

  return {
    periodDays: days,
    retentionDays: PRODUCT_SEARCH_LOG_RETENTION_DAYS,
    aliasApprovalRequired: true,
    noResults: excludeReviewedNoResultQueries(noResultInsights, reviewedAliases).slice(0, limit),
    usefulResults: insights
      .filter((item) => item.resultCount > 0)
      .sort(
        (left, right) =>
          right.selectedSearches - left.selectedSearches ||
          right.searches - left.searches,
      )
      .slice(0, limit),
  };
}

export async function purgeExpiredProductSearchLogs(now = new Date()) {
  const result = await prisma.productSearchQueryLog.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return { deleted: result.count };
}
