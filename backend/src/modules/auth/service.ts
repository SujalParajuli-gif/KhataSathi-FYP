import prisma from "../../db/prisma";
import bcrypt from "bcryptjs";
import { deleteReplacedUpload } from "../../lib/uploads";
import { reconcileProfileImage } from "../../lib/profileImages";
import {
  loginAttemptIdentity,
  normalizeLoginIdentity,
  normalizeRequiredUserPhone,
  validateUserPassword,
} from "../../lib/userIdentity";

const DUMMY_PASSWORD_HASH = bcrypt.hash(
  "khatasathi-nonexistent-account-password",
  10,
);

// handling the login process — verifies credentials and logs the attempt
// we also pass the IP address so every login attempt (successful or not) is recorded with the client's IP
export async function loginUser(identifier: string, password: string, ip?: string) {
  const identity = normalizeLoginIdentity(identifier);
  const user = identity
    ? await prisma.user.findUnique({
        where:
          identity.kind === "email"
            ? { email: identity.value }
            : { phone: identity.value },
      })
    : null;

  // Always perform a password comparison, including for missing accounts. The
  // response stays identical for an unknown identifier, wrong password, or a
  // deactivated account so the login form cannot be used for account discovery.
  const validPassword = await bcrypt.compare(
    password,
    user?.passwordHash || (await DUMMY_PASSWORD_HASH),
  );
  const success = Boolean(user?.isActive && validPassword);
  await prisma.loginAttempt.create({
    data: {
      email: loginAttemptIdentity(identifier, identity),
      success,
      ip,
    },
  });

  if (!success || !user) {
    return { success: false, error: "Invalid phone/email or password" };
  }

  const now = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: now } }); // updating the user's lastLogin timestamp

  // returning a safe subset of user fields (no passwordHash). The controller
  // creates the opaque server-side session only after credentials succeed.
  const safeUser = await reconcileProfileImage(user);

  return {
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      gender: user.gender,
      address: user.address,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      profileImage: safeUser.profileImage,
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
      mustChangePassword: true,
      lastLogin: true,
    },
  });

  if (!user || !user.isActive) return null; // returning null if the user was deactivated since they logged in
  return reconcileProfileImage(user);
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
    validateUserPassword(nextPassword);
    if (await bcrypt.compare(nextPassword, existingUser.passwordHash)) {
      throw new Error("New password must be different from the current password");
    }
  }

  // building the update object with only the fields that were actually provided
  // we trim string values and convert empty strings to null for optional fields
  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.phone !== undefined) updateData.phone = normalizeRequiredUserPhone(data.phone);
  if (data.gender !== undefined) updateData.gender = data.gender?.trim() || null;
  if (data.address !== undefined) updateData.address = data.address?.trim() || null;
  if (nextPassword) {
    updateData.passwordHash = await bcrypt.hash(nextPassword, 10); // hashing the new password with bcrypt (10 salt rounds)
    updateData.mustChangePassword = false;
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
      mustChangePassword: true,
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
