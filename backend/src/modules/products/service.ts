import prisma from "../../db/prisma";

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
            wholesaleQtyThreshold: data.wholesaleQtyThreshold || 1,
            stock: data.stock || 0,
            lowStockThreshold: data.lowStockThreshold || 5,
        },
        include: { brand: { select: { id: true, name: true } } },
    });
}

export async function updateProduct(id: string, data: Partial<CreateProductInput> & { isActive?: boolean }) {
    return prisma.product.update({
        where: { id },
        data,
        include: { brand: { select: { id: true, name: true } } },
    });
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
