import { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

function statusToCode(status: number) {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return "INTERNAL_ERROR";
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    code: "NOT_FOUND",
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status =
    Number(err?.statusCode || err?.status) ||
    (String(err?.message || "").includes("CORS") ? 403 : 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message =
    safeStatus === 500
      ? "Internal server error"
      : err?.message || "Request failed";

  if (safeStatus >= 500) {
    logger.error("Unhandled request error", err);
  }

  res.status(safeStatus).json({
    code: statusToCode(safeStatus),
    error: message,
  });
}
