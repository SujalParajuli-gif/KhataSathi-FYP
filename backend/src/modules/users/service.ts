import prisma from "../../db/prisma";
import { deleteReplacedUpload } from "../../lib/uploads";

// defining the shape of data needed to create a new user
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

// defining the shape of data needed to update an existing user
// all fields are optional because the admin might only change one or two fields at a time
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

// listing all users, with optional role filter to show only admins or only cashiers
// we exclude the passwordHash field from the results to keep it secure
export async function listUsers(query?: { role?: "ADMIN" | "CASHIER" }) {
  const where: any = {};
  if (query?.role) where.role = query.role; // adding role filter only if it was provided

  return prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" }, // newest users first
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

// creating a new user record in the database
// optional fields default to null if not provided, and the role defaults to "CASHIER"
export async function createUser(data: CreateUserInput) {
  return prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      gender: data.gender || null,
      address: data.address || null,
      role: data.role || "CASHIER", // new users are cashiers by default unless admin specifies otherwise
      passwordHash: data.passwordHash,
      isActive: data.isActive ?? true, // active by default
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

// updating an existing user record — handles all fields including profile image changes
export async function updateUser(id: string, data: UpdateUserInput) {
  let previousProfileImage: string | null = null;

  // if the profile image is being changed, we need to save the old URL so we can delete the file later
  if (data.profileImage !== undefined) {
    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: { profileImage: true },
    });
    previousProfileImage = existingUser?.profileImage ?? null;
  }

  // updating the user in the database
  // for optional fields (phone, gender, address), we skip the update if the value is undefined
  // so those fields are only changed when the admin actually sends a new value
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

  // if the profile image was changed, we delete the old file from disk
  if (data.profileImage !== undefined) {
    await deleteReplacedUpload(previousProfileImage, user.profileImage);
  }

  return user;
}

// updating a user's profile photo — fetches the old photo URL, saves the new one, and cleans up the old file
export async function uploadUserPhoto(id: string, photoUrl: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
    select: { profileImage: true }, // only fetching the current photo URL to delete the old file
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

  // deleting the previous photo file from disk now that it has been replaced
  await deleteReplacedUpload(existingUser?.profileImage, user.profileImage);

  return user;
}
