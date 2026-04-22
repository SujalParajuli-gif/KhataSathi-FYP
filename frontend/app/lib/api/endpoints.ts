import { API_BASE_URL } from "./baseUrl";
import api from "./client";

// --- Auth endpoints ---

// logging in with email and password — returns the JWT token and user object
export async function loginApi(email: string, password: string) {
    const res = await api.post("/api/auth/login", { email, password });
    return res.data;
}

// fetching the currently logged-in user's profile data using the JWT token
export async function getMeApi() {
    const res = await api.get("/api/auth/me");
    return res.data;
}

// the shape of business settings that the admin can configure
export type BusinessSettings = {
    defaultLowStockThreshold: number;
    defaultWholesaleQtyThreshold: number;
    loyaltyDiscountPercent: number;
};

// updating the user's own profile — supports name, phone, gender, address, and password change
export async function updateProfileApi(data: { name?: string; phone?: string; gender?: string | null; address?: string | null; currentPassword?: string; newPassword?: string; profileImage?: string | null }) {
    const res = await api.patch("/api/auth/profile", data);
    return res.data;
}

// helper to get the Bearer token header for fetch calls (used where we can't use the axios client)
// we use raw fetch for file uploads because axios doesn't handle FormData content-type properly
function getBearerHeaders() {
    if (typeof window === "undefined") return {} as Record<string, string>;
    const token = localStorage.getItem("khatasathi_token");
    return token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>);
}

