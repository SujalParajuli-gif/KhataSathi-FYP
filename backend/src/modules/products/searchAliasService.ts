import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import {
  PRODUCT_SEARCH_NORMALIZER_VERSION,
  buildProductSearchDocument,
  normalizeProductSearchQuery,
} from "./searchNormalization";
import {
  expandNormalizedProductSearchSynonyms,
  type NormalizedProductSearchSynonym,
} from "./searchSynonyms";

type SearchDbClient = Prisma.TransactionClient | typeof prisma;

export type ReviewedSearchSynonymSeed = {
  alias: string;
  canonicalTerm: string;
};

/** Reviewed examples approved in the implementation plan; never auto-run. */
export const REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED: readonly ReviewedSearchSynonymSeed[] = [
  { alias: "balti", canonicalTerm: "bucket" },
  { alias: "बाल्टी", canonicalTerm: "bucket" },
  { alias: "tokri", canonicalTerm: "basket" },
  { alias: "टोकरी", canonicalTerm: "basket" },
  { alias: "gamala", canonicalTerm: "planter" },
  { alias: "गमला", canonicalTerm: "planter" },
  { alias: "dabba", canonicalTerm: "box" },
  { alias: "डब्बा", canonicalTerm: "box" },
  { alias: "botal", canonicalTerm: "bottle" },
  { alias: "बोतल", canonicalTerm: "bottle" },
  { alias: "pirka", canonicalTerm: "stool" },
  { alias: "पिर्का", canonicalTerm: "stool" },
] as const;

export class SearchAliasValidationError extends Error {
  statusCode = 400;
}

function requiredReviewedTerm(value: unknown, label: string) {
  const raw = String(value || "").trim().replace(/\s+/gu, " ");
  if (!raw) throw new SearchAliasValidationError(`${label} is required.`);
  if (raw.length > 120) {
    throw new SearchAliasValidationError(`${label} must be 120 characters or fewer.`);
  }
  const normalized = normalizeProductSearchQuery(raw);
  if (!normalized) {
    throw new SearchAliasValidationError(`${label} must contain searchable letters or numbers.`);
  }
  if (normalized.length > 191) {
    throw new SearchAliasValidationError(`${label} is too long after normalization.`);
  }
  return { raw, normalized };
}

export function prepareReviewedSearchSynonym(input: {
  alias: unknown;
  canonicalTerm: unknown;
}) {
  const alias = requiredReviewedTerm(input.alias, "Alias");
  const canonical = requiredReviewedTerm(input.canonicalTerm, "Canonical term");
  if (alias.normalized === canonical.normalized) {
    throw new SearchAliasValidationError(
      "Alias and canonical term must represent different searchable text.",
    );
  }
  return {
    alias: alias.raw,
    normalizedAlias: alias.normalized,
    canonicalTerm: canonical.raw,
    normalizedCanonicalTerm: canonical.normalized,
  };
}

export function prepareReviewedProductAlias(aliasInput: unknown) {
  const alias = requiredReviewedTerm(aliasInput, "Product alias");
  return { alias: alias.raw, normalizedAlias: alias.normalized };
}

async function assertActiveAdminApprover(actorId: string, db: SearchDbClient) {
  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, isActive: true },
  });
  if (!actor || actor.role !== "ADMIN" || !actor.isActive) {
    throw Object.assign(
      new Error("An active Admin must approve product search aliases."),
      { statusCode: 403 },
    );
  }
  return actor;
}

export async function getEnabledSearchSynonymRules(
  db: SearchDbClient = prisma,
): Promise<NormalizedProductSearchSynonym[]> {
  return db.productSearchSynonym.findMany({
    where: { isEnabled: true },
    select: {
      normalizedAlias: true,
      normalizedCanonicalTerm: true,
    },
    orderBy: [{ normalizedAlias: "asc" }],
  });
}

