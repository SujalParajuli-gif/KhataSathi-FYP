import prisma from "../../db/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";

export async function loginUser(email: string, password: string, ip?: string) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.isActive) {
    await prisma.loginAttempt.create({ data: { email, success: false, ip } });
    return { success: false, error: "Invalid email or password" };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  await prisma.loginAttempt.create({ data: { email, success: valid, ip } });

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
      role: user.role,
      profileImage: user.profileImage,
      nagariktaNo: user.nagariktaNo,
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
      role: true,
      profileImage: true,
      nagariktaNo: true,
      isActive: true,
      lastLogin: true,
    },
  });

  if (!user || !user.isActive) return null;
  return user;
}

export async function updateProfile(userId: string, data: { name?: string; phone?: string; password?: string; profileImage?: string | null }) {
  const updateData: any = {};
  if (data.name) updateData.name = data.name;
  if (data.phone) updateData.phone = data.phone;
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
      role: true,
      profileImage: true,
      isActive: true,
      lastLogin: true,
    },
  });
  return user;
}

export async function uploadProfilePhoto(userId: string, photoUrl: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { profileImage: photoUrl },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      profileImage: true,
      isActive: true,
      lastLogin: true,
    },
  });
  return user;
}
