import prisma from "../../db/prisma";

type CreateUserInput = {
  name: string;
  email: string;
  phone?: string;
  role?: "ADMIN" | "CASHIER";
  passwordHash: string;
  isActive?: boolean;
  nagariktaNo?: string;
};

type UpdateUserInput = {
  name?: string;
  email?: string;
  phone?: string | null;
  role?: "ADMIN" | "CASHIER";
  passwordHash?: string;
  isActive?: boolean;
  nagariktaNo?: string | null;
};

export async function listUsers(query?: { role?: "ADMIN" | "CASHIER" }) {
  const where: any = {};
  if (query?.role) where.role = query.role;

  return prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      nagariktaNo: true,
      createdAt: true,
    },
  });
}

export async function createUser(data: CreateUserInput) {
  return prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      role: data.role || "CASHIER",
      passwordHash: data.passwordHash,
      isActive: data.isActive ?? true,
      nagariktaNo: data.nagariktaNo || null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      nagariktaNo: true,
      createdAt: true,
    },
  });
}

export async function updateUser(id: string, data: UpdateUserInput) {
  return prisma.user.update({
    where: { id },
    data: {
      ...data,
      phone: data.phone === undefined ? undefined : data.phone,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      nagariktaNo: true,
      createdAt: true,
    },
  });
}

export async function uploadUserPhoto(id: string, photoUrl: string) {
  return prisma.user.update({
    where: { id },
    data: { profileImage: photoUrl },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      profileImage: true,
      nagariktaNo: true,
    },
  });
}
