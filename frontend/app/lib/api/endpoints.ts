// frontend/app/lib/api/endpoints.ts — All API endpoint functions
import api from "./client";

// ─── Auth ────────────────────────────────────────────

export async function loginApi(email: string, password: string) {
    const res = await api.post("/api/auth/login", { email, password });
    return res.data; // { token, user }
}

export async function getMeApi() {
    const res = await api.get("/api/auth/me");
    return res.data; // { user }
}

export async function updateProfileApi(data: { name?: string; phone?: string; password?: string; profileImage?: string | null }) {
    const res = await api.patch("/api/auth/profile", data);
    return res.data;
}

export async function uploadProfilePhotoApi(file: File) {
    const formData = new FormData();
    formData.append("photo", file);
    const token = typeof window !== "undefined" ? localStorage.getItem("khatasathi_token") : null;
    const res = await fetch((import.meta.env.VITE_API_BASE_URL || "http://localhost:4000") + "/api/auth/profile/photo", {
        method: "POST",
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
        body: formData
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
    }
    return res.json();
}

// ─── Brands ──────────────────────────────────────────

export async function listBrandsApi(activeOnly?: boolean) {
    const params = activeOnly ? { active: "true" } : {};
    const res = await api.get("/api/brands", { params });
    return res.data;
}

export async function createBrandApi(name: string) {
    const res = await api.post("/api/brands", { name });
    return res.data;
}

export async function updateBrandApi(id: string, data: { name?: string; isActive?: boolean }) {
    const res = await api.put(`/api/brands/${id}`, data);
    return res.data;
}

export async function deactivateBrandApi(id: string) {
    const res = await api.patch(`/api/brands/${id}/deactivate`);
    return res.data;
}

// ─── Products ────────────────────────────────────────

interface ProductFilters {
    search?: string;
    brand?: string;
    category?: string;
    active?: string;
    lowStock?: string;
    page?: number;
    pageSize?: number;
}

export async function listProductsApi(filters?: ProductFilters) {
    const res = await api.get("/api/products", { params: filters });
    return res.data; // { products, total, page, pageSize }
}

export async function getProductApi(id: string) {
    const res = await api.get(`/api/products/${id}`);
    return res.data;
}

export async function createProductApi(data: any) {
    const res = await api.post("/api/products", data);
    return res.data;
}

export async function updateProductApi(id: string, data: any) {
    const res = await api.put(`/api/products/${id}`, data);
    return res.data;
}

export async function deactivateProductApi(id: string) {
    const res = await api.patch(`/api/products/${id}/deactivate`);
    return res.data;
}

export async function getCategoriesApi() {
    const res = await api.get("/api/products/categories");
    return res.data;
}

export async function importCsvApi(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await api.post("/api/products/import-csv", formData);
    return res.data;
}

// ─── Customers ───────────────────────────────────────

export async function listCustomersApi(activeOnly?: boolean) {
    const params = activeOnly ? { active: "true" } : {};
    const res = await api.get("/api/customers", { params });
    return res.data;
}

export async function createCustomerApi(data: { name: string; phone?: string; email?: string; loyaltyPercent?: number; wholesalePercent?: number }) {
    const res = await api.post("/api/customers", data);
    return res.data;
}

export async function updateCustomerApi(id: string, data: { name?: string; phone?: string; email?: string; loyaltyPercent?: number; wholesalePercent?: number; isActive?: boolean }) {
    const res = await api.put(`/api/customers/${id}`, data);
    return res.data;
}

export async function deactivateCustomerApi(id: string) {
    const res = await api.patch(`/api/customers/${id}/deactivate`);
    return res.data;
}

// ─── Invoices ────────────────────────────────────────

export async function createInvoiceApi(customerId?: string) {
    const res = await api.post("/api/invoices", { customerId });
    return res.data;
}

export async function listInvoicesApi(filters?: any) {
    const res = await api.get("/api/invoices", { params: filters });
    return res.data; // { invoices, total, page, pageSize }
}

export async function getInvoiceApi(id: string) {
    const res = await api.get(`/api/invoices/${id}`);
    return res.data;
}

export async function addInvoiceItemApi(invoiceId: string, productId: string, qty: number, unitPrice?: number) {
    const res = await api.post(`/api/invoices/${invoiceId}/items`, { productId, qty, unitPrice });
    return res.data;
}

export async function updateInvoiceItemApi(invoiceId: string, itemId: string, qty: number) {
    const res = await api.patch(`/api/invoices/${invoiceId}/items/${itemId}`, { qty });
    return res.data;
}

export async function removeInvoiceItemApi(invoiceId: string, itemId: string) {
    const res = await api.delete(`/api/invoices/${invoiceId}/items/${itemId}`);
    return res.data;
}

export async function finalizeInvoiceApi(invoiceId: string, discountAmount?: number) {
    const res = await api.post(`/api/invoices/${invoiceId}/finalize`, { discountAmount });
    return res.data;
}

// ─── Payments ────────────────────────────────────────

export async function addPaymentApi(
    invoiceId: string,
    data: { method: string; amount: number; status?: string; reference?: string }
) {
    const res = await api.post(`/api/invoices/${invoiceId}/payments`, data);
    return res.data;
}

export async function listPaymentsApi(invoiceId: string) {
    const res = await api.get(`/api/invoices/${invoiceId}/payments`);
    return res.data;
}

// ─── Inventory ───────────────────────────────────────

export async function restockApi(productId: string, qty: number, reason?: string) {
    const res = await api.post("/api/inventory/restock", { productId, qty, reason });
    return res.data;
}

export async function adjustStockApi(productId: string, qtyDelta: number, reason?: string) {
    const res = await api.post("/api/inventory/adjust", { productId, qtyDelta, reason });
    return res.data;
}

export async function getLowStockApi() {
    const res = await api.get("/api/inventory/low-stock");
    return res.data;
}

export async function getStockTransactionsApi(productId?: string) {
    const params = productId ? { productId } : {};
    const res = await api.get("/api/inventory/transactions", { params });
    return res.data;
}

// ─── Reports ─────────────────────────────────────────

export async function salesSummaryApi(from: string, to: string) {
    const res = await api.get("/api/reports/sales", { params: { from, to } });
    return res.data;
}

export async function bestSellersApi(from: string, to: string, limit?: number) {
    const res = await api.get("/api/reports/best-sellers", { params: { from, to, limit } });
    return res.data;
}

export async function cashierSalesApi(from: string, to: string) {
    const res = await api.get("/api/reports/cashier-sales", { params: { from, to } });
    return res.data;
}

// ─── Audit ───────────────────────────────────────────

export async function listAuditLogsApi(filters?: any) {
    const res = await api.get("/api/audit", { params: filters });
    return res.data; // { logs, total, page, pageSize }
}

// ─── Admin ───────────────────────────────────────────

export async function triggerBackupApi() {
    const res = await api.post("/api/admin/backup");
    return res.data;
}

// ─── Users ───────────────────────────────────────────

export async function listUsersApi(params?: { role?: string }) {
    const res = await api.get("/api/users", { params });
    return res.data;
}

export async function createUserApi(data: any) {
    const res = await api.post("/api/users", data);
    return res.data;
}

export async function updateUserApi(id: string, data: any) {
    const res = await api.put(`/api/users/${id}`, data);
    return res.data;
}

// ─── Alerts ──────────────────────────────────────────

export async function getReadAlertsApi() {
    const res = await api.get("/api/alerts/read");
    return res.data;
}

export async function markAlertReadApi(alertKey: string) {
    const res = await api.post("/api/alerts/read", { alertKey });
    return res.data;
}

export async function markAllAlertsReadApi(alertKeys: string[]) {
    const res = await api.post("/api/alerts/read-all", { alertKeys });
    return res.data;
}

export async function markAlertUnreadApi(alertKey: string) {
    const res = await api.delete("/api/alerts/read", { data: { alertKey } });
    return res.data;
}

// ─── Admin User Photo ────────────────────────────────

export async function uploadUserPhotoApi(userId: string, file: File) {
    const fd = new FormData();
    fd.append("photo", file);
    const res = await api.post(`/api/users/${userId}/photo`, fd, { headers: { "Content-Type": "multipart/form-data" } });
    return res.data;
}

// ─── Product Image ───────────────────────────────────

export async function uploadProductImageApi(productId: string, file: File) {
    const fd = new FormData();
    fd.append("image", file);
    const res = await api.post(`/api/products/${productId}/image`, fd, { headers: { "Content-Type": "multipart/form-data" } });
    return res.data;
}
