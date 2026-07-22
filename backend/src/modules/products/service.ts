import { DraftRequestStatus, type Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { deleteReplacedUpload, deleteUploadFile } from "../../lib/uploads";
import {
    applyBusinessThresholds,
    getBusinessSettings,
} from "../settings/service";

// defining the shape of filters that can be passed when listing products
interface ProductFilters {
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

type BulkPriceFilterInput = {
    search?: string;
    brand?: string;
    category?: string;
    isActive?: boolean;
    lowStockOnly?: boolean;
    stockStatus?: "in" | "low" | "out";
};

type ProductImportPreviewRowDraft = {
    rowNumber: number;
    rawText: string | null;
    status: string;
    error?: string | null;
    parsed?: Prisma.InputJsonValue;
};

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

    // searching by name, SKU, or exact barcode match
    if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
            { name: { contains: s } },
            { productName: { contains: s } },
            { sku: { contains: s } },
            { barcode: { equals: s } },
            { productCodeVariant: { contains: s } },
            { categoryGroup: { contains: s } },
            { vendorSource: { contains: s } },
        ];
    }

    if (brand) where.brandId = brand; // filtering by brand ID
    if (category) where.category = category; // filtering by category
    if (isActive !== undefined) where.isActive = isActive; // filtering by active status
    if (stockStatus === "out") where.stock = { lte: 0 };

    if (lowStockOnly) {
    }

    const skip = (page - 1) * pageSize; // calculating how many records to skip for pagination
    const settings = await getBusinessSettings(); // fetching business settings to resolve thresholds

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

function normalizeUnitLabel(value: unknown, fallback: string) {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized || fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number) {
    const normalized = Number(value ?? fallback);
    if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
    return normalized;
}

