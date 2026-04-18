import { Prisma, type PaymentMethod, type PaymentStatusInvoice } from "@prisma/client";
import {
  BUSINESS_TIME_ZONE,
  addBusinessDays,
  addBusinessHours,
  parseBusinessDate,
  startOfBusinessDay,
  startOfBusinessWeek,
  toBusinessClock,
  toBusinessRangeEnd,
  toBusinessRangeStart,
} from "../../lib/businessDate";
import prisma from "../../db/prisma";

const DAY_MS = 24 * 60 * 60 * 1000; // milliseconds in a day — used for calculating date spans
const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "ESEWA"]; // all payment methods our system supports
const INVOICE_PAYMENT_STATUSES: PaymentStatusInvoice[] = [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
];

// defining the shape of filters the frontend sends when requesting analytics data
export type AnalyticsFilters = {
  from: string; // YYYY-MM-DD start date
  to: string; // YYYY-MM-DD end date
  cashierId?: string; // optional filter by specific cashier
  paymentStatus?: PaymentStatusInvoice; // optional filter by payment status
};

// the time granularity for the sales-over-time chart — hour for single day, day for up to 45 days, week for longer
type BucketGranularity = "hour" | "day" | "week";

// the metrics we track for each time bucket in the sales-over-time chart
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

// the shape of each payment method slice in the payment distribution chart
type PaymentDistributionSlice = {
  method: PaymentMethod;
  amount: number;
  count: number;
};

type ReportInvoice = Awaited<ReturnType<typeof getReportInvoices>>[number];

// rounding to 2 decimal places for all currency calculations
function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

// formatting a date as "Apr 18" style for the chart x-axis labels
function formatMonthDay(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: BUSINESS_TIME_ZONE, // using Nepal timezone so labels match the business day
  }).format(date);
}

// formatting a date as "3 PM" style for hourly chart labels
function formatHourLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    timeZone: BUSINESS_TIME_ZONE,
  }).format(date);
}

// determining the chart granularity based on how many days the date range spans
// a single day gets hourly buckets, up to 45 days gets daily, anything longer gets weekly
function resolveBucketGranularity(fromDate: Date, toDate: Date): BucketGranularity {
  const spanDays =
    Math.floor(
      (startOfBusinessDay(toDate).getTime() -
        startOfBusinessDay(fromDate).getTime()) /
        DAY_MS,
    ) + 1;

  if (spanDays <= 1) return "hour";
  if (spanDays <= 45) return "day";
  return "week";
}

