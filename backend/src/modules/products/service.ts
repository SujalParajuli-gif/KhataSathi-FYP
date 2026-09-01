import {
    DraftRequestStatus,
    type Prisma,
    type ProductImportRow,
} from "@prisma/client";
import prisma from "../../db/prisma";
import { deleteReplacedUpload, deleteUploadFile } from "../../lib/uploads";
import {
    applyBusinessThresholds,
    getBusinessSettings,
} from "../settings/service";
import { evaluateProductDeletePolicy } from "./deletePolicy";
import { priceFromGrossMargin } from "./pricingMath";
import {
    getEnabledSearchSynonymRules,
    prepareReviewedProductAlias,
    rebuildProductSearchDocument,
} from "./searchAliasService";
import { searchProductsWithDeterministicRanking } from "./productSearchService";
import {
    normalizeUnitLabel,
    normalizePositiveNumber,
    roundCurrency,
    allocateProductIdentifiers,
    buildInitialSupplierStock,
    normalizeSellingPrice,
    resolveSellingPriceStatus,
    type ProductIdentifierTransaction,
} from "./productUtils";

// defining the shape of filters that can be passed when listing products
export interface ProductFilters {
    search?: string;
    brand?: string;
    category?: string;
    isActive?: boolean;
    lowStockOnly?: boolean;
    stockStatus?: "in" | "low" | "out";
    includeDraftReservations?: boolean;
    page?: number;
    pageSize?: number;
}

type ProductDeleteReference = {
    label: string;
    count: number;
};

export type ProductDeleteSafety = {
    productId: string;
    productName: string;
    canPermanentDelete: boolean;
    references: ProductDeleteReference[];
    stockBlocker: string | null;
    canDiscardStockAndDelete: boolean;
    safeReason: string | null;
    recommendedAction: "PERMANENT_DELETE" | "SET_INACTIVE";
};