function roundCurrency(value: number) {
    return Math.round(Number(value || 0) * 100) / 100;
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

function applyImportRetailMargin(basePrice: number, marginPercent = 18) {
    const normalizedBase = Number(basePrice || 0);
    const normalizedMargin = Number(marginPercent);
    if (!Number.isFinite(normalizedBase) || normalizedBase <= 0) return 0;
    if (!Number.isFinite(normalizedMargin) || normalizedMargin <= 0) {
        return roundCurrency(normalizedBase);
    }
    return roundCurrency(normalizedBase * (1 + normalizedMargin / 100));
}

export function buildInitialSupplierStock(packageQuantity: unknown) {
    return 0;
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
    sku: string;
    barcode?: string;
    brandId: string;
    category?: string;
    categoryGroup?: string | null;
    vendorSource?: string | null;
    productCodeVariant?: string | null;
    sizeValue?: number | null;
    sizeUnit?: string | null;
    ratePerPiece?: number;
    packageQuantity?: number;
    packageUnit?: string | null;
    saleUnit?: string | null;
    allowFractionalQty?: boolean;
    quantityStep?: number;
    wholesaleEligible?: boolean;
    sourceCitation?: string | null;
    retailPrice: number;
    wholesalePrice: number;
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
export async function createProduct(data: CreateProductInput) {
    const settings = await getBusinessSettings();

    // determining whether to use default thresholds
    // if the admin explicitly set usesDefault, we use that value
    // otherwise, we check if a custom threshold was provided — if not, it defaults to using the business default
    const usesDefaultWholesaleQtyThreshold =
        data.usesDefaultWholesaleQtyThreshold ??
        (data.wholesaleQtyThreshold === undefined);
    const usesDefaultLowStockThreshold =
        data.usesDefaultLowStockThreshold ??
        (data.lowStockThreshold === undefined);

    const product = await prisma.product.create({
        data: {
            name: data.name,
            productName: data.productName || data.name,
            sku: data.sku,
            barcode: data.barcode || null,
            brandId: data.brandId,
            category: data.category || null,
            categoryGroup: data.categoryGroup || data.category || null,
            vendorSource: data.vendorSource || null,
            productCodeVariant: data.productCodeVariant || null,
            sizeValue: data.sizeValue ?? null,
            sizeUnit: normalizeUnitLabel(data.sizeUnit, "STANDARD"),
            ratePerPiece: data.ratePerPiece ?? data.retailPrice,
            packageQuantity: normalizePositiveNumber(data.packageQuantity, 1),
            packageUnit: normalizeUnitLabel(data.packageUnit, "PIECE"),
            saleUnit: normalizeUnitLabel(data.saleUnit, "PIECE"),
            allowFractionalQty: data.allowFractionalQty ?? false,
            quantityStep: normalizePositiveNumber(data.quantityStep, 1),
            wholesaleEligible: data.wholesaleEligible ?? true,
            sourceCitation: data.sourceCitation || null,
            retailPrice: data.retailPrice,
            wholesalePrice: data.wholesalePrice,
            wholesaleQtyThreshold:
                data.wholesaleQtyThreshold ??
                settings.defaultWholesaleQtyThreshold, // fall back to business default if not provided
            usesDefaultWholesaleQtyThreshold,
            stock: data.stock ?? 0, // default stock is 0 for new products
            lowStockThreshold:
                data.lowStockThreshold ??
                settings.defaultLowStockThreshold,
            usesDefaultLowStockThreshold,
            isActive: data.isActive ?? true, // new products are active by default
            imageUrl: data.imageUrl ?? null,
        },
        include: { brand: { select: { id: true, name: true } } },
    });

    return withAvailableStock(applyBusinessThresholds(product, settings));
}

// updating an existing product — handles threshold flag logic and image replacement
export async function updateProduct(
    id: string,
    data: Partial<CreateProductInput> & { isActive?: boolean },
    actor?: { id: string; role?: string },
) {
    let previousImageUrl: string | null = null;
    const needsPreviousProduct =
        data.imageUrl !== undefined ||
        data.retailPrice !== undefined ||
        data.wholesalePrice !== undefined ||
        data.ratePerPiece !== undefined;
    const previousProduct = needsPreviousProduct
        ? await prisma.product.findUnique({
            where: { id },
            select: {
                id: true,
                name: true,
                sku: true,
                imageUrl: true,
                retailPrice: true,
                wholesalePrice: true,
                ratePerPiece: true,
            },
        })
        : null;

    // if the image URL is being changed, save the old one so we can delete the old file later
    if (data.imageUrl !== undefined) {
        previousImageUrl = previousProduct?.imageUrl ?? null;
    }

    const updateData: any = { ...data };

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

    const product = await prisma.product.update({
        where: { id },
        data: updateData,
        include: { brand: { select: { id: true, name: true } } },
    });

    const priceChanged =
        !!previousProduct &&
        (
            (data.retailPrice !== undefined && Number(previousProduct.retailPrice) !== Number(product.retailPrice)) ||
            (data.wholesalePrice !== undefined && Number(previousProduct.wholesalePrice) !== Number(product.wholesalePrice)) ||
            (data.ratePerPiece !== undefined && Number(previousProduct.ratePerPiece) !== Number(product.ratePerPiece))
        );

    if (actor?.id && priceChanged) {
        await prisma.auditLog.create({
            data: {
                actorId: actor.id,
                action: "PRODUCT_PRICE_UPDATED",
                entityType: "Product",
                entityId: product.id,
                meta: {
                    actorRole: actor.role,
                    productName: product.name,
                    sku: product.sku,
                    before: {
                        retailPrice: previousProduct.retailPrice,
                        wholesalePrice: previousProduct.wholesalePrice,
                        ratePerPiece: previousProduct.ratePerPiece,
                    },
                    after: {
                        retailPrice: product.retailPrice,
                        wholesalePrice: product.wholesalePrice,
                        ratePerPiece: product.ratePerPiece,
                    },
                },
            },
        }).catch(() => undefined);
    }

    // deleting the old image file from disk if the image was changed
    if (data.imageUrl !== undefined) {
        await deleteReplacedUpload(previousImageUrl, product.imageUrl);
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

export async function getProductDeleteSafety(id: string): Promise<ProductDeleteSafety> {
    const product = await prisma.product.findUnique({
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
        prisma.invoiceItem.count({ where: { productId: id } }),
        prisma.stockTransaction.count({ where: { productId: id } }),
        prisma.returnItem.count({ where: { productId: id } }),
        prisma.priceOverrideAuthorization.count({ where: { productId: id } }),
        prisma.draftRequestItem.count({ where: { productId: id } }),
        prisma.document.count({
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
    const canPermanentDelete = references.length === 0 && !stockBlocker;

    return {
        productId: product.id,
        productName: product.name,
        canPermanentDelete,
        references,
        stockBlocker,
        safeReason: canPermanentDelete
            ? "No stock, reserved stock, or transactional references were found."
            : null,
        recommendedAction: canPermanentDelete ? "PERMANENT_DELETE" : "SET_INACTIVE",
    };
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
        select: { id: true, name: true, sku: true, imageUrl: true },
    });

    await deleteUploadFile(product.imageUrl);

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

// --

// defining the shape of a normalized CSV import row
type CsvImportRow = {
    name: string;
    productName?: string | null;
    sku: string;
    skuWasGenerated?: boolean;
    barcode?: string;
    brand?: string;
    brandId?: string;
    category?: string;
    categoryGroup?: string | null;
    vendorSource?: string | null;
    productCodeVariant?: string | null;
    sizeValue?: number | null;
    sizeUnit?: string | null;
    ratePerPiece?: number;
    packageQuantity?: number;
    packageUnit?: string | null;
    saleUnit?: string | null;
    allowFractionalQty?: boolean;
    quantityStep?: number;
    wholesaleEligible?: boolean;
    sourceCitation?: string | null;
    retailPrice: number;
    wholesalePrice: number;
    stock?: number;
};

// defining the shape of an import error — includes the row number and original values for debugging
type CsvImportError = {
    rowNumber: number;
    sku?: string;
    name?: string;
    message: string;
};

type ReviewedPdfImportRowInput = {
    rowId: string;
    name?: string;
    sku?: string;
    barcode?: string;
    brand?: string;
    category?: string;
    categoryGroup?: string;
    vendorSource?: string;
    productCodeVariant?: string;
    sizeValue?: number | string | null;
    sizeUnit?: string;
    ratePerPiece?: number | string;
    packageQuantity?: number | string;
    packageUnit?: string;
    saleUnit?: string;
    allowFractionalQty?: boolean;
    quantityStep?: number | string;
    wholesaleEligible?: boolean;
    sourceCitation?: string;
    retailPrice?: number | string;
    wholesalePrice?: number | string;
    stock?: number | string;
};

type ProductImportColumnMap = Record<string, string | string[] | undefined>;

type ProductImportDefaults = {
    supplier?: string;
    brand?: string;
    category?: string;
    categoryGroup?: string;
    packageUnit?: string;
    saleUnit?: string;
    stock?: number;
    retailMarginPercent?: number;
    wholesaleEligible?: boolean;
};

type CsvImportOptions = {
    fieldMap?: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
};

// safely converting a CSV cell value to a trimmed string
function normalizeCsvText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function getCsvCell(row: Record<string, unknown>, ...names: string[]) {
    for (const name of names) {
        const key = name.trim().toLowerCase();
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return value;
        }
    }
    return undefined;
}

function getMappedCsvCell(
    row: Record<string, unknown>,
    fieldMap: ProductImportColumnMap | undefined,
    canonicalName: string,
    ...aliases: string[]
) {
    const mapped = fieldMap?.[canonicalName];
    const mappedNames = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
    return getCsvCell(row, ...mappedNames, ...aliases);
}

function slugifySkuPart(value: string) {
    return value
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[_\s]+/g, "-")
        .replace(/-+/g, "-")
        .toUpperCase()
        .slice(0, 36);
}

function parseBooleanCsvValue(value: unknown, fallback: boolean) {
    const normalized = normalizeCsvText(value).toLowerCase();
    if (!normalized) return fallback;
    if (["true", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
    return fallback;
}

function escapeImportRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importNumberPattern(value: number) {
    const normalized = String(Number(value || 0));
    if (!normalized || normalized === "0") return "";
    const [whole, decimal] = normalized.split(".");
    const formattedWhole = Number(whole).toLocaleString("en-US", {
        maximumFractionDigits: 0,
    });
    const wholePattern =
        formattedWhole === whole
            ? escapeImportRegExp(whole)
            : `(?:${escapeImportRegExp(whole)}|${escapeImportRegExp(formattedWhole)})`;
    return decimal
        ? `${wholePattern}\\.${escapeImportRegExp(decimal)}0*`
        : `${wholePattern}(?:\\.0+)?`;
}

function cleanImportedProductName(rawName: string, rate: number) {
    const normalized = normalizeCsvText(rawName);
    if (!normalized) return "";

    const ratePattern = importNumberPattern(rate);
    let cleaned = normalized;
    if (ratePattern) {
        const withoutRate = cleaned
            .replace(new RegExp(`\\bMRP\\b\\s*(?:Rs\\.?|NPR)?\\s*${ratePattern}\\b`, "i"), " ")
            .replace(new RegExp(`(?:Rs\\.?|NPR|Price|Rate)\\s*${ratePattern}\\b`, "i"), " ")
            .replace(new RegExp(`\\s+${ratePattern}\\s*$`, "i"), " ")
            .replace(/\s+/g, " ")
            .trim();
        if (withoutRate !== cleaned) {
            cleaned = withoutRate.replace(/\s+\d+(?:,\d{3})*(?:\.\d+)?\s*$/, " ").trim();
        }
    }

    return (
        cleaned
            .replace(/^\s*(?:s\.?\s*n\.?|sl\.?|sn|#)?\s*\d+\s*[-.)]?\s*/i, "")
            .replace(/\b(?:npr|rs\.?|mrp|rate|price)\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim() || normalized
    );
}

function parseProductSize(rawName: string) {
    const patterns: Array<{ unit: string; regex: RegExp }> = [
        { unit: "LTR", regex: /(\d+(?:\.\d+)?)\s*(?:ltrs?|ltr\.?|liters?|litres?|itr)\b/i },
        { unit: "KG", regex: /(\d+(?:\.\d+)?)\s*(?:kgs?|kilograms?)\b/i },
        { unit: "GRAM", regex: /(\d+(?:\.\d+)?)\s*(?:grams?|gms?|gm|g)\b/i },
        { unit: "INCH", regex: /(\d+(?:\.\d+)?)\s*(?:"|inches|inch|in\b)/i },
        { unit: "CM", regex: /(\d+(?:\.\d+)?)\s*(?:cms?|centimeters?)\b/i },
        { unit: "METER", regex: /(\d+(?:\.\d+)?)\s*(?:mtrs?|meters?|metres?)\b/i },
        { unit: "ML", regex: /(\d+(?:\.\d+)?)\s*(?:ml|milliliters?|millilitres?)\b/i },
    ];

    for (const pattern of patterns) {
        const match = rawName.match(pattern.regex);
        if (!match) continue;

        const sizeValue = Number(match[1]);
        const productName = rawName
            .replace(match[0], "")
            .replace(/\s{2,}/g, " ")
            .replace(/\s+([-/])/g, "$1")
            .replace(/[-/]\s*$/g, "")
            .trim();

        return {
            productName: productName || rawName.trim(),
            sizeValue: Number.isFinite(sizeValue) ? sizeValue : null,
            sizeUnit: pattern.unit,
        };
    }

    return {
        productName: rawName.trim(),
        sizeValue: null,
        sizeUnit: "STANDARD",
    };
}

function buildSupplierSku(vendorSource: string, serial: string, productName: string, variant?: string) {
    const vendorPart = slugifySkuPart(vendorSource) || "SUPPLIER";
    const serialPart = slugifySkuPart(serial) || slugifySkuPart(productName).slice(0, 12) || "ITEM";
    const variantPart = variant ? `-${slugifySkuPart(variant).slice(0, 16)}` : "";
    return `${vendorPart}-${serialPart}${variantPart}`.slice(0, 80);
}

// parsing a numeric value from a CSV cell with validation
// supports optional minimum value check and the ability to allow blank cells
function parseCsvNumber(
    value: unknown,
    fieldName: string,
    rowNumber: number,
    options?: { min?: number; allowBlank?: boolean },
) {
    const raw = normalizeCsvText(value);

    if (!raw) {
        if (options?.allowBlank) return undefined; // blank is okay for optional fields like stock
        throw new Error(`Row ${rowNumber}: ${fieldName} is required.`);
    }

    const parsed = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
        throw new Error(`Row ${rowNumber}: ${fieldName} must be a valid number.`);
    }

    if (typeof options?.min === "number" && parsed < options.min) {
        throw new Error(`Row ${rowNumber}: ${fieldName} must be at least ${options.min}.`);
    }

    return parsed;
}

// resolving the brand ID for a CSV import row
// the CSV can provide either a brandId (direct reference) or a brand name
// if a brand name is given and does not exist yet, we automatically create it
// we cache brand lookups so repeated brand names do not cause extra database queries
async function resolveBrandIdForImport(
    tx: Prisma.TransactionClient,
    row: CsvImportRow,
    rowNumber: number,
    brandCache: Map<string, string>,
) {
    const brandId = normalizeCsvText(row.brandId);
    if (brandId) {
        const brand = await tx.brand.findUnique({ where: { id: brandId } }); // looking up brand by ID
        if (!brand) {
            throw new Error(`Row ${rowNumber}: brandId "${brandId}" was not found.`);
        }
        brandCache.set(brand.name.toLowerCase(), brand.id); // caching for future rows
        return brand.id;
    }

    const brandName = normalizeCsvText(row.brand);
    if (!brandName) {
        throw new Error(`Row ${rowNumber}: brand or brandId is required.`);
    }

    // checking the cache first to avoid redundant database lookups
    const cacheKey = brandName.toLowerCase();
    const cachedBrandId = brandCache.get(cacheKey);
    if (cachedBrandId) {
        return cachedBrandId;
    }

    // looking up the brand by name in the database (case-insensitive comparison)
    const existingBrand = (await tx.brand.findMany({
        select: { id: true, name: true },
    })).find((brand) => brand.name.toLowerCase() === cacheKey);

    if (existingBrand) {
        brandCache.set(cacheKey, existingBrand.id);
        return existingBrand.id;
    }

    // brand does not exist yet — creating it automatically
    const createdBrand = await tx.brand.create({
        data: {
            name: brandName,
            isActive: true,
        },
        select: { id: true, name: true },
    });

    brandCache.set(cacheKey, createdBrand.id);
    return createdBrand.id;
}

// normalizing a raw CSV row into our typed CsvImportRow format
// we lowercase all column headers so "RetailPrice", "retailprice", and "RETAILPRICE" all work
function normalizeCsvImportRow(
    rawRow: Record<string, unknown>,
    rowNumber: number,
    options: CsvImportOptions = {},
): CsvImportRow {
    // converting all column keys to lowercase and trimming them
    const normalizedRow = Object.entries(rawRow).reduce<Record<string, unknown>>((acc, [key, value]) => {
        acc[key.trim().toLowerCase()] = value;
        return acc;
    }, {});

    const defaults = options.defaults || {};
    const supplierProductName = normalizeCsvText(
        getMappedCsvCell(
            normalizedRow,
            options.fieldMap,
            "productName",
            "product_name",
            "product name",
            "productname",
            "item name",
            "item_name",
            "description",
            "product",
            "article",
        ),
    );
    const vendorSource =
        normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "supplier",
                "vendor_source",
                "vendor source",
                "vendorsource",
                "supplier",
                "supplier name",
                "supplier_name",
                "brand",
                "company",
            ),
        ) || normalizeCsvText(defaults.supplier);

    if (supplierProductName || vendorSource) {
        let fullName = supplierProductName;
        const variant = normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "variant",
                "product_code_variant",
                "product code variant",
                "productcodevariant",
                "variant",
                "code",
                "model",
                "series",
            ),
        );
        const serial = normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "serial",
                "s_n",
                "sn",
                "s.n",
                "serial",
                "sl",
                "sl.",
                "#",
            ),
        );
        const packageQuantity =
            parseCsvNumber(
                getMappedCsvCell(
                    normalizedRow,
                    options.fieldMap,
                    "packageQuantity",
                    "package_qty",
                    "package qty",
                    "packagequantity",
                    "package_quantity",
                    "pack",
                    "pkg",
                    "pkg.",
                    "carton",
                    "case",
                ),
                "Package_Qty",
                rowNumber,
                { min: 0, allowBlank: true },
            ) ?? 1;
        const wholesaleCsvPrice = parseCsvNumber(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "wholesalePrice",
                "wholesaleprice",
                "wholesale_price",
                "wsp",
                "dealer price",
                "dealer_price",
                "rate",
                "rateperpiece",
                "rate_per_piece",
                "base price",
                "base_price",
            ),
            "Wholesale price",
            rowNumber,
            { min: 0.01, allowBlank: true },
        );
        const retailCsvPrice = parseCsvNumber(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "retailPrice",
                "retailprice",
                "retail_price",
                "mrp",
                "maximum retail price",
                "price",
            ),
            "Retail price",
            rowNumber,
            { min: 0.01, allowBlank: true },
        );
        const rate = wholesaleCsvPrice ?? retailCsvPrice;
        if (!rate) {
            throw new Error(`Row ${rowNumber}: price is required. Map MRP, WSP, Rate, or Price.`);
        }
        fullName = cleanImportedProductName(fullName, rate);
        const parsedSize = parseProductSize(fullName);
        const providedSku = normalizeCsvText(
            getMappedCsvCell(normalizedRow, options.fieldMap, "sku", "sku", "item code", "item_code"),
        );
        const sku =
            providedSku ||
            buildSupplierSku(vendorSource || "Supplier", serial, fullName, variant);
        const wholesaleEligible = parseBooleanCsvValue(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "wholesaleEligible",
                "wholesale_eligible",
                "wholesaleeligible",
            ),
            defaults.wholesaleEligible ?? !/fixed\s*price/i.test(vendorSource),
        );
        const saleUnit = normalizeUnitLabel(
            getMappedCsvCell(normalizedRow, options.fieldMap, "saleUnit", "sale_unit", "saleunit"),
            defaults.saleUnit || "PIECE",
        );
        const allowFractionalQty = parseBooleanCsvValue(
            getCsvCell(normalizedRow, "allow_fractional_qty", "allowfractionalqty"),
            ["KG", "GRAM", "METER"].includes(saleUnit),
        );

        if (!fullName) {
            throw new Error(`Row ${rowNumber}: Product_Name is required.`);
        }

        return {
            name: fullName,
            productName: parsedSize.productName,
            sku,
            skuWasGenerated: !providedSku,
            barcode: normalizeCsvText(getCsvCell(normalizedRow, "barcode")) || undefined,
            brand: normalizeCsvText(defaults.brand) || vendorSource || "Supplier",
            brandId: undefined,
            category: normalizeCsvText(defaults.category) || vendorSource || "Supplier",
            categoryGroup:
                normalizeCsvText(defaults.categoryGroup) ||
                normalizeCsvText(defaults.category) ||
                vendorSource ||
                null,
            vendorSource: vendorSource || null,
            productCodeVariant: variant || null,
            sizeValue: parsedSize.sizeValue,
            sizeUnit: parsedSize.sizeUnit,
            ratePerPiece: rate,
            packageQuantity,
            packageUnit: normalizeUnitLabel(
                getMappedCsvCell(
                    normalizedRow,
                    options.fieldMap,
                    "packageUnit",
                    "package_unit",
                    "packageunit",
                ),
                defaults.packageUnit || "PIECE",
            ),
            saleUnit,
            allowFractionalQty,
            quantityStep: allowFractionalQty ? 0.01 : 1,
            wholesaleEligible,
            sourceCitation:
                normalizeCsvText(getCsvCell(normalizedRow, "citation", "sourcecitation")) ||
                null,
            retailPrice:
                retailCsvPrice ??
                (wholesaleCsvPrice
                    ? applyImportRetailMargin(wholesaleCsvPrice, defaults.retailMarginPercent ?? 18)
                    : rate),
            wholesalePrice: wholesaleCsvPrice ?? retailCsvPrice ?? rate,
            stock:
                parseCsvNumber(
                    getMappedCsvCell(normalizedRow, options.fieldMap, "stock", "stock", "qty in stock"),
                    "stock",
                    rowNumber,
                    { min: 0, allowBlank: true },
                ) ?? Number(defaults.stock ?? 0),
        };
    }

    const name = normalizeCsvText(getCsvCell(normalizedRow, "name"));
    const sku = normalizeCsvText(getCsvCell(normalizedRow, "sku"));

    if (!name) {
        throw new Error(`Row ${rowNumber}: name is required.`);
    }

    if (!sku) {
        throw new Error(`Row ${rowNumber}: sku is required.`);
    }

    return {
        name,
        productName: normalizeCsvText(getCsvCell(normalizedRow, "productname", "product_name")) || name,
        sku,
        skuWasGenerated: false,
        barcode: normalizeCsvText(getCsvCell(normalizedRow, "barcode")) || undefined,
        brand: normalizeCsvText(getCsvCell(normalizedRow, "brand")) || undefined,
        brandId: normalizeCsvText(getCsvCell(normalizedRow, "brandid", "brand_id")) || undefined,
        category: normalizeCsvText(getCsvCell(normalizedRow, "category")) || undefined,
        categoryGroup:
            normalizeCsvText(getCsvCell(normalizedRow, "categorygroup", "category_group")) ||
            undefined,
        vendorSource:
            normalizeCsvText(getCsvCell(normalizedRow, "vendorsource", "vendor_source")) ||
            undefined,
        productCodeVariant:
            normalizeCsvText(
                getCsvCell(normalizedRow, "productcodevariant", "product_code_variant"),
            ) || undefined,
        sizeValue: parseCsvNumber(
            getCsvCell(normalizedRow, "sizevalue", "size_value"),
            "sizeValue",
            rowNumber,
            { min: 0, allowBlank: true },
        ),
        sizeUnit: normalizeUnitLabel(getCsvCell(normalizedRow, "sizeunit", "size_unit"), "STANDARD"),
        ratePerPiece: parseCsvNumber(
            getCsvCell(normalizedRow, "rateperpiece", "rate_per_piece"),
            "ratePerPiece",
            rowNumber,
            { min: 0.01, allowBlank: true },
        ),
        packageQuantity:
            parseCsvNumber(
                getCsvCell(normalizedRow, "packagequantity", "package_quantity"),
                "packageQuantity",
                rowNumber,
                { min: 0, allowBlank: true },
            ) ?? 1,
        packageUnit: normalizeUnitLabel(
            getCsvCell(normalizedRow, "packageunit", "package_unit"),
            "PIECE",
        ),
        saleUnit: normalizeUnitLabel(getCsvCell(normalizedRow, "saleunit", "sale_unit"), "PIECE"),
        allowFractionalQty: parseBooleanCsvValue(
            getCsvCell(normalizedRow, "allowfractionalqty", "allow_fractional_qty"),
            false,
        ),
        quantityStep:
            parseCsvNumber(
                getCsvCell(normalizedRow, "quantitystep", "quantity_step"),
                "quantityStep",
                rowNumber,
                { min: 0.001, allowBlank: true },
            ) ?? 1,
        wholesaleEligible: parseBooleanCsvValue(
            getCsvCell(normalizedRow, "wholesaleeligible", "wholesale_eligible"),
            true,
        ),
        sourceCitation:
            normalizeCsvText(getCsvCell(normalizedRow, "sourcecitation", "source_citation")) ||
            undefined,
        retailPrice: parseCsvNumber(getCsvCell(normalizedRow, "retailprice", "retail_price"), "retailPrice", rowNumber, { min: 0.01 })!,
        wholesalePrice: parseCsvNumber(getCsvCell(normalizedRow, "wholesaleprice", "wholesale_price"), "wholesalePrice", rowNumber, { min: 0.01 })!,
        stock:
            parseCsvNumber(getCsvCell(normalizedRow, "stock"), "stock", rowNumber, { min: 0, allowBlank: true }) ??
            Number(defaults.stock ?? 0),
    };
}

// processing all CSV rows and creating products one by one
// each row runs in its own transaction so one failing row does not block the others
// returns a summary with created count, error count, and details for both
export async function importProductsFromCsv(rawRows: Array<Record<string, unknown>>) {
    const createdProducts: Array<{ id: string; sku: string; name: string }> = [];
    const errors: CsvImportError[] = [];
    const brandCache = new Map<string, string>(); // caching brand lookups to reduce database queries
    const settings = await getBusinessSettings(); // fetching business defaults for new product thresholds

    // pre-loading all existing brands into the cache
    const existingBrands = await prisma.brand.findMany({
        select: { id: true, name: true },
    });
    existingBrands.forEach((brand) => brandCache.set(brand.name.toLowerCase(), brand.id));

    // processing each row — rowNumber starts at 2 because row 1 is the CSV header
    for (let index = 0; index < rawRows.length; index += 1) {
        const rowNumber = index + 2;
        const rawRow = rawRows[index];

        try {
            const row = normalizeCsvImportRow(rawRow, rowNumber); // parsing and validating the raw row

            const created = await prisma.$transaction(async (tx) => {
                const brandId = await resolveBrandIdForImport(tx, row, rowNumber, brandCache); // resolving or creating the brand

                let finalSku = row.sku;

                // checking if a product with this SKU already exists
                const duplicateSku = await tx.product.findUnique({
                    where: { sku: finalSku },
                    select: { id: true, name: true, vendorSource: true },
                });
                if (duplicateSku) {
                    const sameImportedProduct =
                        duplicateSku.name.trim().toLowerCase() === row.name.trim().toLowerCase() &&
                        normalizeCsvText(duplicateSku.vendorSource).toLowerCase() ===
                            normalizeCsvText(row.vendorSource).toLowerCase();

                    if (!row.skuWasGenerated || sameImportedProduct) {
                        throw new Error(`Row ${rowNumber}: SKU "${finalSku}" already exists.`);
                    }

                    const baseSku = `${finalSku}-${slugifySkuPart(row.name).slice(0, 18)}`.slice(0, 74);
                    let suffix = 1;
                    do {
                        finalSku = suffix === 1 ? baseSku : `${baseSku}-${suffix}`;
                        const existingCandidate = await tx.product.findUnique({
                            where: { sku: finalSku },
                            select: { id: true },
                        });
                        if (!existingCandidate) break;
                        suffix += 1;
                    } while (suffix < 100);

                    const unresolvedDuplicate = await tx.product.findUnique({
                        where: { sku: finalSku },
                        select: { id: true },
                    });
                    if (unresolvedDuplicate) {
                        throw new Error(`Row ${rowNumber}: could not generate a unique SKU for "${row.name}".`);
                    }
                }

                // checking if a product with this barcode already exists (only if barcode is provided)
                if (row.barcode) {
                    const duplicateBarcode = await tx.product.findUnique({
                        where: { barcode: row.barcode },
                        select: { id: true },
                    });
                    if (duplicateBarcode) {
                        throw new Error(`Row ${rowNumber}: barcode "${row.barcode}" already exists.`);
                    }
                }

                // creating the product with all business defaults applied
                // all imported products use the business default thresholds
                return tx.product.create({
                    data: {
                        name: row.name,
                        productName: row.productName || row.name,
                        sku: finalSku,
                        barcode: row.barcode || null,
                        brandId,
                        category: row.category || null,
                        categoryGroup: row.categoryGroup || row.category || null,
                        vendorSource: row.vendorSource || null,
                        productCodeVariant: row.productCodeVariant || null,
                        sizeValue: row.sizeValue ?? null,
                        sizeUnit: normalizeUnitLabel(row.sizeUnit, "STANDARD"),
                        ratePerPiece: row.ratePerPiece ?? row.retailPrice,
                        packageQuantity: normalizePositiveNumber(row.packageQuantity, 1),
                        packageUnit: normalizeUnitLabel(row.packageUnit, "PIECE"),
                        saleUnit: normalizeUnitLabel(row.saleUnit, "PIECE"),
                        allowFractionalQty: row.allowFractionalQty ?? false,
                        quantityStep: normalizePositiveNumber(row.quantityStep, 1),
                        wholesaleEligible: row.wholesaleEligible ?? true,
                        sourceCitation: row.sourceCitation || null,
                        retailPrice: row.retailPrice,
                        wholesalePrice: row.wholesalePrice,
                        wholesaleQtyThreshold: settings.defaultWholesaleQtyThreshold,
                        usesDefaultWholesaleQtyThreshold: true, // imported products always use business defaults
                        stock: row.stock ?? 0,
                        lowStockThreshold: settings.defaultLowStockThreshold,
                        usesDefaultLowStockThreshold: true,
                        isActive: true,
                    },
                    select: { id: true, sku: true, name: true },
                });
            });

            createdProducts.push(created);
        } catch (err: any) {
            // collecting the error so we can report it without stopping the entire import
            errors.push({
                rowNumber,
                sku: normalizeCsvText((rawRow as any).sku) || undefined,
                name:
                    normalizeCsvText((rawRow as any).name) ||
                    normalizeCsvText((rawRow as any).Product_Name) ||
                    undefined,
                message: err?.message || `Row ${rowNumber}: import failed.`,
            });
        }
    }

    // returning a summary of the import results
    return {
        totalRows: rawRows.length,
        createdCount: createdProducts.length,
        errorCount: errors.length,
        createdProducts,
        errors,
    };
}

function csvImportRowToParsedProduct(row: CsvImportRow) {
    const rate = Number(row.ratePerPiece ?? row.wholesalePrice ?? row.retailPrice ?? 0);
    return {
        name: row.name,
        productName: row.productName || row.name,
        sku: row.sku,
        barcode: row.barcode || "",
        brand: row.brand || row.vendorSource || "Supplier",
        category: row.category || row.vendorSource || "Supplier",
        categoryGroup: row.categoryGroup || row.category || row.vendorSource || "",
        vendorSource: row.vendorSource || "",
        productCodeVariant: row.productCodeVariant || "",
        sizeValue: row.sizeValue ?? null,
        sizeUnit: normalizeUnitLabel(row.sizeUnit, "STANDARD"),
        ratePerPiece: rate || row.retailPrice,
        packageQuantity: normalizePositiveNumber(row.packageQuantity, 1),
        packageUnit: normalizeUnitLabel(row.packageUnit, "PIECE"),
        saleUnit: normalizeUnitLabel(row.saleUnit, "PIECE"),
        allowFractionalQty: row.allowFractionalQty ?? false,
        quantityStep: normalizePositiveNumber(row.quantityStep, 1),
        wholesaleEligible: row.wholesaleEligible ?? true,
        sourceCitation: row.sourceCitation || "",
        retailPrice: row.retailPrice,
        wholesalePrice: row.wholesalePrice,
        stock: row.stock ?? 0,
    };
}

async function findImportDuplicate(parsed: ReturnType<typeof csvImportRowToParsedProduct>) {
    const checks: string[] = [];
    const existingSku = parsed.sku
        ? await prisma.product.findUnique({
              where: { sku: parsed.sku },
              select: { id: true, name: true, sku: true },
          })
        : null;
    if (existingSku) {
        checks.push(`SKU already exists on ${existingSku.name}`);
    }

    const existingBarcode = parsed.barcode
        ? await prisma.product.findUnique({
              where: { barcode: parsed.barcode },
              select: { id: true, name: true, barcode: true },
          })
        : null;
    if (existingBarcode) {
        checks.push(`Barcode already exists on ${existingBarcode.name}`);
    }

    return checks.length > 0 ? checks.join(". ") : null;
}

export async function createCsvImportPreview(input: {
    fileName?: string;
    rows: Array<Record<string, unknown>>;
    createdById: string;
    supplier?: string;
    templateId?: string;
    fieldMap?: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
}) {
    const createdRows: ProductImportPreviewRowDraft[] = [];
    const template = input.templateId
        ? await prisma.productImportTemplate.findUnique({ where: { id: input.templateId } })
        : null;
    const templateFieldMap =
        template?.fieldMap && typeof template.fieldMap === "object"
            ? (template.fieldMap as ProductImportColumnMap)
            : undefined;
    const templateDefaults =
        template?.defaults && typeof template.defaults === "object"
            ? (template.defaults as ProductImportDefaults)
            : undefined;
    const options: CsvImportOptions = {
        fieldMap: input.fieldMap || templateFieldMap,
        defaults: {
            ...(templateDefaults || {}),
            ...(input.defaults || {}),
            supplier: input.supplier || input.defaults?.supplier || templateDefaults?.supplier,
        },
    };

    for (let index = 0; index < input.rows.length; index += 1) {
        const rowNumber = index + 2;
        const rawRow = input.rows[index];
        try {
            const normalized = normalizeCsvImportRow(rawRow, rowNumber, options);
            const parsedProduct = csvImportRowToParsedProduct(normalized);
            const duplicateMessage = await findImportDuplicate(parsedProduct);
            createdRows.push({
                rowNumber,
                rawText: JSON.stringify(rawRow),
                status: duplicateMessage ? "DUPLICATE" : "READY",
                error: duplicateMessage,
                parsed: {
                    sourceType: "CSV_ROW",
                    ...parsedProduct,
                },
            });
        } catch (err: any) {
            createdRows.push({
                rowNumber,
                rawText: JSON.stringify(rawRow),
                status: "FAILED",
                error: err?.message || `Row ${rowNumber}: could not parse CSV row.`,
                parsed: {
                    sourceType: "CSV_ROW",
                },
            });
        }
    }

    const failedRows = createdRows.filter((row) => row.status === "FAILED").length;
    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "CSV",
            fileName: input.fileName || null,
            supplier: options.defaults?.supplier || null,
            status: createdRows.length > 0 ? "DRAFT" : "FAILED",
            totalRows: input.rows.length,
            importedRows: 0,
            failedRows,
            createdById: input.createdById,
            rows:
                createdRows.length > 0
                    ? { create: createdRows }
                    : {
                          create: [
                              {
                                  rowNumber: 1,
                                  rawText: null,
                                  status: "FAILED",
                                  error: "No CSV rows were found in this file.",
                              },
                          ],
                      },
        },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 50,
            },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({
                rowNumber: row.rowNumber,
                message: row.error || "CSV row needs review.",
            })),
        message: `CSV imported into review (${batch.totalRows} row${batch.totalRows === 1 ? "" : "s"} captured).`,
    };
}

