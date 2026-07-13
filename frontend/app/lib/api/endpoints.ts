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
    returnWindowDays: number;
    parkedBillExpiryHours: number;
    draftRequestExpiryMinutes: number;
};

export type CashierPrivilege = {
    id?: string;
    userId: string;
    canCreateDiscountedCustomer: boolean;
    maxCustomerLoyaltyPercent: number;
    maxCustomerWholesalePercent: number;
    canRequestCustomerDiscount: boolean;
    canOverrideBillingPrice: boolean;
    canApplyManualDiscount: boolean;
    canVoidPayment: boolean;
    updatedById?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
};

export type CashierPrivilegeRow = {
    id: string;
    name: string;
    email: string;
    phone?: string | null;
    isActive: boolean;
    privilege: CashierPrivilege;
};

export type CustomerDiscountRequest = {
    id: string;
    customerName: string;
    phone: string;
    email?: string | null;
    discountType: "LOYALTY" | "WHOLESALE";
    discountPercent: number;
    reason?: string | null;
    status: "PENDING" | "APPROVED" | "REJECTED";
    requestedById: string;
    reviewedById?: string | null;
    reviewedAt?: string | null;
    adminNote?: string | null;
    approvedCustomerId?: string | null;
    createdAt: string;
    updatedAt: string;
    requestedBy?: { id: string; name: string; email?: string | null } | null;
    reviewedBy?: { id: string; name: string; email?: string | null } | null;
    approvedCustomer?: { id: string; name: string; phone?: string | null } | null;
};

