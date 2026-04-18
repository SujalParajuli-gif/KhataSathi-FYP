import prisma from "../../db/prisma";

// defining the shape of data needed to create a new customer
type CustomerInput = {
  name: string;
  phone?: string;
  email?: string;
  loyaltyPercent?: number;
  wholesalePercent?: number;
};

// extending CustomerInput with optional isActive field for updates
// Partial makes all fields optional so we can update just the ones that changed
type CustomerUpdateInput = Partial<CustomerInput> & { isActive?: boolean };

// listing all customers, optionally filtered to show only active ones
// sorted alphabetically by name so the frontend displays them in a consistent order
export async function listCustomers(activeOnly?: boolean) {
  const where = activeOnly ? { isActive: true } : {};
  return prisma.customer.findMany({ where, orderBy: { name: "asc" } });
}

// fetching a single customer record by their ID
export async function getCustomer(id: string) {
  return prisma.customer.findUnique({ where: { id } });
}

// creating a new customer in the database
// optional fields default to null or 0 if not provided, so the database always has valid values
export async function createCustomer(data: CustomerInput) {
  return prisma.customer.create({
    data: {
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      loyaltyPercent: data.loyaltyPercent || 0, // defaults to 0 if no loyalty discount is assigned
      wholesalePercent: data.wholesalePercent || 0, // defaults to 0 if no wholesale discount is assigned
    },
  });
}

// updating an existing customer record — only the fields included in the data object will be changed
export async function updateCustomer(id: string, data: CustomerUpdateInput) {
  return prisma.customer.update({ where: { id }, data });
}

// soft-deactivating a customer by setting isActive to false
// we do not delete the record because the customer might be linked to existing invoices
export async function deactivateCustomer(id: string) {
  return prisma.customer.update({ where: { id }, data: { isActive: false } });
}