function parseJsonFromAiText(text: string) {
    const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    const candidate =
        firstBrace >= 0 && lastBrace > firstBrace
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : firstBracket >= 0 && lastBracket > firstBracket
              ? cleaned.slice(firstBracket, lastBracket + 1)
              : cleaned;
    return JSON.parse(candidate);
}

function summarizeAiImportRow(item: Record<string, unknown>) {
    const parts = [
        normalizeCsvText(item.productName || item.name || item.Product_Name || item.product_name),
        normalizeCsvText(item.code || item.variant || item.Product_Code_Variant),
        normalizeCsvText(item.packageQty || item.pkg || item.packageQuantity)
            ? `Pkg ${normalizeCsvText(item.packageQty || item.pkg || item.packageQuantity)}`
            : "",
        normalizeCsvText(item.wsp || item.WSP)
            ? `WSP ${normalizeCsvText(item.wsp || item.WSP)}`
            : "",
        normalizeCsvText(item.rate || item.Rate)
            ? `Rate ${normalizeCsvText(item.rate || item.Rate)}`
            : "",
        normalizeCsvText(item.mrp || item.MRP || item.price)
            ? `MRP ${normalizeCsvText(item.mrp || item.MRP || item.price)}`
            : "",
    ].filter(Boolean);

    return parts.join(" | ") || JSON.stringify(item);
}