type SearchDocumentProduct = {
  id: string;
  name: string;
  productName: string | null;
  sku: string;
  barcode: string | null;
  productCodeVariant: string | null;
  sizeValue: number | null;
  sizeUnit: string;
  packageQuantity: number;
  packageUnit: string;
  saleUnit: string;
  category: string | null;
  categoryGroup: string | null;
  vendorSource: string | null;
  brand: { name: string };
  searchAliases: Array<{ alias: string; isEnabled: boolean }>;
};

export function compileProductSearchDocument(
  product: SearchDocumentProduct,
  synonymRules: readonly NormalizedProductSearchSynonym[],
) {
  const normalizedBase = buildProductSearchDocument({
    name: product.name,
    productName: product.productName,
    sku: product.sku,
    barcode: product.barcode,
    productCodeVariant: product.productCodeVariant,
    sizeValue: product.sizeValue,
    sizeUnit: product.sizeUnit,
    packageQuantity: product.packageQuantity,
    packageUnit: product.packageUnit,
    saleUnit: product.saleUnit,
    brand: product.brand.name,
    category: product.category,
    categoryGroup: product.categoryGroup,
    vendorSource: product.vendorSource,
    aliases: product.searchAliases
      .filter((alias) => alias.isEnabled)
      .map((alias) => alias.alias),
  });
  return expandNormalizedProductSearchSynonyms(normalizedBase, synonymRules);
}

const searchDocumentProductInclude = {
  brand: { select: { name: true } },
  searchAliases: {
    select: { alias: true, isEnabled: true },
    orderBy: { normalizedAlias: "asc" as const },
  },
};

async function persistCompiledProductSearchDocument(
  product: SearchDocumentProduct,
  synonymRules: readonly NormalizedProductSearchSynonym[],
  db: SearchDbClient,
) {
  const normalizedText = compileProductSearchDocument(product, synonymRules);
  await db.productSearchDocument.upsert({
    where: { productId: product.id },
    create: {
      productId: product.id,
      normalizedText,
      normalizerVersion: PRODUCT_SEARCH_NORMALIZER_VERSION,
    },
    update: {
      normalizedText,
      normalizerVersion: PRODUCT_SEARCH_NORMALIZER_VERSION,
    },
  });
  return normalizedText;
}

export async function rebuildProductSearchDocument(
  productId: string,
  db: SearchDbClient = prisma,
  providedRules?: readonly NormalizedProductSearchSynonym[],
) {
  const [product, synonymRules] = await Promise.all([
    db.product.findUnique({
      where: { id: productId },
      include: searchDocumentProductInclude,
    }),
    providedRules
      ? Promise.resolve(providedRules)
      : getEnabledSearchSynonymRules(db),
  ]);
  if (!product) {
    await db.productSearchDocument.deleteMany({ where: { productId } });
    return null;
  }
  return persistCompiledProductSearchDocument(
    product as SearchDocumentProduct,
    synonymRules,
    db,
  );
}

export async function rebuildAllProductSearchDocuments(
  db: SearchDbClient = prisma,
) {
  const [products, synonymRules] = await Promise.all([
    db.product.findMany({
      include: searchDocumentProductInclude,
      orderBy: { id: "asc" },
    }),
    getEnabledSearchSynonymRules(db),
  ]);

  for (const product of products) {
    await persistCompiledProductSearchDocument(
      product as SearchDocumentProduct,
      synonymRules,
      db,
    );
  }
  return { rebuiltCount: products.length, normalizerVersion: PRODUCT_SEARCH_NORMALIZER_VERSION };
}

export async function rebuildProductSearchDocumentsForBrand(
  brandId: string,
  db: SearchDbClient = prisma,
) {
  const [products, synonymRules] = await Promise.all([
    db.product.findMany({
      where: { brandId },
      include: searchDocumentProductInclude,
      orderBy: { id: "asc" },
    }),
    getEnabledSearchSynonymRules(db),
  ]);
  for (const product of products) {
    await persistCompiledProductSearchDocument(
      product as SearchDocumentProduct,
      synonymRules,
      db,
    );
  }
  return products.length;
}

