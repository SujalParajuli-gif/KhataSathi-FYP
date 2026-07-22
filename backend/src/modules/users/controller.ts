import { Request, Response } from "express";
import * as userService from "./service";
import bcrypt from "bcryptjs";

// normalizing role input to one of the supported staff roles.
// if the role is not provided or is invalid, it defaults to "CASHIER"
function normalizeRole(role: unknown): userService.ManagedUserRole {
  const normalized = String(role || "CASHIER").toUpperCase();
  return normalized === "ADMIN" ||
    normalized === "MANAGER" ||
    normalized === "CASHIER" ||
    normalized === "STAFF"
    ? normalized
    : "CASHIER";
}

// listing all users, with optional role filter
// the admin uses this to view and manage cashier accounts
export async function list(req: Request, res: Response) {
  try {
    const role = req.query.role ? normalizeRole(req.query.role) : undefined; // reading the optional role filter from the query string
    const users = await userService.listUsers({ role });
    res.json(users);
  } catch (err) {
    console.error("List users error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function touchPresence(req: Request, res: Response) {
  try {
    const presence = await userService.touchUserPresence(req.user!.id);
    res.json({ presence });
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    console.error("Update user presence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listCashierPresence(_req: Request, res: Response) {
  try {
    const cashiers = await userService.listCashierPresence();
    res.json({ cashiers });
  } catch (err) {
    console.error("List cashier presence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// creating a new user — the admin uses this to add new cashier accounts
export async function create(req: Request, res: Response) {
  try {
    const { name, email, phone, gender, address, role, password, isActive } = req.body;

    // validating that the required fields are present
    if (!name || !email || !password) {
      res.status(400).json({ error: "Name, email, and password are required" });
      return;
    }

    // normalizing all string inputs — trimming whitespace and lowercasing the email
    const normalizedName = String(name).trim();
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPhone =
      typeof phone === "string" ? String(phone).trim() : undefined;
    const normalizedGender =
      typeof gender === "string" ? String(gender).trim() || undefined : undefined;
    const normalizedAddress =
      typeof address === "string" ? String(address).trim() || undefined : undefined;

    const passwordHash = await bcrypt.hash(password, 10); // hashing the password with 10 salt rounds before storing
    const user = await userService.createUser({
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      gender: normalizedGender,
      address: normalizedAddress,
      role: normalizeRole(role),
      passwordHash,
      isActive: isActive !== false, // defaults to true unless explicitly set to false
    });

    res.status(201).json(user);
  } catch (err: any) {
    // P2002 means a unique constraint was violated — either the email or phone already exists
    if (err.code === "P2002") {
      res.status(409).json({ error: "Email or phone already exists" });
      return;
    }
    console.error("Create user error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// updating an existing user — admin can change name, email, role, password, active status, etc.
// unlike the self-profile update, the admin does not need to provide the current password
export async function update(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    const { password, newPassword, role, ...data } = req.body; // separating password and role for special handling
    const updateData: any = { ...data };

    if (role !== undefined) updateData.role = normalizeRole(role); // normalizing role to ensure it is valid

    // admin can set a new password directly — supporting both "newPassword" and "password" field names
    if (newPassword) {
      updateData.passwordHash = await bcrypt.hash(String(newPassword), 10);
    } else if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

    // trimming and normalizing all string fields before saving
    if (typeof updateData.name === "string") updateData.name = updateData.name.trim();
    if (typeof updateData.email === "string") {
      updateData.email = updateData.email.trim().toLowerCase();
    }
    if (typeof updateData.phone === "string") updateData.phone = updateData.phone.trim() || null;
    if (typeof updateData.gender === "string") updateData.gender = updateData.gender.trim() || null;
    if (typeof updateData.address === "string") updateData.address = updateData.address.trim() || null;

    const user = await userService.updateUser(userId, updateData);
    res.json(user);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Email or phone already exists" });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    console.error("Update user error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteSafety(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    const safety = await userService.getUserDeleteSafety(userId, req.user!.id);
    res.json(safety);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    console.error("User delete safety error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function permanentDelete(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    const result = await userService.permanentlyDeleteUser(userId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.code === "P2025") {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (err.code === "USER_DELETE_BLOCKED") {
      res.status(409).json({
        error: err.message,
        safety: err.safety,
      });
      return;
    }
    console.error("Permanent user delete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
