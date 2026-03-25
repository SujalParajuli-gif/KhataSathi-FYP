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
    const { name, email, phone, role, password, isActive, nagariktaNo } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "Name, email, and password are required" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await userService.createUser({
      name: String(name).trim(),
      email: String(email).trim(),
      phone: phone ? String(phone).trim() : undefined,
      role: normalizeRole(role),
      passwordHash,
      isActive: isActive !== false,
      nagariktaNo: nagariktaNo ? String(nagariktaNo).trim() : undefined,
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
    const { password, role, ...data } = req.body;
    const updateData: any = { ...data };
    if (role !== undefined) updateData.role = normalizeRole(role);
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    if (typeof updateData.phone === "string") updateData.phone = updateData.phone.trim() || null;

    const user = await userService.updateUser(req.params.id, updateData);
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
