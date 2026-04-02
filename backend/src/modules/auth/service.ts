import prisma from "../../db/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { deleteReplacedUpload } from "../../lib/uploads";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";

export async function loginUser(email: string, password: string, ip?: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user || !user.isActive) {
    await prisma.loginAttempt.create({ data: { email: normalizedEmail, success: false, ip } });
    return { success: false, error: "Invalid email or password" };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  await prisma.loginAttempt.create({ data: { email: normalizedEmail, success: valid, ip } });

  if (!valid) {
    return { success: false, error: "Invalid email or password" };
  }

  const now = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: now } });

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "8h" });

  return {
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      gender: user.gender,
      address: user.address,
      role: user.role,
      profileImage: user.profileImage,
      lastLogin: now,
    },
  };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      profileImage: true,
      isActive: true,
      lastLogin: true,
    },
  });

  if (!user || !user.isActive) return null;
  return user;
}

export async function updateProfile(userId: string, data: { name?: string; phone?: string; gender?: string | null; address?: string | null; password?: string; profileImage?: string | null }) {
  let previousProfileImage: string | null = null;
  if (data.profileImage !== undefined) {
    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileImage: true },
    });
    previousProfileImage = existingUser?.profileImage ?? null;
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.phone !== undefined) updateData.phone = data.phone.trim() || null;
  if (data.gender !== undefined) updateData.gender = data.gender?.trim() || null;
  if (data.address !== undefined) updateData.address = data.address?.trim() || null;
  if (data.password) {
    updateData.passwordHash = await bcrypt.hash(data.password, 10);
  }
  if (data.profileImage !== undefined) updateData.profileImage = data.profileImage;

  const user = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      profileImage: true,
      isActive: true,
      lastLogin: true,
    },
  });

  if (data.profileImage !== undefined) {
    await deleteReplacedUpload(previousProfileImage, user.profileImage);
  }

  return user;
}

export async function uploadProfilePhoto(userId: string, photoUrl: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { profileImage: true },
  });

  const user = await prisma.user.update({
    where: { id: userId },
    data: { profileImage: photoUrl },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gender: true,
      address: true,
      role: true,
      profileImage: true,
      isActive: true,
      lastLogin: true,
    },
  });

  await deleteReplacedUpload(existingUser?.profileImage, user.profileImage);

  return user;
}
