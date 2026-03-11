// src/modules/customers/service.ts — Customer business logic
import prisma from "../../db/prisma";

export async function listCustomers(activeOnly?: boolean) {
    const where = activeOnly ? { isActive: true } : {};
    return prisma.customer.findMany({ where, orderBy: { name: "asc" } });
}

export async function getCustomer(id: string) {
    return prisma.customer.findUnique({ where: { id } });
}

export async function createCustomer(data: { name: string; phone?: string; loyaltyPercent?: number }) {
    return prisma.customer.create({
        data: {
            name: data.name,
            phone: data.phone || null,
            loyaltyPercent: data.loyaltyPercent || 0,
        },
    });
}

export async function updateCustomer(id: string, data: { name?: string; phone?: string; loyaltyPercent?: number; isActive?: boolean }) {
    return prisma.customer.update({ where: { id }, data });
}

export async function deactivateCustomer(id: string) {
    return prisma.customer.update({ where: { id }, data: { isActive: false } });
}