// listing products with support for search, filtering, pagination, and low-stock-only mode
// low stock mode requires special handling because we need to resolve each product's threshold
// before we can determine if it is below the threshold
export async function listProducts(filters: ProductFilters) {
    const {
        search,
        brand,
        category,
        isActive,
        lowStockOnly,
        stockStatus,
        includeDraftReservations,
        page = 1,
        pageSize = 50,
    } = filters;

    const where: any = {};

    const normalizedSearch = String(search || "").trim();

    if (brand) where.brandId = brand; // filtering by brand ID
    if (category) where.category = category; // filtering by category
    if (isActive !== undefined) where.isActive = isActive; // filtering by active status
    if (stockStatus === "out" && !normalizedSearch) where.stock = { lte: 0 };

    if (lowStockOnly) {
    }

    const skip = (page - 1) * pageSize; // calculating how many records to skip for pagination
    const settings = await getBusinessSettings(); // fetching business settings to resolve thresholds

    if (normalizedSearch) {
        const ranked = await searchProductsWithDeterministicRanking({
            query: normalizedSearch,
            where,
            page,
            pageSize,
            lowStockOnly,
            stockStatus,
            settings,
        });
        return {
            ...ranked,
            products: includeDraftReservations
                ? await withPendingDraftQuantities(ranked.products)
                : ranked.products,
        };
    }

    if (lowStockOnly || stockStatus === "low" || stockStatus === "in") {
        // for threshold-aware stock filtering, we fetch all matching products first because we need to
        // resolve each product's effective threshold (custom or default) before filtering
        // this cannot be done in a single database query since thresholds are conditional
        const allProducts = await prisma.product.findMany({
            where,
            include: { brand: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
        });

        // applying business thresholds so each product has its effective lowStockThreshold
        const resolvedProducts = allProducts.map((product) =>
            withAvailableStock(applyBusinessThresholds(product, settings)),
        );

        const filtered =
            stockStatus === "in"
                ? resolvedProducts.filter((p) => p.availableStock > p.lowStockThreshold)
                : resolvedProducts.filter((p) => p.availableStock > 0 && p.availableStock <= p.lowStockThreshold);
        const total = filtered.length;

        const paged = filtered.slice(skip, skip + pageSize); // applying manual pagination on the filtered results

        return {
            products: includeDraftReservations
                ? await withPendingDraftQuantities(paged)
                : paged,
            total,
            page,
            pageSize,
        };
    } else {
        // normal listing with database-level pagination
        const [products, total] = await Promise.all([
            prisma.product.findMany({
                where,
                include: { brand: { select: { id: true, name: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: pageSize,
            }),
            prisma.product.count({ where }), // getting total count for pagination info
        ]);

        const resolvedProducts = products.map((product) =>
                withAvailableStock(applyBusinessThresholds(product, settings)),
            ); // resolving thresholds on each product

        return {
            products: includeDraftReservations
                ? await withPendingDraftQuantities(resolvedProducts)
                : resolvedProducts,
            total,
            page,
            pageSize,
        };
    }
}

// fetching a single product by ID with its brand info and resolved thresholds
export async function getProduct(id: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findUnique({
        where: { id },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? withAvailableStock(applyBusinessThresholds(product, settings)) : product; // only apply thresholds if product exists
}

// Billing refreshes only the products in its cart, preserving input order so
// the frontend can reconcile results deterministically.
export async function getProductsByIds(ids: string[]) {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    const settings = await getBusinessSettings();
    const products = await prisma.product.findMany({
        where: { id: { in: uniqueIds } },
        include: { brand: { select: { id: true, name: true } } },
    });
    const byId = new Map(
        products.map((product) => [
            product.id,
            withAvailableStock(applyBusinessThresholds(product, settings)),
        ]),
    );
    return uniqueIds.flatMap((id) => {
        const product = byId.get(id);
        return product ? [product] : [];
    });
}

// Scanner lookup is exact so one SKU cannot accidentally match a similarly
// prefixed catalog item.
export async function getProductByCode(code: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findFirst({
        where: {
            isActive: true,
            OR: [{ sku: code }, { barcode: code }],
        },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? withAvailableStock(applyBusinessThresholds(product, settings)) : null;
}

// fetching a product by its barcode — used for barcode scanning in the billing page
export async function getProductByBarcode(barcode: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findUnique({
        where: { barcode },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? withAvailableStock(applyBusinessThresholds(product, settings)) : product;
}

function withAvailableStock<T extends { stock: number; reservedStock?: number | null }>(
    product: T,
) {
    const reservedStock = Math.max(0, Number(product.reservedStock || 0));
    return {
        ...product,
        reservedStock,
        availableStock: Math.max(0, Number(product.stock || 0) - reservedStock),
    };
}

async function getPendingDraftQuantities(productIds: string[]) {
    if (productIds.length === 0) return new Map<string, number>();

    const rows = await prisma.draftRequestItem.groupBy({
        by: ["productId"],
        where: {
            productId: { in: productIds },
            draftRequest: {
                status: {
                    in: [
                        DraftRequestStatus.PENDING,
                        DraftRequestStatus.MODIFIED,
                    ],
                },
            },
        },
        _sum: { qty: true },
    });

    return new Map(
        rows.map((row) => [row.productId, Math.max(0, Number(row._sum.qty || 0))]),
    );
}

async function withPendingDraftQuantities<
    T extends { id: string; availableStock?: number; stock: number; reservedStock?: number | null },
>(products: T[]) {
    const requestedByProduct = await getPendingDraftQuantities(
        products.map((product) => product.id),
    );

    return products.map((product) => {
        const draftRequestedQty = Number(requestedByProduct.get(product.id) || 0);
        const availableStock = Number(product.availableStock ?? product.stock ?? 0);
        return {
            ...product,
            draftRequestedQty,
            effectiveAvailableStock: Math.max(0, availableStock - draftRequestedQty),
        };
    });
}

// defining the shape of data needed to create a new product
interface CreateProductInput {
    name: string;
    productName?: string | null;
    sku?: string;
    barcode?: string;
    barcodeOrigin?: string;
    brandId?: string;
    brandName?: string;
    category?: string;
    categoryGroup?: string | null;
    vendorSource?: string | null;
    productCodeVariant?: string | null;
    sizeValue?: number | null;
    sizeUnit?: string | null;
    ratePerPiece?: number | null;
    packageQuantity?: number | null;
    packageUnit?: string | null;
    saleUnit?: string | null;
    allowFractionalQty?: boolean;
    quantityStep?: number;
    wholesaleEligible?: boolean;
    sourceCitation?: string | null;
    availabilityStatus?: "CATALOG_LISTED" | "COMING_SOON";
    retailPrice?: number | null;
    wholesalePrice?: number | null;
    wholesaleQtyThreshold?: number;
    usesDefaultWholesaleQtyThreshold?: boolean;
    stock?: number;
    lowStockThreshold?: number;
    usesDefaultLowStockThreshold?: boolean;
    isActive?: boolean;
    imageUrl?: string | null;
}

// creating a new product in the database
// if the admin does not provide custom thresholds, the product automatically uses the business defaults
export async function createProduct(data: CreateProductInput, actorId: string) {
    const settings = await getBusinessSettings();
    const retailPrice = normalizeSellingPrice(data.retailPrice);
    const wholesalePrice = normalizeSellingPrice(data.wholesalePrice);

    // determining whether to use default thresholds
    // if the admin explicitly set usesDefault, we use that value
    // otherwise, we check if a custom threshold was provided — if not, it defaults to using the business default
    const usesDefaultWholesaleQtyThreshold =
        data.usesDefaultWholesaleQtyThreshold ??
        (data.wholesaleQtyThreshold === undefined);
    const usesDefaultLowStockThreshold =
        data.usesDefaultLowStockThreshold ??
        (data.lowStockThreshold === undefined);

    const product = await prisma.$transaction(async (tx) => {
        let brandId = data.brandId;
        if (!brandId) {
            const brandName = String(data.brandName || "").trim().replace(/\s+/g, " ");
            if (!brandName) throw new Error("brand is required");
            const brand = await tx.brand.upsert({
                where: { name: brandName },
                create: { name: brandName, isActive: true },
                update: { isActive: true },
                select: { id: true },
            });
            brandId = brand.id;
        }

        const identifiers = await allocateProductIdentifiers(tx, data.sku, data.barcode);

        const created = await tx.product.create({
          data: {
            name: data.name,
            productName: data.productName || data.name,
            sku: identifiers.sku,
            barcode: identifiers.barcode,
            barcodeOrigin: identifiers.barcodeOrigin,
            brandId,
            category: data.category || null,
            categoryGroup: data.categoryGroup || data.category || null,
            vendorSource: data.vendorSource || null,
            productCodeVariant: data.productCodeVariant || null,
            sizeValue: data.sizeValue ?? null,
            sizeUnit: normalizeUnitLabel(data.sizeUnit, "STANDARD"),
            ratePerPiece: data.ratePerPiece ?? null,
            packageQuantity:
                data.packageQuantity === null || data.packageQuantity === undefined
                    ? null
                    : normalizePositiveNumber(data.packageQuantity, 1),
            packageUnit: normalizeUnitLabel(data.packageUnit, "PIECE"),
            saleUnit: normalizeUnitLabel(data.saleUnit, "PIECE"),
            allowFractionalQty: data.allowFractionalQty ?? false,
            quantityStep: normalizePositiveNumber(data.quantityStep, 1),
            wholesaleEligible: data.wholesaleEligible ?? true,
            sourceCitation: data.sourceCitation || null,
            availabilityStatus:
                data.availabilityStatus ||
                (data.ratePerPiece === null || data.ratePerPiece === undefined
                    ? "COMING_SOON"
                    : "CATALOG_LISTED"),
            sellingPriceStatus: resolveSellingPriceStatus(retailPrice, wholesalePrice),
            retailPrice,
            wholesalePrice,
            wholesaleQtyThreshold:
                data.wholesaleQtyThreshold ??
                settings.defaultWholesaleQtyThreshold, // fall back to business default if not provided
            usesDefaultWholesaleQtyThreshold,
            // Catalog mode does not claim uncounted inventory. A real opening
            // count is entered only after inventory tracking is enabled.
            stock:
                settings.businessMode === "CATALOG_ONLY"
                    ? 0
                    : data.stock ?? settings.defaultInitialStock,
            lowStockThreshold:
                data.lowStockThreshold ??
                settings.defaultLowStockThreshold,
            usesDefaultLowStockThreshold,
            isActive: data.isActive ?? true, // new products are active by default
            imageUrl: data.imageUrl ?? null,
          },
          include: { brand: { select: { id: true, name: true } } },
        });

        const initialStock = Number(created.stock || 0);
        if (initialStock > 0) {
            await tx.stockTransaction.create({
                data: {
                    productId: created.id,
                    type: "RESTOCK",
                    qtyDelta: initialStock,
                    reason: "Initial stock from product creation",
                    createdById: actorId,
                },
            });
        }
        await tx.auditLog.create({
            data: {
                actorId,
                action: "PRODUCT_CREATED",
                entityType: "Product",
                entityId: created.id,
                meta: { productName: created.name, sku: created.sku, initialStock },
            },
        });
        await rebuildProductSearchDocument(created.id, tx);
        return created;
    });

    return withAvailableStock(applyBusinessThresholds(product, settings));
}

const PRODUCT_CATALOG_DETAIL_LABELS: Record<string, string> = {
    name: "name",
    sku: "SKU",
    barcode: "barcode",
    brandId: "brand",
    category: "category",
    categoryGroup: "category group",
    vendorSource: "supplier",
    productCodeVariant: "variant",
    sizeValue: "size",
    sizeUnit: "size unit",
    packageQuantity: "package quantity",
    packageUnit: "package unit",
    saleUnit: "sale unit",
    allowFractionalQty: "fractional quantity setting",
    quantityStep: "quantity step",
    wholesaleEligible: "wholesale eligibility",
    sourceCitation: "source reference",
    wholesaleQtyThreshold: "wholesale threshold",
    usesDefaultWholesaleQtyThreshold: "wholesale threshold rule",
    imageUrl: "image",
};

function comparableProductValue(value: unknown) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    return String(value);
}

// updating an existing product — handles threshold flag logic, audit events,
// and image replacement
export async function updateProduct(
    id: string,
    data: Partial<CreateProductInput> & { isActive?: boolean },
    actor?: { id: string; role?: string },
) {
    let previousImageUrl: string | null = null;
    let previousThumbnailUrl: string | null = null;
    // Always capture the previous row. Besides image cleanup, this is what lets
    // us emit exact, non-duplicated price/status/details events for Alerts.
    const previousProduct = await prisma.product.findUnique({ where: { id } });
    if (!previousProduct) {
        const error: any = new Error("Product not found");
        error.code = "P2025";
        throw error;
    }

    // if the image URL is being changed, save the old one so we can delete the old file later
    if (data.imageUrl !== undefined) {
        previousImageUrl = previousProduct?.imageUrl ?? null;
        previousThumbnailUrl = previousProduct?.thumbnailUrl ?? null;
    }

    const updateData: any = { ...data };
    if (data.retailPrice !== undefined || data.wholesalePrice !== undefined) {
        const retailPrice = data.retailPrice !== undefined
            ? normalizeSellingPrice(data.retailPrice)
            : previousProduct.retailPrice;
        const wholesalePrice = data.wholesalePrice !== undefined
            ? normalizeSellingPrice(data.wholesalePrice)
            : previousProduct.wholesalePrice;
        updateData.retailPrice = retailPrice;
        updateData.wholesalePrice = wholesalePrice;
        updateData.sellingPriceStatus = resolveSellingPriceStatus(
            retailPrice,
            wholesalePrice,
        );
    }
    // A thumbnail belongs to one exact display image. Preserve it for ordinary
    // edits, but clear it if a legacy/direct image URL is removed or changed.
    if (
        data.imageUrl !== undefined &&
        (data.imageUrl ?? null) !== (previousProduct?.imageUrl ?? null)
    ) {
        updateData.thumbnailUrl = null;
    }

    // when a custom wholesale threshold is provided but usesDefault is not explicitly set,
    // we automatically set usesDefault to false because the admin is providing a custom value
    if (
        updateData.usesDefaultWholesaleQtyThreshold === undefined &&
        updateData.wholesaleQtyThreshold !== undefined
    ) {
        updateData.usesDefaultWholesaleQtyThreshold = false;
    }
    // same logic for low stock threshold
    if (
        updateData.usesDefaultLowStockThreshold === undefined &&
        updateData.lowStockThreshold !== undefined
    ) {
        updateData.usesDefaultLowStockThreshold = false;
    }

    // when switching back to default, we remove the custom threshold value from the update
    // so the stored value stays untouched and the product just uses the global default
    if (
        updateData.usesDefaultWholesaleQtyThreshold === true &&
        updateData.wholesaleQtyThreshold === undefined
    ) {
        delete updateData.wholesaleQtyThreshold;
    }
    if (
        updateData.usesDefaultLowStockThreshold === true &&
        updateData.lowStockThreshold === undefined
    ) {
        delete updateData.lowStockThreshold;
    }

    const product = await prisma.$transaction(async (tx) => {
        if (!updateData.brandId && updateData.brandName) {
            const brandName = String(updateData.brandName).trim().replace(/\s+/g, " ");
            const brand = await tx.brand.upsert({
                where: { name: brandName },
                create: { name: brandName, isActive: true },
                update: { isActive: true },
                select: { id: true },
            });
            updateData.brandId = brand.id;
        }
        delete updateData.brandName;
        const updated = await tx.product.update({
            where: { id },
            data: updateData,
            include: { brand: { select: { id: true, name: true } } },
        });
        await rebuildProductSearchDocument(updated.id, tx);

        if (actor?.id) {
            const priceChanged =
                (data.retailPrice !== undefined && Number(previousProduct.retailPrice) !== Number(updated.retailPrice)) ||
                (data.wholesalePrice !== undefined && Number(previousProduct.wholesalePrice) !== Number(updated.wholesalePrice)) ||
                (data.ratePerPiece !== undefined &&
                    comparableProductValue(previousProduct.ratePerPiece) !==
                        comparableProductValue(updated.ratePerPiece));
            const statusChanged =
                data.isActive !== undefined && previousProduct.isActive !== updated.isActive;
            const changedDetailFields = Object.entries(PRODUCT_CATALOG_DETAIL_LABELS)
                .filter(([field]) =>
                    updateData[field] !== undefined &&
                    comparableProductValue((previousProduct as any)[field]) !==
                        comparableProductValue((updated as any)[field]),
                )
                .map(([, label]) => label);

            if (priceChanged) {
                await tx.auditLog.create({
                    data: {
                        actorId: actor.id,
                        action: "PRODUCT_PRICE_UPDATED",
                        entityType: "Product",
                        entityId: updated.id,
                        meta: {
                            actorRole: actor.role,
                            productName: updated.name,
                            sku: updated.sku,
                            before: {
                                retailPrice: previousProduct.retailPrice,
                                wholesalePrice: previousProduct.wholesalePrice,
                                ratePerPiece: previousProduct.ratePerPiece,
                            },
                            after: {
                                retailPrice: updated.retailPrice,
                                wholesalePrice: updated.wholesalePrice,
                                ratePerPiece: updated.ratePerPiece,
                            },
                        },
                    },
                });
            }

            if (statusChanged) {
                await tx.auditLog.create({
                    data: {
                        actorId: actor.id,
                        action: updated.isActive ? "PRODUCT_ACTIVATED" : "PRODUCT_DEACTIVATED",
                        entityType: "Product",
                        entityId: updated.id,
                        meta: {
                            actorRole: actor.role,
                            productName: updated.name,
                            sku: updated.sku,
                        },
                    },
                });
            }

            if (changedDetailFields.length > 0) {
                await tx.auditLog.create({
                    data: {
                        actorId: actor.id,
                        action: "PRODUCT_UPDATED",
                        entityType: "Product",
                        entityId: updated.id,
                        meta: {
                            actorRole: actor.role,
                            productName: updated.name,
                            sku: updated.sku,
                            changedFields: changedDetailFields,
                        },
                    },
                });
            }
        }
        return updated;
    });

    // deleting the old image file from disk if the image was changed
    if (data.imageUrl !== undefined) {
        await Promise.all([
            deleteReplacedUpload(previousImageUrl, product.imageUrl),
            deleteReplacedUpload(previousThumbnailUrl, product.thumbnailUrl),
        ]);
    }

    const settings = await getBusinessSettings();
    return withAvailableStock(applyBusinessThresholds(product, settings)); // returning the product with resolved thresholds
}

// deactivating a product by setting isActive to false
// the product data stays in the database for existing invoices and history
export async function deactivateProduct(id: string, actorId?: string) {
    const existing = await prisma.product.findUnique({
        where: { id },
        select: { id: true, name: true, sku: true, isActive: true },
    });
    if (!existing) {
        const error: any = new Error("Product not found");
        error.code = "P2025";
        throw error;
    }
    if (!existing.isActive) {
        return {
            product: existing,
            changed: false,
            message: "Product is already inactive.",
        };
    }

    const product = await prisma.$transaction(async (tx) => {
        const product = await tx.product.update({
            where: { id },
            data: { isActive: false },
            select: { id: true, name: true, sku: true, isActive: true },
        });

        if (actorId) {
            await tx.auditLog.create({
                data: {
                    actorId,
                    action: "PRODUCT_DEACTIVATED",
                    entityType: "Product",
                    entityId: product.id,
                    meta: {
                        productName: product.name,
                        sku: product.sku,
                    },
                },
            });
        }

        return product;
    });

    return {
        product,
        changed: true,
        message: "Product set to Inactive.",
    };
}

async function buildProductDeleteSafety(db: any, id: string): Promise<ProductDeleteSafety> {
    const product = await db.product.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            stock: true,
            reservedStock: true,
        },
    });
    if (!product) {
        const error: any = new Error("Product not found");
        error.code = "P2025";
        throw error;
    }

    const [
        invoiceItems,
        stockTransactions,
        returnItems,
        priceOverrides,
        draftRequestItems,
        linkedDocuments,
    ] = await Promise.all([
        db.invoiceItem.count({ where: { productId: id } }),
        db.stockTransaction.count({ where: { productId: id } }),
        db.returnItem.count({ where: { productId: id } }),
        db.priceOverrideAuthorization.count({ where: { productId: id } }),
        db.draftRequestItem.count({ where: { productId: id } }),
        db.document.count({
            where: {
                linkedEntityType: "Product",
                linkedEntityId: id,
                deletedAt: null,
            },
        }),
    ]);

    const references = [
        { label: "invoice item(s)", count: invoiceItems },
        { label: "stock transaction(s)", count: stockTransactions },
        { label: "return item(s)", count: returnItems },
        { label: "price override authorization(s)", count: priceOverrides },
        { label: "draft request item(s)", count: draftRequestItems },
        { label: "linked document(s)", count: linkedDocuments },
    ].filter((item) => item.count > 0);

    const stock = Number(product.stock || 0);
    const reservedStock = Number(product.reservedStock || 0);
    const stockBlocker =
        stock !== 0 || reservedStock !== 0
            ? `Stock must be zero before permanent delete. Current stock: ${stock}, reserved: ${reservedStock}.`
            : null;
    const { canPermanentDelete, canDiscardStockAndDelete } = evaluateProductDeletePolicy({
        referenceCount: references.length,
        stock,
        reservedStock,
    });

    return {
        productId: product.id,
        productName: product.name,
        canPermanentDelete,
        references,
        stockBlocker,
        canDiscardStockAndDelete,
        safeReason: canPermanentDelete
            ? "No stock, reserved stock, or transactional references were found."
            : null,
        recommendedAction: canPermanentDelete ? "PERMANENT_DELETE" : "SET_INACTIVE",
    };
}

export async function getProductDeleteSafety(id: string): Promise<ProductDeleteSafety> {
    return buildProductDeleteSafety(prisma, id);
}

export async function permanentlyDeleteProduct(id: string, actorId: string) {
    const safety = await getProductDeleteSafety(id);
    if (!safety.canPermanentDelete) {
        const error: any = new Error("Product cannot be permanently deleted.");
        error.code = "PRODUCT_DELETE_BLOCKED";
        error.safety = safety;
        throw error;
    }

    const product = await prisma.product.delete({
        where: { id },
        select: { id: true, name: true, sku: true, imageUrl: true, thumbnailUrl: true },
    });

    await Promise.all([
        deleteUploadFile(product.imageUrl),
        deleteUploadFile(product.thumbnailUrl),
    ]);

    await prisma.auditLog.create({
        data: {
            actorId,
            action: "PRODUCT_PERMANENTLY_DELETED",
            entityType: "Product",
            entityId: product.id,
            meta: {
                productName: product.name,
                sku: product.sku,
                safeReason: safety.safeReason,
            },
        },
    }).catch(() => undefined);

    return {
        deleted: true,
        product,
        safety,
        message: `${product.name} permanently deleted.`,
    };
}

export async function discardStockAndPermanentlyDeleteProduct(id: string, actorId: string) {
    const result = await prisma.$transaction(async (tx) => {
        const safety = await buildProductDeleteSafety(tx, id);
        if (!safety.canDiscardStockAndDelete) {
            const error: any = new Error(
                "Stock can only be discarded for an unreferenced product with no reserved quantity.",
            );
            error.code = "PRODUCT_STOCK_DISCARD_DELETE_BLOCKED";
            error.safety = safety;
            throw error;
        }

        const productBeforeDelete = await tx.product.findUniqueOrThrow({
            where: { id },
            select: { id: true, name: true, sku: true, stock: true, imageUrl: true, thumbnailUrl: true },
        });

        await tx.product.update({ where: { id }, data: { stock: 0 } });
        const product = await tx.product.delete({
            where: { id },
            select: { id: true, name: true, sku: true, imageUrl: true, thumbnailUrl: true },
        });

        await tx.auditLog.create({
            data: {
                actorId,
                action: "PRODUCT_STOCK_DISCARDED_AND_PERMANENTLY_DELETED",
                entityType: "Product",
                entityId: product.id,
                meta: {
                    productName: product.name,
                    sku: product.sku,
                    discardedStock: productBeforeDelete.stock,
                    reason: "Unreferenced product removed from catalog",
                },
            },
        });

        return { product, safety, discardedStock: Number(productBeforeDelete.stock || 0) };
    });

    await Promise.all([
        deleteUploadFile(result.product.imageUrl),
        deleteUploadFile(result.product.thumbnailUrl),
    ]);
    return {
        deleted: true,
        ...result,
        message: `${result.product.name} stock was set to zero and the product was permanently deleted.`,
    };
}

// fetching all unique categories from existing products, sorted alphabetically
// we filter out null categories and return just the category strings
export async function getCategories() {
    const products = await prisma.product.findMany({
        where: { category: { not: null } },
        select: { category: true },
        distinct: ["category"], // only unique values
        orderBy: { category: "asc" },
    });
    return products.map((p) => p.category).filter(Boolean);
}

// Re-export modularized product utilities, import logic, and pricing logic
export * from "./productUtils";
export * from "./importService";
export * from "./pricingService";
