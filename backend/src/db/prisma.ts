import * as PrismaPkg from "@prisma/client";

const PrismaClientCtor = (PrismaPkg as any).PrismaClient;

if (!PrismaClientCtor) {
  throw new Error(
    "Prisma Client is not generated yet. Run 'pnpm install' and 'pnpm exec prisma generate' before starting the backend.",
  );
}

const prisma = new PrismaClientCtor();

export default prisma;
