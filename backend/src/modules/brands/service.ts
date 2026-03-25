import prisma from "../../db/prisma";

export async function listBrands(activeOnly?: boolean) {
    const where = activeOnly ? { isActive: true } : {};
    return prisma.brand.findMany({ where, orderBy: { name: "asc" } });
}

export async function getBrand(id: string) {
    return prisma.brand.findUnique({ where: { id } });
}

export async function createBrand(name: string) {
    return prisma.brand.create({ data: { name } });
}

export async function updateBrand(id: string, data: { name?: string; isActive?: boolean }) {
    return prisma.brand.update({ where: { id }, data });
}

export async function deactivateBrand(id: string) {
    return prisma.brand.update({ where: { id }, data: { isActive: false } });
}
