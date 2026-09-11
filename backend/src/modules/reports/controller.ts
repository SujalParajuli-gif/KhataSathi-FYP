import type { PaymentStatusInvoice } from "@prisma/client";
import { Request, Response } from "express";
import * as reportService from "./service";

// extracting common filter parameters from the request query string
// both from and to dates are required for all report endpoints
function getFilters(req: Request) {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const cashierId =
    typeof req.query.cashierId === "string" ? req.query.cashierId : undefined;
  const paymentStatus =
    typeof req.query.paymentStatus === "string"
      ? (req.query.paymentStatus as PaymentStatusInvoice)
      : undefined;

  if (!from || !to) {
    throw new reportService.ReportValidationError(
      "from and to query params are required (YYYY-MM-DD).",
    );
  }

  return { from, to, cashierId, paymentStatus };
}

function shouldIncludeOperations(req: Request) {
  const raw = String(req.query.includeOperations || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// shared error handler for all report endpoints
// we check the error message to determine if it is a validation error (400) or an unexpected error (500)
export function handleReportError(res: Response, err: unknown, label: string) {
  if (err instanceof reportService.ReportValidationError) {
    res.status(400).json({ code: err.code, error: err.message });
    return;
  }
  console.error(`${label}:`, err);
  res.status(500).json({
    code: "REPORT_UNAVAILABLE",
    error: "The report could not be generated. Please try again.",
    requestId: res.locals.requestId,
  });
}

// returning the full analytics dashboard data — revenue, invoice counts, payment breakdown, etc.
export async function analytics(req: Request, res: Response) {
  try {
    const result = await reportService.getAnalyticsReport(getFilters(req), {
      viewerRole: req.user?.role,
      includeOperations: shouldIncludeOperations(req),
    });
    res.json(result);
  } catch (err) {
    handleReportError(res, err, "Analytics report error");
  }
}

// exporting the analytics data as a downloadable CSV file
// the filename includes the date range so the admin knows which period the data covers
export async function analyticsCsv(req: Request, res: Response) {
  try {
    const filters = getFilters(req);
    const csv = await reportService.exportAnalyticsCsv(filters);
    const filename = `khatasathi-analytics-${filters.from}-to-${filters.to}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`, // this tells the browser to download the file instead of displaying it
    );
    res.send(csv);
  } catch (err) {
    handleReportError(res, err, "Analytics CSV export error");
  }
}

// returning a summary of total sales, revenue, and discount stats for a date range
export async function salesSummary(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const result = await reportService.salesSummary(from, to);
    res.json(result);
  } catch (err) {
    handleReportError(res, err, "Sales summary error");
  }
}

// returning the top-selling products ranked by quantity sold within a date range
export async function bestSellers(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 10; // how many products to return, defaults to 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new reportService.ReportValidationError(
        "limit must be an integer from 1 to 100.",
      );
    }
    const result = await reportService.bestSellers(from, to, limit);
    res.json(result);
  } catch (err) {
    handleReportError(res, err, "Best sellers error");
  }
}

// returning sales performance breakdown per cashier for a date range
export async function cashierSales(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const result = await reportService.cashierSales(from, to);
    res.json(result);
  } catch (err) {
    handleReportError(res, err, "Cashier sales error");
  }
}
