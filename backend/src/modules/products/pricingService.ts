// Bulk pricing operations — extracted from service.ts for maintainability.
// Handles audited bulk price updates with cost-based margin calculations.

import { type Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { priceFromGrossMargin } from "./pricingMath";
import { listProducts, type ProductFilters } from "./service";

type BulkPriceFilterInput = {
    search?: string;
    brand?: string;
    category?: string;
    isActive?: boolean;
    lowStockOnly?: boolean;
    stockStatus?: "in" | "low" | "out";
};

// safely converting a CSV cell value to a trimmed string (duplicated here to avoid import cycle)
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
            where: {
                OR: [
                    { id: brand },
                    { name: brand },
                ],
            },
            select: { id: true },
        });
        if (!brandRecord) {
            throw new Error(`Brand not found: ${brand}`);
        }
        filters.brand = brandRecord.id;
    }

    return filters;
}

export async function bulkUpdateProductPrices(input: {
    updates?: Array<{
        productId: string;
        retailPrice?: number;
        wholesalePrice?: number;
        ratePerPiece?: number | null;
    }>;
    scope?: "IDS" | "FILTERED";
    filters?: BulkPriceFilterInput;
    excludedProductIds?: unknown[];
    wholesaleMarginPercent?: number;
    retailMarginPercent?: number;
    reason: string;
    actorId: string;
    actorRole?: string;
}) {
    const reason = normalizePriceText(input.reason);
    if (!reason) {
        throw new Error("Reason is required for bulk price updates.");
    }

    let updates = Array.isArray(input.updates) ? input.updates : [];
    let filteredExcludedCount = 0;
    if (input.scope === "FILTERED") {
        const excludedProductIds = Array.from(new Set(
            (input.excludedProductIds || [])
                .map((id) => String(id || "").trim())
                .filter(Boolean),
        ));
        if (excludedProductIds.length > 10_000) {
            throw new Error("Too many product exclusions. Narrow the filters and try again.");
        }
        filteredExcludedCount = excludedProductIds.length;
        const excludedProductIdSet = new Set(excludedProductIds);
        const filters = await normalizeBulkPriceFilters(input.filters || {});
        const productsResult = await listProducts({
            ...filters,
            page: 1,
            pageSize: 100000,
        });
        const wholesaleMargin = Number(input.wholesaleMarginPercent || 0);
        const retailMargin = Number(input.retailMarginPercent || 0);
        updates = productsResult.products
          .filter((product: any) => !excludedProductIdSet.has(product.id))
          .map((product: any) => {
            if (product.ratePerPiece === null || product.ratePerPiece === undefined) {
                throw new Error(
                    `Purchase cost is not entered for ${product.name}. Add it before applying cost-based margins.`,
                );
            }
            const baseRate = Number(product.ratePerPiece);
            return {
                productId: product.id,
                ratePerPiece: baseRate,
                wholesalePrice: priceFromGrossMargin(baseRate, wholesaleMargin),
                retailPrice: priceFromGrossMargin(baseRate, retailMargin),
            };
          });
    }
    if (updates.length === 0) {
        throw new Error("At least one product price update is required.");
    }

    const results: Array<{ id: string; name: string; sku: string }> = [];
    const errors: Array<{ productId: string; message: string }> = [];

    for (const update of updates) {
        try {
            const retailPrice = Number(update.retailPrice);
            const wholesalePrice = Number(update.wholesalePrice);
            const purchaseCostWasProvided = Object.prototype.hasOwnProperty.call(
                update,
                "ratePerPiece",
            );
            const ratePerPiece =
                update.ratePerPiece === null || update.ratePerPiece === undefined
                    ? null
                    : Number(update.ratePerPiece);

            if (!update.productId) {
                throw new Error("Missing product id.");
            }
            if (!Number.isFinite(retailPrice) || retailPrice <= 0) {
                throw new Error("Retail price must be greater than 0.");
            }
            if (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0) {
                throw new Error("Wholesale price must be greater than 0.");
            }
            if (
                purchaseCostWasProvided &&
                ratePerPiece !== null &&
                (!Number.isFinite(ratePerPiece) || ratePerPiece <= 0)
            ) {
                throw new Error("Purchase cost must be greater than 0 or left blank.");
            }

            const result = await prisma.$transaction(async (tx) => {
                const before = await tx.product.findUnique({
                    where: { id: update.productId },
                    select: {
                        id: true,
                        name: true,
                        sku: true,
                        retailPrice: true,
                        wholesalePrice: true,
                        ratePerPiece: true,
                    },
                });

                if (!before) {
                    throw new Error("Product not found.");
                }

                const product = await tx.product.update({
                    where: { id: update.productId },
                    data: {
                        retailPrice,
                        wholesalePrice,
                        ...(purchaseCostWasProvided ? { ratePerPiece } : {}),
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
                                retailPrice,
                                wholesalePrice,
                                ratePerPiece: purchaseCostWasProvided
                                    ? ratePerPiece
                                    : before.ratePerPiece,
                            },
                        },
                    },
                });

                return product;
            });

            results.push(result);
        } catch (err: any) {
            errors.push({
                productId: update.productId,
                message: err?.message || "Price update failed.",
            });
        }
    }

    if (String(input.actorRole || "").toUpperCase() === "MANAGER" && results.length > 0) {
        await prisma.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "MANAGER_PRODUCT_BULK_PRICE_UPDATE",
                entityType: "Product",
                entityId: "bulk-price-update",
                meta: {
                    reason,
                    selectionScope: input.scope || "IDS",
                    excludedCount: filteredExcludedCount,
                    updatedCount: results.length,
                    errorCount: errors.length,
                    products: results.map((product) => ({
                        id: product.id,
                        name: product.name,
                        sku: product.sku,
                    })),
                },
            },
        });
    } else if (results.length > 0) {
        await prisma.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_PRICE_UPDATE_DIGEST",
                entityType: "Product",
                entityId: "bulk-price-update",
                meta: {
                    reason,
                    selectionScope: input.scope || "IDS",
                    excludedCount: filteredExcludedCount,
                    updatedCount: results.length,
                    errorCount: errors.length,
                    products: results.map((product) => ({
                        id: product.id,
                        name: product.name,
                        sku: product.sku,
                    })),
                },
            },
        });
    }

    return {
        updatedCount: results.length,
        errorCount: errors.length,
        products: results,
        errors,
    };
}
