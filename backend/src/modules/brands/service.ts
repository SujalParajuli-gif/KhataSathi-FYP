import prisma from "../../db/prisma";
import { rebuildProductSearchDocumentsForBrand } from "../products/searchAliasService";

// listing all brands, optionally filtered to show only active ones
// sorted alphabetically by name for consistent display in the frontend dropdown
export async function listBrands(activeOnly?: boolean) {
    const where = activeOnly ? { isActive: true } : {};
    const [brands, groupedCounts] = await prisma.$transaction([
        prisma.brand.findMany({ where, orderBy: { name: "asc" } }),
        prisma.product.groupBy({
            by: ["brandId", "isActive"],
            _count: { _all: true },
        }),
    ]);
    const counts = new Map<string, { total: number; active: number }>();
    for (const group of groupedCounts) {
        const current = counts.get(group.brandId) || { total: 0, active: 0 };
        current.total += group._count._all;
        if (group.isActive) current.active += group._count._all;
        counts.set(group.brandId, current);
    }
    return brands.map((brand) => ({
        ...brand,
        productCount: counts.get(brand.id)?.total || 0,
        activeProductCount: counts.get(brand.id)?.active || 0,
    }));
}

// fetching a single brand by ID along with its linked products
// we include product details so the admin can see which products belong to this brand
export async function getBrand(id: string) {
    return prisma.brand.findUnique({
        where: { id },
        include: {
            products: {
                select: {
                    id: true,
                    name: true,
                    sku: true,
                    stock: true,
                    lowStockThreshold: true,
                    isActive: true,
                },
                orderBy: { name: "asc" },
            },
        },
    });
}

// creating a new brand record in the database
// the unique constraint on the name field is enforced by Prisma, so duplicates are handled in the controller
export async function createBrand(name: string) {
    return prisma.brand.create({ data: { name } });
}

// updating a brand — can change the name, active status, or both
// we wrap this in a transaction because deactivating a brand also deactivates all its products
// and we need both operations to either succeed or fail together
export async function updateBrand(
    id: string,
    data: { name?: string; isActive?: boolean },
    actorId?: string,
) {
    return prisma.$transaction(async (tx) => {
        const existing = await tx.brand.findUnique({
            where: { id },
            select: { id: true, name: true, isActive: true },
        });

        if (!existing) {
            throw Object.assign(new Error("Brand not found"), { code: "P2025" });
        }

        if (data.isActive === false && existing.isActive) {
            const activeProductCount = await tx.product.count({
                where: { brandId: id, isActive: true },
            });
            if (activeProductCount > 0) {
                throw Object.assign(
                    new Error(
                        `This brand still has ${activeProductCount} active product${activeProductCount === 1 ? "" : "s"}. Reassign or deactivate those products first.`,
                    ),
                    { code: "BRAND_HAS_ACTIVE_PRODUCTS", activeProductCount },
                );
            }
        }

        const updated = await tx.brand.update({
            where: { id },
            data,
        });

        if (actorId) {
            await tx.auditLog.create({
                data: {
                    actorId,
                    action: "BRAND_UPDATED",
                    entityType: "Brand",
                    entityId: id,
                    meta: {
                        brandNameBefore: existing.name,
                        brandNameAfter: updated.name,
                        previousActive: existing.isActive,
                        nextActive: updated.isActive,
                        productCascade: false,
                    },
                },
            });
        }

        if (data.name !== undefined && updated.name !== existing.name) {
            await rebuildProductSearchDocumentsForBrand(id, tx);
        }

        return updated;
    });
}

// convenience function that calls updateBrand with isActive set to false
// used by the deactivate route to keep the controller code clean
export async function deactivateBrand(id: string, actorId?: string) {
    return updateBrand(id, { isActive: false }, actorId);
}
