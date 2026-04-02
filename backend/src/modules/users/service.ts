import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";

type CreateUserInput = {
  name: string;
  email: string;
  phone?: string;
  gender?: string | null;
  address?: string | null;
  role?: "ADMIN" | "CASHIER";
  passwordHash: string;
  isActive?: boolean;
};

type UpdateUserInput = {
  name?: string;
  email?: string;
  phone?: string | null;
  gender?: string | null;
  address?: string | null;
  role?: "ADMIN" | "CASHIER";
  passwordHash?: string;
  isActive?: boolean;
  profileImage?: string | null;
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
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
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
      gender: data.gender || null,
      address: data.address || null,
      role: data.role || "CASHIER",
      passwordHash: data.passwordHash,
      isActive: data.isActive ?? true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      createdAt: true,
    },
  });
}

export async function updateUser(id: string, data: UpdateUserInput) {
  let previousProfileImage: string | null = null;
  if (data.profileImage !== undefined) {
    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: { profileImage: true },
    });
    previousProfileImage = existingUser?.profileImage ?? null;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...data,
      phone: data.phone === undefined ? undefined : data.phone,
      gender: data.gender === undefined ? undefined : data.gender,
      address: data.address === undefined ? undefined : data.address,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      createdAt: true,
    },
  });

  if (data.profileImage !== undefined) {
    await deleteReplacedUpload(previousProfileImage, user.profileImage);
  }

  return user;
}

export async function uploadUserPhoto(id: string, photoUrl: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { profileImage: true },
  });

  const user = await prisma.user.update({
    where: { id },
    data: { profileImage: photoUrl },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      isActive: true,
      lastLogin: true,
      profileImage: true,
      createdAt: true,
    },
  });

  await deleteReplacedUpload(existingUser?.profileImage, user.profileImage);

  return user;
}
