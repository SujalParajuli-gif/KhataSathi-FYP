import prisma from "../../db/prisma";

export async function listBrands(activeOnly?: boolean) {
    const where = activeOnly ? { isActive: true } : {};
    return prisma.brand.findMany({ where, orderBy: { name: "asc" } });
}

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

export async function createBrand(name: string) {
    return prisma.brand.create({ data: { name } });
}

export async function updateBrand(
    id: string,
    data: { name?: string; isActive?: boolean },
    actorId?: string,
) {
    return prisma.$transaction(async (tx) => {
        const existing = await tx.brand.findUnique({
            where: { id },
            include: {
                products: {
                    select: { id: true, isActive: true },
                },
            },
        });

        if (!existing) {
            throw Object.assign(new Error("Brand not found"), { code: "P2025" });
        }

        const updated = await tx.brand.update({
            where: { id },
            data,
        });

        let affectedProducts = 0;
        if (data.isActive === false && existing.isActive !== false) {
            const result = await tx.product.updateMany({
                where: { brandId: id, isActive: true },
                data: { isActive: false },
            });
            affectedProducts = result.count;
        }

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
                        deactivatedProductCount: affectedProducts,
                    },
                },
            });
        }

        return { ...updated, deactivatedProductCount: affectedProducts };
    });
}

export async function deactivateBrand(id: string, actorId?: string) {
    return updateBrand(id, { isActive: false }, actorId);
}
