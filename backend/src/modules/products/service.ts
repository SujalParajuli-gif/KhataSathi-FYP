import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";
import {
    applyBusinessThresholds,
    getBusinessSettings,
} from "../settings/service";

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

    if (lowStockOnly) {
    }

    const skip = (page - 1) * pageSize;
    const settings = await getBusinessSettings();

    if (lowStockOnly) {
        const allProducts = await prisma.product.findMany({
            where,
            include: { brand: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
        });

        const resolvedProducts = allProducts.map((product) =>
            applyBusinessThresholds(product, settings),
        );

        const filtered = resolvedProducts.filter((p) => p.stock > 0 && p.stock <= p.lowStockThreshold);
        const total = filtered.length;

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

        return {
            products: products.map((product) => applyBusinessThresholds(product, settings)),
            total,
            page,
            pageSize,
        };
    }
}

export async function getProduct(id: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findUnique({
        where: { id },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? applyBusinessThresholds(product, settings) : product;
}

export async function getProductByBarcode(barcode: string) {
    const settings = await getBusinessSettings();
    const product = await prisma.product.findUnique({
        where: { barcode },
        include: { brand: { select: { id: true, name: true } } },
    });
    return product ? applyBusinessThresholds(product, settings) : product;
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
    usesDefaultWholesaleQtyThreshold?: boolean;
    stock?: number;
    lowStockThreshold?: number;
    usesDefaultLowStockThreshold?: boolean;
    isActive?: boolean;
    imageUrl?: string | null;
}

export async function createProduct(data: CreateProductInput) {
    const settings = await getBusinessSettings();
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
                settings.defaultWholesaleQtyThreshold,
            usesDefaultWholesaleQtyThreshold,
            stock: data.stock ?? 0,
            lowStockThreshold:
                data.lowStockThreshold ??
                settings.defaultLowStockThreshold,
            usesDefaultLowStockThreshold,
            isActive: data.isActive ?? true,
            imageUrl: data.imageUrl ?? null,
        },
        include: { brand: { select: { id: true, name: true } } },
    });

    return applyBusinessThresholds(product, settings);
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

    const updateData: any = { ...data };
    if (
        updateData.usesDefaultWholesaleQtyThreshold === undefined &&
        updateData.wholesaleQtyThreshold !== undefined
    ) {
        updateData.usesDefaultWholesaleQtyThreshold = false;
    }
    if (
        updateData.usesDefaultLowStockThreshold === undefined &&
        updateData.lowStockThreshold !== undefined
    ) {
        updateData.usesDefaultLowStockThreshold = false;
    }
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

    if (data.imageUrl !== undefined) {
        await deleteReplacedUpload(previousImageUrl, product.imageUrl);
    }

    const settings = await getBusinessSettings();
    return applyBusinessThresholds(product, settings);
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
    stock?: number;
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
        stock: parseCsvNumber(normalizedRow.stock, "stock", rowNumber, { min: 0, allowBlank: true }),
    };
}

export async function importProductsFromCsv(rawRows: Array<Record<string, unknown>>) {
    const createdProducts: Array<{ id: string; sku: string; name: string }> = [];
    const errors: CsvImportError[] = [];
    const brandCache = new Map<string, string>();
    const settings = await getBusinessSettings();

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
                        wholesaleQtyThreshold: settings.defaultWholesaleQtyThreshold,
                        usesDefaultWholesaleQtyThreshold: true,
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
