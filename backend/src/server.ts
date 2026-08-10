import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";

import authRoutes from "./modules/auth/routes";
import brandRoutes from "./modules/brands/routes";
import productSearchAliasRoutes from "./modules/products/searchAliasRoutes";
import productRoutes from "./modules/products/routes";
import customerRoutes from "./modules/customers/routes";
import invoiceRoutes from "./modules/invoices/routes";
import paymentRoutes from "./modules/payments/routes";
import inventoryRoutes from "./modules/inventory/routes";
import reportRoutes from "./modules/reports/routes";
import auditRoutes from "./modules/audit/routes";
import adminRoutes, { runDueScheduledBackup } from "./modules/admin/backup";
import userRoutes from "./modules/users/routes";
import alertRoutes from "./modules/alerts/routes";
import settingsRoutes from "./modules/settings/routes";
import returnRoutes from "./modules/returns/routes";
import cashDrawerRoutes from "./modules/cash-drawers/routes";
import documentRoutes from "./modules/documents/routes";
import binRoutes from "./modules/bin/routes";
import draftRequestRoutes from "./modules/draft-requests/routes";
import { cleanupStaleEsewaPayments } from "./modules/payments/service";
import { expireDueParkedDrafts } from "./modules/invoices/service";
import { expireDueDraftRequests } from "./modules/draft-requests/service";
import { runDueBinPurge } from "./modules/bin/service";
import { purgeExpiredProductSearchLogs } from "./modules/products/searchLogging";
import { purgeDeadAuthSessions } from "./modules/auth/session";
import prisma from "./db/prisma";
import {
  getAllowedCorsOrigins,
  getRateLimitConfig,
  validateProductionEnvironment,
} from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { sanitizeBody } from "./middleware/sanitize";
import {
  getBusinessCapabilities,
  requireBusinessCapability,
} from "./modules/settings/capabilities";
import { logger } from "./lib/logger";
import { uploadsRoot } from "./lib/uploads";
import {
  attachRateLimitIdentity,
  generalApiRateLimitKey,
  isBackgroundRateLimitRequest,
  isGeneralApiRateLimitExempt,
  isMediaRateLimitRequest,
} from "./lib/rateLimit";

validateProductionEnvironment();

const app = express(); // creating the express application instance
const PORT = Number(process.env.PORT) || 4000; // reading port from env, defaults to 4000 for local dev
const allowedCorsOrigins = getAllowedCorsOrigins();
const rateLimitConfig = getRateLimitConfig();

app.set("trust proxy", 1);

app.use((req, res, next) => {
  const requestId = String(req.header("x-request-id") || randomUUID());
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use(
  helmet({
    // The frontend dev/prod app can run on a different origin than the API.
    // Uploaded product/profile images must remain embeddable from that app.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");
      if (allowedCorsOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
    // Dev and production frontends run on a different origin from the API.
    // Expose limiter metadata so the request gate can honor the server's real
    // reset time instead of falling back to an early retry.
    exposedHeaders: [
      "Retry-After",
      "RateLimit",
      "RateLimit-Policy",
      "X-Request-Id",
    ],
  }),
);

// Deployment monitoring must remain available even when a user exhausts an
// API budget. Keep this endpoint before every rate limiter.
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "OK", database: "OK", message: "KhataSathi API running" });
  } catch {
    res.status(503).json({
      status: "ERROR",
      database: "UNAVAILABLE",
      message: "KhataSathi API running, but database check failed",
    });
  }
});

function rateLimitHandler(
  scope: "login" | "background" | "media" | "api",
  message: string,
) {
  return (req: express.Request, res: express.Response) => {
    const details = (req as express.Request & { rateLimit?: Record<string, unknown> })
      .rateLimit;
    logger.warn("API rate limit exceeded", {
      scope,
      requestId: res.locals.requestId,
      method: req.method,
      path: req.originalUrl,
      userId: req.rateLimitUserId,
      ip: req.ip,
      limit: details?.limit,
      used: details?.used,
      remaining: details?.remaining,
      resetTime: details?.resetTime,
    });
    res.status(429).json({
      code: "RATE_LIMITED",
      scope,
      error: message,
      requestId: res.locals.requestId,
    });
  };
}

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: rateLimitConfig.loginLimitPerMinute,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitHandler(
    "login",
    "Too many login attempts. Please try again in a minute.",
  ),
});

