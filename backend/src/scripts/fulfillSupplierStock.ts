import prisma from "../db/prisma";
import { buildInitialSupplierStock } from "../modules/products/service";

async function main() {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      vendorSource: { not: null },
      stock: { lte: 0 },
    },
    select: {
      id: true,
      name: true,
      sku: true,
      stock: true,
      packageQuantity: true,
    },
  });

  const actor = await prisma.user.findFirst({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let updatedCount = 0;
  let totalStockAdded = 0;

  for (const product of products) {
    const targetStock = buildInitialSupplierStock(product.packageQuantity);
    const qtyDelta = Math.max(0, targetStock - Number(product.stock || 0));
    if (qtyDelta <= 0) continue;

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { stock: targetStock },
      });

      if (actor) {
        await tx.stockTransaction.create({
          data: {
            productId: product.id,
            type: "RESTOCK",
            qtyDelta,
            reason: "Initial supplier catalog stock fulfillment",
            createdById: actor.id,
          },
        });
      }
    });

    updatedCount += 1;
    totalStockAdded += qtyDelta;
  }

  const activeProducts = await prisma.product.count({ where: { isActive: true } });
  const outOfStockProducts = await prisma.product.count({
    where: { isActive: true, stock: { lte: 0 } },
  });
  const stockRows = await prisma.product.findMany({
    where: { isActive: true },
    select: { stock: true, lowStockThreshold: true },
  });
  const lowStockProducts = stockRows.filter(
    (product) => product.stock > 0 && product.stock <= product.lowStockThreshold,
  ).length;

  console.log(
    JSON.stringify(
      {
        updatedCount,
        totalStockAdded,
        stockTransactionsCreated: actor ? updatedCount : 0,
        actorFound: Boolean(actor),
        catalog: {
          activeProducts,
          outOfStockProducts,
          lowStockProducts,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
