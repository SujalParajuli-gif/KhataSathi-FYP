// src/server.ts — KhataSathi Express API Server
import "dotenv/config";
import express from "express";
import cors from "cors";

// Import route modules
import authRoutes from "./modules/auth/routes";
import brandRoutes from "./modules/brands/routes";
import productRoutes from "./modules/products/routes";
import customerRoutes from "./modules/customers/routes";
import invoiceRoutes from "./modules/invoices/routes";
import paymentRoutes from "./modules/payments/routes";
import inventoryRoutes from "./modules/inventory/routes";
import reportRoutes from "./modules/reports/routes";
import auditRoutes from "./modules/audit/routes";
import adminRoutes from "./modules/admin/backup";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// ─── Middleware ──────────────────────────────────────
app.use(cors()); // Allow frontend to call API
app.use(express.json()); // Parse JSON bodies

// ─── Health Check ───────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", message: "KhataSathi API running" });
});

// ─── API Routes ─────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/invoices", paymentRoutes); // payments nested under /api/invoices/:id/payments
app.use("/api/inventory", inventoryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/admin", adminRoutes);

// ─── Start Server ───────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ KhataSathi Backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
});