async function extractImageRateRowsWithGemini(input: {
    fileName?: string;
    mimeType: string;
    base64: string;
}) {
    const apiKey =
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        return {
            rows: [],
            document: null,
            error:
                "AI image parsing is not configured. Add GEMINI_API_KEY to enable PNG/JPG supplier rate-list imports.",
        };
    }

    const prompt = `Extract product data from this supplier price-list image for an inventory/billing catalog import.
Return strict JSON only in this shape:
{
  "supplierName": "company or supplier name printed in the document header, empty if unknown",
  "brandName": "brand name only if clearly printed; if the supplier is the brand, use the supplier name",
  "products": [
    {
      "serial": 1,
      "productName": "clean product name without serial, package quantity, MRP, WSP, or price",
      "code": "model/series/code such as Royal, Rose, 3G, 36mm, 105; empty if absent",
      "packageQty": 100,
      "mrp": 85,
      "wsp": null,
      "rate": null,
      "category": "section heading such as ROYAL BUCKET or BASIN - KING",
      "variant": "variant or series if different from code"
    }
  ]
}
Rules:
- Never invent stock. Supplier rate lists usually do not contain shop stock.
- Treat MRP as retail price. Treat WSP or Rate as wholesale/base price.
- Do not put price numbers inside productName.
- Keep section/category headings separate from productName.`;
    const model = process.env.GEMINI_IMPORT_MODEL || "gemini-2.5-flash";
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: prompt },
                            {
                                inline_data: {
                                    mime_type: input.mimeType,
                                    data: input.base64,
                                },
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: "application/json",
                },
            }),
        },
    );

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
            rows: [],
            document: null,
            error: `AI image parsing failed (${response.status}). ${body.slice(0, 180)}`,
        };
    }

    const payload: any = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = parseJsonFromAiText(text);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.products) ? parsed.products : [];
    return {
        rows,
        document: Array.isArray(parsed)
            ? null
            : {
                  supplierName: normalizeCsvText(parsed?.supplierName),
                  brandName: normalizeCsvText(parsed?.brandName),
              },
        error: null,
    };
}

