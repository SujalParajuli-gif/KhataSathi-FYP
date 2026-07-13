import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";

import authRoutes from "./modules/auth/routes";
import brandRoutes from "./modules/brands/routes";
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
import { cleanupStaleEsewaPayments } from "./modules/payments/service";
import { runDueBinPurge } from "./modules/bin/service";
import prisma from "./db/prisma";
import { getAllowedCorsOrigins, getRateLimitConfig } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { sanitizeBody } from "./middleware/sanitize";
import { logger } from "./lib/logger";
import {
  attachRateLimitIdentity,
  generalApiRateLimitKey,
} from "./lib/rateLimit";

const app = express(); // creating the express application instance
const PORT = Number(process.env.PORT) || 4000; // reading port from env, defaults to 4000 for local dev
const allowedCorsOrigins = getAllowedCorsOrigins();
const rateLimitConfig = getRateLimitConfig();

app.set("trust proxy", 1);

app.use(helmet());

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
  }),
);

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: rateLimitConfig.loginLimitPerMinute,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    error: "Too many login attempts. Please try again in a minute.",
  },
});

const apiLimiter = rateLimit({
  windowMs: rateLimitConfig.apiWindowMinutes * 60 * 1000,
  limit: rateLimitConfig.apiLimitPerWindow,
  keyGenerator: generalApiRateLimitKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    error: "Too many requests. Please slow down and try again shortly.",
  },
});

app.use("/api/auth/login", loginLimiter);
app.use("/api", attachRateLimitIdentity);
app.use("/api", apiLimiter);
app.use(express.json({ limit: "1mb" })); // parsing incoming JSON request bodies so we can access req.body
app.use(express.urlencoded({ extended: true, limit: "1mb" })); // parsing URL-encoded form data (used by some payment callbacks)
app.use(sanitizeBody);
// serving uploaded files (product images, profile photos) as static files
// the uploads folder sits at the project root, two levels up from this file's compiled location
app.use("/uploads", express.static(path.join(__dirname, "../../uploads")));

// simple health check endpoint so we can verify the backend is running
// hitting http://localhost:4000/api/health should return { status: "OK" }
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

// mounting all module routes under their respective API paths
// each module handles its own route definitions, controllers, and services
app.use("/api/auth", authRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api", paymentRoutes); // payment routes handle both /api/payments and /api/invoices/:id/payments internally
app.use("/api/inventory", inventoryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/cash-drawers", cashDrawerRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/bin", binRoutes);

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

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutdown signal received", { signal });
  clearInterval(esewaCleanupTimer);
  clearInterval(backupScheduleTimer);
  clearInterval(binPurgeTimer);

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
