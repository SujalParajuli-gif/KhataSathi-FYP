export type AnalyticsRangePreset = "today" | "week" | "month" | "quarter";
export type AnalyticsPaymentStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED";
export type AnalyticsPaymentMethod = "CASH" | "ESEWA";
export type AnalyticsBucketGranularity = "hour" | "day" | "week";

export type AnalyticsFilters = {
  from: string;
  to: string;
  cashierId?: string;
  paymentStatus?: AnalyticsPaymentStatus;
};

export type AnalyticsSummary = {
  finalizedInvoiceCount: number;
  invoiceCount: number;
  cancelledInvoiceCount: number;
  paidInvoiceCount: number;
  partiallyPaidInvoiceCount: number;
  unpaidInvoiceCount: number;
  customerCount: number;
  cashierCount: number;
  walkInInvoiceCount: number;
  itemsSold: number;
  grossSales: number;
  discountTotal: number;
  netSales: number;
  collectedTotal: number;
  dueTotal: number;
  averageBasketSize: number;
  collectionRate: number;
  discountRate: number;
};

export type AnalyticsBucket = {
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

export type AnalyticsTopProduct = {
  productId: string;
  name: string;
  sku: string;
  brandId: string | null;
  brandName: string;
  qty: number;
  revenue: number;
  invoiceCount: number;
};

export type AnalyticsTopCustomer = {
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
};

export type AnalyticsCashierPerformance = {
  cashierId: string;
  name: string;
  invoiceCount: number;
  revenue: number;
  collected: number;
  due: number;
  discount: number;
  itemsSold: number;
  averageBasket: number;
};

export type AnalyticsPaymentDistribution = {
  method: AnalyticsPaymentMethod;
  amount: number;
  count: number;
};

export type AnalyticsBrandPerformance = {
  brandId: string | null;
  brandName: string;
  qty: number;
  revenue: number;
  invoiceCount: number;
};

export type AnalyticsReport = {
  filters: AnalyticsFilters;
  meta: {
    generatedAt: string;
    bucketGranularity: AnalyticsBucketGranularity;
    rangeDays: number;
  };
  cashiers: Array<{ id: string; name: string }>;
  summary: AnalyticsSummary;
  salesOverTime: AnalyticsBucket[];
  topProducts: AnalyticsTopProduct[];
  topCustomers: AnalyticsTopCustomer[];
  cashierPerformance: AnalyticsCashierPerformance[];
  paymentDistribution: AnalyticsPaymentDistribution[];
  brandPerformance: AnalyticsBrandPerformance[];
};

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getRangeFromPreset(
  preset: AnalyticsRangePreset,
): Pick<AnalyticsFilters, "from" | "to"> {
  const end = new Date();
  const start = new Date(end);

  if (preset === "week") {
    start.setDate(start.getDate() - 6);
  } else if (preset === "month") {
    start.setDate(start.getDate() - 29);
  } else if (preset === "quarter") {
    start.setDate(start.getDate() - 89);
  }

  return {
    from: toDateInputValue(start),
    to: toDateInputValue(end),
  };
}

export function serializeAnalyticsFilters(filters: AnalyticsFilters) {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.cashierId) params.set("cashierId", filters.cashierId);
  if (filters.paymentStatus) params.set("paymentStatus", filters.paymentStatus);
  return params.toString();
}

export function paymentStatusLabel(status: AnalyticsPaymentStatus) {
  if (status === "PAID") return "Paid";
  if (status === "PARTIALLY_PAID") return "Partial";
  if (status === "CANCELLED") return "Cancelled";
  return "Unpaid";
}

export function paymentMethodLabel(method: AnalyticsPaymentMethod) {
  if (method === "ESEWA") return "eSewa";
  return "Cash";
}