// uploading a profile photo — uses raw fetch instead of axios because FormData needs
// the browser to auto-set the multipart/form-data content-type with the correct boundary
export async function uploadProfilePhotoApi(file: File) {
    const formData = new FormData();
    formData.append("photo", file);
    const res = await fetch(API_BASE_URL + "/api/auth/profile/photo", {
        method: "POST",
        headers: getBearerHeaders(),
        body: formData
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
    }
    return res.json();
}

// --- Brand endpoints ---

// listing all brands — optionally filtering to only active ones
export async function listBrandsApi(activeOnly?: boolean) {
    const params = activeOnly ? { active: "true" } : {};
    const res = await api.get("/api/brands", { params });
    return res.data;
}

// creating a new brand with the given name
export async function createBrandApi(name: string) {
    const res = await api.post("/api/brands", { name });
    return res.data;
}

// updating a brand's name or active status
export async function updateBrandApi(id: string, data: { name?: string; isActive?: boolean }) {
    const res = await api.put(`/api/brands/${id}`, data);
    return res.data;
}

// deactivating a brand — this will also deactivate all products under this brand
export async function deactivateBrandApi(id: string) {
    const res = await api.patch(`/api/brands/${id}/deactivate`);
    return res.data;
}

// --- Product endpoints ---

interface ProductFilters {
    search?: string;
    brand?: string;
    category?: string;
    active?: string;
    lowStock?: string;
    page?: number;
    pageSize?: number;
}

// listing products with optional search, brand filter, category filter, and pagination
export async function listProductsApi(filters?: ProductFilters) {
    const res = await api.get("/api/products", { params: filters });
    return res.data;
}

// fetching a single product by its ID
export async function getProductApi(id: string) {
    const res = await api.get(`/api/products/${id}`);
    return res.data;
}

// creating a new product with all its details (name, SKU, prices, brand, etc.)
export async function createProductApi(data: any) {
    const res = await api.post("/api/products", data);
    return res.data;
}

// updating an existing product's details
export async function updateProductApi(id: string, data: any) {
    const res = await api.put(`/api/products/${id}`, data);
    return res.data;
}

// soft-deleting a product by marking it as inactive
export async function deactivateProductApi(id: string) {
    const res = await api.patch(`/api/products/${id}/deactivate`);
    return res.data;
}

// fetching all available product categories for the filter dropdown
export async function getCategoriesApi() {
    const res = await api.get("/api/products/categories");
    return res.data;
}

// uploading a CSV file to bulk import products — uses raw fetch for FormData
export async function importCsvApi(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(API_BASE_URL + "/api/products/import-csv", {
        method: "POST",
        headers: getBearerHeaders(),
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to import products.");
    }
    return res.json();
}

// --- Business settings endpoints ---

// fetching the current business settings (low stock threshold, wholesale qty, loyalty discount)
export async function getBusinessSettingsApi() {
    const res = await api.get("/api/settings/business");
    return res.data as BusinessSettings;
}

// updating business settings — only admin can access this
export async function updateBusinessSettingsApi(data: Partial<BusinessSettings>) {
    const res = await api.put("/api/settings/business", data);
    return res.data as BusinessSettings;
}

// --- Customer endpoints ---

// listing all customers — optionally filtering to active only
export async function listCustomersApi(activeOnly?: boolean) {
    const params = activeOnly ? { active: "true" } : {};
    const res = await api.get("/api/customers", { params });
    return res.data;
}

// creating a new customer with name and optional phone, email, and discount percentages
export async function createCustomerApi(data: { name: string; phone?: string; email?: string; loyaltyPercent?: number; wholesalePercent?: number }) {
    const res = await api.post("/api/customers", data);
    return res.data;
}

// updating an existing customer's details
export async function updateCustomerApi(id: string, data: { name?: string; phone?: string; email?: string; loyaltyPercent?: number; wholesalePercent?: number; isActive?: boolean }) {
    const res = await api.put(`/api/customers/${id}`, data);
    return res.data;
}

// deactivating a customer (soft delete)
export async function deactivateCustomerApi(id: string) {
    const res = await api.patch(`/api/customers/${id}/deactivate`);
    return res.data;
}

// --- Invoice endpoints ---

// creating a new draft invoice — optionally linked to a customer
export async function createInvoiceApi(customerId?: string) {
    const res = await api.post("/api/invoices", { customerId });
    return res.data;
}

// listing invoices with optional filters (date range, status, cashier, etc.)
export async function listInvoicesApi(filters?: any) {
    const res = await api.get("/api/invoices", { params: filters });
    return res.data;
}

// fetching a single invoice with all its items and payment details
export async function getInvoiceApi(id: string) {
    const res = await api.get(`/api/invoices/${id}`);
    return res.data;
}

// adding a product to a draft invoice with the given quantity
export async function addInvoiceItemApi(invoiceId: string, productId: string, qty: number) {
    const res = await api.post(`/api/invoices/${invoiceId}/items`, { productId, qty });
    return res.data;
}

// updating the quantity of an existing item in a draft invoice
export async function updateInvoiceItemApi(invoiceId: string, itemId: string, qty: number) {
    const res = await api.patch(`/api/invoices/${invoiceId}/items/${itemId}`, { qty });
    return res.data;
}

// removing an item from a draft invoice
export async function removeInvoiceItemApi(invoiceId: string, itemId: string) {
    const res = await api.delete(`/api/invoices/${invoiceId}/items/${itemId}`);
    return res.data;
}

// finalizing a draft invoice — this locks it, deducts stock, and applies any discount
export async function finalizeInvoiceApi(invoiceId: string, discountAmount?: number) {
    const res = await api.post(`/api/invoices/${invoiceId}/finalize`, { discountAmount });
    return res.data;
}

// cancelling an invoice — restores the stock that was deducted when the invoice was finalized
export async function cancelInvoiceApi(invoiceId: string) {
    const res = await api.patch(`/api/invoices/${invoiceId}/cancel`);
    return res.data;
}

// --- Payment endpoints ---

// recording a payment against an invoice (cash, eSewa, etc.)
export async function addPaymentApi(
    invoiceId: string,
    data: { method: string; amount: number; status?: string; reference?: string }
) {
    const res = await api.post(`/api/invoices/${invoiceId}/payments`, data);
    return res.data;
}

// initiating an eSewa online payment — returns the form fields to POST to eSewa's payment page
export async function initiateEsewaPaymentApi(data: {
    invoiceId: string;
    amount: number;
}) {
    const res = await api.post("/api/payments/esewa/initiate", data);
    return res.data;
}

// listing all payments recorded against an invoice
export async function listPaymentsApi(invoiceId: string) {
    const res = await api.get(`/api/invoices/${invoiceId}/payments`);
    return res.data;
}

// --- Inventory endpoints ---

// restocking a product — adding new stock with an optional reason for the audit trail
export async function restockApi(productId: string, qty: number, reason?: string) {
    const res = await api.post("/api/inventory/restock", { productId, qty, reason });
    return res.data;
}

// manually adjusting stock (positive or negative delta) with an optional reason
export async function adjustStockApi(productId: string, qtyDelta: number, reason?: string) {
    const res = await api.post("/api/inventory/adjust", { productId, qtyDelta, reason });
    return res.data;
}

// fetching all products currently below their low stock threshold
export async function getLowStockApi() {
    const res = await api.get("/api/inventory/low-stock");
    return res.data;
}

// fetching stock transaction history — optionally filtered by product
export async function getStockTransactionsApi(productId?: string) {
    const params = productId ? { productId } : {};
    const res = await api.get("/api/inventory/transactions", { params });
    return res.data;
}

// --- Reports and analytics endpoints ---

// fetching a simple sales summary for a date range
export async function salesSummaryApi(from: string, to: string) {
    const res = await api.get("/api/reports/sales", { params: { from, to } });
    return res.data;
}

// fetching the best-selling products for a date range
export async function bestSellersApi(from: string, to: string, limit?: number) {
    const res = await api.get("/api/reports/best-sellers", { params: { from, to, limit } });
    return res.data;
}

// fetching per-cashier sales performance for a date range
export async function cashierSalesApi(from: string, to: string) {
    const res = await api.get("/api/reports/cashier-sales", { params: { from, to } });
    return res.data;
}

// fetching the full analytics report with charts data, breakdowns, and summaries
export async function getAnalyticsReportApi(filters: {
    from: string;
    to: string;
    cashierId?: string;
    paymentStatus?: string;
}) {
    const res = await api.get("/api/reports/analytics", { params: filters });
    return res.data;
}

// downloading the analytics report as a CSV file (returns a blob)
export async function downloadAnalyticsCsvApi(filters: {
    from: string;
    to: string;
    cashierId?: string;
    paymentStatus?: string;
}) {
    const res = await api.get("/api/reports/analytics/export/csv", {
        params: filters,
        responseType: "blob", // telling axios to return the raw binary data instead of parsing JSON
    });
    return res.data;
}

// --- Audit endpoints ---

// fetching audit log entries with optional filters
export async function listAuditLogsApi(filters?: any) {
    const res = await api.get("/api/audit", { params: filters });
    return res.data;
}

// fetching login attempt records with optional filters
export async function listLoginAttemptsApi(filters?: any) {
    const res = await api.get("/api/audit/login-attempts", { params: filters });
    return res.data;
}

// --- Admin endpoints ---

// triggering a full database backup (admin only)
export async function triggerBackupApi() {
    const res = await api.post("/api/admin/backup");
    return res.data;
}

// --- User management endpoints ---

// listing all users — optionally filtered by role
export async function listUsersApi(params?: { role?: string }) {
    const res = await api.get("/api/users", { params });
    return res.data;
}

// creating a new user account (admin creates cashiers here)
export async function createUserApi(data: any) {
    const res = await api.post("/api/users", data);
    return res.data;
}

// updating an existing user's details
export async function updateUserApi(id: string, data: any) {
    const res = await api.put(`/api/users/${id}`, data);
    return res.data;
}

// --- Alert endpoints ---

// fetching the list of alert keys that the current user has already marked as read
export async function getReadAlertsApi() {
    const res = await api.get("/api/alerts/read");
    return res.data;
}

// fetching all alerts (stock + invoice activity) for the current user
export async function listAlertsApi(limit?: number) {
    const res = await api.get("/api/alerts", { params: limit ? { limit } : undefined });
    return res.data;
}

// marking a single alert as read by its key
export async function markAlertReadApi(alertKey: string) {
    const res = await api.post("/api/alerts/read", { alertKey });
    return res.data;
}

// marking multiple alerts as read at once
export async function markAllAlertsReadApi(alertKeys: string[]) {
    const res = await api.post("/api/alerts/read-all", { alertKeys });
    return res.data;
}

// marking an alert as unread (removing its read status)
export async function markAlertUnreadApi(alertKey: string) {
    const res = await api.delete("/api/alerts/read", { data: { alertKey } });
    return res.data;
}

// --- File upload endpoints ---

// uploading a profile photo for a specific user (admin managing cashier photos)
export async function uploadUserPhotoApi(userId: string, file: File) {
    const fd = new FormData();
    fd.append("photo", file);
    const res = await fetch(API_BASE_URL + `/api/users/${userId}/photo`, {
        method: "POST",
        headers: getBearerHeaders(),
        body: fd,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
    }
    return res.json();
}

// uploading an image for a product listing
export async function uploadProductImageApi(productId: string, file: File) {
    const fd = new FormData();
    fd.append("image", file);
    const res = await fetch(API_BASE_URL + `/api/products/${productId}/image`, {
        method: "POST",
        headers: getBearerHeaders(),
        body: fd,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
    }
    return res.json();
}
