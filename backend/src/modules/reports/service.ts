import prisma from "../../db/prisma";

export async function salesSummary(from: string, to: string) {
  const dateFilter = {
    finalizedAt: {
      gte: new Date(from),
      lte: new Date(`${to}T23:59:59.999Z`),
    },
    status: "FINALIZED" as const,
  };

  const invoices = await prisma.invoice.findMany({
    where: dateFilter,
    select: {
      id: true,
      invoiceNo: true,
      subTotal: true,
      loyaltyDiscountAmount: true,
      netTotal: true,
      paidTotal: true,
      finalizedAt: true,
    },
  });

  const totalSales = invoices.reduce((sum, inv) => sum + inv.netTotal, 0);
  const totalDiscount = invoices.reduce((sum, inv) => sum + inv.loyaltyDiscountAmount, 0);
  const totalCollected = invoices.reduce((sum, inv) => sum + inv.paidTotal, 0);

  return {
    from,
    to,
    invoiceCount: invoices.length,
    totalSales: Math.round(totalSales * 100) / 100,
    totalRevenue: Math.round(totalSales * 100) / 100,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    totalCollected: Math.round(totalCollected * 100) / 100,
    totalPaid: Math.round(totalCollected * 100) / 100,
    invoices,
  };
}

export async function bestSellers(from: string, to: string, limit = 10) {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "FINALIZED",
      finalizedAt: {
        gte: new Date(from),
        lte: new Date(`${to}T23:59:59.999Z`),
      },
    },
    select: { id: true },
  });

  const invoiceIds = invoices.map((invoice) => invoice.id);
  if (invoiceIds.length === 0) return [];

  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId: { in: invoiceIds } },
    include: { product: { select: { id: true, name: true, sku: true, barcode: true } } },
  });

  const productMap = new Map<string, { product: any; totalQty: number; totalRevenue: number }>();

  for (const item of items) {
    const existing = productMap.get(item.productId);
    if (existing) {
      existing.totalQty += item.qty;
      existing.totalRevenue += item.lineTotal;
    } else {
      productMap.set(item.productId, {
        product: item.product,
        totalQty: item.qty,
        totalRevenue: item.lineTotal,
      });
    }
  }

  return Array.from(productMap.values())
    .sort((a, b) => b.totalQty - a.totalQty)
    .slice(0, limit);
}

export async function cashierSales(from: string, to: string) {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "FINALIZED",
      finalizedAt: {
        gte: new Date(from),
        lte: new Date(`${to}T23:59:59.999Z`),
      },
    },
    include: {
      cashier: { select: { id: true, name: true, email: true } },
    },
  });

  const cashierMap = new Map<string, { cashier: any; invoiceCount: number; totalSales: number }>();

  for (const inv of invoices) {
    const existing = cashierMap.get(inv.cashierId);
    if (existing) {
      existing.invoiceCount += 1;
      existing.totalSales += inv.netTotal;
    } else {
      cashierMap.set(inv.cashierId, {
        cashier: inv.cashier,
        invoiceCount: 1,
        totalSales: inv.netTotal,
      });
    }
  }

  return Array.from(cashierMap.values()).sort((a, b) => b.totalSales - a.totalSales);
}