export async function createImageImportPreview(input: {
    fileName?: string;
    mimeType: string;
    buffer: Buffer;
    createdById: string;
}) {
    const sourceName =
        (input.fileName || "Image Supplier")
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Image Supplier";

    let aiRows: any[] = [];
    let aiDocument: { supplierName?: string; brandName?: string } | null = null;
    let aiError: string | null = null;
    try {
        const result = await extractImageRateRowsWithGemini({
            fileName: input.fileName,
            mimeType: input.mimeType,
            base64: input.buffer.toString("base64"),
        });
        aiRows = result.rows;
        aiDocument = result.document;
        aiError = result.error;
    } catch (err: any) {
        aiError = err?.message || "AI image parsing failed.";
    }

    const rows: ProductImportPreviewRowDraft[] = [];
    for (let index = 0; index < aiRows.length; index += 1) {
        const item = aiRows[index] || {};
        const rawProductName = normalizeCsvText(
            item.productName || item.name || item.Product_Name || item.product_name,
        );
        const code = normalizeCsvText(item.code || item.variant || item.Product_Code_Variant);
        const wholesaleInput = Number(item.wsp ?? item.WSP ?? item.rate ?? item.Rate ?? 0);
        const retailInput = Number(item.mrp ?? item.MRP ?? item.price ?? 0);
        const rate = wholesaleInput || retailInput;
        const packageQuantity = Number(item.packageQty ?? item.pkg ?? item.packageQuantity ?? 1);
        const supplierName = normalizeCsvText(aiDocument?.supplierName) || sourceName;
        const brandName = normalizeCsvText(aiDocument?.brandName) || supplierName;
        const category = normalizeCsvText(item.category || item.group) || supplierName;
        const productName = cleanImportedProductName(rawProductName, rate);

        if (!productName || !Number.isFinite(rate) || rate <= 0) {
            rows.push({
                rowNumber: index + 1,
                rawText: summarizeAiImportRow(item),
                status: "FAILED",
                error: "AI row did not include both product name and price.",
                parsed: { sourceType: "IMAGE_AI_ROW", raw: item },
            });
            continue;
        }

        const parsedSize = parseProductSize(productName);
        const wholesalePrice = roundCurrency(rate);
        const retailPrice = wholesaleInput
            ? applyImportRetailMargin(wholesalePrice, 18)
            : roundCurrency(retailInput || wholesalePrice);
        const parsedProduct = {
            name: productName,
            productName: parsedSize.productName || productName,
            sku: buildSupplierSku(supplierName, String(item.serial || index + 1), productName, code),
            barcode: "",
            brand: brandName,
            category,
            categoryGroup: category,
            vendorSource: supplierName,
            productCodeVariant: code,
            sizeValue: parsedSize.sizeValue,
            sizeUnit: parsedSize.sizeUnit,
            ratePerPiece: wholesalePrice,
            packageQuantity: Number.isFinite(packageQuantity) ? packageQuantity : 1,
            packageUnit: "PIECE",
            saleUnit:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER"
                    ? parsedSize.sizeUnit
                    : "PIECE",
            allowFractionalQty:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER",
            quantityStep:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER" ? 0.01 : 1,
            wholesaleEligible: true,
            sourceCitation: input.fileName || "AI image import",
            retailPrice,
            wholesalePrice,
            stock: 0,
        };
        const duplicateMessage = await findImportDuplicate(parsedProduct);
        rows.push({
            rowNumber: index + 1,
            rawText: summarizeAiImportRow(item),
            status: duplicateMessage ? "DUPLICATE" : "READY",
            error: duplicateMessage,
            parsed: { sourceType: "IMAGE_AI_ROW", ...parsedProduct },
        });
    }

    if (rows.length === 0) {
        rows.push({
            rowNumber: 1,
            rawText: null,
            status: "FAILED",
            error: aiError || "AI image parser did not return any product rows.",
            parsed: { sourceType: "IMAGE_AI_ROW" },
        });
    }

    const failedRows = rows.filter((row) => row.status === "FAILED").length;
    const detectedSupplier = normalizeCsvText(aiDocument?.supplierName) || sourceName;
    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "IMAGE",
            fileName: input.fileName || null,
            supplier: detectedSupplier,
            status: rows.length > 0 && failedRows < rows.length ? "DRAFT" : "FAILED",
            totalRows: rows.length,
            importedRows: 0,
            failedRows,
            createdById: input.createdById,
            rows: { create: rows },
        },
        include: {
            rows: { orderBy: { rowNumber: "asc" }, take: 50 },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({ rowNumber: row.rowNumber, message: row.error || "Image row needs review." })),
        message:
            failedRows === batch.totalRows
                ? batch.rows[0]?.error || "Image import needs AI parser configuration."
                : `Image parsed into review (${batch.totalRows} row${batch.totalRows === 1 ? "" : "s"} captured).`,
    };
}

