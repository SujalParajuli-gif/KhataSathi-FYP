import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";

interface ProductFilters {
    search?: string;
    brand?: string;
    category?: string;
    isActive?: boolean;
    lowStockOnly?: boolean;
    page?: number;
    pageSize?: number;
}

export async function listProducts(filters: ProductFilters) {
    const { search, brand, category, isActive, lowStockOnly, page = 1, pageSize = 50 } = filters;

    const where: any = {};

    // Search by name, SKU, or barcode
    if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
            { name: { contains: s } },
            { sku: { contains: s } },
            { barcode: { equals: s } },
        ];
    }

    if (brand) where.brandId = brand;
    if (category) where.category = category;
    if (isActive !== undefined) where.isActive = isActive;

    // Low stock filter: stock <= lowStockThreshold AND stock > 0
    // We'll handle this in raw where clause
    if (lowStockOnly) {
        // Prisma doesn't support comparing two columns directly,
        // so we fetch all and filter in JS for simplicity
    }

    const skip = (page - 1) * pageSize;

    if (lowStockOnly) {
        // Fetch all matching the where clause
        const allProducts = await prisma.product.findMany({
            where,
            include: { brand: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
        });
        
        // Filter in JS
        const filtered = allProducts.filter((p) => p.stock > 0 && p.stock <= p.lowStockThreshold);
        const total = filtered.length;
        
        // Paginate in JS
        const paged = filtered.slice(skip, skip + pageSize);
        
        return { products: paged, total, page, pageSize };
    } else {
        const [products, total] = await Promise.all([
            prisma.product.findMany({
                where,
                include: { brand: { select: { id: true, name: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: pageSize,
            }),
            prisma.product.count({ where }),
        ]);

        return { products, total, page, pageSize };
    }
}

export async function getProduct(id: string) {
    return prisma.product.findUnique({
        where: { id },
        include: { brand: { select: { id: true, name: true } } },
    });
}

export async function getProductByBarcode(barcode: string) {
    return prisma.product.findUnique({
        where: { barcode },
        include: { brand: { select: { id: true, name: true } } },
    });
}

interface CreateProductInput {
    name: string;
    sku: string;
    barcode?: string;
    brandId: string;
    category?: string;
    retailPrice: number;
    wholesalePrice: number;
    wholesaleQtyThreshold?: number;
    stock?: number;
    lowStockThreshold?: number;
    isActive?: boolean;
    imageUrl?: string | null;
}

export async function createProduct(data: CreateProductInput) {
    return prisma.product.create({
        data: {
            name: data.name,
            sku: data.sku,
            barcode: data.barcode || null,
            brandId: data.brandId,
            category: data.category || null,
            retailPrice: data.retailPrice,
            wholesalePrice: data.wholesalePrice,
            wholesaleQtyThreshold: data.wholesaleQtyThreshold ?? 1,
            stock: data.stock ?? 0,
            lowStockThreshold: data.lowStockThreshold ?? 5,
            isActive: data.isActive ?? true,
            imageUrl: data.imageUrl ?? null,
        },
        include: { brand: { select: { id: true, name: true } } },
    });
}

export async function updateProduct(id: string, data: Partial<CreateProductInput> & { isActive?: boolean }) {
    let previousImageUrl: string | null = null;

    if (data.imageUrl !== undefined) {
        const existing = await prisma.product.findUnique({
            where: { id },
            select: { imageUrl: true },
        });
        previousImageUrl = existing?.imageUrl ?? null;
    }

    const product = await prisma.product.update({
        where: { id },
        data,
        include: { brand: { select: { id: true, name: true } } },
    });

    if (data.imageUrl !== undefined) {
        await deleteReplacedUpload(previousImageUrl, product.imageUrl);
    }

    return product;
}

export async function deactivateProduct(id: string) {
    return prisma.product.update({
        where: { id },
        data: { isActive: false },
    });
}

export async function getCategories() {
    const products = await prisma.product.findMany({
        where: { category: { not: null } },
        select: { category: true },
        distinct: ["category"],
        orderBy: { category: "asc" },
    });
    return products.map((p) => p.category).filter(Boolean);
}

type CsvImportRow = {
    name: string;
    sku: string;
    barcode?: string;
    brand?: string;
    brandId?: string;
    category?: string;
    retailPrice: number;
    wholesalePrice: number;
    wholesaleQtyThreshold?: number;
    stock?: number;
    lowStockThreshold?: number;
    isActive?: boolean;
};

type CsvImportError = {
    rowNumber: number;
    sku?: string;
    name?: string;
    message: string;
};

function normalizeCsvText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeCsvBoolean(value: unknown) {
    const normalized = normalizeCsvText(value).toLowerCase();
    if (!normalized) return true;
    return !["inactive", "false", "0", "no"].includes(normalized);
}

function parseCsvNumber(
    value: unknown,
    fieldName: string,
    rowNumber: number,
    options?: { min?: number; allowBlank?: boolean },
) {
    const raw = normalizeCsvText(value);

    if (!raw) {
        if (options?.allowBlank) return undefined;
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

async function resolveBrandIdForImport(
    tx: Prisma.TransactionClient,
    row: CsvImportRow,
    rowNumber: number,
    brandCache: Map<string, string>,
) {
    const brandId = normalizeCsvText(row.brandId);
    if (brandId) {
        const brand = await tx.brand.findUnique({ where: { id: brandId } });
        if (!brand) {
            throw new Error(`Row ${rowNumber}: brandId "${brandId}" was not found.`);
        }
        brandCache.set(brand.name.toLowerCase(), brand.id);
        return brand.id;
    }

    const brandName = normalizeCsvText(row.brand);
    if (!brandName) {
        throw new Error(`Row ${rowNumber}: brand or brandId is required.`);
    }

    const cacheKey = brandName.toLowerCase();
    const cachedBrandId = brandCache.get(cacheKey);
    if (cachedBrandId) {
        return cachedBrandId;
    }

    const existingBrand = (await tx.brand.findMany({
        select: { id: true, name: true },
    })).find((brand) => brand.name.toLowerCase() === cacheKey);

    if (existingBrand) {
        brandCache.set(cacheKey, existingBrand.id);
        return existingBrand.id;
    }

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

function normalizeCsvImportRow(rawRow: Record<string, unknown>, rowNumber: number): CsvImportRow {
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
        wholesaleQtyThreshold: parseCsvNumber(
            normalizedRow.wholesaleqtythreshold ?? normalizedRow.thresholdqty,
            "wholesaleQtyThreshold",
            rowNumber,
            { min: 1, allowBlank: true },
        ),
        stock: parseCsvNumber(normalizedRow.stock, "stock", rowNumber, { min: 0, allowBlank: true }),
        lowStockThreshold: parseCsvNumber(
            normalizedRow.lowstockthreshold,
            "lowStockThreshold",
            rowNumber,
            { min: 0, allowBlank: true },
        ),
        isActive: normalizeCsvBoolean(normalizedRow.status),
    };
}

export async function importProductsFromCsv(rawRows: Array<Record<string, unknown>>) {
    const createdProducts: Array<{ id: string; sku: string; name: string }> = [];
    const errors: CsvImportError[] = [];
    const brandCache = new Map<string, string>();

    const existingBrands = await prisma.brand.findMany({
        select: { id: true, name: true },
    });
    existingBrands.forEach((brand) => brandCache.set(brand.name.toLowerCase(), brand.id));

    for (let index = 0; index < rawRows.length; index += 1) {
        const rowNumber = index + 2;
        const rawRow = rawRows[index];

        try {
            const row = normalizeCsvImportRow(rawRow, rowNumber);

            const created = await prisma.$transaction(async (tx) => {
                const brandId = await resolveBrandIdForImport(tx, row, rowNumber, brandCache);

                const duplicateSku = await tx.product.findUnique({
                    where: { sku: row.sku },
                    select: { id: true },
                });
                if (duplicateSku) {
                    throw new Error(`Row ${rowNumber}: SKU "${row.sku}" already exists.`);
                }

                if (row.barcode) {
                    const duplicateBarcode = await tx.product.findUnique({
                        where: { barcode: row.barcode },
                        select: { id: true },
                    });
                    if (duplicateBarcode) {
                        throw new Error(`Row ${rowNumber}: barcode "${row.barcode}" already exists.`);
                    }
                }

                return tx.product.create({
                    data: {
                        name: row.name,
                        sku: row.sku,
                        barcode: row.barcode || null,
                        brandId,
                        category: row.category || null,
                        retailPrice: row.retailPrice,
                        wholesalePrice: row.wholesalePrice,
                        wholesaleQtyThreshold: row.wholesaleQtyThreshold ?? 1,
                        stock: row.stock ?? 0,
                        lowStockThreshold: row.lowStockThreshold ?? 5,
                        isActive: row.isActive ?? true,
                    },
                    select: { id: true, sku: true, name: true },
                });
            });

            createdProducts.push(created);
        } catch (err: any) {
            errors.push({
                rowNumber,
                sku: normalizeCsvText(rawRow.sku) || undefined,
                name: normalizeCsvText(rawRow.name) || undefined,
                message: err?.message || `Row ${rowNumber}: import failed.`,
            });
        }
    }

    return {
        totalRows: rawRows.length,
        createdCount: createdProducts.length,
        errorCount: errors.length,
        createdProducts,
        errors,
    };
}