const apiLimiter = rateLimit({
  windowMs: rateLimitConfig.apiWindowMinutes * 60 * 1000,
  limit: rateLimitConfig.apiLimitPerWindow,
  keyGenerator: generalApiRateLimitKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: isGeneralApiRateLimitExempt,
  handler: rateLimitHandler(
    "api",
    "Too many requests. Please slow down and try again shortly.",
  ),
});

// background/heartbeat endpoints (presence pings, alert polls) get their own generous
// rate-limit bucket so they never eat into the user's main API quota.
// 200 requests per 15 minutes is ~1 request every 4.5 seconds — well above the 60-second
// interval used by the frontend for these endpoints.
const backgroundLimiter = rateLimit({
  windowMs: rateLimitConfig.apiWindowMinutes * 60 * 1000,
  limit: rateLimitConfig.backgroundLimitPerWindow,
  keyGenerator: generalApiRateLimitKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitHandler(
    "background",
    "Too many background requests. Please try again shortly.",
  ),
});

const mediaLimiter = rateLimit({
  windowMs: rateLimitConfig.apiWindowMinutes * 60 * 1000,
  limit: rateLimitConfig.mediaLimitPerWindow,
  keyGenerator: generalApiRateLimitKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitHandler(
    "media",
    "Too many document preview requests. Please try again shortly.",
  ),
});

app.use("/api/auth/login", loginLimiter);
app.use("/api", attachRateLimitIdentity);

// background endpoints use their own separate bucket — mounted before the general limiter
// so they are handled here and skip the general apiLimiter below
app.use("/api", (req, res, next) => {
  if (!isBackgroundRateLimitRequest(req)) {
    next();
    return;
  }
  backgroundLimiter(req, res, next);
});

app.use("/api", (req, res, next) => {
  if (!isMediaRateLimitRequest(req)) {
    next();
    return;
  }
  mediaLimiter(req, res, next);
});

app.use("/api", apiLimiter);
app.use(express.json({ limit: "1mb" })); // parsing incoming JSON request bodies so we can access req.body
app.use(express.urlencoded({ extended: true, limit: "1mb" })); // parsing URL-encoded form data (used by some payment callbacks)
app.use(sanitizeBody);
// serving uploaded files (product images, profile photos) as static files
// the uploads folder sits at the project root, two levels up from this file's compiled location
app.use("/uploads", express.static(uploadsRoot));

// simple health check endpoint so we can verify the backend is running
// hitting http://localhost:4000/api/health should return { status: "OK" }
// mounting all module routes under their respective API paths
// each module handles its own route definitions, controllers, and services
app.use("/api/auth", authRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/product-search", productSearchAliasRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", requireBusinessCapability("POS"), customerRoutes);
app.use("/api/invoices", requireBusinessCapability("POS"), invoiceRoutes);
app.use("/api", paymentRoutes); // payment routes handle both /api/payments and /api/invoices/:id/payments internally
app.use("/api/inventory", requireBusinessCapability("INVENTORY"), inventoryRoutes);
app.use("/api/reports", requireBusinessCapability("POS"), reportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", requireBusinessCapability("INVENTORY"), alertRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/returns", requireBusinessCapability("POS"), returnRoutes);
app.use("/api/cash-drawers", requireBusinessCapability("POS"), cashDrawerRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/bin", binRoutes);
app.use(
  "/api/draft-requests",
  requireBusinessCapability("STAFF_DRAFT_REQUESTS"),
  draftRequestRoutes,
);

app.use(notFoundHandler);
app.use(errorHandler);

// starting the server on all network interfaces (0.0.0.0) so it is accessible from other devices on the network
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ KhataSathi Backend running on http://localhost:${PORT}`);
  logger.info("KhataSathi Backend running", {
    port: PORT,
    healthUrl: `http://localhost:${PORT}/api/health`,
  });
});

async function runEsewaCleanup() {
  try {
    if (!(await getBusinessCapabilities()).posEnabled) return;
    const result = await cleanupStaleEsewaPayments(30);
    if (result.expired > 0) {
      logger.info("Expired stale eSewa payments", result);
    }
  } catch (error) {
    logger.error("Stale eSewa payment cleanup failed", error);
  }
}