export async function createPdfImportPreview(input: {
    fileName?: string;
    text: string;
    createdById: string;
}) {
    const lines = input.text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    const status = lines.length > 0 ? "DRAFT" : "FAILED";
    const failedRows = lines.length > 0 ? 0 : 1;
    const previewRows = lines.slice(0, 500);
    const noTextMessage =
        "No selectable product text was found. This supplier PDF may be scanned/image-only and needs OCR before import.";

    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "PDF",
            fileName: input.fileName || null,
            status,
            totalRows: lines.length,
            importedRows: 0,
            failedRows,
            createdById: input.createdById,
            rows:
                previewRows.length > 0
                    ? {
                          create: previewRows.map((line, index) => ({
                              rowNumber: index + 1,
                              rawText: line,
                              status: "READY",
                              parsed: {
                                  sourceType: "PDF_TEXT_LINE",
                              },
                          })),
                      }
                    : {
                          create: [
                              {
                                  rowNumber: 1,
                                  rawText: null,
                                  status: "FAILED",
                                  error: noTextMessage,
                              },
                          ],
                      },
        },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 25,
            },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({
                rowNumber: row.rowNumber,
                message: row.error || "PDF preview row could not be processed.",
            })),
        message:
            lines.length > 0
                ? `PDF text extracted into an import preview (${lines.length} line${lines.length === 1 ? "" : "s"} captured; ${previewRows.length} stored for review).`
                : noTextMessage,
    };
}

