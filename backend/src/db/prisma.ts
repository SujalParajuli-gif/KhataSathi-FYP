import * as PrismaPkg from "@prisma/client";

// extracting PrismaClient constructor using a dynamic cast
// we do it this way because the import structure can vary depending on the Prisma version and bundler setup
const PrismaClientCtor = (PrismaPkg as any).PrismaClient;

// checking if Prisma Client has been generated before the server starts
// without running "prisma generate" first, PrismaClient will not exist and the backend would crash with a confusing error
// we added this check to give a clear message instead
if (!PrismaClientCtor) {
  throw new Error(
    "Prisma Client is not generated yet. Run 'pnpm install' and 'pnpm exec prisma generate' before starting the backend.",
  );
}

// creating a single Prisma client instance that the entire backend shares
// every service file imports this same instance so all database operations go through one connection
const prisma = new PrismaClientCtor();

export default prisma;
