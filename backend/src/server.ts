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

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
import path from "path";
app.use("/uploads", express.static(path.join(__dirname, "../../uploads")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "OK", message: "KhataSathi API running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/products", productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api", paymentRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", alertRoutes);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ KhataSathi Backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
});
