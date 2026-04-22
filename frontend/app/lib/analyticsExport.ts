import type { AnalyticsReport } from "./reports";
import { paymentMethodLabel, paymentStatusLabel } from "./reports";

// creating a temporary download link and clicking it to trigger a file download in the browser
function downloadBlob(filename: string, data: BlobPart, mimeType: string) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url); // cleaning up the object URL after download to free memory
}

// generating a base filename from the report date range — used for both Excel and CSV exports
function buildBaseFilename(report: AnalyticsReport) {
  return `khatasathi-analytics-${report.filters.from}-to-${report.filters.to}`;
}

// applying header row styling to Excel worksheet rows — bold text with light gray background
function styleHeaderRow(row: any) {
  row.font = { bold: true, color: { argb: "FF111827" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF8FAFC" },
  };
  row.border = {
    bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
  };
}

// --

// generating a multi-sheet Excel workbook from the analytics report data
// we dynamically import exceljs here so it is only loaded when the user actually clicks "Export Excel"
// this keeps the initial page load fast since exceljs is a large library
export async function exportAnalyticsWorkbook(report: AnalyticsReport) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KhataSathi";
  workbook.created = new Date();

  // Sheet 1: Summary — report metadata and all aggregate metrics
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 22 },
  ];

  summary.addRow(["KhataSathi Analytics Report", ""]);
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.addRow(["Generated At", report.meta.generatedAt]);
  summary.addRow(["From", report.filters.from]);
  summary.addRow(["To", report.filters.to]);
  summary.addRow(["Cashier Filter", report.filters.cashierId || "All cashiers"]);
  summary.addRow([
    "Payment Status Filter",
    report.filters.paymentStatus
      ? paymentStatusLabel(report.filters.paymentStatus)
      : "All payment statuses",
  ]);
  summary.addRow([]);
  summary.addRow(["Metric", "Value"]);
  styleHeaderRow(summary.getRow(8));
  summary.addRows([
    ["Sales invoices", report.summary.invoiceCount],
    ["Cancelled invoices", report.summary.cancelledInvoiceCount],
    ["Paid invoices", report.summary.paidInvoiceCount],
    ["Partially paid invoices", report.summary.partiallyPaidInvoiceCount],
    ["Unpaid invoices", report.summary.unpaidInvoiceCount],
    ["Customers", report.summary.customerCount],
    ["Walk-in invoices", report.summary.walkInInvoiceCount],
    ["Cashiers", report.summary.cashierCount],
    ["Items sold", report.summary.itemsSold],
    ["Gross sales", report.summary.grossSales],
    ["Discount total", report.summary.discountTotal],
    ["Net sales", report.summary.netSales],
    ["Collected total", report.summary.collectedTotal],
    ["Due total", report.summary.dueTotal],
    ["Average basket size", report.summary.averageBasketSize],
    ["Collection rate (%)", report.summary.collectionRate],
    ["Discount rate (%)", report.summary.discountRate],
  ]);

  // Sheet 2: Sales Over Time — the time-series data used for the main chart
  const trend = workbook.addWorksheet("Sales Over Time");
  trend.columns = [
    { header: "Period", key: "label", width: 18 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Collected", key: "collected", width: 14 },
    { header: "Due", key: "due", width: 14 },
    { header: "Discount", key: "discount", width: 14 },
    { header: "Invoices", key: "invoices", width: 12 },
    { header: "Items Sold", key: "itemsSold", width: 12 },
    { header: "Average Basket", key: "averageBasket", width: 16 },
  ];
  styleHeaderRow(trend.getRow(1));
  report.salesOverTime.forEach((point) => {
    trend.addRow(point);
  });

  // Sheet 3: Top Products — best-selling products by revenue
  const products = workbook.addWorksheet("Top Products");
  products.columns = [
    { header: "Product", key: "name", width: 28 },
    { header: "SKU", key: "sku", width: 16 },
    { header: "Brand", key: "brandName", width: 18 },
    { header: "Qty", key: "qty", width: 10 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Invoice Count", key: "invoiceCount", width: 14 },
  ];
  styleHeaderRow(products.getRow(1));
  report.topProducts.forEach((product) => {
    products.addRow(product);
  });

  // Sheet 4: Top Customers — highest-spending customers
  const customers = workbook.addWorksheet("Top Customers");
  customers.columns = [
    { header: "Customer", key: "name", width: 24 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Invoices", key: "invoiceCount", width: 12 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Collected", key: "collected", width: 14 },
    { header: "Due", key: "due", width: 14 },
    { header: "Discount", key: "discount", width: 14 },
    { header: "Items Sold", key: "itemsSold", width: 12 },
    { header: "Average Basket", key: "averageBasket", width: 16 },
  ];
  styleHeaderRow(customers.getRow(1));
  report.topCustomers.forEach((customer) => {
    customers.addRow(customer);
  });

  // Sheet 5: Cashiers — per-cashier performance breakdown
  const cashiers = workbook.addWorksheet("Cashiers");
  cashiers.columns = [
    { header: "Cashier", key: "name", width: 24 },
    { header: "Invoices", key: "invoiceCount", width: 12 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Collected", key: "collected", width: 14 },
    { header: "Due", key: "due", width: 14 },
    { header: "Discount", key: "discount", width: 14 },
    { header: "Items Sold", key: "itemsSold", width: 12 },
    { header: "Average Basket", key: "averageBasket", width: 16 },
  ];
  styleHeaderRow(cashiers.getRow(1));
  report.cashierPerformance.forEach((cashier) => {
    cashiers.addRow(cashier);
  });

  // Sheet 6: Payments — payment method distribution
  const payments = workbook.addWorksheet("Payments");
  payments.columns = [
    { header: "Method", key: "method", width: 16 },
    { header: "Amount", key: "amount", width: 14 },
    { header: "Count", key: "count", width: 12 },
  ];
  styleHeaderRow(payments.getRow(1));
  report.paymentDistribution.forEach((payment) => {
    payments.addRow({
      ...payment,
      method: paymentMethodLabel(payment.method), // converting "CASH" to "Cash", "ESEWA" to "eSewa"
    });
  });

  // Sheet 7: Brands — per-brand revenue breakdown
  const brands = workbook.addWorksheet("Brands");
  brands.columns = [
    { header: "Brand", key: "brandName", width: 22 },
    { header: "Qty", key: "qty", width: 10 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Invoice Count", key: "invoiceCount", width: 14 },
  ];
  styleHeaderRow(brands.getRow(1));
  report.brandPerformance.forEach((brand) => {
    brands.addRow(brand);
  });

  // writing the workbook to a buffer and triggering the browser download
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    `${buildBaseFilename(report)}.xlsx`,
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

// downloading a CSV blob that was received from the backend API
export function downloadCsvBlob(report: AnalyticsReport, blob: Blob) {
  downloadBlob(`${buildBaseFilename(report)}.csv`, blob, "text/csv;charset=utf-8");
}

