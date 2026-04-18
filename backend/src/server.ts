import "dotenv/config";
import express from "express";
import cors from "cors";

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
import userRoutes from "./modules/users/routes";
import alertRoutes from "./modules/alerts/routes";
import settingsRoutes from "./modules/settings/routes";

const app = express(); // creating the express application instance
const PORT = Number(process.env.PORT) || 4000; // reading port from env, defaults to 4000 for local dev

app.use(cors()); // enabling CORS so the frontend (running on a different port) can make API requests
app.use(express.json()); // parsing incoming JSON request bodies so we can access req.body
app.use(express.urlencoded({ extended: true })); // parsing URL-encoded form data (used by some payment callbacks)
import path from "path";
// serving uploaded files (product images, profile photos) as static files
// the uploads folder sits at the project root, two levels up from this file's compiled location
app.use("/uploads", express.static(path.join(__dirname, "../../uploads")));

// simple health check endpoint so we can verify the backend is running
// hitting http://localhost:4000/api/health should return { status: "OK" }
app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", message: "KhataSathi API running" });
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

// starting the server on all network interfaces (0.0.0.0) so it is accessible from other devices on the network
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ KhataSathi Backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
});