export type OverridePolicy = {
    pinConfigured: boolean;
    pinUpdatedAt?: string | null;
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

export type ProductDeleteSafety = {
    productId: string;
    productName: string;
    canPermanentDelete: boolean;
    references: Array<{ label: string; count: number }>;
    stockBlocker: string | null;
    safeReason: string | null;
    recommendedAction: "PERMANENT_DELETE" | "SET_INACTIVE";
};

export async function getProductDeleteSafetyApi(id: string) {
    const res = await api.get<ProductDeleteSafety>(`/api/products/${id}/delete-safety`);
    return res.data;
}

export async function permanentlyDeleteProductApi(id: string) {
    const res = await api.delete<{
        deleted: boolean;
        product: { id: string; name: string; sku: string };
        safety: ProductDeleteSafety;
        message: string;
    }>(`/api/products/${id}`);
    return res.data;
}

// fetching all available product categories for the filter dropdown
export async function getCategoriesApi() {
    const res = await api.get("/api/products/categories");
    return res.data;
}

// uploading a CSV file to bulk import products — uses raw fetch for FormData
export type ProductImportTemplate = {
    id: string;
    name: string;
    supplier: string;
    sourceType: string;
    fieldMap: Record<string, string | string[]>;
    defaults?: Record<string, unknown> | null;
    createdById: string;
    createdBy?: { id: string; name?: string | null; role?: string | null };
    createdAt: string;
    updatedAt: string;
};

export type ProductImportTemplatePayload = {
    id?: string;
    name?: string;
    supplier: string;
    sourceType?: string;
    fieldMap: Record<string, string | string[]>;
    defaults?: Record<string, unknown>;
};

export async function importCsvApi(
    file: File,
    options?: {
        supplier?: string;
        templateId?: string;
        fieldMap?: Record<string, string | string[]>;
        defaults?: Record<string, unknown>;
    },
) {
    const formData = new FormData();
    formData.append("file", file);
    if (options?.supplier) formData.append("supplier", options.supplier);
    if (options?.templateId) formData.append("templateId", options.templateId);
    if (options?.fieldMap) formData.append("fieldMap", JSON.stringify(options.fieldMap));
    if (options?.defaults) formData.append("defaults", JSON.stringify(options.defaults));
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

export async function listProductImportTemplatesApi(sourceType?: string) {
    const res = await api.get("/api/products/import-templates", {
        params: sourceType ? { sourceType } : undefined,
    });
    return res.data as { templates: ProductImportTemplate[] };
}

export async function saveProductImportTemplateApi(payload: ProductImportTemplatePayload) {
    const res = await api.post("/api/products/import-templates", payload);
    return res.data as ProductImportTemplate;
}

export async function deleteProductImportTemplateApi(id: string) {
    const res = await api.delete(`/api/products/import-templates/${id}`);
    return res.data as {
        deleted: boolean;
        template: Pick<ProductImportTemplate, "id" | "supplier" | "sourceType">;
    };
}

export async function bulkUpdateProductPricesApi(payload: {
    reason: string;
    updates: Array<{
        productId: string;
        retailPrice: number;
        wholesalePrice: number;
        ratePerPiece?: number;
    }>;
}) {
    const res = await api.post("/api/products/bulk-price-update", payload);
    return res.data as {
        updatedCount: number;
        errorCount: number;
        products: Array<{ id: string; name: string; sku: string }>;
        errors: Array<{ productId: string; message: string }>;
    };
}

// uploading a text-based supplier PDF to create an import preview batch
export async function importPdfApi(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(API_BASE_URL + "/api/products/import-pdf", {
        method: "POST",
        headers: getBearerHeaders(),
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to import PDF.");
    }
    return res.json();
}

export async function importImageRateListApi(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(API_BASE_URL + "/api/products/import-image", {
        method: "POST",
        headers: getBearerHeaders(),
        body: formData,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to import image.");
    }
    return res.json();
}

export type ProductImportRow = {
    id: string;
    batchId: string;
    rowNumber: number;
    rawText?: string | null;
    status: string;
    error?: string | null;
    parsed?: unknown;
    createdAt: string;
};

export type ProductImportBatch = {
    id: string;
    sourceType: string;
    fileName?: string | null;
    supplier?: string | null;
    status: string;
    totalRows: number;
    importedRows: number;
    failedRows: number;
    createdById: string;
    createdBy?: { id: string; name?: string | null; role?: string | null };
    createdAt: string;
    rows: ProductImportRow[];
};

export type ImportedProductSummary = {
    id: string;
    sku: string;
    name: string;
};

export type CsvImportResult = {
    totalRows: number;
    createdCount: number;
    errorCount: number;
    createdProducts?: ImportedProductSummary[];
    errors: Array<{ rowNumber: number; sku?: string; name?: string; message: string }>;
    batchId?: string;
    sourceType?: string;
    message?: string;
};

export type ReviewedPdfImportRowPayload = {
    rowId: string;
    name: string;
    sku: string;
    barcode?: string;
    brand: string;
    category: string;
    categoryGroup?: string;
    vendorSource?: string;
    productCodeVariant?: string;
    sizeValue?: number | null;
    sizeUnit?: string;
    ratePerPiece: number;
    packageQuantity: number;
    packageUnit: string;
    saleUnit: string;
    allowFractionalQty: boolean;
    quantityStep: number;
    wholesaleEligible: boolean;
    sourceCitation?: string;
    retailPrice: number;
    wholesalePrice: number;
    stock: number;
};

export type ReviewedPdfImportResult = {
    totalRows: number;
    createdCount: number;
    errorCount: number;
    createdProducts?: ImportedProductSummary[];
    errors: Array<{ rowNumber: number; sku?: string; name?: string; message: string }>;
    batch: ProductImportBatch;
};

export async function getProductImportBatchApi(batchId: string) {
    const res = await api.get(`/api/products/import-batches/${batchId}`);
    return res.data as ProductImportBatch;
}

export async function listProductImportBatchesApi() {
    const res = await api.get("/api/products/import-batches");
    return res.data as { batches: ProductImportBatch[] };
}

export async function deleteProductImportBatchApi(batchId: string) {
    const res = await api.delete(`/api/products/import-batches/${batchId}`);
    return res.data as {
        deleted: boolean;
        message?: string;
        batch?: Pick<ProductImportBatch, "id" | "fileName" | "sourceType">;
    };
}

export async function importReviewedPdfRowsApi(
    batchId: string,
    payload: { rows: ReviewedPdfImportRowPayload[]; ignoredRowIds?: string[] },
) {
    const res = await api.post(`/api/products/import-batches/${batchId}/import`, payload);
    return res.data as ReviewedPdfImportResult;
}

export async function importProductDocumentApi(documentId: string) {
    const res = await api.post(`/api/products/import-documents/${documentId}`);
    return res.data as CsvImportResult;
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

export async function getOverridePolicyApi() {
    const res = await api.get("/api/settings/override-policy");
    return res.data as OverridePolicy;
}

export async function updateOverridePinApi(pin: string) {
    const res = await api.put("/api/settings/override-pin", { pin });
    return res.data as OverridePolicy;
}

export async function getMyCashierPrivilegesApi() {
    const res = await api.get("/api/settings/cashier-privileges/me");
    return res.data as { privilege: CashierPrivilege };
}

export async function listCashierPrivilegesApi() {
    const res = await api.get("/api/settings/cashier-privileges");
    return res.data as { cashiers: CashierPrivilegeRow[] };
}

export async function updateCashierPrivilegeApi(
    userId: string,
    data: Partial<CashierPrivilege>,
) {
    const res = await api.put(`/api/settings/cashier-privileges/${userId}`, data);
    return res.data as {
        cashier: { id: string; name: string; email: string };
        privilege: CashierPrivilege;
    };
}

export type CashDrawerEvent = {
    id: string;
    drawerId: string;
    type: "OPEN" | "CASH_IN" | "CASH_OUT" | "CLOSE";
    amount: number;
    note?: string | null;
    createdAt: string;
    createdBy?: { id: string; name: string } | null;
};

export type CashDrawer = {
    id: string;
    cashierId: string;
    status: "OPEN" | "CLOSED";
    openedAt: string;
    closedAt?: string | null;
    openingFloat: number;
    cashSalesTotal: number;
    cashInTotal: number;
    cashOutTotal: number;
    expectedTotal: number;
    actualTotal?: number | null;
    difference?: number | null;
    note?: string | null;
    cashier?: { id: string; name: string; email?: string | null } | null;
    events?: CashDrawerEvent[];
};

export async function getCurrentCashDrawerApi() {
    const res = await api.get("/api/cash-drawers/current");
    return res.data as { drawer: CashDrawer | null };
}

export async function listCashDrawersApi() {
    const res = await api.get("/api/cash-drawers");
    return res.data as { drawers: CashDrawer[] };
}

export async function openCashDrawerApi(data: { openingFloat: number; note?: string }) {
    const res = await api.post("/api/cash-drawers/open", data);
    return res.data as { drawer: CashDrawer };
}

export async function addCashDrawerEventApi(
    id: string,
    data: { type: "CASH_IN" | "CASH_OUT"; amount: number; note?: string },
) {
    const res = await api.post(`/api/cash-drawers/${id}/events`, data);
    return res.data as { drawer: CashDrawer };
}

export async function closeCashDrawerApi(
    id: string,
    data: { actualTotal: number; note?: string },
) {
    const res = await api.post(`/api/cash-drawers/${id}/close`, data);
    return res.data as { drawer: CashDrawer };
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

export async function createCashierDiscountedCustomerApi(data: {
    name: string;
    phone: string;
    email?: string;
    discountType: "LOYALTY" | "WHOLESALE";
    discountPercent: number;
}) {
    const res = await api.post("/api/customers/cashier-discounted", data);
    return res.data;
}

export async function createCustomerDiscountRequestApi(data: {
    name: string;
    phone: string;
    email?: string;
    discountType: "LOYALTY" | "WHOLESALE";
    discountPercent: number;
    reason?: string;
}) {
    const res = await api.post("/api/customers/discount-requests", data);
    return res.data as CustomerDiscountRequest;
}

export async function listCustomerDiscountRequestsApi(status?: "PENDING" | "APPROVED" | "REJECTED") {
    const res = await api.get("/api/customers/discount-requests", {
        params: status ? { status } : undefined,
    });
    return res.data as { requests: CustomerDiscountRequest[] };
}

export async function approveCustomerDiscountRequestApi(
    id: string,
    data?: { discountPercent?: number; adminNote?: string },
) {
    const res = await api.patch(`/api/customers/discount-requests/${id}/approve`, data || {});
    return res.data as CustomerDiscountRequest;
}

export async function rejectCustomerDiscountRequestApi(
    id: string,
    data?: { adminNote?: string },
) {
    const res = await api.patch(`/api/customers/discount-requests/${id}/reject`, data || {});
    return res.data as CustomerDiscountRequest;
}

export type CustomerDiscountDeleteSafety = {
    customer: {
        id: string;
        name: string;
        phone?: string | null;
        loyaltyPercent: number;
        wholesalePercent: number;
    };
    discountType: "LOYALTY" | "WHOLESALE";
    currentPercent: number;
    purchaseCount: number;
    references: string[];
    canDelete: boolean;
    reason?: string | null;
};

export async function getCustomerDiscountDeleteSafetyApi(
    id: string,
    discountType: "LOYALTY" | "WHOLESALE",
) {
    const res = await api.get(`/api/customers/${id}/discounts/${discountType}/delete-safety`);
    return res.data as CustomerDiscountDeleteSafety;
}

export async function deleteCustomerDiscountApi(
    id: string,
    discountType: "LOYALTY" | "WHOLESALE",
) {
    const res = await api.delete(`/api/customers/${id}/discounts/${discountType}`);
    return res.data as {
        changed: boolean;
        message: string;
        customer: CustomerDiscountDeleteSafety["customer"];
        safety: CustomerDiscountDeleteSafety;
    };
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

export async function checkoutInvoiceApi(data: {
    draftInvoiceId?: string;
    customerId?: string;
    discountAmount?: number;
    overridePin?: string;
    notes?: string;
    items: Array<{
        productId: string;
        qty: number;
        overrideUnitPrice?: number;
        overrideReason?: string;
        overrideAuthorizationToken?: string;
    }>;
    payment?: {
        method: "CASH" | "ESEWA" | "NONE";
        amount?: number;
        reference?: string;
        tenderedAmount?: number;
    };
    payments?: Array<{
        method: "CASH" | "ESEWA" | "NONE";
        amount?: number;
        reference?: string;
        tenderedAmount?: number;
    }>;
}) {
    const res = await api.post("/api/invoices/checkout", data);
    return res.data;
}

export async function authorizePriceOverrideApi(data: {
    productId: string;
    customerId?: string;
    qty: number;
    overrideUnitPrice: number;
    overrideReason: string;
    pin?: string;
}) {
    const res = await api.post("/api/invoices/price-overrides/authorize", data);
    return res.data as {
        token: string;
        expiresAt: string;
        productId: string;
        qty: number;
        originalUnitPrice: number;
        overrideUnitPrice: number;
        overrideReason: string;
    };
}

export async function parkInvoiceDraftApi(data: {
    replaceDraftInvoiceId?: string;
    customerId?: string;
    label?: string;
    items: Array<{ productId: string; qty: number }>;
}) {
    const res = await api.post("/api/invoices/parked", data);
    return res.data;
}

export async function listParkedDraftsApi() {
    const res = await api.get("/api/invoices/parked");
    return res.data;
}

export async function resumeParkedDraftApi(id: string) {
    const res = await api.post(`/api/invoices/parked/${id}/resume`);
    return res.data;
}

export async function discardParkedDraftApi(id: string) {
    const res = await api.delete(`/api/invoices/parked/${id}`);
    return res.data;
}

export async function transferParkedDraftApi(id: string, cashierId: string) {
    const res = await api.patch(`/api/invoices/parked/${id}/transfer`, { cashierId });
    return res.data;
}

export async function modifyFinalizedInvoiceApi(
    invoiceId: string,
    data: {
        customerId?: string | null;
        discountAmount?: number;
        overridePin?: string;
        reason?: string;
        items: Array<{ productId: string; qty: number }>;
    }
) {
    const res = await api.post(`/api/invoices/${invoiceId}/modify`, data);
    return res.data;
}

export type ReturnReasonCode =
    | "DAMAGED"
    | "WRONG_ITEM"
    | "CUSTOMER_REQUEST"
    | "EXCHANGE"
    | "OTHER";

export type ReturnStatusCode = "PENDING" | "APPROVED" | "REJECTED" | "REVERSED";

export async function createReturnRequestApi(data: {
    invoiceId: string;
    reason: ReturnReasonCode;
    note?: string;
    refundMethod?: "CASH" | "ESEWA" | null;
    items: Array<{ invoiceItemId: string; qty: number }>;
}) {
    const res = await api.post("/api/returns", data);
    return res.data;
}

export async function listReturnRequestsApi(filters?: {
    status?: ReturnStatusCode;
}) {
    const res = await api.get("/api/returns", { params: filters });
    return res.data;
}

export async function approveReturnRequestApi(id: string) {
    const res = await api.patch(`/api/returns/${id}/approve`);
    return res.data;
}

export async function rejectReturnRequestApi(id: string, note?: string) {
    const res = await api.patch(`/api/returns/${id}/reject`, { note });
    return res.data;
}

export async function reverseReturnRequestApi(id: string, note?: string) {
    const res = await api.patch(`/api/returns/${id}/reverse`, { note });
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

// voiding a successful payment — marks it as failed and recomputes the invoice payment status
// admin can void directly; cashier needs privilege + override PIN
export async function voidPaymentApi(invoiceId: string, paymentId: string, overridePin?: string) {
    const res = await api.patch(`/api/invoices/${invoiceId}/payments/${paymentId}/void`, { overridePin });
    return res.data;
}

// --- Inventory endpoints ---

// restocking a product — adding new stock with an optional reason for the audit trail
// now supports optional bill file uploads with metadata
export async function restockApi(
    productId: string,
    qty: number,
    reason?: string,
    billData?: {
        supplierName?: string;
        billNumber?: string;
        billDate?: string;
        billAmount?: number;
        files?: File[];
    },
) {
    // if bill files are provided, use FormData with fetch instead of axios
    if (billData?.files && billData.files.length > 0) {
        const fd = new FormData();
        fd.append("productId", productId);
        fd.append("qty", String(qty));
        if (reason) fd.append("reason", reason);
        if (billData.supplierName) fd.append("supplierName", billData.supplierName);
        if (billData.billNumber) fd.append("billNumber", billData.billNumber);
        if (billData.billDate) fd.append("billDate", billData.billDate);
        if (billData.billAmount !== undefined) fd.append("billAmount", String(billData.billAmount));
        for (const file of billData.files) {
            fd.append("billFiles", file);
        }
        const res = await fetch(API_BASE_URL + "/api/inventory/restock", {
            method: "POST",
            headers: getBearerHeaders(),
            body: fd,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Restock failed");
        }
        return res.json();
    }

    // no files — use the simple JSON approach
    const res = await api.post("/api/inventory/restock", { productId, qty, reason });
    return res.data;
}

export async function receiveStockBatchApi(data: {
    supplierName: string;
    reason?: string;
    billNumber?: string;
    billDate?: string;
    billAmount?: number;
    remarks?: string;
    lines: Array<{ productId: string; qty: number }>;
    files?: File[];
    documentIds?: string[];
}) {
    const fd = new FormData();
    fd.append("supplierName", data.supplierName);
    fd.append("lines", JSON.stringify(data.lines));
    if (data.reason) fd.append("reason", data.reason);
    if (data.billNumber) fd.append("billNumber", data.billNumber);
    if (data.billDate) fd.append("billDate", data.billDate);
    if (data.billAmount !== undefined) fd.append("billAmount", String(data.billAmount));
    if (data.remarks) fd.append("remarks", data.remarks);
    if (data.documentIds?.length) fd.append("documentIds", JSON.stringify(data.documentIds));
    for (const file of data.files || []) {
        fd.append("billFiles", file);
    }

    const res = await fetch(API_BASE_URL + "/api/inventory/receive-batch", {
        method: "POST",
        headers: getBearerHeaders(),
        body: fd,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Stock receive failed");
    }
    return res.json();
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

export type StockReceiveBatchDetail = {
    id: string;
    supplierName: string;
    billNumber?: string | null;
    billDate?: string | null;
    billAmount?: number | null;
    remarks?: string | null;
    createdAt: string;
    createdBy?: { id: string; name?: string | null };
    historyItems?: Array<{
        productId: string;
        productName: string;
        sku: string;
        qty: number;
        previousStock?: number;
        nextStock?: number;
    }>;
    transactions: Array<{
        id: string;
        productId: string;
        qtyDelta: number;
        reason?: string | null;
        createdAt: string;
        product?: {
            id: string;
            name: string;
            sku: string;
            stock?: number;
        };
    }>;
};

export async function getStockReceiveBatchApi(id: string) {
    const res = await api.get(`/api/inventory/receive-batches/${id}`);
    return res.data as StockReceiveBatchDetail;
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
    includeOperations?: boolean;
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

export async function listCategorizedHistoryApi(filters?: {
    category?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: number;
    pageSize?: number;
}) {
    const res = await api.get("/api/audit/history", { params: filters });
    return res.data as {
        category: string;
        events: Array<{
            id: string;
            category?: string;
            action: string;
            entityType: string;
            entityId: string;
            title?: string;
            description?: string;
            detailType?: string | null;
            detailId?: string | null;
            actionLabel?: string | null;
            actor?: { id: string; name?: string | null; email?: string | null; role?: string | null };
            meta?: unknown;
            createdAt: string;
        }>;
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
    };
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

export async function listBackupHistoryApi() {
    const res = await api.get("/api/admin/backups");
    return res.data;
}

export async function getBackupScheduleApi() {
    const res = await api.get("/api/admin/backup-schedule");
    return res.data;
}

export async function updateBackupScheduleApi(data: {
    enabled: boolean;
    frequency: "DAILY" | "WEEKLY";
    timeOfDay: string;
    dayOfWeek?: number | null;
}) {
    const res = await api.put("/api/admin/backup-schedule", data);
    return res.data;
}

export async function restoreBackupApi(id: string, confirmation: string) {
    const res = await api.post(`/api/admin/backups/${id}/restore`, { confirmation });
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

export type UserDeleteSafety = {
    userId: string;
    userName: string;
    canPermanentDelete: boolean;
    references: Array<{ label: string; count: number }>;
    supportCleanup: Array<{ label: string; count: number }>;
    safeReason: string | null;
    recommendedAction: "PERMANENT_DELETE" | "DEACTIVATE";
};

export async function getUserDeleteSafetyApi(id: string) {
    const res = await api.get<UserDeleteSafety>(`/api/users/${id}/delete-safety`);
    return res.data;
}

export async function permanentlyDeleteUserApi(id: string) {
    const res = await api.delete<{
        deleted: boolean;
        user: { id: string; name: string; email: string; role: string };
        safety: UserDeleteSafety;
        message: string;
    }>(`/api/users/${id}`);
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

export async function resolveAlertApi(alertKey: string) {
    const res = await api.post("/api/alerts/resolve", { alertKey });
    return res.data;
}

export async function dismissAlertApi(alertKey: string) {
    const res = await api.post("/api/alerts/dismiss", { alertKey });
    return res.data;
}

// --- Bin endpoints ---

export type BinRecord = {
    id: string;
    entityType: string;
    entityId: string;
    entityLabel: string | null;
    deletedById: string;
    deleteReason: string | null;
    entitySnapshot: unknown;
    purgeAfter: string;
    purgedAt: string | null;
    createdAt: string;
    deletedBy?: { id: string; name?: string | null; email?: string | null; role?: string | null };
};

export async function listBinApi(filters?: {
    entityType?: string;
    page?: number;
    pageSize?: number;
}) {
    const res = await api.get("/api/bin", { params: filters });
    return res.data as {
        records: BinRecord[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
    };
}

export async function restoreBinRecordApi(id: string) {
    const res = await api.post(`/api/bin/${id}/restore`);
    return res.data;
}

export async function purgeBinRecordApi(id: string) {
    const res = await api.delete(`/api/bin/${id}`);
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

// --- Document Storage endpoints ---

// the shape of document types the system supports
export type DocumentType = "STOCK_BILL" | "PRODUCT_IMPORT" | "RETURN_PROOF" | "PAYMENT_PROOF" | "DISCOUNT_PROOF" | "GENERAL";
export type DocumentVisibility = "ALL_AUTHENTICATED" | "ADMIN_MANAGER" | "ADMIN_ONLY";

// the shape of a document record from the backend
export type DocumentRecord = {
    id: string;
    documentType: DocumentType;
    fileName: string;
    storedFileName: string;
    storedPath: string;
    mimeType: string;
    fileSize: number;
    checksum: string | null;
    supplierName: string | null;
    billNumber: string | null;
    billDate: string | null;
    billAmount: number | null;
    remarks: string | null;
    linkedEntityType: string | null;
    linkedEntityId: string | null;
    visibility: DocumentVisibility;
    uploadedById: string;
    createdAt: string;
    uploadedBy: { id: string; name: string };
    processingStatus: "PROCESSED" | "UNPROCESSED";
    processingLabel: string;
};

// the shape of the paginated document list response
export type DocumentListResponse = {
    documents: DocumentRecord[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
};

// the shape of the storage info response
export type StorageInfo = {
    storageRoot: string;
    isConfigured: boolean;
    isAccessible: boolean;
    totalDocuments: number;
    totalSizeBytes: number;
    byType: { type: DocumentType; count: number; sizeBytes: number }[];
};

// uploading one or more documents with metadata
export async function uploadDocumentsApi(
    files: File[],
    metadata: {
        documentType: DocumentType;
        supplierName?: string;
        billNumber?: string;
        billDate?: string;
        billAmount?: number;
        remarks?: string;
        linkedEntityType?: string;
        linkedEntityId?: string;
        visibility?: DocumentVisibility;
    },
) {
    const fd = new FormData();
    for (const file of files) {
        fd.append("files", file);
    }
    fd.append("documentType", metadata.documentType);
    if (metadata.supplierName) fd.append("supplierName", metadata.supplierName);
    if (metadata.billNumber) fd.append("billNumber", metadata.billNumber);
    if (metadata.billDate) fd.append("billDate", metadata.billDate);
    if (metadata.billAmount !== undefined) fd.append("billAmount", String(metadata.billAmount));
    if (metadata.remarks) fd.append("remarks", metadata.remarks);
    if (metadata.linkedEntityType) fd.append("linkedEntityType", metadata.linkedEntityType);
    if (metadata.linkedEntityId) fd.append("linkedEntityId", metadata.linkedEntityId);
    if (metadata.visibility) fd.append("visibility", metadata.visibility);

    const res = await fetch(API_BASE_URL + "/api/documents", {
        method: "POST",
        headers: getBearerHeaders(),
        body: fd,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Document upload failed");
    }
    return res.json();
}

// listing documents with optional filters and pagination
export async function listDocumentsApi(filters?: {
    documentType?: DocumentType;
    processingStatus?: "PROCESSED" | "UNPROCESSED";
    visibility?: DocumentVisibility;
    supplierName?: string;
    billNumber?: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
}) {
    const res = await api.get<DocumentListResponse>("/api/documents", { params: filters });
    return res.data;
}

// fetching a single document's metadata
export async function getDocumentApi(id: string) {
    const res = await api.get<DocumentRecord>(`/api/documents/${id}`);
    return res.data;
}

// getting the URL to preview/download a document file
export function getDocumentFileUrl(id: string) {
    return `${API_BASE_URL}/api/documents/${id}/file`;
}

export async function fetchDocumentFileBlobApi(id: string) {
    const res = await fetch(getDocumentFileUrl(id), {
        headers: getBearerHeaders(),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load document file");
    }
    return res.blob();
}

// deleting a document
export async function deleteDocumentApi(id: string) {
    const res = await api.delete(`/api/documents/${id}`);
    return res.data;
}

export async function updateDocumentVisibilityApi(id: string, visibility: DocumentVisibility) {
    const res = await api.patch(`/api/documents/${id}/visibility`, { visibility });
    return res.data as {
        document: DocumentRecord;
        changed: boolean;
        message: string;
    };
}

// fetching storage health and statistics
export async function getStorageInfoApi() {
    const res = await api.get<StorageInfo>("/api/documents/storage-info");
    return res.data;
}
