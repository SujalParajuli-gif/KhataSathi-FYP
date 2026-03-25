import prisma from "../../db/prisma";

type CustomerInput = {
  name: string;
  phone?: string;
  email?: string;
  loyaltyPercent?: number;
  wholesalePercent?: number;
};

type CustomerUpdateInput = Partial<CustomerInput> & { isActive?: boolean };

export async function listCustomers(activeOnly?: boolean) {
  const where = activeOnly ? { isActive: true } : {};
  return prisma.customer.findMany({ where, orderBy: { name: "asc" } });
}

export async function getCustomer(id: string) {
  return prisma.customer.findUnique({ where: { id } });
}

export async function createCustomer(data: CustomerInput) {
  return prisma.customer.create({
    data: {
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      loyaltyPercent: data.loyaltyPercent || 0,
      wholesalePercent: data.wholesalePercent || 0,
    },
  });
}

export async function updateCustomer(id: string, data: CustomerUpdateInput) {
  return prisma.customer.update({ where: { id }, data });
}

export async function deactivateCustomer(id: string) {
  return prisma.customer.update({ where: { id }, data: { isActive: false } });
}
