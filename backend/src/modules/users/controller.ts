import { Request, Response } from "express";
import * as userService from "./service";
import bcrypt from "bcryptjs";

function normalizeRole(role: unknown): "ADMIN" | "CASHIER" {
  return String(role || "CASHIER").toUpperCase() === "ADMIN" ? "ADMIN" : "CASHIER";
}

export async function list(req: Request, res: Response) {
  try {
    const role = req.query.role as "ADMIN" | "CASHIER" | undefined;
    const users = await userService.listUsers({ role });
    res.json(users);
  } catch (err) {
    console.error("List users error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const { name, email, phone, gender, address, role, password, isActive } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "Name, email, and password are required" });
      return;
    }

    const normalizedName = String(name).trim();
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPhone =
      typeof phone === "string" ? String(phone).trim() : undefined;
    const normalizedGender =
      typeof gender === "string" ? String(gender).trim() || undefined : undefined;
    const normalizedAddress =
      typeof address === "string" ? String(address).trim() || undefined : undefined;

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await userService.createUser({
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      gender: normalizedGender,
      address: normalizedAddress,
      role: normalizeRole(role),
      passwordHash,
      isActive: isActive !== false,
    });

    res.status(201).json(user);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Email or phone already exists" });
      return;
    }
    console.error("Create user error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    const { password, currentPassword, newPassword, role, ...data } = req.body;
    const updateData: any = { ...data };
    if (role !== undefined) updateData.role = normalizeRole(role);
    if (newPassword || currentPassword) {
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: "Current password and new password are required" });
        return;
      }

      const userAuth = await userService.getUserAuthById(userId);
      if (!userAuth) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const validPassword = await bcrypt.compare(String(currentPassword), userAuth.passwordHash);
      if (!validPassword) {
        res.status(400).json({ error: "Current password is incorrect" });
        return;
      }

      updateData.passwordHash = await bcrypt.hash(String(newPassword), 10);
    } else if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

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
