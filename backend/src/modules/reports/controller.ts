import type { PaymentStatusInvoice } from "@prisma/client";
import { Request, Response } from "express";
import * as reportService from "./service";

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
    throw new Error("from and to query params are required (YYYY-MM-DD).");
  }

  return { from, to, cashierId, paymentStatus };
}

function handleError(res: Response, err: unknown, label: string) {
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  const status = /required|format|valid|before|Unsupported/.test(message)
    ? 400
    : 500;

  if (status === 500) {
    console.error(`${label}:`, err);
  }

  res.status(status).json({ error: message });
}

export async function analytics(req: Request, res: Response) {
  try {
    const result = await reportService.getAnalyticsReport(getFilters(req));
    res.json(result);
  } catch (err) {
    handleError(res, err, "Analytics report error");
  }
}

export async function analyticsCsv(req: Request, res: Response) {
  try {
    const filters = getFilters(req);
    const csv = await reportService.exportAnalyticsCsv(filters);
    const filename = `khatasathi-analytics-${filters.from}-to-${filters.to}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.send(csv);
  } catch (err) {
    handleError(res, err, "Analytics CSV export error");
  }
}

export async function salesSummary(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const result = await reportService.salesSummary(from, to);
    res.json(result);
  } catch (err) {
    handleError(res, err, "Sales summary error");
  }
}

export async function bestSellers(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
    const result = await reportService.bestSellers(from, to, limit);
    res.json(result);
  } catch (err) {
    handleError(res, err, "Best sellers error");
  }
}

export async function cashierSales(req: Request, res: Response) {
  try {
    const { from, to } = getFilters(req);
    const result = await reportService.cashierSales(from, to);
    res.json(result);
  } catch (err) {
    handleError(res, err, "Cashier sales error");
  }
}