// pre-creating empty buckets for the entire date range so the chart shows every time period
// even if there were no invoices in some periods — this gives us a continuous x-axis
function buildBucketSeed(
  fromDate: Date,
  toDate: Date,
  granularity: BucketGranularity,
) {
  const buckets: BucketMetrics[] = [];
  const map = new Map<string, BucketMetrics>();

  // for hourly granularity, we create 24 buckets (one per hour of the day)
  if (granularity === "hour") {
    const start = startOfBusinessDay(fromDate);
    for (let hour = 0; hour < 24; hour += 1) {
      const bucketDate = addBusinessHours(start, hour);
      const key = bucketDate.toISOString().slice(0, 13); // using ISO date up to hour as the key
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

  // for daily granularity, we create one bucket per day in the range
  if (granularity === "day") {
    for (
      let bucketDate = startOfBusinessDay(fromDate);
      bucketDate <= startOfBusinessDay(toDate);
      bucketDate = addBusinessDays(bucketDate, 1)
    ) {
      const key = bucketDate.toISOString().slice(0, 10); // using just the date as the key
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

  // for weekly granularity, we start from the beginning of the week and step by 7 days
  for (
    let bucketDate = startOfBusinessWeek(fromDate);
    bucketDate <= startOfBusinessDay(toDate);
    bucketDate = addBusinessDays(bucketDate, 7)
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

// determining which bucket an invoice date falls into based on the current granularity
function getBucketKey(date: Date, granularity: BucketGranularity) {
  const businessDate = toBusinessClock(date); // converting to Nepal time first

  if (granularity === "hour") {
    return businessDate.toISOString().slice(0, 13);
  }

  if (granularity === "day") {
    return businessDate.toISOString().slice(0, 10);
  }

  return startOfBusinessWeek(businessDate).toISOString().slice(0, 10);
}

// validating and normalizing the date filters — making sure from <= to and status is valid
function normalizeAnalyticsFilters(filters: AnalyticsFilters) {
  const fromDate = parseBusinessDate(filters.from, "from");
  const toDate = parseBusinessDate(filters.to, "to");

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
    startAt: toBusinessRangeStart(fromDate), // converting to UTC range start for the database query
    endAt: toBusinessRangeEnd(toDate), // converting to UTC range end for the database query
  };
}

// fetching all finalized invoices within the date range with their items, payments, cashier, and customer data
// we include everything here because the analytics report needs to compute metrics from all of this
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

// building the Prisma where clause for invoice queries based on the analytics filters
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
    status: "FINALIZED", // only finalized invoices count in analytics
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

// summing the total quantity of all items in a single invoice
function sumInvoiceItemQty(invoice: ReportInvoice) {
  return invoice.items.reduce((sum, item) => sum + item.qty, 0);
}

// summing only successful payments for an invoice — pending and failed payments do not count
function sumSuccessfulPayments(invoice: ReportInvoice) {
  return roundCurrency(
    invoice.payments
      .filter((payment) => payment.status === "SUCCESS")
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
}

// --

// the main analytics report function — this computes everything the analytics dashboard needs
// it loops through all finalized invoices in the date range and aggregates data into:
// - time-series buckets for the sales chart
// - per-product, per-brand, per-customer, per-cashier breakdowns
// - payment method distribution for the pie chart
// - summary totals for the metric cards
export async function getAnalyticsReport(input: AnalyticsFilters) {
  const normalized = normalizeAnalyticsFilters(input);
  const granularity = resolveBucketGranularity(
    normalized.fromDate,
    normalized.toDate,
  );
  // creating empty buckets for the entire date range so the chart has a continuous x-axis
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

  // fetching all active cashiers for the cashier filter dropdown in the frontend
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

  // maps for accumulating per-entity metrics as we loop through invoices
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
  // initializing the payment distribution map with zeros for each supported method
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

  // summary counters
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

  // looping through every invoice and accumulating metrics
  for (const invoice of invoices) {
    // using the higher of the stored paidTotal and the actual sum of successful payments
    // in case they got out of sync at some point
    const successfulPaidTotal = sumSuccessfulPayments(invoice);
    const effectivePaidTotal = roundCurrency(
      Math.max(invoice.paidTotal, successfulPaidTotal),
    );
    const isCancelled = invoice.paymentStatus === "CANCELLED";

    // skipping cancelled invoices from all analytics calculations
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
    const customerKey = invoice.customer?.id || "__walk_in__"; // walk-in customers (no customer record) are grouped together
    const bucketKey = getBucketKey(
      invoice.finalizedAt || invoice.createdAt,
      granularity,
    );
    const bucket = bucketMap.get(bucketKey);

    // accumulating summary totals
    grossSales += invoice.subTotal;
    discountTotal += invoice.loyaltyDiscountAmount;
    netSales += invoice.netTotal;
    collectedTotal += effectivePaidTotal;
    dueTotal += invoiceDue;
    itemsSold += invoiceItemsSold;

    if (!invoice.customer?.id) {
      walkInInvoiceCount += 1;
    }

    // adding this invoice's metrics to its time bucket for the chart
    if (bucket) {
      bucket.revenue += invoice.netTotal;
      bucket.collected += effectivePaidTotal;
      bucket.due += invoiceDue;
      bucket.discount += invoice.loyaltyDiscountAmount;
      bucket.invoices += 1;
      bucket.itemsSold += invoiceItemsSold;
    }

    // accumulating per-product and per-brand metrics from the invoice items
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

    // accumulating per-payment-method metrics for the pie chart
    for (const payment of invoice.payments) {
      if (payment.status !== "SUCCESS") continue; // only counting successful payments
      const slice = paymentMap.get(payment.method);
      if (!slice) continue;

      slice.amount += payment.amount;
      slice.count += 1;
    }

    // accumulating per-customer metrics
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

    // accumulating per-cashier metrics
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

  // rounding all bucket values and computing the average basket size per bucket
  for (const bucket of buckets) {
    bucket.revenue = roundCurrency(bucket.revenue);
    bucket.collected = roundCurrency(bucket.collected);
    bucket.due = roundCurrency(bucket.due);
    bucket.discount = roundCurrency(bucket.discount);
    bucket.averageBasket =
      bucket.invoices > 0 ? roundCurrency(bucket.revenue / bucket.invoices) : 0;
  }

  // sorting products by revenue to get the top sellers
  const topProducts = Array.from(productMap.values())
    .map((product) => ({
      ...product,
      revenue: roundCurrency(product.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, 10);

  // sorting customers by revenue to get the top customers
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

  // sorting cashiers by revenue to show the best performing cashiers
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

  // sorting brands by revenue for the brand performance chart
  const brandPerformance = Array.from(brandMap.values())
    .map((brand) => ({
      ...brand,
      revenue: roundCurrency(brand.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);

  // building the payment distribution array from our payment method map
  const paymentDistribution = PAYMENT_METHODS.map((method) => {
    const slice = paymentMap.get(method);
    return {
      method,
      amount: roundCurrency(slice?.amount || 0),
      count: slice?.count || 0,
    };
  });

  // returning the complete analytics report — the frontend renders all of this on the dashboard
  return {
    filters: normalized.filters,
    meta: {
      generatedAt: new Date().toISOString(),
      bucketGranularity: granularity,
      rangeDays:
        Math.floor(
          (startOfBusinessDay(normalized.toDate).getTime() -
            startOfBusinessDay(normalized.fromDate).getTime()) /
            DAY_MS,
        ) + 1,
    },
    cashiers: availableCashiers, // for the cashier filter dropdown
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
    salesOverTime: buckets, // the time-series data for the main chart
    topProducts,
    topCustomers,
    cashierPerformance,
    paymentDistribution, // for the pie chart
    brandPerformance,
  };
}

// --

// escaping a CSV value by wrapping it in quotes if it contains commas, quotes, or newlines
function formatCsvValue(value: string | number) {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// joining an array of values into a single CSV row
function csvRow(values: Array<string | number>) {
  return values.map(formatCsvValue).join(",");
}

// exporting the analytics report as a CSV file — generates the same data as getAnalyticsReport
// and formats it into a multi-section CSV with summary, sales over time, top products, etc.
export async function exportAnalyticsCsv(filters: AnalyticsFilters) {
  const report = await getAnalyticsReport(filters);
  const lines: string[] = [];

  // header section with report metadata
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

  // summary section with all the aggregate metrics
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

  // sales over time section — the same data that powers the main chart
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

  // top products section
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

  // top customers section
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

  // cashier performance section
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

  // payment distribution section
  lines.push(csvRow(["Payment Distribution"]));
  lines.push(csvRow(["Method", "Amount", "Count"]));
  for (const payment of report.paymentDistribution) {
    lines.push(csvRow([payment.method, payment.amount, payment.count]));
  }
  lines.push("");

  // brand performance section
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

  // adding the UTF-8 BOM so Excel opens the CSV with correct encoding
  return `\uFEFF${lines.join("\r\n")}`;
}

// --

// simplified sales summary — reuses the full analytics report and returns just the totals
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

// returning the best-selling products ranked by revenue for a given date range
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

// returning sales performance per cashier for a given date range
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