export async function getProductImportBatch(batchId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
            },
            createdBy: {
                select: { id: true, name: true, role: true },
            },
        },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    return batch;
}

export async function listProductImportBatches(filters?: {
    sourceType?: string;
    status?: string;
    supplier?: string;
    search?: string;
    page?: number;
    pageSize?: number;
}) {
    const page = Math.max(1, filters?.page || 1);
    const pageSize = Math.max(1, Math.min(100, filters?.pageSize || 30));
    const where: any = { deletedAt: null };
    if (filters?.sourceType) where.sourceType = filters.sourceType;
    if (filters?.status) where.status = filters.status;
    if (filters?.supplier) where.supplier = { contains: filters.supplier };
    if (filters?.search) {
        where.OR = [
            { fileName: { contains: filters.search } },
            { supplier: { contains: filters.search } },
            { sourceType: { contains: filters.search } },
        ];
    }

    return prisma.productImportBatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
            createdBy: {
                select: { id: true, name: true, role: true },
            },
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 3,
            },
        },
    });
}

export async function deleteProductImportBatch(batchId: string, userId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        select: {
            id: true,
            fileName: true,
            sourceType: true,
            supplier: true,
            status: true,
            totalRows: true,
            importedRows: true,
            failedRows: true,
        },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    const purgeAfter = new Date();
    purgeAfter.setDate(purgeAfter.getDate() + 30);

    await prisma.$transaction([
        prisma.productImportBatch.update({
            where: { id: batchId },
            data: {
                deletedAt: new Date(),
                purgeAfter,
                deleteReason: "Deleted from import reviews",
                deletedById: userId,
            },
        }),
        prisma.softDeleteRecord.create({
            data: {
                entityType: "ProductImportBatch",
                entityId: batchId,
                entityLabel: batch.fileName || `${batch.sourceType} import review`,
                deletedById: userId,
                deleteReason: "Deleted from import reviews",
                purgeAfter,
                entitySnapshot: batch,
            },
        }),
        prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "PRODUCT_IMPORT_BATCH_DELETED",
                entityType: "ProductImportBatch",
                entityId: batchId,
                meta: {
                    fileName: batch.fileName,
                    sourceType: batch.sourceType,
                    supplier: batch.supplier,
                    status: batch.status,
                    totalRows: batch.totalRows,
                    importedRows: batch.importedRows,
                    failedRows: batch.failedRows,
                },
            },
        }),
    ]);

    return {
        deleted: true,
        batch,
        message: "Import review deleted. Products that were already imported were not removed.",
    };
}

export async function listProductImportTemplates(sourceType?: string) {
    return prisma.productImportTemplate.findMany({
        where: sourceType ? { sourceType } : undefined,
        orderBy: [{ supplier: "asc" }, { updatedAt: "desc" }],
        include: {
            createdBy: {
                select: { id: true, name: true, role: true },
            },
        },
    });
}

export async function upsertProductImportTemplate(input: {
    id?: string;
    name?: string;
    supplier: string;
    sourceType?: string;
    fieldMap: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
    createdById: string;
}) {
    const supplier = normalizeCsvText(input.supplier);
    if (!supplier) {
        throw new Error("Supplier name is required for an import template.");
    }

    const sourceType = normalizeCsvText(input.sourceType || "CSV").toUpperCase();
    const name = normalizeCsvText(input.name) || `${supplier} ${sourceType} template`;
    const fieldMap = input.fieldMap || {};
    const defaults = input.defaults || {};

    if (input.id) {
        return prisma.productImportTemplate.update({
            where: { id: input.id },
            data: {
                name,
                supplier,
                sourceType,
                fieldMap: fieldMap as Prisma.InputJsonValue,
                defaults: defaults as Prisma.InputJsonValue,
            },
        });
    }

    return prisma.productImportTemplate.upsert({
        where: {
            supplier_sourceType: {
                supplier,
                sourceType,
            },
        },
        create: {
            name,
            supplier,
            sourceType,
            fieldMap: fieldMap as Prisma.InputJsonValue,
            defaults: defaults as Prisma.InputJsonValue,
            createdById: input.createdById,
        },
        update: {
            name,
            fieldMap: fieldMap as Prisma.InputJsonValue,
            defaults: defaults as Prisma.InputJsonValue,
        },
    });
}