void runEsewaCleanup();
const esewaCleanupTimer = setInterval(() => {
  void runEsewaCleanup();
}, 5 * 60 * 1000);
esewaCleanupTimer.unref();

async function runDraftRequestExpiryCheck() {
  try {
    if (!(await getBusinessCapabilities()).staffDraftRequestsEnabled) return;
    const result = await expireDueDraftRequests();
    if (result.expired > 0) {
      logger.info("Expired due draft requests", result);
    }
  } catch (error) {
    logger.error("Draft request expiry cleanup failed", error);
  }
}

void runDraftRequestExpiryCheck();
const draftRequestExpiryTimer = setInterval(() => {
  void runDraftRequestExpiryCheck();
}, 60 * 1000);
draftRequestExpiryTimer.unref();

async function runParkedBillExpiryCheck() {
  try {
    if (!(await getBusinessCapabilities()).posEnabled) return;
    const result = await expireDueParkedDrafts();
    if (result.expired > 0) {
      logger.info("Expired due parked bills", result);
    }
  } catch (error) {
    logger.error("Parked bill expiry cleanup failed", error);
  }
}

void runParkedBillExpiryCheck();
const parkedBillExpiryTimer = setInterval(() => {
  void runParkedBillExpiryCheck();
}, 60 * 60 * 1000);
parkedBillExpiryTimer.unref();

async function runBackupScheduleCheck() {
  try {
    const result = await runDueScheduledBackup();
    if (result.ran) {
      logger.info("Scheduled backup check completed", {
        backupId: (result as any).backup?.id,
        hadError: Boolean((result as any).error),
      });
    }
  } catch (error) {
    logger.error("Scheduled backup check failed", error);
  }
}

void runBackupScheduleCheck();
const backupScheduleTimer = setInterval(() => {
  void runBackupScheduleCheck();
}, 60 * 1000);
backupScheduleTimer.unref();

async function runBinPurgeCheck() {
  try {
    const result = await runDueBinPurge();
    if (
      result.documents > 0 ||
      result.productImportBatches > 0 ||
      result.alerts > 0 ||
      result.failed > 0
    ) {
      logger.info("Scheduled bin purge completed", result);
    }
  } catch (error) {
    logger.error("Scheduled bin purge failed", error);
  }
}

void runBinPurgeCheck();
const binPurgeTimer = setInterval(() => {
  void runBinPurgeCheck();
}, 60 * 60 * 1000);
binPurgeTimer.unref();

async function runProductSearchLogPurgeCheck() {
  try {
    const result = await purgeExpiredProductSearchLogs();
    if (result.deleted > 0) {
      logger.info("Expired product search logs purged", result);
    }
  } catch (error) {
    logger.error("Product search log purge failed", error);
  }
}

void runProductSearchLogPurgeCheck();
const productSearchLogPurgeTimer = setInterval(() => {
  void runProductSearchLogPurgeCheck();
}, 24 * 60 * 60 * 1000);
productSearchLogPurgeTimer.unref();

async function runAuthSessionPurgeCheck() {
  try {
    const result = await purgeDeadAuthSessions();
    if (result.count > 0) {
      logger.info("Expired or old revoked auth sessions purged", result);
    }
  } catch (error) {
    logger.error("Auth session purge failed", error);
  }
}

void runAuthSessionPurgeCheck();
const authSessionPurgeTimer = setInterval(() => {
  void runAuthSessionPurgeCheck();
}, 24 * 60 * 60 * 1000);
authSessionPurgeTimer.unref();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutdown signal received", { signal });
  clearInterval(esewaCleanupTimer);
  clearInterval(draftRequestExpiryTimer);
  clearInterval(parkedBillExpiryTimer);
  clearInterval(backupScheduleTimer);
  clearInterval(binPurgeTimer);
  clearInterval(productSearchLogPurgeTimer);
  clearInterval(authSessionPurgeTimer);

  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown timeout reached");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (error) => {
    if (error) {
      logger.error("HTTP server close failed", error);
    }

    try {
      await prisma.$disconnect();
      logger.info("Prisma connection closed");
      process.exit(error ? 1 : 0);
    } catch (disconnectError) {
      logger.error("Prisma disconnect failed", disconnectError);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  void shutdown("uncaughtException");
});