export async function listSearchSynonyms() {
  return prisma.productSearchSynonym.findMany({
    include: { approvedBy: { select: { id: true, name: true } } },
    orderBy: [{ normalizedCanonicalTerm: "asc" }, { normalizedAlias: "asc" }],
  });
}

export async function createSearchSynonym(
  input: { alias: unknown; canonicalTerm: unknown },
  actorId: string,
) {
  const prepared = prepareReviewedSearchSynonym(input);
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const synonym = await tx.productSearchSynonym.create({
      data: {
        ...prepared,
        source: "ADMIN_REVIEW",
        approvedById: actorId,
      },
      include: { approvedBy: { select: { id: true, name: true } } },
    });
    await rebuildAllProductSearchDocuments(tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_SYNONYM_CREATED",
        entityType: "ProductSearchSynonym",
        entityId: synonym.id,
        meta: { alias: prepared.alias, canonicalTerm: prepared.canonicalTerm },
      },
    });
    return synonym;
  }, { timeout: 30_000 });
}

export async function getSearchSynonymPromotionContext(input: {
  alias: unknown;
  canonicalTerm: unknown;
}) {
  const prepared = prepareReviewedSearchSynonym(input);
  const [existingSynonym, linkedProductAliases] = await Promise.all([
    prisma.productSearchSynonym.findUnique({
      where: { normalizedAlias: prepared.normalizedAlias },
      select: {
        id: true,
        alias: true,
        canonicalTerm: true,
        normalizedCanonicalTerm: true,
        isEnabled: true,
      },
    }),
    prisma.productSearchAlias.findMany({
      where: { normalizedAlias: prepared.normalizedAlias, isEnabled: true },
      select: {
        id: true,
        product: { select: { id: true, name: true, sku: true } },
      },
      orderBy: { product: { name: "asc" } },
    }),
  ]);
  return { prepared, existingSynonym, linkedProductAliases };
}

export async function promoteSearchSynonym(
  input: { alias: unknown; canonicalTerm: unknown },
  actorId: string,
) {
  const prepared = prepareReviewedSearchSynonym(input);
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const existingSynonym = await tx.productSearchSynonym.findUnique({
      where: { normalizedAlias: prepared.normalizedAlias },
    });
    if (
      existingSynonym &&
      existingSynonym.normalizedCanonicalTerm !== prepared.normalizedCanonicalTerm
    ) {
      throw Object.assign(
        new Error(
          `“${existingSynonym.alias}” already maps to “${existingSynonym.canonicalTerm}”. Disable or edit that rule first.`,
        ),
        { statusCode: 409 },
      );
    }

    const linkedAliases = await tx.productSearchAlias.findMany({
      where: { normalizedAlias: prepared.normalizedAlias, isEnabled: true },
      select: { id: true, productId: true, product: { select: { name: true } } },
    });
    if (linkedAliases.length > 0) {
      await tx.productSearchAlias.updateMany({
        where: { id: { in: linkedAliases.map((alias) => alias.id) } },
        data: { isEnabled: false, approvedById: actorId },
      });
    }

    const synonym = existingSynonym
      ? await tx.productSearchSynonym.update({
          where: { id: existingSynonym.id },
          data: { ...prepared, isEnabled: true, source: "ADMIN_REVIEW", approvedById: actorId },
          include: { approvedBy: { select: { id: true, name: true } } },
        })
      : await tx.productSearchSynonym.create({
          data: { ...prepared, source: "ADMIN_REVIEW", approvedById: actorId },
          include: { approvedBy: { select: { id: true, name: true } } },
        });

    await rebuildAllProductSearchDocuments(tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_SYNONYM_PROMOTED",
        entityType: "ProductSearchSynonym",
        entityId: synonym.id,
        meta: {
          alias: prepared.alias,
          canonicalTerm: prepared.canonicalTerm,
          disabledProductAliases: linkedAliases.map((alias) => ({
            productId: alias.productId,
            productName: alias.product.name,
          })),
        },
      },
    });
    return {
      synonym,
      disabledProductAliasCount: linkedAliases.length,
    };
  }, { timeout: 60_000 });
}

