import { createHash } from "node:crypto";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { normalizeImportIdentity } from "./importComparison";

type ProductIdentityClient = PrismaClient | Prisma.TransactionClient;

export class ProductCatalogIdentityConflictError extends Error {
  statusCode = 409;
  code = "PRODUCT_CATALOG_IDENTITY_CONFLICT";

  constructor(public readonly existingProductId: string, name: string, brandName?: string) {
    super(`${brandName ? `${brandName} - ` : ""}${name} already exists in the catalog.`);
  }
}

export function productCatalogIdentityHash(brandId: string, productName: string) {
  const identity = `${brandId}\0${normalizeImportIdentity(productName)}`;
  return createHash("sha256").update(identity).digest("hex");
}

export async function assertProductCatalogIdentityAvailable(
  client: ProductIdentityClient,
  input: { brandId: string; productName: string; excludeProductId?: string },
) {
  const normalizedName = normalizeImportIdentity(input.productName);
  if (!normalizedName) throw new Error("Product name is required.");
  const products = await client.product.findMany({
    where: {
      brandId: input.brandId,
      ...(input.excludeProductId ? { id: { not: input.excludeProductId } } : {}),
    },
    select: { id: true, name: true, brand: { select: { name: true } } },
  });
  const existing = products.find((product) => normalizeImportIdentity(product.name) === normalizedName);
  if (existing) {
    throw new ProductCatalogIdentityConflictError(
      existing.id,
      existing.name,
      existing.brand.name,
    );
  }
  return productCatalogIdentityHash(input.brandId, input.productName);
}

export function isProductCatalogIdentityUniqueError(error: unknown) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; meta?: { target?: unknown } } : {};
  const target = candidate.meta?.target;
  return candidate.code === "P2002"
    && ((Array.isArray(target) && target.includes("catalogIdentityHash"))
      || String(target || "").includes("catalogIdentityHash"));
}
