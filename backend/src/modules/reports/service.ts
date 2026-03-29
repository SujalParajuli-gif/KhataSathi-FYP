import { Prisma, type PaymentMethod, type PaymentStatusInvoice } from "@prisma/client";
import prisma from "../../db/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "ESEWA", "KHALTI"];
const INVOICE_PAYMENT_STATUSES: PaymentStatusInvoice[] = [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
];

export type AnalyticsFilters = {
  from: string;
  to: string;
  cashierId?: string;
  paymentStatus?: PaymentStatusInvoice;
};

type BucketGranularity = "hour" | "day" | "week";

type BucketMetrics = {
  key: string;
  label: string;
  revenue: number;
  collected: number;
  due: number;
  discount: number;
  invoices: number;
  itemsSold: number;
  averageBasket: number;
};

type PaymentDistributionSlice = {
  method: PaymentMethod;
  amount: number;
  count: number;
};

type ReportInvoice = Awaited<ReturnType<typeof getReportInvoices>>[number];

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function parseDateInput(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date.`);
  }

  return parsed;
}

function toUtcDayStart(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function toUtcDayEnd(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function addUtcHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * HOUR_MS);
}

function startOfUtcWeek(date: Date) {
  const day = date.getUTCDay();
  const distanceFromMonday = (day + 6) % 7;
  return addUtcDays(toUtcDayStart(date), -distanceFromMonday);
}

function formatMonthDay(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatHourLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    timeZone: "UTC",
  }).format(date);
}

function resolveBucketGranularity(fromDate: Date, toDate: Date): BucketGranularity {
  const spanDays =
    Math.floor((toUtcDayStart(toDate).getTime() - toUtcDayStart(fromDate).getTime()) / DAY_MS) + 1;

  if (spanDays <= 1) return "hour";
  if (spanDays <= 45) return "day";
  return "week";
}

function buildBucketSeed(
  fromDate: Date,
  toDate: Date,
  granularity: BucketGranularity,
) {
  const buckets: BucketMetrics[] = [];
  const map = new Map<string, BucketMetrics>();

  if (granularity === "hour") {
    const start = toUtcDayStart(fromDate);
    for (let hour = 0; hour < 24; hour += 1) {
      const bucketDate = addUtcHours(start, hour);
      const key = bucketDate.toISOString().slice(0, 13);
      const bucket: BucketMetrics = {
        key,
        label: formatHourLabel(bucketDate),
        revenue: 0,
        collected: 0,
        due: 0,
        discount: 0,
        invoices: 0,
        itemsSold: 0,
        averageBasket: 0,
      };

      buckets.push(bucket);
      map.set(key, bucket);
    }

    return { buckets, map };
  }

  if (granularity === "day") {
    for (
      let bucketDate = toUtcDayStart(fromDate);
      bucketDate <= toUtcDayStart(toDate);
      bucketDate = addUtcDays(bucketDate, 1)
    ) {
      const key = bucketDate.toISOString().slice(0, 10);
      const bucket: BucketMetrics = {
        key,
        label: formatMonthDay(bucketDate),
        revenue: 0,
        collected: 0,
        due: 0,
        discount: 0,
        invoices: 0,
        itemsSold: 0,
        averageBasket: 0,
      };

      buckets.push(bucket);
      map.set(key, bucket);
    }

    return { buckets, map };
  }

  for (
    let bucketDate = startOfUtcWeek(fromDate);
    bucketDate <= toUtcDayStart(toDate);
    bucketDate = addUtcDays(bucketDate, 7)
  ) {
    const key = bucketDate.toISOString().slice(0, 10);
    const bucket: BucketMetrics = {
      key,
      label: `Week of ${formatMonthDay(bucketDate)}`,
      revenue: 0,
      collected: 0,
      due: 0,
      discount: 0,
      invoices: 0,
      itemsSold: 0,
      averageBasket: 0,
    };

    buckets.push(bucket);
    map.set(key, bucket);
  }

  return { buckets, map };
}

function getBucketKey(date: Date, granularity: BucketGranularity) {
  if (granularity === "hour") {
    return date.toISOString().slice(0, 13);
  }

  if (granularity === "day") {
    return date.toISOString().slice(0, 10);
  }

  return startOfUtcWeek(date).toISOString().slice(0, 10);
}

function normalizeAnalyticsFilters(filters: AnalyticsFilters) {
  const fromDate = parseDateInput(filters.from, "from");
  const toDate = parseDateInput(filters.to, "to");

  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error("from must be before or equal to to.");
  }

  if (
    filters.paymentStatus &&
    !INVOICE_PAYMENT_STATUSES.includes(filters.paymentStatus)
  ) {
    throw new Error("Unsupported paymentStatus filter.");
  }

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      cashierId: filters.cashierId || undefined,
      paymentStatus: filters.paymentStatus || undefined,
    },
    fromDate,
    toDate,
    startAt: toUtcDayStart(fromDate),
    endAt: toUtcDayEnd(toDate),
  };
}

async function getReportInvoices(where: Prisma.InvoiceWhereInput) {
  return prisma.invoice.findMany({
    where,
    orderBy: { finalizedAt: "asc" },
    include: {
      cashier: {
        select: {
          id: true,
          name: true,
        },
      },
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
        },
      },
      items: {
        select: {
          id: true,
          qty: true,
          appliedUnitPrice: true,
          lineTotal: true,
          productId: true,
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      },
      payments: {
        select: {
          id: true,
          method: true,
          amount: true,
          status: true,
          reference: true,
          createdAt: true,
        },
      },
    },
  });
}

function buildWhereClause({
  startAt,
  endAt,
  filters,
}: {
  startAt: Date;
  endAt: Date;
  filters: AnalyticsFilters;
}): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {
    status: "FINALIZED",
    finalizedAt: {
      gte: startAt,
      lte: endAt,
    },
  };

  if (filters.cashierId) {
    where.cashierId = filters.cashierId;
  }

  if (filters.paymentStatus) {
    where.paymentStatus = filters.paymentStatus;
  }

  return where;
}

function sumInvoiceItemQty(invoice: ReportInvoice) {
  return invoice.items.reduce((sum, item) => sum + item.qty, 0);
}

function sumSuccessfulPayments(invoice: ReportInvoice) {
  return roundCurrency(
    invoice.payments
      .filter((payment) => payment.status === "SUCCESS")
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
}

export async function getAnalyticsReport(input: AnalyticsFilters) {
  const normalized = normalizeAnalyticsFilters(input);
  const granularity = resolveBucketGranularity(
    normalized.fromDate,
    normalized.toDate,
  );
  const { buckets, map: bucketMap } = buildBucketSeed(
    normalized.fromDate,
    normalized.toDate,
    granularity,
  );

  const invoices = await getReportInvoices(
    buildWhereClause({
      startAt: normalized.startAt,
      endAt: normalized.endAt,
      filters: normalized.filters,
    }),
  );

  const availableCashiers = await prisma.user.findMany({
    where: {
      role: "CASHIER",
      isActive: true,
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
    },
  });

  const productMap = new Map<
    string,
    {
      productId: string;
      name: string;
      sku: string;
      brandId: string | null;
      brandName: string;
      qty: number;
      revenue: number;
      invoiceCount: number;
    }
  >();
  const brandMap = new Map<
    string,
    {
      brandId: string | null;
      brandName: string;
      qty: number;
      revenue: number;
      invoiceCount: number;
    }
  >();
  const customerMap = new Map<
    string,
    {
      customerId: string | null;
      name: string;
      phone: string | null;
      invoiceCount: number;
      revenue: number;
      collected: number;
      due: number;
      discount: number;
      itemsSold: number;
      averageBasket: number;
    }
  >();
  const cashierMap = new Map<
    string,
    {
      cashierId: string;
      name: string;
      invoiceCount: number;
      revenue: number;
      collected: number;
      due: number;
      discount: number;
      itemsSold: number;
      averageBasket: number;
    }
  >();
  const paymentMap = new Map<PaymentMethod, PaymentDistributionSlice>(
    PAYMENT_METHODS.map((method) => [
      method,
      {
        method,
        amount: 0,
        count: 0,
      },
    ]),
  );

  let grossSales = 0;
  let discountTotal = 0;
  let netSales = 0;
  let collectedTotal = 0;
  let dueTotal = 0;
  let itemsSold = 0;
  let activeInvoiceCount = 0;
  let cancelledInvoiceCount = 0;
  let paidInvoiceCount = 0;
  let partiallyPaidInvoiceCount = 0;
  let unpaidInvoiceCount = 0;
  let walkInInvoiceCount = 0;

  for (const invoice of invoices) {
    const successfulPaidTotal = sumSuccessfulPayments(invoice);
    const effectivePaidTotal = roundCurrency(
      Math.max(invoice.paidTotal, successfulPaidTotal),
    );
    const isCancelled = invoice.paymentStatus === "CANCELLED";

    if (isCancelled) {
      cancelledInvoiceCount += 1;
      continue;
    }

    activeInvoiceCount += 1;
    if (invoice.paymentStatus === "PAID") paidInvoiceCount += 1;
    else if (invoice.paymentStatus === "PARTIALLY_PAID") partiallyPaidInvoiceCount += 1;
    else unpaidInvoiceCount += 1;

    const invoiceDue = roundCurrency(
      Math.max(0, invoice.netTotal - effectivePaidTotal),
    );
    const invoiceItemsSold = sumInvoiceItemQty(invoice);
    const customerKey = invoice.customer?.id || "__walk_in__";
    const bucketKey = getBucketKey(
      invoice.finalizedAt || invoice.createdAt,
      granularity,
    );
    const bucket = bucketMap.get(bucketKey);

    grossSales += invoice.subTotal;
    discountTotal += invoice.loyaltyDiscountAmount;
    netSales += invoice.netTotal;
    collectedTotal += effectivePaidTotal;
    dueTotal += invoiceDue;
    itemsSold += invoiceItemsSold;

    if (!invoice.customer?.id) {
      walkInInvoiceCount += 1;
    }

    if (bucket) {
      bucket.revenue += invoice.netTotal;
      bucket.collected += effectivePaidTotal;
      bucket.due += invoiceDue;
      bucket.discount += invoice.loyaltyDiscountAmount;
      bucket.invoices += 1;
      bucket.itemsSold += invoiceItemsSold;
    }

    for (const item of invoice.items) {
      const existingProduct = productMap.get(item.productId);
      if (existingProduct) {
        existingProduct.qty += item.qty;
        existingProduct.revenue += item.lineTotal;
        existingProduct.invoiceCount += 1;
      } else {
        productMap.set(item.productId, {
          productId: item.productId,
          name: item.product.name,
          sku: item.product.sku,
          brandId: item.product.brand?.id || null,
          brandName: item.product.brand?.name || "Unbranded",
          qty: item.qty,
          revenue: item.lineTotal,
          invoiceCount: 1,
        });
      }

      const brandKey = item.product.brand?.id || "__unbranded__";
      const existingBrand = brandMap.get(brandKey);
      if (existingBrand) {
        existingBrand.qty += item.qty;
        existingBrand.revenue += item.lineTotal;
        existingBrand.invoiceCount += 1;
      } else {
        brandMap.set(brandKey, {
          brandId: item.product.brand?.id || null,
          brandName: item.product.brand?.name || "Unbranded",
          qty: item.qty,
          revenue: item.lineTotal,
          invoiceCount: 1,
        });
      }
    }

    for (const payment of invoice.payments) {
      if (payment.status !== "SUCCESS") continue;
      const slice = paymentMap.get(payment.method);
      if (!slice) continue;

      slice.amount += payment.amount;
      slice.count += 1;
    }

    const existingCustomer = customerMap.get(customerKey);
    if (existingCustomer) {
      existingCustomer.invoiceCount += 1;
      existingCustomer.revenue += invoice.netTotal;
      existingCustomer.collected += effectivePaidTotal;
      existingCustomer.due += invoiceDue;
      existingCustomer.discount += invoice.loyaltyDiscountAmount;
      existingCustomer.itemsSold += invoiceItemsSold;
    } else {
      customerMap.set(customerKey, {
        customerId: invoice.customer?.id || null,
        name: invoice.customer?.name || "Walk-in customer",
        phone: invoice.customer?.phone || null,
        invoiceCount: 1,
        revenue: invoice.netTotal,
        collected: effectivePaidTotal,
        due: invoiceDue,
        discount: invoice.loyaltyDiscountAmount,
        itemsSold: invoiceItemsSold,
        averageBasket: 0,
      });
    }

    const existingCashier = cashierMap.get(invoice.cashierId);
    if (existingCashier) {
      existingCashier.invoiceCount += 1;
      existingCashier.revenue += invoice.netTotal;
      existingCashier.collected += effectivePaidTotal;
      existingCashier.due += invoiceDue;
      existingCashier.discount += invoice.loyaltyDiscountAmount;
      existingCashier.itemsSold += invoiceItemsSold;
    } else {
      cashierMap.set(invoice.cashierId, {
        cashierId: invoice.cashierId,
        name: invoice.cashier?.name || "Unknown cashier",
        invoiceCount: 1,
        revenue: invoice.netTotal,
        collected: effectivePaidTotal,
        due: invoiceDue,
        discount: invoice.loyaltyDiscountAmount,
        itemsSold: invoiceItemsSold,
        averageBasket: 0,
      });
    }
  }

  for (const bucket of buckets) {
    bucket.revenue = roundCurrency(bucket.revenue);
    bucket.collected = roundCurrency(bucket.collected);
    bucket.due = roundCurrency(bucket.due);
    bucket.discount = roundCurrency(bucket.discount);
    bucket.averageBasket =
      bucket.invoices > 0 ? roundCurrency(bucket.revenue / bucket.invoices) : 0;
  }

  const topProducts = Array.from(productMap.values())
    .map((product) => ({
      ...product,
      revenue: roundCurrency(product.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, 10);

  const topCustomers = Array.from(customerMap.values())
    .map((customer) => ({
      ...customer,
      revenue: roundCurrency(customer.revenue),
      collected: roundCurrency(customer.collected),
      due: roundCurrency(customer.due),
      discount: roundCurrency(customer.discount),
      averageBasket:
        customer.invoiceCount > 0
          ? roundCurrency(customer.revenue / customer.invoiceCount)
          : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.invoiceCount - a.invoiceCount)
    .slice(0, 10);

  const cashierPerformance = Array.from(cashierMap.values())
    .map((cashier) => ({
      ...cashier,
      revenue: roundCurrency(cashier.revenue),
      collected: roundCurrency(cashier.collected),
      due: roundCurrency(cashier.due),
      discount: roundCurrency(cashier.discount),
      averageBasket:
        cashier.invoiceCount > 0
          ? roundCurrency(cashier.revenue / cashier.invoiceCount)
          : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.invoiceCount - a.invoiceCount);

  const brandPerformance = Array.from(brandMap.values())
    .map((brand) => ({
      ...brand,
      revenue: roundCurrency(brand.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);

  const paymentDistribution = PAYMENT_METHODS.map((method) => {
    const slice = paymentMap.get(method);
    return {
      method,
      amount: roundCurrency(slice?.amount || 0),
      count: slice?.count || 0,
    };
  });

  return {
    filters: normalized.filters,
    meta: {
      generatedAt: new Date().toISOString(),
      bucketGranularity: granularity,
      rangeDays:
        Math.floor(
          (toUtcDayStart(normalized.toDate).getTime() -
            toUtcDayStart(normalized.fromDate).getTime()) /
            DAY_MS,
        ) + 1,
    },
    cashiers: availableCashiers,
    summary: {
      finalizedInvoiceCount: invoices.length,
      invoiceCount: activeInvoiceCount,
      cancelledInvoiceCount,
      paidInvoiceCount,
      partiallyPaidInvoiceCount,
      unpaidInvoiceCount,
      customerCount: Array.from(customerMap.values()).filter(
        (customer) => customer.customerId,
      ).length,
      cashierCount: cashierMap.size,
      walkInInvoiceCount,
      itemsSold,
      grossSales: roundCurrency(grossSales),
      discountTotal: roundCurrency(discountTotal),
      netSales: roundCurrency(netSales),
      collectedTotal: roundCurrency(collectedTotal),
      dueTotal: roundCurrency(dueTotal),
      averageBasketSize:
        activeInvoiceCount > 0
          ? roundCurrency(netSales / activeInvoiceCount)
          : 0,
      collectionRate:
        netSales > 0 ? roundCurrency((collectedTotal / netSales) * 100) : 0,
      discountRate:
        grossSales > 0 ? roundCurrency((discountTotal / grossSales) * 100) : 0,
    },
    salesOverTime: buckets,
    topProducts,
    topCustomers,
    cashierPerformance,
    paymentDistribution,
    brandPerformance,
  };
}

function formatCsvValue(value: string | number) {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function csvRow(values: Array<string | number>) {
  return values.map(formatCsvValue).join(",");
}

export async function exportAnalyticsCsv(filters: AnalyticsFilters) {
  const report = await getAnalyticsReport(filters);
  const lines: string[] = [];

  lines.push(csvRow(["KhataSathi Analytics Export"]));
  lines.push(csvRow(["Generated At", report.meta.generatedAt]));
  lines.push(csvRow(["From", report.filters.from]));
  lines.push(csvRow(["To", report.filters.to]));
  lines.push(csvRow(["Cashier Filter", report.filters.cashierId || "All cashiers"]));
  lines.push(
    csvRow([
      "Payment Status Filter",
      report.filters.paymentStatus || "All payment statuses",
    ]),
  );
  lines.push("");

  lines.push(csvRow(["Summary"]));
  lines.push(csvRow(["Metric", "Value"]));
  lines.push(csvRow(["Sales invoices", report.summary.invoiceCount]));
  lines.push(csvRow(["Cancelled invoices", report.summary.cancelledInvoiceCount]));
  lines.push(csvRow(["Paid invoices", report.summary.paidInvoiceCount]));
  lines.push(
    csvRow(["Partially paid invoices", report.summary.partiallyPaidInvoiceCount]),
  );
  lines.push(csvRow(["Unpaid invoices", report.summary.unpaidInvoiceCount]));
  lines.push(csvRow(["Customers", report.summary.customerCount]));
  lines.push(csvRow(["Walk-in invoices", report.summary.walkInInvoiceCount]));
  lines.push(csvRow(["Cashiers", report.summary.cashierCount]));
  lines.push(csvRow(["Items sold", report.summary.itemsSold]));
  lines.push(csvRow(["Gross sales", report.summary.grossSales]));
  lines.push(csvRow(["Discount total", report.summary.discountTotal]));
  lines.push(csvRow(["Net sales", report.summary.netSales]));
  lines.push(csvRow(["Collected total", report.summary.collectedTotal]));
  lines.push(csvRow(["Due total", report.summary.dueTotal]));
  lines.push(csvRow(["Average basket size", report.summary.averageBasketSize]));
  lines.push(csvRow(["Collection rate (%)", report.summary.collectionRate]));
  lines.push(csvRow(["Discount rate (%)", report.summary.discountRate]));
  lines.push("");

  lines.push(csvRow(["Sales Over Time"]));
  lines.push(
    csvRow([
      "Period",
      "Revenue",
      "Collected",
      "Due",
      "Discount",
      "Invoices",
      "Items Sold",
      "Average Basket",
    ]),
  );
  for (const point of report.salesOverTime) {
    lines.push(
      csvRow([
        point.label,
        point.revenue,
        point.collected,
        point.due,
        point.discount,
        point.invoices,
        point.itemsSold,
        point.averageBasket,
      ]),
    );
  }
  lines.push("");

  lines.push(csvRow(["Top Products"]));
  lines.push(csvRow(["Product", "SKU", "Brand", "Quantity", "Revenue", "Invoice Count"]));
  for (const product of report.topProducts) {
    lines.push(
      csvRow([
        product.name,
        product.sku,
        product.brandName,
        product.qty,
        product.revenue,
        product.invoiceCount,
      ]),
    );
  }
  lines.push("");

  lines.push(csvRow(["Top Customers"]));
  lines.push(
    csvRow([
      "Customer",
      "Phone",
      "Invoices",
      "Revenue",
      "Collected",
      "Due",
      "Discount",
      "Items Sold",
      "Average Basket",
    ]),
  );
  for (const customer of report.topCustomers) {
    lines.push(
      csvRow([
        customer.name,
        customer.phone || "",
        customer.invoiceCount,
        customer.revenue,
        customer.collected,
        customer.due,
        customer.discount,
        customer.itemsSold,
        customer.averageBasket,
      ]),
    );
  }
  lines.push("");

  lines.push(csvRow(["Cashier Performance"]));
  lines.push(
    csvRow([
      "Cashier",
      "Invoices",
      "Revenue",
      "Collected",
      "Due",
      "Discount",
      "Items Sold",
      "Average Basket",
    ]),
  );
  for (const cashier of report.cashierPerformance) {
    lines.push(
      csvRow([
        cashier.name,
        cashier.invoiceCount,
        cashier.revenue,
        cashier.collected,
        cashier.due,
        cashier.discount,
        cashier.itemsSold,
        cashier.averageBasket,
      ]),
    );
  }
  lines.push("");

  lines.push(csvRow(["Payment Distribution"]));
  lines.push(csvRow(["Method", "Amount", "Count"]));
  for (const payment of report.paymentDistribution) {
    lines.push(csvRow([payment.method, payment.amount, payment.count]));
  }
  lines.push("");

  lines.push(csvRow(["Brand Performance"]));
  lines.push(csvRow(["Brand", "Quantity", "Revenue", "Invoice Count"]));
  for (const brand of report.brandPerformance) {
    lines.push(
      csvRow([
        brand.brandName,
        brand.qty,
        brand.revenue,
        brand.invoiceCount,
      ]),
    );
  }

  return `\uFEFF${lines.join("\r\n")}`;
}

export async function salesSummary(from: string, to: string) {
  const report = await getAnalyticsReport({ from, to });

  return {
    from,
    to,
    invoiceCount: report.summary.invoiceCount,
    totalSales: report.summary.netSales,
    totalRevenue: report.summary.netSales,
    totalDiscount: report.summary.discountTotal,
    totalCollected: report.summary.collectedTotal,
    totalPaid: report.summary.collectedTotal,
  };
}

export async function bestSellers(from: string, to: string, limit = 10) {
  const report = await getAnalyticsReport({ from, to });
  return report.topProducts.slice(0, limit).map((product) => ({
    product: {
      id: product.productId,
      name: product.name,
      sku: product.sku,
      brand: product.brandName,
    },
    totalQty: product.qty,
    totalRevenue: product.revenue,
  }));
}

export async function cashierSales(from: string, to: string) {
  const report = await getAnalyticsReport({ from, to });
  return report.cashierPerformance.map((cashier) => ({
    cashier: {
      id: cashier.cashierId,
      name: cashier.name,
    },
    invoiceCount: cashier.invoiceCount,
    totalSales: cashier.revenue,
    totalCollected: cashier.collected,
    totalDue: cashier.due,
  }));
}