export async function updateSearchSynonym(
  id: string,
  input: { alias?: unknown; canonicalTerm?: unknown; isEnabled?: unknown },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const existing = await tx.productSearchSynonym.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error("Search synonym not found."), { statusCode: 404 });
    const prepared = prepareReviewedSearchSynonym({
      alias: input.alias === undefined ? existing.alias : input.alias,
      canonicalTerm:
        input.canonicalTerm === undefined ? existing.canonicalTerm : input.canonicalTerm,
    });
    const synonym = await tx.productSearchSynonym.update({
      where: { id },
      data: {
        ...prepared,
        isEnabled:
          input.isEnabled === undefined ? existing.isEnabled : input.isEnabled === true,
        source: "ADMIN_REVIEW",
        approvedById: actorId,
      },
      include: { approvedBy: { select: { id: true, name: true } } },
    });
    await rebuildAllProductSearchDocuments(tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_SYNONYM_UPDATED",
        entityType: "ProductSearchSynonym",
        entityId: synonym.id,
        meta: {
          before: { alias: existing.alias, canonicalTerm: existing.canonicalTerm, isEnabled: existing.isEnabled },
          after: { alias: synonym.alias, canonicalTerm: synonym.canonicalTerm, isEnabled: synonym.isEnabled },
        },
      },
    });
    return synonym;
  }, { timeout: 30_000 });
}

export async function listProductSearchAliases(productId?: string) {
  return prisma.productSearchAlias.findMany({
    where: productId ? { productId } : {},
    include: {
      product: { select: { id: true, name: true, sku: true } },
      approvedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ productId: "asc" }, { normalizedAlias: "asc" }],
  });
}

export async function createProductSearchAlias(
  input: { productId: unknown; alias: unknown },
  actorId: string,
) {
  const productId = String(input.productId || "").trim();
  if (!productId) throw new SearchAliasValidationError("Product is required.");
  const prepared = prepareReviewedProductAlias(input.alias);
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw Object.assign(new Error("Product not found."), { statusCode: 404 });
    const alias = await tx.productSearchAlias.create({
      data: {
        productId,
        ...prepared,
        source: "ADMIN_REVIEW",
        approvedById: actorId,
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    await rebuildProductSearchDocument(productId, tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_ALIAS_CREATED",
        entityType: "ProductSearchAlias",
        entityId: alias.id,
        meta: { productId, alias: prepared.alias },
      },
    });
    return alias;
  }, { timeout: 30_000 });
}

export async function updateProductSearchAlias(
  id: string,
  input: { alias?: unknown; isEnabled?: unknown },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const existing = await tx.productSearchAlias.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error("Product alias not found."), { statusCode: 404 });
    const prepared = prepareReviewedProductAlias(
      input.alias === undefined ? existing.alias : input.alias,
    );
    const alias = await tx.productSearchAlias.update({
      where: { id },
      data: {
        ...prepared,
        isEnabled:
          input.isEnabled === undefined ? existing.isEnabled : input.isEnabled === true,
        source: "ADMIN_REVIEW",
        approvedById: actorId,
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    await rebuildProductSearchDocument(existing.productId, tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_ALIAS_UPDATED",
        entityType: "ProductSearchAlias",
        entityId: alias.id,
        meta: {
          productId: existing.productId,
          before: { alias: existing.alias, isEnabled: existing.isEnabled },
          after: { alias: alias.alias, isEnabled: alias.isEnabled },
        },
      },
    });
    return alias;
  }, { timeout: 30_000 });
}

