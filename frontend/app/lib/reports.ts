// the quick date range presets for the analytics filter bar
export type AnalyticsRangePreset = "today" | "week" | "month" | "quarter";
export type AnalyticsPaymentStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED";
export type AnalyticsPaymentMethod =
  | "CASH"
  | "ESEWA"
  | "FONEPAY"
  | "BANK_TRANSFER";
export type AnalyticsBucketGranularity = "hour" | "day" | "week";

// the filters the analytics page sends to the backend
export type AnalyticsFilters = {
  from: string;
  to: string;
  cashierId?: string;
  paymentStatus?: AnalyticsPaymentStatus;
};

// the summary metrics shown in the top metric cards on the analytics page
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

// each time bucket in the sales-over-time chart (hourly, daily, or weekly)
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

// each product in the top products ranking
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

// each customer in the top customers ranking
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

// each cashier's performance data
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

// each payment method's slice in the payment distribution pie chart
export type AnalyticsPaymentDistribution = {
  method: AnalyticsPaymentMethod;
  amount: number;
  count: number;
};

// each brand's performance data
export type AnalyticsBrandPerformance = {
  brandId: string | null;
  brandName: string;
  qty: number;
  revenue: number;
  invoiceCount: number;
};

export type AnalyticsOperationalStockProduct = {
  id: string;
  name: string;
  sku: string;
  brandName: string;
  stock: number;
  lowStockThreshold: number;
};

export type AnalyticsOperations = {
  generatedAt: string;
  stock: {
    lowStockCount: number;
    outOfStockCount: number;
    slowMovingCount: number;
    lowStockProducts: AnalyticsOperationalStockProduct[];
    outOfStockProducts: AnalyticsOperationalStockProduct[];
    slowMovingProducts: AnalyticsOperationalStockProduct[];
  };
  cashDrawers: {
    openCount: number;
    openDrawers: Array<{
      id: string;
      openedAt: string;
      openingFloat: number;
      expectedTotal: number;
      cashSalesTotal: number;
      cashier?: { id: string; name: string } | null;
    }>;
  };
  parkedBills: {
    count: number;
    recent: Array<{
      id: string;
      invoiceNo: string;
      parkedLabel?: string | null;
      parkedAt?: string | null;
      netTotal: number;
      cashier?: { id: string; name: string } | null;
    }>;
  };
  discountRequests: {
    pendingCount: number;
    recent: Array<{
      id: string;
      customerName: string;
      discountType: string;
      discountPercent: number;
      createdAt: string;
      requestedBy?: { id: string; name: string } | null;
    }>;
  };
  returns: {
    count: number;
    pendingCount: number;
    approvedCount: number;
    refundAmount: number;
    recent: Array<{
      id: string;
      status: string;
      refundAmount: number;
      refundMethod?: AnalyticsPaymentMethod | null;
      createdAt: string;
      invoice?: { id: string; invoiceNo: string } | null;
      createdBy?: { id: string; name: string } | null;
    }>;
  };
  recentStockReceives: Array<{
    id: string;
    supplierName: string;
    billNumber?: string | null;
    createdAt: string;
    createdBy?: { id: string; name: string } | null;
    lineCount: number;
    totalQty: number;
    products: Array<{ id: string; name: string; sku: string; qty: number }>;
  }>;
};

// the complete analytics report — this is the full response from getAnalyticsReportApi
export type AnalyticsReport = {
  filters: AnalyticsFilters;
  meta: {
    generatedAt: string;
    bucketGranularity: AnalyticsBucketGranularity;
    rangeDays: number;
  };
  cashiers: Array<{ id: string; name: string }>; // for the cashier filter dropdown
  summary: AnalyticsSummary;
  salesOverTime: AnalyticsBucket[];
  topProducts: AnalyticsTopProduct[];
  topCustomers: AnalyticsTopCustomer[];
  cashierPerformance: AnalyticsCashierPerformance[];
  paymentDistribution: AnalyticsPaymentDistribution[];
  brandPerformance: AnalyticsBrandPerformance[];
  operations?: AnalyticsOperations;
};

// --

// converting a Date to a YYYY-MM-DD string for HTML date inputs
function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// calculating the from/to dates for each preset range
// "today" is just today, "week" is the last 7 days, "month" is the last 30, "quarter" is the last 90
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

// converting analytics filters into URL search params for the API request
export function serializeAnalyticsFilters(filters: AnalyticsFilters) {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.cashierId) params.set("cashierId", filters.cashierId);
  if (filters.paymentStatus) params.set("paymentStatus", filters.paymentStatus);
  return params.toString();
}

// display-friendly labels for payment statuses
export function paymentStatusLabel(status: AnalyticsPaymentStatus) {
  if (status === "PAID") return "Paid";
  if (status === "PARTIALLY_PAID") return "Partial";
  if (status === "CANCELLED") return "Cancelled";
  return "Unpaid";
}

// display-friendly labels for payment methods
export function paymentMethodLabel(method: AnalyticsPaymentMethod) {
  if (method === "ESEWA") return "eSewa";
  if (method === "FONEPAY") return "Fonepay";
  if (method === "BANK_TRANSFER") return "Bank Transfer";
  return "Cash";
}
