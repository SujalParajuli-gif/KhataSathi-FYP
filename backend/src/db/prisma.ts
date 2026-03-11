// src/db/prisma.ts — Singleton PrismaClient
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default prisma;
