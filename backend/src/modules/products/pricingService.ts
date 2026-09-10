// Audited bulk selling-price updates. Rate is a neutral starting value, not a
// verified cost, so calculations are expressed as a percentage change from Rate.

import { type Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { priceFromPercentageChange } from "./pricingMath";
import { listProducts, type ProductFilters } from "./service";
import { resolveSellingPriceStatus } from "./productUtils";

type BulkPriceFilterInput = {
    search?: string;
    brand?: string;
    category?: string;
    isActive?: boolean;
    lowStockOnly?: boolean;
    stockStatus?: "in" | "low" | "out";
};

type ExistingPricePolicy = "FILL_EMPTY" | "REPLACE";
type ChangeDirection = "INCREASE" | "DECREASE";
type PreviewSort = "affected_first" | "rate_desc" | "rate_asc" | "price_desc";
type DirectPriceUpdate = {
    productId: string;
    ratePerPiece?: number;
    retailPrice?: number;
    wholesalePrice?: number;
};

type PricePreview = {
    productId: string;
    name: string;
    sku: string;
    currentRate: number | null;
    newRate: number | null;
    rate: number | null;
    currentRetailPrice: number | null;
    newRetailPrice: number | null;
    currentWholesalePrice: number | null;
    newWholesalePrice: number | null;
    willChange: boolean;
};

type BulkPriceProduct = {
    id: string;
    name: string;
    sku: string;
    ratePerPiece: number | null;
    retailPrice: number | null;
    wholesalePrice: number | null;
    availabilityStatus: string;
};

const MAX_FILTERED_BULK_PRODUCTS = 10_000;
const MAX_PREVIEW_PAGE_SIZE = 100;
const MAX_FILTERED_PRICE_OVERRIDES = 100;
const PRICE_UPDATE_CONCURRENCY = 8;

function normalizePriceText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

async function normalizeBulkPriceFilters(input: BulkPriceFilterInput): Promise<ProductFilters> {
    const filters: ProductFilters = {};
    const search = String(input.search || "").trim();
    const brand = String(input.brand || "").trim();
    const category = String(input.category || "").trim();
    if (search) filters.search = search;
    if (category && category !== "All Categories") filters.category = category;
    if (typeof input.isActive === "boolean") filters.isActive = input.isActive;
    if (input.lowStockOnly) filters.lowStockOnly = true;
    if (input.stockStatus === "in" || input.stockStatus === "low" || input.stockStatus === "out") {
        filters.stockStatus = input.stockStatus;
    }
    if (brand && brand !== "All Brands") {
        const brandRecord = await prisma.brand.findFirst({
            where: { OR: [{ id: brand }, { name: brand }] },
            select: { id: true },
        });
        if (!brandRecord) throw new Error(`Brand not found: ${brand}`);
        filters.brand = brandRecord.id;
    }
    return filters;
}

async function loadBulkPriceProducts(filters: ProductFilters) {
    const needsResolvedStockFiltering = Boolean(
        filters.search
        || filters.lowStockOnly
        || filters.stockStatus === "low"
        || filters.stockStatus === "in",
    );
    if (needsResolvedStockFiltering) {
        const result = await listProducts({
            ...filters,
            page: 1,
            pageSize: MAX_FILTERED_BULK_PRODUCTS + 1,
        });
        return {
            products: result.products as BulkPriceProduct[],
            total: result.total,
        };
    }

    // The common catalog-wide path needs only pricing identity fields. Avoid
    // loading brand relations, stock settings, media, and other product data on
    // every debounced preview search.
    const where: Prisma.ProductWhereInput = {
        ...(filters.brand ? { brandId: filters.brand } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
        ...(filters.stockStatus === "out" ? { stock: { lte: 0 } } : {}),
    };
    const [products, total] = await Promise.all([
        prisma.product.findMany({
            where,
            select: {
                id: true,
                name: true,
                sku: true,
                ratePerPiece: true,
                retailPrice: true,
                wholesalePrice: true,
                availabilityStatus: true,
            },
            orderBy: { createdAt: "desc" },
            take: MAX_FILTERED_BULK_PRODUCTS + 1,
        }),
        prisma.product.count({ where }),
    ]);
    return { products, total };
}

export async function bulkUpdateProductPrices(input: {
    updates?: DirectPriceUpdate[];
    scope?: "IDS" | "FILTERED";
    filters?: BulkPriceFilterInput;
    excludedProductIds?: unknown[];
    overrides?: DirectPriceUpdate[];
    wholesalePercent?: number;
    retailPercent?: number;
    direction?: ChangeDirection;
    existingPricePolicy?: ExistingPricePolicy;
    previewOnly?: boolean;
    previewPage?: number;
    previewPageSize?: number;
    previewSearch?: string;
    previewSort?: PreviewSort;
    reason: string;
    actorId: string;
    actorRole?: string;
}) {
    const reason = normalizePriceText(input.reason);
    if (!reason) throw new Error("Reason is required for bulk price updates.");
    if (reason.length > 500) throw new Error("Reason must be 500 characters or fewer.");

    let updates: DirectPriceUpdate[] = Array.isArray(input.updates) ? input.updates : [];
    if (updates.length > MAX_FILTERED_BULK_PRODUCTS) {
        throw new Error(`A price update cannot contain more than ${MAX_FILTERED_BULK_PRODUCTS.toLocaleString()} products.`);
    }
    const duplicateUpdateIds = updates
        .map((update) => String(update?.productId || "").trim())
        .filter((id, index, ids) => id && ids.indexOf(id) !== index);
    if (duplicateUpdateIds.length > 0) {
        throw new Error("The price update contains the same product more than once.");
    }
    let filteredExcludedCount = 0;
    let matchedCount = updates.length;
    let skippedMissingRate = 0;
    let skippedComingSoon = 0;
    let skippedExisting = 0;
    const filteredProductSnapshots = new Map<string, BulkPriceProduct>();
    const filteredProductOrder = new Map<string, number>();
    const preservedPreview: PricePreview[] = [];
    const requestedPreviewSearch = normalizePriceText(input.previewSearch).toLocaleLowerCase();
    const filteredOverrideIdSet = new Set<string>();
    const filteredOverrides = Array.isArray(input.overrides) ? input.overrides : [];
    if (filteredOverrides.length > MAX_FILTERED_PRICE_OVERRIDES) {
        throw new Error(`You can manually adjust up to ${MAX_FILTERED_PRICE_OVERRIDES} products in one catalog-wide price change.`);
    }
    const duplicateOverrideIds = filteredOverrides
        .map((update) => String(update?.productId || "").trim())
        .filter((id, index, ids) => id && ids.indexOf(id) !== index);
    if (duplicateOverrideIds.length > 0) {
        throw new Error("The manual price adjustments contain the same product more than once.");
    }
    for (const override of filteredOverrides) {
        const productId = String(override?.productId || "").trim();
        if (!productId) throw new Error("A manual price adjustment is missing its product.");
        const providedFields = (["ratePerPiece", "wholesalePrice", "retailPrice"] as const)
            .filter((field) => Object.prototype.hasOwnProperty.call(override, field));
        if (providedFields.length === 0) {
            throw new Error("A manual price adjustment must include at least one price.");
        }
        for (const field of providedFields) {
            const value = Number(override[field]);
            if (!Number.isFinite(value) || value <= 0) {
                const label = field === "ratePerPiece" ? "Rate" : field === "wholesalePrice" ? "Wholesale price" : "Retail price";
                throw new Error(`${label} must be greater than 0 for every manual adjustment.`);
            }
        }
    }

    if (input.scope === "FILTERED") {
        const excludedProductIds = Array.from(new Set(
            (input.excludedProductIds || []).map((id) => String(id || "").trim()).filter(Boolean),
        ));
        if (excludedProductIds.length > 10_000) {
            throw new Error("Too many product exclusions. Narrow the filters and try again.");
        }
        filteredExcludedCount = excludedProductIds.length;
        const excludedProductIdSet = new Set(excludedProductIds);
        const filters = await normalizeBulkPriceFilters(input.filters || {});
        const productsResult = await loadBulkPriceProducts(filters);
        if (productsResult.total > MAX_FILTERED_BULK_PRODUCTS) {
            throw new Error(
                `This price update matches more than ${MAX_FILTERED_BULK_PRODUCTS.toLocaleString()} products. Narrow the filters and try again.`,
            );
        }
        const products = productsResult.products.filter(
            (product) => !excludedProductIdSet.has(product.id),
        );
        const productIdSet = new Set(products.map((product) => product.id));
        if (filteredOverrides.some((override) => !productIdSet.has(String(override?.productId || "")))) {
            throw new Error("A manually adjusted product is no longer part of this price change. Refresh the preview and try again.");
        }
        const overrideByProductId = new Map(
            filteredOverrides.map((override) => [String(override.productId), override]),
        );
        filteredOverrides.forEach((override) => filteredOverrideIdSet.add(String(override.productId)));
        products.forEach((product, index) => {
            filteredProductSnapshots.set(product.id, product);
            filteredProductOrder.set(product.id, index);
        });
        matchedCount = products.length;

        const hasWholesale = input.wholesalePercent !== undefined;
        const hasRetail = input.retailPercent !== undefined;
        if (!hasWholesale && !hasRetail) {
            throw new Error("Choose Retail price, Wholesale price, or both.");
        }
        const direction = input.direction === "DECREASE" ? "DECREASE" : "INCREASE";
        const policy = input.existingPricePolicy === "REPLACE" ? "REPLACE" : "FILL_EMPTY";
        const wholesalePercent = hasWholesale ? Number(input.wholesalePercent) : null;
        const retailPercent = hasRetail ? Number(input.retailPercent) : null;
        updates = [];

        for (const product of products) {
            if (product.availabilityStatus === "COMING_SOON") {
                skippedComingSoon += 1;
                continue;
            }
            const override = overrideByProductId.get(product.id);
            const rateProvided = Boolean(override && Object.prototype.hasOwnProperty.call(override, "ratePerPiece"));
            const rate = Number(rateProvided ? override?.ratePerPiece : product.ratePerPiece);
            if (!Number.isFinite(rate) || rate <= 0) {
                skippedMissingRate += 1;
                continue;
            }
            const update: DirectPriceUpdate = { productId: product.id };
            if (rateProvided) update.ratePerPiece = rate;
            if (wholesalePercent !== null && !(policy === "FILL_EMPTY" && Number(product.wholesalePrice) > 0)) {
                update.wholesalePrice = priceFromPercentageChange(rate, wholesalePercent, direction);
            }
            if (retailPercent !== null && !(policy === "FILL_EMPTY" && Number(product.retailPrice) > 0)) {
                update.retailPrice = priceFromPercentageChange(rate, retailPercent, direction);
            }
            if (override && Object.prototype.hasOwnProperty.call(override, "wholesalePrice")) {
                update.wholesalePrice = override.wholesalePrice;
            }
            if (override && Object.prototype.hasOwnProperty.call(override, "retailPrice")) {
                update.retailPrice = override.retailPrice;
            }
            if (update.ratePerPiece === undefined && update.retailPrice === undefined && update.wholesalePrice === undefined) {
                skippedExisting += 1;
                // Preserved rows still belong to the selected catalog scope. Keep them
                // in the paginated browser so the user can find one and add an exact
                // exception without switching the whole batch to Replace prices.
                preservedPreview.push({
                    productId: product.id,
                    name: product.name,
                    sku: product.sku,
                    currentRate: product.ratePerPiece,
                    newRate: product.ratePerPiece,
                    rate: product.ratePerPiece,
                    currentRetailPrice: product.retailPrice,
                    newRetailPrice: product.retailPrice,
                    currentWholesalePrice: product.wholesalePrice,
                    newWholesalePrice: product.wholesalePrice,
                    willChange: false,
                });
                continue;
            }
            updates.push(update);
        }
    }

    const results: Array<{ id: string; name: string; sku: string }> = [];
    const errors: Array<{ productId: string; message: string }> = [];
    const preview: PricePreview[] = [];

    // Keep row-level transactions and audit records, but process a small bounded
    // group at once so a catalog-wide update does not wait on 1,500 round trips
    // serially or overwhelm the database connection pool.
    for (let start = 0; start < updates.length; start += PRICE_UPDATE_CONCURRENCY) {
        const batch = updates.slice(start, start + PRICE_UPDATE_CONCURRENCY);
        await Promise.all(batch.map(async (update) => {
          try {
            const rateProvided = Object.prototype.hasOwnProperty.call(update, "ratePerPiece");
            const retailProvided = Object.prototype.hasOwnProperty.call(update, "retailPrice");
            const wholesaleProvided = Object.prototype.hasOwnProperty.call(update, "wholesalePrice");
            const ratePerPiece = rateProvided ? Number(update.ratePerPiece) : undefined;
            const retailPrice = retailProvided ? Number(update.retailPrice) : undefined;
            const wholesalePrice = wholesaleProvided ? Number(update.wholesalePrice) : undefined;
            if (!update.productId) throw new Error("Missing product id.");
            if (!rateProvided && !retailProvided && !wholesaleProvided) throw new Error("Choose at least one price to update.");
            if (rateProvided && (!Number.isFinite(ratePerPiece) || Number(ratePerPiece) <= 0)) {
                throw new Error("Rate must be greater than 0.");
            }
            if (retailProvided && (!Number.isFinite(retailPrice) || Number(retailPrice) <= 0)) {
                throw new Error("Retail price must be greater than 0.");
            }
            if (wholesaleProvided && (!Number.isFinite(wholesalePrice) || Number(wholesalePrice) <= 0)) {
                throw new Error("Wholesale price must be greater than 0.");
            }

            const perform = async (tx: Prisma.TransactionClient | typeof prisma) => {
                const before = input.previewOnly && input.scope === "FILTERED"
                    ? filteredProductSnapshots.get(update.productId)
                    : await tx.product.findUnique({
                        where: { id: update.productId },
                        select: {
                            id: true,
                            name: true,
                            sku: true,
                            retailPrice: true,
                            wholesalePrice: true,
                            ratePerPiece: true,
                            availabilityStatus: true,
                        },
                    });
                if (!before) throw new Error("Product not found.");
                const effectiveRate = rateProvided ? Number(ratePerPiece) : Number(before.ratePerPiece);
                if (before.availabilityStatus !== "COMING_SOON" && ![effectiveRate, retailProvided ? retailPrice : before.retailPrice, wholesaleProvided ? wholesalePrice : before.wholesalePrice].some((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
                    throw new Error("Enter an announced price or mark this product as Coming soon.");
                }
                const policy = input.existingPricePolicy === "REPLACE" ? "REPLACE" : "FILL_EMPTY";
                const isManualOverride = filteredOverrideIdSet.has(update.productId);
                const updateRetail = retailProvided
                    && (isManualOverride || !(policy === "FILL_EMPTY" && Number(before.retailPrice) > 0))
                    && Number(retailPrice) !== Number(before.retailPrice);
                const updateWholesale = wholesaleProvided
                    && (isManualOverride || !(policy === "FILL_EMPTY" && Number(before.wholesalePrice) > 0))
                    && Number(wholesalePrice) !== Number(before.wholesalePrice);
                const updateRate = rateProvided && Number(ratePerPiece) !== Number(before.ratePerPiece);
                if (!updateRate && !updateRetail && !updateWholesale) {
                    skippedExisting += 1;
                    return null;
                }
                const nextRate = updateRate ? Number(ratePerPiece) : before.ratePerPiece;
                const nextRetailPrice = updateRetail ? Number(retailPrice) : before.retailPrice;
                const nextWholesalePrice = updateWholesale ? Number(wholesalePrice) : before.wholesalePrice;
                preview.push({
                    productId: before.id,
                    name: before.name,
                    sku: before.sku,
                    currentRate: before.ratePerPiece,
                    newRate: nextRate,
                    rate: nextRate,
                    currentRetailPrice: before.retailPrice,
                    newRetailPrice: nextRetailPrice,
                    currentWholesalePrice: before.wholesalePrice,
                    newWholesalePrice: nextWholesalePrice,
                    willChange: true,
                });
                if (input.previewOnly) return { id: before.id, name: before.name, sku: before.sku };

                const product = await tx.product.update({
                    where: { id: update.productId },
                    data: {
                        ...(updateRate ? { ratePerPiece, rateUpdatedAt: new Date() } : {}),
                        ...(updateRetail ? { retailPrice } : {}),
                        ...(updateWholesale ? { wholesalePrice } : {}),
                        sellingPriceStatus: resolveSellingPriceStatus(nextRetailPrice, nextWholesalePrice),
                    },
                    select: { id: true, name: true, sku: true },
                });
                await tx.auditLog.create({
                    data: {
                        actorId: input.actorId,
                        action: "PRODUCT_BULK_PRICE_UPDATE",
                        entityType: "PRODUCT",
                        entityId: product.id,
                        meta: {
                            reason,
                            before,
                            after: {
                                retailPrice: nextRetailPrice,
                                wholesalePrice: nextWholesalePrice,
                                ratePerPiece: nextRate,
                            },
                        },
                    },
                });
                return product;
            };

            const result = input.previewOnly
                ? await perform(prisma)
                : await prisma.$transaction((tx) => perform(tx));
            if (result && !input.previewOnly) results.push(result);
          } catch (error: any) {
              errors.push({ productId: update.productId, message: error?.message || "Price update failed." });
          }
        }));
    }

    let auditWarning: string | null = null;
    if (!input.previewOnly && results.length > 0) {
        try {
            await prisma.auditLog.create({
                data: {
                    actorId: input.actorId,
                    action: String(input.actorRole || "").toUpperCase() === "MANAGER"
                        ? "MANAGER_PRODUCT_BULK_PRICE_UPDATE"
                        : "PRODUCT_PRICE_UPDATE_DIGEST",
                    entityType: "Product",
                    entityId: "bulk-price-update",
                    meta: {
                        reason,
                        selectionScope: input.scope || "IDS",
                        excludedCount: filteredExcludedCount,
                        updatedCount: results.length,
                        errorCount: errors.length,
                        skippedMissingRate,
                        skippedComingSoon,
                        skippedExisting,
                        products: results.map((product) => ({ id: product.id, name: product.name, sku: product.sku })),
                    },
                },
            });
        } catch (error) {
            // Every successful row already has its own audit record. Do not report the
            // committed price changes as failed just because the optional digest failed.
            console.error("Bulk price digest audit failed:", error);
            auditWarning = "Prices were saved, but the summary audit record could not be created.";
        }
    }

    const previewSearch = requestedPreviewSearch;
    // `preview` is the set the rule will change. `previewSearchSource` is the
    // complete browsable scope, including prices preserved by Fill empty only.
    // Keeping these separate prevents the UI from claiming preserved rows will
    // change while still making every eligible product searchable.
    const previewSearchSource = [...preview, ...preservedPreview].sort(
        (left, right) => (filteredProductOrder.get(left.productId) ?? 0) - (filteredProductOrder.get(right.productId) ?? 0),
    );
    const matchingPreview = previewSearch
        ? previewSearchSource.filter((item) =>
            [item.name, item.sku].some((value) => String(value || "").toLocaleLowerCase().includes(previewSearch)),
        )
        : previewSearchSource;
    const previewSort: PreviewSort = input.previewSort === "rate_desc"
        || input.previewSort === "rate_asc"
        || input.previewSort === "price_desc"
        ? input.previewSort
        : "affected_first";
    const sortedPreview = [...matchingPreview].sort((left, right) => {
        const byName = left.name.localeCompare(right.name) || left.productId.localeCompare(right.productId);
        if (previewSort === "rate_desc") {
            return (Number(right.rate) || 0) - (Number(left.rate) || 0) || byName;
        }
        if (previewSort === "rate_asc") {
            return (Number(left.rate) || 0) - (Number(right.rate) || 0) || byName;
        }
        if (previewSort === "price_desc") {
            const leftPrice = Math.max(Number(left.newWholesalePrice) || 0, Number(left.newRetailPrice) || 0);
            const rightPrice = Math.max(Number(right.newWholesalePrice) || 0, Number(right.newRetailPrice) || 0);
            return rightPrice - leftPrice || byName;
        }
        return Number(right.willChange) - Number(left.willChange) || byName;
    });
    const previewPageSize = Math.max(
        1,
        Math.min(MAX_PREVIEW_PAGE_SIZE, Math.floor(Number(input.previewPageSize) || 25)),
    );
    const previewTotalPages = Math.max(1, Math.ceil(matchingPreview.length / previewPageSize));
    const previewPage = Math.min(
        previewTotalPages,
        Math.max(1, Math.floor(Number(input.previewPage) || 1)),
    );
    const previewStart = (previewPage - 1) * previewPageSize;

    return {
        updatedCount: input.previewOnly ? 0 : results.length,
        previewCount: preview.length,
        previewMatchedCount: matchingPreview.length,
        previewPage,
        previewPageSize,
        previewTotalPages,
        errorCount: errors.length,
        matchedCount,
        skippedMissingRate,
        skippedComingSoon,
        skippedExisting,
        products: results,
        errors,
        preview: input.previewOnly
            ? sortedPreview.slice(previewStart, previewStart + previewPageSize)
            : [],
        partialSuccess: !input.previewOnly && results.length > 0 && errors.length > 0,
        auditWarning,
    };
}
