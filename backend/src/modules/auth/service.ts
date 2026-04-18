import prisma from "../../db/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { deleteReplacedUpload } from "../../lib/uploads";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret"; // pulling secret from env, fallback is only for local dev

// handling the login process — verifies credentials, logs the attempt, and issues a JWT token on success
// we also pass the IP address so every login attempt (successful or not) is recorded with the client's IP
export async function loginUser(email: string, password: string, ip?: string) {
  const normalizedEmail = email.trim().toLowerCase(); // normalizing email to lowercase so "Admin@email.com" and "admin@email.com" are treated the same
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } }); // looking up the user by their normalized email

  // this handles when the user does not exist or their account has been deactivated
  // we log the failed attempt and return a generic error so attackers cannot tell if the email exists
  if (!user || !user.isActive) {
    await prisma.loginAttempt.create({ data: { email: normalizedEmail, success: false, ip } });
    return { success: false, error: "Invalid email or password" };
  }

  const valid = await bcrypt.compare(password, user.passwordHash); // comparing the entered password against the stored hash
  await prisma.loginAttempt.create({ data: { email: normalizedEmail, success: valid, ip } }); // logging the attempt regardless of success or failure

  // this handles when the password does not match
  if (!valid) {
    return { success: false, error: "Invalid email or password" };
  }

  const now = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: now } }); // updating the user's lastLogin timestamp

  // creating a JWT with the user's id and role, valid for 8 hours
  // the frontend stores this token and sends it with every API request
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "8h" });

  // returning the token and a safe subset of user fields (no passwordHash)
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

// fetching the current user's profile data by their ID
// we use a select to only return the fields the frontend needs, and exclude sensitive fields like passwordHash
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

  if (!user || !user.isActive) return null; // returning null if the user was deactivated since they logged in
  return user;
}

// updating the logged-in user's own profile — they can change name, phone, gender, address, password, or profile image
// for password changes, the user must provide their current password first for security
export async function updateProfile(userId: string, data: { name?: string; phone?: string; gender?: string | null; address?: string | null; currentPassword?: string; newPassword?: string; password?: string; profileImage?: string | null }) {
  const nextPassword = data.newPassword || data.password; // supporting both field names for backward compatibility
  let previousProfileImage: string | null = null; // storing the old image URL so we can delete the file later if it changes
  let existingUser:
    | {
        passwordHash: string;
        profileImage: string | null;
      }
    | null = null;

  // we only need to fetch the existing user if we are changing the profile image or password
  // this avoids an unnecessary database call when only updating name/phone/etc
  if (data.profileImage !== undefined || nextPassword) {
    existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, profileImage: true },
    });
  }

  // saving the previous profile image URL so we can delete the old file after updating
  if (data.profileImage !== undefined) {
    previousProfileImage = existingUser?.profileImage ?? null;
  }

  // password change requires the current password for verification
  // this prevents someone who has access to the session from changing the password without knowing the old one
  if (nextPassword) {
    if (!existingUser) {
      throw new Error("User not found");
    }
    if (!data.currentPassword) {
      throw new Error("Current password is required");
    }
    const passwordMatches = await bcrypt.compare(
      data.currentPassword,
      existingUser.passwordHash,
    );
    if (!passwordMatches) {
      throw new Error("Current password is incorrect");
    }
  }

  // building the update object with only the fields that were actually provided
  // we trim string values and convert empty strings to null for optional fields
  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.phone !== undefined) updateData.phone = data.phone.trim() || null;
  if (data.gender !== undefined) updateData.gender = data.gender?.trim() || null;
  if (data.address !== undefined) updateData.address = data.address?.trim() || null;
  if (nextPassword) {
    updateData.passwordHash = await bcrypt.hash(nextPassword, 10); // hashing the new password with bcrypt (10 salt rounds)
  }
  if (data.profileImage !== undefined) updateData.profileImage = data.profileImage;

  // updating the user record and returning the updated profile fields
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

  // if the profile image was changed, we delete the old file from disk so it does not take up space
  if (data.profileImage !== undefined) {
    await deleteReplacedUpload(previousProfileImage, user.profileImage);
  }

  return user;
}

// updating the user's profile photo after multer has saved the file to disk
// we fetch the old photo URL first so we can delete it after the database update
export async function uploadProfilePhoto(userId: string, photoUrl: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { profileImage: true }, // only need the current image URL to delete the old file
  });

  // saving the new photo URL to the database
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

  // deleting the previous profile photo file from disk since it has been replaced
  await deleteReplacedUpload(existingUser?.profileImage, user.profileImage);

  return user;
}
