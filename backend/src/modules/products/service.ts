import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";
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
    page?: number;
    pageSize?: number;
}

// listing products with support for search, filtering, pagination, and low-stock-only mode
// low stock mode requires special handling because we need to resolve each product's threshold
// before we can determine if it is below the threshold
export async function listProducts(filters: ProductFilters) {
    const { search, brand, category, isActive, lowStockOnly, page = 1, pageSize = 50 } = filters;

    const where: any = {};

    // searching by name, SKU, or exact barcode match
    if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
            { name: { contains: s } },
            { sku: { contains: s } },
            { barcode: { equals: s } },
        ];
    }

    if (brand) where.brandId = brand; // filtering by brand ID
    if (category) where.category = category; // filtering by category
    if (isActive !== undefined) where.isActive = isActive; // filtering by active status

    if (lowStockOnly) {
    }

    const skip = (page - 1) * pageSize; // calculating how many records to skip for pagination
    const settings = await getBusinessSettings(); // fetching business settings to resolve thresholds

    if (lowStockOnly) {
        // for low stock filtering, we fetch all matching products first because we need to
        // resolve each product's effective threshold (custom or default) before filtering
        // this cannot be done in a single database query since thresholds are conditional
        const allProducts = await prisma.product.findMany({
            where,
            include: { brand: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
        });

        // applying business thresholds so each product has its effective lowStockThreshold
        const resolvedProducts = allProducts.map((product) =>
            applyBusinessThresholds(product, settings),
        );

        // filtering to only include products where stock is above 0 but at or below the threshold
        // products with 0 stock are considered "out of stock", not "low stock"
        const filtered = resolvedProducts.filter((p) => p.stock > 0 && p.stock <= p.lowStockThreshold);
        const total = filtered.length;

        const paged = filtered.slice(skip, skip + pageSize); // applying manual pagination on the filtered results

        return { products: paged, total, page, pageSize };
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

        return {
            products: products.map((product) => applyBusinessThresholds(product, settings)), // resolving thresholds on each product
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
    return product ? applyBusinessThresholds(product, settings) : product; // only apply thresholds if product exists
}

// fetching a product by its barcode — used for barcode scanning in the billing page
export async function getProductByBarcode(barcode: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findUnique({
        where: { barcode },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? applyBusinessThresholds(product, settings) : product;
}

// defining the shape of data needed to create a new product
interface CreateProductInput {
    name: string;
    sku: string;
    barcode?: string;
    brandId: string;
    category?: string;
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
            sku: data.sku,
            barcode: data.barcode || null,
            brandId: data.brandId,
            category: data.category || null,
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

    return applyBusinessThresholds(product, settings);
}

// updating an existing product — handles threshold flag logic and image replacement
export async function updateProduct(id: string, data: Partial<CreateProductInput> & { isActive?: boolean }) {
    let previousImageUrl: string | null = null;

    // if the image URL is being changed, save the old one so we can delete the old file later
    if (data.imageUrl !== undefined) {
        const existing = await prisma.product.findUnique({
            where: { id },
            select: { imageUrl: true },
        });
        previousImageUrl = existing?.imageUrl ?? null;
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

    // deleting the old image file from disk if the image was changed
    if (data.imageUrl !== undefined) {
        await deleteReplacedUpload(previousImageUrl, product.imageUrl);
    }

    const settings = await getBusinessSettings();
    return applyBusinessThresholds(product, settings); // returning the product with resolved thresholds
}

// soft-deactivating a product by setting isActive to false
// the product data stays in the database for existing invoices and history
export async function deactivateProduct(id: string) {
    return prisma.product.update({
        where: { id },
        data: { isActive: false },
    });
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
    sku: string;
    barcode?: string;
    brand?: string;
    brandId?: string;
    category?: string;
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

// safely converting a CSV cell value to a trimmed string
function normalizeCsvText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
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

    const parsed = Number(raw);
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
function normalizeCsvImportRow(rawRow: Record<string, unknown>, rowNumber: number): CsvImportRow {
    // converting all column keys to lowercase and trimming them
    const normalizedRow = Object.entries(rawRow).reduce<Record<string, unknown>>((acc, [key, value]) => {
        acc[key.trim().toLowerCase()] = value;
        return acc;
    }, {});

    const name = normalizeCsvText(normalizedRow.name);
    const sku = normalizeCsvText(normalizedRow.sku);

    if (!name) {
        throw new Error(`Row ${rowNumber}: name is required.`);
    }

    if (!sku) {
        throw new Error(`Row ${rowNumber}: sku is required.`);
    }

    return {
        name,
        sku,
        barcode: normalizeCsvText(normalizedRow.barcode) || undefined,
        brand: normalizeCsvText(normalizedRow.brand) || undefined,
        brandId: normalizeCsvText(normalizedRow.brandid) || undefined,
        category: normalizeCsvText(normalizedRow.category) || undefined,
        retailPrice: parseCsvNumber(normalizedRow.retailprice, "retailPrice", rowNumber, { min: 0.01 })!,
        wholesalePrice: parseCsvNumber(normalizedRow.wholesaleprice, "wholesalePrice", rowNumber, { min: 0.01 })!,
        stock: parseCsvNumber(normalizedRow.stock, "stock", rowNumber, { min: 0, allowBlank: true }),
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

                // checking if a product with this SKU already exists
                const duplicateSku = await tx.product.findUnique({
                    where: { sku: row.sku },
                    select: { id: true },
                });
                if (duplicateSku) {
                    throw new Error(`Row ${rowNumber}: SKU "${row.sku}" already exists.`);
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
                        sku: row.sku,
                        barcode: row.barcode || null,
                        brandId,
                        category: row.category || null,
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
                sku: normalizeCsvText(rawRow.sku) || undefined,
                name: normalizeCsvText(rawRow.name) || undefined,
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