export async function deleteProductImportTemplate(id: string) {
    const template = await prisma.productImportTemplate.findUnique({
        where: { id },
        select: { id: true, supplier: true, sourceType: true },
    });

    if (!template) {
        throw new Error("Product import template was not found.");
    }

    await prisma.productImportTemplate.delete({ where: { id } });
    return { deleted: true, template };
}

export async function bulkUpdateProductPrices(input: {
    updates?: Array<{
        productId: string;
        retailPrice?: number;
        wholesalePrice?: number;
        ratePerPiece?: number;
    }>;
    scope?: "IDS" | "FILTERED";
    filters?: BulkPriceFilterInput;
    wholesaleMarginPercent?: number;
    retailMarginPercent?: number;
    reason: string;
    actorId: string;
    actorRole?: string;
}) {
    const reason = normalizeCsvText(input.reason);
    if (!reason) {
        throw new Error("Reason is required for bulk price updates.");
    }

    let updates = Array.isArray(input.updates) ? input.updates : [];
    if (input.scope === "FILTERED") {
        const filters = await normalizeBulkPriceFilters(input.filters || {});
        const productsResult = await listProducts({
            ...filters,
            page: 1,
            pageSize: 100000,
        });
        const wholesaleMargin = Number(input.wholesaleMarginPercent || 0);
        const retailMargin = Number(input.retailMarginPercent || 0);
        updates = productsResult.products.map((product: any) => {
            const baseRate = Number(product.ratePerPiece || product.wholesalePrice || product.retailPrice || 0);
            return {
                productId: product.id,
                ratePerPiece: baseRate,
                wholesalePrice: roundCurrency(baseRate * (1 + wholesaleMargin / 100)),
                retailPrice: roundCurrency(baseRate * (1 + retailMargin / 100)),
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
            const ratePerPiece = Number(update.ratePerPiece ?? update.wholesalePrice ?? update.retailPrice);

            if (!update.productId) {
                throw new Error("Missing product id.");
            }
            if (!Number.isFinite(retailPrice) || retailPrice <= 0) {
                throw new Error("Retail price must be greater than 0.");
            }
            if (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0) {
                throw new Error("Wholesale price must be greater than 0.");
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
                        ratePerPiece: Number.isFinite(ratePerPiece) && ratePerPiece > 0 ? ratePerPiece : wholesalePrice,
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
                                ratePerPiece: Number.isFinite(ratePerPiece) && ratePerPiece > 0 ? ratePerPiece : wholesalePrice,
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

function reviewedPdfRowToCsvRow(input: ReviewedPdfImportRowInput) {
    const rate = input.ratePerPiece ?? input.retailPrice;
    return {
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        brand: input.brand || input.vendorSource,
        category: input.category || input.vendorSource,
        categoryGroup: input.categoryGroup || input.category || input.vendorSource,
        vendorSource: input.vendorSource,
        productCodeVariant: input.productCodeVariant,
        sizeValue: input.sizeValue ?? undefined,
        sizeUnit: input.sizeUnit || "STANDARD",
        ratePerPiece: rate,
        packageQuantity: input.packageQuantity ?? 1,
        packageUnit: input.packageUnit || "PIECE",
        saleUnit: input.saleUnit || "PIECE",
        allowFractionalQty: input.allowFractionalQty ? "true" : "false",
        quantityStep: input.quantityStep ?? 1,
        wholesaleEligible: input.wholesaleEligible === false ? "false" : "true",
        sourceCitation: input.sourceCitation,
        retailPrice: input.retailPrice ?? rate,
        wholesalePrice: input.wholesalePrice ?? rate,
        stock: input.stock ?? 0,
    };
}

export async function importReviewedPdfRows(
    batchId: string,
    input: {
        rows: ReviewedPdfImportRowInput[];
        ignoredRowIds?: string[];
        actorId?: string;
    },
) {
    const batch = await prisma.productImportBatch.findUnique({
        where: { id: batchId },
        include: { rows: true },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    const existingRowsById = new Map(batch.rows.map((row) => [row.id, row]));
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const ignoredRowIds = Array.isArray(input.ignoredRowIds) ? input.ignoredRowIds : [];

    for (const row of rows) {
        if (!existingRowsById.has(row.rowId)) {
            throw new Error("One or more selected rows do not belong to this import batch.");
        }
    }

    for (const rowId of ignoredRowIds) {
        if (!existingRowsById.has(rowId)) {
            throw new Error("One or more ignored rows do not belong to this import batch.");
        }
    }

    if (ignoredRowIds.length > 0) {
        await prisma.productImportRow.updateMany({
            where: { id: { in: ignoredRowIds } },
            data: { status: "IGNORED", error: null },
        });
    }

    if (rows.length === 0) {
        const refreshed = await getProductImportBatch(batchId);
        return {
            totalRows: 0,
            createdCount: 0,
            errorCount: 0,
            errors: [],
            batch: refreshed,
        };
    }

    const csvRows = rows.map(reviewedPdfRowToCsvRow);
    const result = await importProductsFromCsv(csvRows);
    const errorsBySelectedIndex = new Map<number, CsvImportError>();

    result.errors.forEach((error) => {
        const selectedIndex = error.rowNumber - 2;
        if (selectedIndex >= 0) {
            errorsBySelectedIndex.set(selectedIndex, error);
        }
    });

    await Promise.all(
        rows.map((row, index) => {
            const error = errorsBySelectedIndex.get(index);
            return prisma.productImportRow.update({
                where: { id: row.rowId },
                data: {
                    status: error ? "FAILED" : "IMPORTED",
                    error: error?.message || null,
                    parsed: {
                        sourceType: "PDF_REVIEWED_ROW",
                        ...row,
                    },
                },
            });
        }),
    );

    const importedRows = await prisma.productImportRow.count({
        where: { batchId, status: "IMPORTED" },
    });
    const failedRows = await prisma.productImportRow.count({
        where: { batchId, status: "FAILED" },
    });
    const actionableRows = await prisma.productImportRow.count({
        where: { batchId, status: { in: ["READY", "FAILED", "DUPLICATE"] } },
    });

    await prisma.productImportBatch.update({
        where: { id: batchId },
        data: {
            importedRows,
            failedRows,
            status: actionableRows > 0 ? "DRAFT" : "IMPORTED",
        },
    });

    if (input.actorId && result.createdCount > 0) {
        await prisma.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_IMPORT_COMPLETED",
                entityType: "ProductImportBatch",
                entityId: batchId,
                meta: {
                    fileName: batch.fileName,
                    sourceType: batch.sourceType,
                    supplier: batch.supplier,
                    totalRows: result.totalRows,
                    createdCount: result.createdCount,
                    errorCount: result.errorCount,
                },
            },
        });
    }

    const refreshed = await getProductImportBatch(batchId);
    return {
        ...result,
        batch: refreshed,
    };
}