export async function replaceProductSearchAliases(
  productIdInput: unknown,
  aliasInputs: unknown,
  actorId: string,
) {
  const productId = String(productIdInput || "").trim();
  if (!productId) throw new SearchAliasValidationError("Product is required.");
  if (!Array.isArray(aliasInputs)) {
    throw new SearchAliasValidationError("Search terms must be an array.");
  }
  if (aliasInputs.length > 20) {
    throw new SearchAliasValidationError("A product can have at most 20 search terms.");
  }

  const preparedByNormalized = new Map<string, ReturnType<typeof prepareReviewedProductAlias>>();
  for (const aliasInput of aliasInputs) {
    const prepared = prepareReviewedProductAlias(aliasInput);
    preparedByNormalized.set(prepared.normalizedAlias, prepared);
  }
  const preparedAliases = [...preparedByNormalized.values()];

  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, sku: true },
    });
    if (!product) throw Object.assign(new Error("Product not found."), { statusCode: 404 });

    const existing = await tx.productSearchAlias.findMany({ where: { productId } });
    const keepNormalized = preparedAliases.map((alias) => alias.normalizedAlias);
    await tx.productSearchAlias.updateMany({
      where: {
        productId,
        ...(keepNormalized.length > 0
          ? { normalizedAlias: { notIn: keepNormalized } }
          : {}),
        isEnabled: true,
      },
      data: { isEnabled: false, approvedById: actorId },
    });

    for (const prepared of preparedAliases) {
      await tx.productSearchAlias.upsert({
        where: {
          productId_normalizedAlias: {
            productId,
            normalizedAlias: prepared.normalizedAlias,
          },
        },
        create: {
          productId,
          ...prepared,
          source: "PRODUCT_EDITOR",
          approvedById: actorId,
        },
        update: {
          alias: prepared.alias,
          isEnabled: true,
          source: "PRODUCT_EDITOR",
          approvedById: actorId,
        },
      });
    }

    await rebuildProductSearchDocument(productId, tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_ALIASES_REPLACED",
        entityType: "Product",
        entityId: productId,
        meta: {
          productName: product.name,
          sku: product.sku,
          before: existing.filter((alias) => alias.isEnabled).map((alias) => alias.alias),
          after: preparedAliases.map((alias) => alias.alias),
        },
      },
    });

    return tx.productSearchAlias.findMany({
      where: { productId, isEnabled: true },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { normalizedAlias: "asc" },
    });
  }, { timeout: 30_000 });
}

export async function applyReviewedSearchSynonymSeed(
  actorId: string,
  source = "CONTROLLED_SEED_2026_08",
) {
  return prisma.$transaction(async (tx) => {
    await assertActiveAdminApprover(actorId, tx);
    const reviewedAliases = REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED.map(
      (seed) => prepareReviewedSearchSynonym(seed).normalizedAlias,
    );
    const disabledStale = await tx.productSearchSynonym.updateMany({
      where: {
        source,
        normalizedAlias: { notIn: reviewedAliases },
        isEnabled: true,
      },
      data: { isEnabled: false, approvedById: actorId },
    });
    for (const seed of REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED) {
      const prepared = prepareReviewedSearchSynonym(seed);
      await tx.productSearchSynonym.upsert({
        where: { normalizedAlias: prepared.normalizedAlias },
        create: {
          ...prepared,
          source,
          isEnabled: true,
          approvedById: actorId,
        },
        update: {
          alias: prepared.alias,
          canonicalTerm: prepared.canonicalTerm,
          normalizedCanonicalTerm: prepared.normalizedCanonicalTerm,
          source,
          isEnabled: true,
          approvedById: actorId,
        },
      });
    }
    const rebuild = await rebuildAllProductSearchDocuments(tx);
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PRODUCT_SEARCH_SYNONYM_SEED_APPLIED",
        entityType: "ProductSearchSynonym",
        entityId: source,
        meta: {
          aliases: REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED,
          disabledStaleCount: disabledStale.count,
          rebuiltCount: rebuild.rebuiltCount,
        },
      },
    });
    return {
      appliedCount: REVIEWED_PRODUCT_SEARCH_SYNONYM_SEED.length,
      disabledStaleCount: disabledStale.count,
      ...rebuild,
    };
  }, { timeout: 30_000 });
}
