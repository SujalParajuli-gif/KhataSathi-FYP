// src/modules/auth/service.ts — Auth business logic
import prisma from "../../db/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret";

export async function loginUser(email: string, password: string, ip?: string) {
    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.isActive) {
        // Log failed attempt
        await prisma.loginAttempt.create({
            data: { email, success: false, ip },
        });
        return { success: false, error: "Invalid email or password" };
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.passwordHash);

    // Log the attempt
    await prisma.loginAttempt.create({
        data: { email, success: valid, ip },
    });

    if (!valid) {
        return { success: false, error: "Invalid email or password" };
    }

    // Generate JWT (expires in 8 hours)
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
        expiresIn: "8h",
    });

    return {
        success: true,
        token,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
        },
    };
}

export async function getMe(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
        return null;
    }

    return user;
}
