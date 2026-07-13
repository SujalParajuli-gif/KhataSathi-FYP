import React, { useEffect, useMemo, useState } from "react";
import {
  InvoiceStatusChip,
  PaymentMethodChip,
} from "~/components/invoices/InvoiceChips";
import { ConfirmDialog } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import PaginationBar from "~/components/ui/PaginationBar";
import { useToast } from "~/components/ui/Toast";
import InvoiceDetailModal from "~/components/invoices/InvoiceDetailModal";
import {
  addPaymentApi,
  approveReturnRequestApi,
  cancelInvoiceApi,
  createReturnRequestApi,
  discardParkedDraftApi,
  getMyCashierPrivilegesApi,
  getInvoiceApi,
  initiateEsewaPaymentApi,
  listInvoicesApi,
  listParkedDraftsApi,
  listProductsApi,
  listUsersApi,
  listReturnRequestsApi,
  modifyFinalizedInvoiceApi,
  rejectReturnRequestApi,
  reverseReturnRequestApi,
  transferParkedDraftApi,
  voidPaymentApi,
  type ReturnReasonCode,
  type ReturnStatusCode,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import { submitEsewaForm } from "~/lib/esewa";
import type {
  AppInvoice,
  InvoiceStatusLabel,
  PaymentMethodLabel,
} from "~/lib/invoices";
import { formatNpr, normalizeInvoice, openInvoicePrint } from "~/lib/invoices";

// we use this helper function to easily join multiple tailwind class strings
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// this function loops through all invoices to calculate totals for the dashboard-style summary cards
// we filter out cancelled invoices when summing up sales and due amounts so the numbers are accurate
function calcSummary(invoices: AppInvoice[]) {
  const generated = invoices.length;
  const paid = invoices.filter((invoice) => invoice.status === "Paid").length;
  const partial = invoices.filter(
    (invoice) => invoice.status === "Partial",
  ).length;
  const unpaid = invoices.filter(
    (invoice) => invoice.status === "Unpaid",
  ).length;
  const due = invoices.filter(
    (invoice) => invoice.status !== "Cancelled" && invoice.dueAmount > 0,
  ).length;
  const cancelled = invoices.filter(
    (invoice) => invoice.status === "Cancelled",
  ).length;

  const totalSales = invoices.reduce(
    (sum, invoice) =>
      sum + (invoice.status !== "Cancelled" ? invoice.netTotal : 0),
    0,
  );

  const outstandingDue = invoices.reduce(
    (sum, invoice) =>
      sum + (invoice.status !== "Cancelled" ? invoice.dueAmount : 0),
    0,
  );

  return {
    generated,
    paid,
    partial,
    unpaid,
    due,
    cancelled,
    totalSales,
    outstandingDue,
  };
}

// we use this to keep the pagination page number between 1 and the max pages available
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

async function fetchAllInvoices(filters?: Record<string, unknown>) {
  const pageSize = 200;
  let page = 1;
  let total = 0;
  const collected: any[] = [];

  do {
    const data = await listInvoicesApi({ ...filters, page, pageSize });
    const batch = Array.isArray(data?.invoices) ? data.invoices : [];
    collected.push(...batch);
    total = Number(data?.total ?? collected.length);
    page += 1;
    if (batch.length === 0) break;
  } while (collected.length < total);

  return collected.map(normalizeInvoice);
}

// this builds a short string summarizing the items in the invoice (e.g., "Apple x2 + 3 more")
// we use it in the invoice list table to show a quick preview without needing too much space
function getCompactInvoiceSummary(invoice: AppInvoice) {
  const rawItems = (invoice as any)?.items;

  if (Array.isArray(rawItems) && rawItems.length > 0) {
    const firstItem = rawItems[0];
    const firstName =
      firstItem?.productName || firstItem?.name || firstItem?.title || "Item";

    const quantity =
      firstItem?.quantity ?? firstItem?.qty ?? firstItem?.count ?? null;

    const firstLabel = quantity
      ? `${firstName} x${quantity}`
      : String(firstName);

    if (rawItems.length === 1) return firstLabel;

    return `${firstLabel} + ${rawItems.length - 1} more`;
  }

  const raw = invoice.itemSummary?.trim();
  if (!raw) return "No items";

  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return parts[0] || "No items";
  }

  return `${parts[0]} + ${parts.length - 1} more`;
}

// keeping customer type checks in one place makes the invoice and history filters easier to read
function getInvoiceCustomerType(invoice: Pick<AppInvoice, "customerId">) {
  return invoice.customerId ? "Registered" : "Walk-in";
}

type InvoiceEditPaymentMethod = "Cash" | "eSewa";
type InvoiceCustomerTypeFilter = "All" | "Walk-in" | "Registered";
type PendingInvoiceAction =
  | { kind: "cash-payment"; amount: number }
  | { kind: "esewa-payment"; amount: number }
  | { kind: "mark-paid"; amount: number }
  | { kind: "cancel-invoice" }
  | null;
type ModifyInvoiceLine = {
  productId: string;
  name: string;
  sku?: string;
  barcode?: string;
  qty: number;
  unitPrice: number;
};

type ModifyProductResult = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  retailPrice: number;
  stock: number;
};

type ReturnRefundMethod = "CASH" | "ESEWA";
type PendingReturnReviewAction =
  | { kind: "approve"; requestId: string }
  | { kind: "reject"; requestId: string }
  | { kind: "reverse"; requestId: string }
  | null;

type AdminParkedDraft = {
  id: string;
  invoiceNo?: string;
  parkedLabel?: string | null;
  parkedAt?: string | null;
  subTotal?: number;
  cashier?: { id?: string; name?: string; email?: string } | null;
  customer?: { id?: string; name?: string; phone?: string } | null;
  items?: Array<{ qty?: number; product?: { name?: string } | null }>;
};

type AdminCashierOption = {
  id: string;
  name: string;
  isActive?: boolean;
};

type PendingParkedTransfer = {
  draft: AdminParkedDraft;
  cashier: AdminCashierOption;
} | null;

type ReturnLineState = {
  invoiceItemId: string;
  productId?: string;
  name: string;
  sku?: string;
  qtyPurchased: number;
  qtyReturning: number;
  unitPrice: number;
};

type AppReturnRequestItem = {
  id: string;
  name: string;
  sku?: string;
  qtyReturned: number;
  unitPrice: number;
  lineTotal: number;
};

type AppReturnRequest = {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  customerName: string;
  cashierName: string;
  reason: ReturnReasonCode;
  note?: string;
  status: ReturnStatusCode;
  refundAmount: number;
  refundMethod?: ReturnRefundMethod;
  createdAt: string;
  createdByName: string;
  reviewedAt?: string;
  reviewedByName?: string;
  items: AppReturnRequestItem[];
};

const CREDIT_REASON_SUGGESTIONS = [
  "Wrong quantity",
  "Item exchanged",
  "Customer returned item",
  "Price correction",
  "Damaged item",
  "Billing mistake",
  "Customer request",
];

const RETURN_REASON_OPTIONS: Array<{
  code: ReturnReasonCode;
  label: string;
  helper: string;
}> = [
  {
    code: "CUSTOMER_REQUEST",
    label: "Customer request",
    helper: "Good condition, customer changed mind",
  },
  {
    code: "DAMAGED",
    label: "Damaged item",
    helper: "Item came back damaged or defective",
  },
  {
    code: "WRONG_ITEM",
    label: "Wrong item",
    helper: "Incorrect product was billed or issued",
  },
  {
    code: "EXCHANGE",
    label: "Exchange",
    helper: "Customer is swapping for another item",
  },
  {
    code: "OTHER",
    label: "Other",
    helper: "Needs a custom note",
  },
];

function getReturnReasonLabel(reason: string) {
  return (
    RETURN_REASON_OPTIONS.find((option) => option.code === reason)?.label ||
    reason
  );
}

function getReturnStatusLabel(status: ReturnStatusCode) {
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  if (status === "REVERSED") return "Reversed";
  return "Pending";
}

function getReturnStatusClass(status: ReturnStatusCode) {
  if (status === "APPROVED") {
    return "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]";
  }
  if (status === "REJECTED") {
    return "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]";
  }
  if (status === "REVERSED") {
    return "border-[#F5D28A] bg-[#FFF7E6] text-[#A46100]";
  }
  return "border-[#CFCFD3] bg-[#F3F4F6] text-[#565449]";
}

function normalizeReturnRequest(raw: any): AppReturnRequest {
  return {
    id: String(raw.id),
    invoiceId: String(raw.invoiceId || raw.invoice?.id || ""),
    invoiceNo: String(raw.invoice?.invoiceNo || raw.invoiceNo || "Return"),
    customerName: String(raw.invoice?.customer?.name || "Walk-in"),
    cashierName: String(raw.invoice?.cashier?.name || "Unknown cashier"),
    reason: String(raw.reason || "OTHER") as ReturnReasonCode,
    note: raw.note ? String(raw.note) : undefined,
    status: String(raw.status || "PENDING") as ReturnStatusCode,
    refundAmount: Number(raw.refundAmount || 0),
    refundMethod: raw.refundMethod
      ? (String(raw.refundMethod) as ReturnRefundMethod)
      : undefined,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    createdByName: String(raw.createdBy?.name || "Unknown user"),
    reviewedAt: raw.reviewedAt ? String(raw.reviewedAt) : undefined,
    reviewedByName: raw.reviewedBy?.name
      ? String(raw.reviewedBy.name)
      : undefined,
    items: Array.isArray(raw.items)
      ? raw.items.map((item: any) => ({
          id: String(item.id),
          name: String(item.product?.name || "Returned item"),
          sku: item.product?.sku ? String(item.product.sku) : undefined,
          qtyReturned: Number(item.qtyReturned || 0),
          unitPrice: Number(item.unitPrice || 0),
          lineTotal: Number(item.lineTotal || 0),
        }))
      : [],
  };
}

function mapModifyProductResult(product: any): ModifyProductResult {
  return {
    id: String(product.id),
    name: String(product.name || "Unnamed product"),
    sku: String(product.sku || ""),
    barcode: product.barcode ? String(product.barcode) : undefined,
    retailPrice: Number(product.retailPrice || 0),
    stock: Number(product.stock || 0),
  };
}

function InvoiceModifyModal({
  invoice,
  lines,
  reason,
  error,
  busy,
  onChangeReason,
  onChangeQty,
  onRemoveLine,
  onAddLine,
  onClose,
  onSubmit,
}: {
  invoice: AppInvoice | null;
  lines: ModifyInvoiceLine[];
  reason: string;
  error: string;
  busy: boolean;
  onChangeReason: (value: string) => void;
  onChangeQty: (productId: string, qty: number) => void;
  onRemoveLine: (productId: string) => void;
  onAddLine: (product: ModifyProductResult) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [addProductQuery, setAddProductQuery] = useState("");
  const [addProductResults, setAddProductResults] = useState<ModifyProductResult[]>([]);
  const [addProductLoading, setAddProductLoading] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [scanError, setScanError] = useState("");
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  // debounced product search — waits 300ms after typing stops before calling the API
  useEffect(() => {
    if (!invoice) return;
    const query = addProductQuery.trim();
    if (query.length < 2) {
      setAddProductResults([]);
      return;
    }

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      setAddProductLoading(true);
      try {
        const response = await listProductsApi({ search: query, active: "true", pageSize: 20 });
        const products = Array.isArray(response?.products) ? response.products : [];
        setAddProductResults(products.map(mapModifyProductResult));
      } catch {
        setAddProductResults([]);
      } finally {
        setAddProductLoading(false);
      }
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [addProductQuery, invoice]);

  // reset search state when the modal opens or closes
  useEffect(() => {
    if (!invoice) {
      setAddProductQuery("");
      setAddProductResults([]);
      setScanInput("");
      setScanModalOpen(false);
      setScanStatus("");
      setScanError("");
    }
  }, [invoice]);

  useEffect(() => {
    if (!scanStatus || scanModalOpen || scanBusy) return;
    const timer = window.setTimeout(() => setScanStatus(""), 3000);
    return () => window.clearTimeout(timer);
  }, [scanBusy, scanModalOpen, scanStatus]);

  useEffect(() => {
    if (!scanError || scanModalOpen || scanBusy) return;
    const timer = window.setTimeout(() => setScanError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [scanBusy, scanError, scanModalOpen]);

  useEffect(() => {
    if (!scanModalOpen) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let frameId = 0;

    async function startCameraScanner() {
      setScanError("");
      setScanStatus("Starting camera...");

      const BarcodeDetectorCtor =
        typeof window !== "undefined" ? (window as any).BarcodeDetector : null;

      if (!BarcodeDetectorCtor || !navigator.mediaDevices?.getUserMedia) {
        setScanStatus("");
        setScanError(
          "Camera barcode scanning is unavailable in this browser. Enter the barcode or SKU manually.",
        );
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });

        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();

        const detector = new BarcodeDetectorCtor({
          formats: [
            "ean_13",
            "ean_8",
            "code_128",
            "code_39",
            "upc_a",
            "upc_e",
            "qr_code",
          ],
        });

        setScanStatus("Point the camera at the barcode.");

        const scanFrame = async () => {
          if (stopped) return;

          try {
            if (video.readyState >= 2) {
              const matches = await detector.detect(video);
              const rawValue = matches?.[0]?.rawValue;

              if (rawValue) {
                stopped = true;
                void addProductFromCode(String(rawValue), "camera");
                return;
              }
            }
          } catch {
            setScanError(
              "The camera is open, but barcode detection failed. Try manual entry below.",
            );
          }

          frameId = window.requestAnimationFrame(scanFrame);
        };

        frameId = window.requestAnimationFrame(scanFrame);
      } catch {
        setScanStatus("");
        setScanError(
          "Camera permission was blocked or no camera is available. Enter the barcode or SKU manually.",
        );
      }
    }

    void startCameraScanner();

    return () => {
      stopped = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [scanModalOpen]);

  if (!invoice) return null;

  const nextSubtotal = lines.reduce(
    (sum, line) => sum + line.qty * line.unitPrice,
    0,
  );
  const nextUnits = lines.reduce((sum, line) => sum + line.qty, 0);
  const originalUnits = invoice.items.reduce((sum, item) => sum + item.qty, 0);
  const estimatedCreditTransfer = Math.min(invoice.paidAmount, nextSubtotal);
  const estimatedDueAfterTransfer = Math.max(
    0,
    nextSubtotal - estimatedCreditTransfer,
  );
  const estimatedCustomerCredit = Math.max(
    0,
    invoice.paidAmount - nextSubtotal,
  );
  const totalDifference = nextSubtotal - invoice.netTotal;

  // filter out products that are already in the replacement items list so the search results are cleaner
  const existingProductIds = new Set(lines.map((line) => line.productId));
  const filteredResults = addProductResults.filter(
    (product) => !existingProductIds.has(product.id),
  );

  function applyReasonSuggestion(suggestion: string) {
    const current = reason.trim();
    if (!current) {
      onChangeReason(suggestion);
      return;
    }

    if (current.toLowerCase().includes(suggestion.toLowerCase())) return;
    onChangeReason(`${current}; ${suggestion}`);
  }

  async function addProductFromCode(rawValue: string, source: "manual" | "camera") {
    const code = rawValue.trim();
    if (!code) {
      setScanError("Enter a barcode or SKU first.");
      return;
    }

    setScanBusy(true);
    setScanError("");
    setScanStatus(source === "camera" ? "Barcode detected." : "Looking up product...");

    try {
      const response = await listProductsApi({
        search: code,
        active: "true",
        pageSize: 20,
      });
      const products: ModifyProductResult[] = Array.isArray(response?.products)
        ? response.products.map(mapModifyProductResult)
        : [];
      const normalized = code.toLowerCase();
      const exactMatch = products.find(
        (product) =>
          product.sku.toLowerCase() === normalized ||
          (product.barcode || "").toLowerCase() === normalized,
      );
      const product = exactMatch || (products.length === 1 ? products[0] : null);

      if (!product) {
        setScanStatus("");
        setScanError(`No active product found for "${code}".`);
        return;
      }

      if (product.stock <= 0) {
        setScanStatus("");
        setScanError(`"${product.name}" is out of stock.`);
        return;
      }

      onAddLine(product);
      setScanInput("");
      setAddProductQuery("");
      setAddProductResults([]);
      setScanModalOpen(false);
      setScanStatus(`Added ${product.name}.`);
    } catch (err: any) {
      setScanStatus("");
      setScanError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to scan product.",
      );
    } finally {
      setScanBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute left-1/2 top-1/2 flex max-h-[92vh] w-[1180px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF]">
        <div className="flex flex-col gap-4 border-b border-[#CFCFD3] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
              Modify finalized invoice
            </div>
            <div className="mt-1 truncate text-[20px] font-extrabold text-[#000000]">
              {invoice.invoiceNo}
            </div>
            <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
              {invoice.customerName} | Original {formatNpr(invoice.netTotal)}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden rounded-[14px] border border-[#F6D28B] bg-[#FFF7E8] px-4 py-3 text-[12px] font-semibold text-[#B7791F] lg:block">
              Credit note + replacement invoice
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#CFCFD3]"
              aria-label="Close"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-4">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF]">
                <div className="flex flex-col gap-3 border-b border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                      Add replacement item
                    </div>
                    <div className="mt-0.5 text-[11px] font-semibold text-[#8C8889]">
                      Search, scan, or type a barcode/SKU.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setScanModalOpen(true);
                      setScanError("");
                      setScanStatus("");
                    }}
                    className="flex h-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27]"
                  >
                    <Icon name="qr_code_scanner" className="text-[16px]" />
                    Scan
                  </button>
                </div>

                <div className="grid gap-3 p-4 xl:grid-cols-[1fr_280px]">
                  <div className="relative">
                    <div className="flex items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 py-2.5 transition focus-within:border-[#000000]">
                      <Icon name="search" className="text-[18px] text-[#8C8889]" />
                    <input
                      value={addProductQuery}
                      onChange={(event) => {
                        setAddProductQuery(event.target.value);
                        setScanError("");
                        setScanStatus("");
                      }}
                      onBlur={() => {
                        setScanError("");
                        setScanStatus("");
                      }}
                      placeholder="Search product name, SKU, barcode..."
                      className="w-full bg-transparent text-[13px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889]"
                    />
                      {addProductLoading ? (
                        <span className="shrink-0 text-[11px] font-semibold text-[#8C8889]">
                          Searching...
                        </span>
                      ) : null}
                    </div>

                    {addProductQuery.trim().length >= 2 ? (
                      <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[230px] overflow-y-auto rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] shadow-lg">
                        {filteredResults.map((product) => (
                          <button
                            key={product.id}
                            type="button"
                            disabled={product.stock <= 0}
                            onClick={() => {
                              onAddLine(product);
                              setAddProductQuery("");
                              setAddProductResults([]);
                              setScanError("");
                              setScanStatus("");
                            }}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition",
                              product.stock <= 0
                                ? "cursor-not-allowed opacity-40"
                                : "hover:bg-[#F3F4F6]",
                            )}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-extrabold text-[#000000]">
                                {product.name}
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-[#8C8889]">
                                <span>SKU: {product.sku || "-"}</span>
                                {product.barcode ? <span>Barcode: {product.barcode}</span> : null}
                                <span>{formatNpr(product.retailPrice)}</span>
                              </div>
                            </div>
                            <span
                              className={cn(
                                "shrink-0 rounded-[8px] border px-2 py-0.5 text-[11px] font-extrabold",
                                product.stock > 0
                                  ? "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]"
                                  : "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]",
                              )}
                            >
                              {product.stock > 0 ? `${product.stock} in stock` : "Out"}
                            </span>
                          </button>
                        ))}
                        {filteredResults.length === 0 && !addProductLoading ? (
                          <div className="px-4 py-3 text-center text-[12px] font-semibold text-[#8C8889]">
                            No matching products found.
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 py-2.5 transition focus-within:border-[#000000]">
                      <Icon name="barcode_scanner" className="text-[18px] text-[#8C8889]" />
                      <input
                        value={scanInput}
                        onChange={(event) => {
                          setScanInput(event.target.value);
                          setScanError("");
                          setScanStatus("");
                        }}
                        onBlur={() => {
                          setScanError("");
                          setScanStatus("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void addProductFromCode(scanInput, "manual");
                          }
                        }}
                        placeholder="Barcode / SKU"
                        className="w-full bg-transparent font-mono text-[13px] font-semibold text-[#000000] outline-none placeholder:font-sans placeholder:text-[#8C8889]"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={scanBusy}
                      onClick={() => void addProductFromCode(scanInput, "manual")}
                      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6] disabled:opacity-50"
                      aria-label="Add scanned product"
                      title="Add scanned product"
                    >
                      <Icon name="add" />
                    </button>
                  </div>
                </div>
                {scanStatus && !scanModalOpen ? (
                  <div className="mx-4 mb-4 rounded-[12px] border border-[#9DD8B2] bg-[#EAF8EF] px-3 py-2 text-[12px] font-semibold text-[#179B4D]">
                    {scanStatus}
                  </div>
                ) : null}
                {scanError && !scanModalOpen ? (
                  <div className="mx-4 mb-4 rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 py-2 text-[12px] font-semibold text-[#BE123C]">
                    {scanError}
                  </div>
                ) : null}
              </div>

              <div className="overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF]">
                <div className="flex items-center justify-between border-b border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3">
                  <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                    Replacement items
                  </div>
                  <div className="text-[12px] font-bold text-[#8C8889]">
                    {lines.length} line(s) | {nextUnits} unit(s)
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <div className="min-w-[760px]">
                    <div className="grid grid-cols-[minmax(260px,1fr)_120px_132px_130px_44px] gap-3 border-b border-[#E5E7EB] px-4 py-2 text-[11px] font-extrabold uppercase text-[#8C8889]">
                      <div>Item</div>
                      <div>Unit</div>
                      <div>Qty</div>
                      <div className="text-right">Total</div>
                      <div />
                    </div>

                    <div className="divide-y divide-[#E5E7EB]">
                      {lines.map((line) => (
                        <div
                          key={line.productId}
                          className="grid grid-cols-[minmax(260px,1fr)_120px_132px_130px_44px] items-center gap-3 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-extrabold text-[#000000]">
                              {line.name}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-[#8C8889]">
                              {line.sku ? <span>SKU: {line.sku}</span> : null}
                              {line.barcode ? <span>Barcode: {line.barcode}</span> : null}
                            </div>
                          </div>
                          <div className="font-mono text-[12px] font-extrabold text-[#000000]">
                            {formatNpr(line.unitPrice)}
                          </div>
                          <div className="flex h-[38px] items-center rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] p-1">
                            <button
                              type="button"
                              onClick={() => onChangeQty(line.productId, line.qty - 1)}
                              disabled={line.qty <= 1}
                              className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#FFFFFF] disabled:opacity-40"
                              aria-label={`Decrease ${line.name} quantity`}
                              title="Decrease quantity"
                            >
                              <Icon name="remove" className="text-[16px]" />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={line.qty}
                              aria-label={`Quantity for ${line.name}`}
                              onChange={(event) =>
                                onChangeQty(line.productId, Number(event.target.value || 1))
                              }
                              className="h-[28px] w-[54px] bg-transparent text-center text-[13px] font-extrabold outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => onChangeQty(line.productId, line.qty + 1)}
                              className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#FFFFFF]"
                              aria-label={`Increase ${line.name} quantity`}
                              title="Increase quantity"
                            >
                              <Icon name="add" className="text-[16px]" />
                            </button>
                          </div>
                          <div className="text-right font-mono text-[13px] font-extrabold text-[#000000]">
                            {formatNpr(line.qty * line.unitPrice)}
                          </div>
                          <button
                            type="button"
                            onClick={() => onRemoveLine(line.productId)}
                            className="flex h-[36px] w-[36px] items-center justify-center rounded-[10px] border border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] transition hover:bg-rose-100"
                            aria-label={`Remove ${line.name}`}
                            title="Remove"
                          >
                            <Icon name="delete" className="text-[16px]" />
                          </button>
                        </div>
                      ))}
                      {lines.length === 0 ? (
                        <div className="px-4 py-8 text-center text-[13px] font-semibold text-[#8C8889]">
                          All items removed. Add a product before saving.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-[16px] border border-[#F6D28B] bg-[#FFF7E8] px-4 py-3 text-[12px] font-semibold text-[#B7791F]">
                This creates a credit note for the original invoice and finalizes a replacement invoice.
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
                <label className="block text-[12px] font-extrabold uppercase text-[#8C8889]">
                  Reason / reminder note
                </label>
                <textarea
                  value={reason}
                  onChange={(event) => onChangeReason(event.target.value)}
                  placeholder="Wrong quantity, item change, customer request..."
                  rows={4}
                  className="mt-2 w-full resize-none rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-4 py-3 text-[13px] font-semibold text-[#000000] outline-none transition focus:border-[#000000]"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {CREDIT_REASON_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => applyReasonSuggestion(suggestion)}
                      className="rounded-[10px] border border-[#CFCFD3] bg-[#F3F4F6] px-3 py-1.5 text-[11px] font-extrabold text-[#565449] transition hover:border-[#11120d] hover:bg-[#FFFFFF] hover:text-[#000000]"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
                <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                  Credit preview
                </div>
                <div className="mt-4 space-y-3 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Original total</span>
                    <span className="font-mono font-extrabold text-[#000000]">
                      {formatNpr(invoice.netTotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Original paid</span>
                    <span className="font-mono font-extrabold text-[#000000]">
                      {formatNpr(invoice.paidAmount)}
                    </span>
                  </div>
                  <div className="border-t border-dashed border-[#CFCFD3]" />
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Replacement estimate</span>
                    <span className="font-mono font-extrabold text-[#000000]">
                      {formatNpr(nextSubtotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Credit transfer est.</span>
                    <span className="font-mono font-extrabold text-[#000000]">
                      {formatNpr(estimatedCreditTransfer)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Due after replacement</span>
                    <span className="font-mono font-extrabold text-[#BE123C]">
                      {formatNpr(estimatedDueAfterTransfer)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Customer credit est.</span>
                    <span className="font-mono font-extrabold text-[#179B4D]">
                      {formatNpr(estimatedCustomerCredit)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-3">
                  <div className="text-[12px] font-bold text-[#8C8889]">
                    Original units
                  </div>
                  <div className="mt-1 font-mono font-extrabold text-[#000000]">
                    {originalUnits}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-3">
                  <div className="text-[12px] font-bold text-[#8C8889]">
                    Replacement units
                  </div>
                  <div className="mt-1 font-mono font-extrabold text-[#000000]">
                    {nextUnits}
                  </div>
                </div>
              </div>

              {error ? (
                <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[12px] font-semibold text-[#BE123C]">
                  {error}
                </div>
              ) : null}
            </aside>
          </div>
        </div>

        {scanModalOpen ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-[#FFFFFF]">
            <div className="flex items-center justify-between border-b border-[#CFCFD3] p-5">
              <div>
                <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
                  Barcode scanner
                </div>
                <div className="mt-1 text-[18px] font-extrabold text-[#000000]">
                  Add replacement item
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setScanModalOpen(false);
                  setScanError("");
                  setScanStatus("");
                }}
                className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6]"
                aria-label="Close scanner"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="relative min-h-[320px] overflow-hidden rounded-[18px] border border-[#11120d] bg-[#11120d]">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  className="h-full min-h-[320px] w-full object-cover"
                />
                <div className="pointer-events-none absolute inset-x-[18%] top-1/2 h-[96px] -translate-y-1/2 rounded-[18px] border-2 border-[#FFFFFF]" />
              </div>

              <div className="space-y-4">
                <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6] p-4 text-[12px] font-semibold text-[#565449]">
                  {scanStatus || "Camera scanner opens when supported by the browser."}
                </div>
                {scanError ? (
                  <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[12px] font-semibold text-[#BE123C]">
                    {scanError}
                  </div>
                ) : null}
                <div>
                  <label className="block text-[12px] font-extrabold uppercase text-[#8C8889]">
                    Manual barcode / SKU
                  </label>
                  <div className="mt-2 flex gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 py-2.5 transition focus-within:border-[#000000]">
                      <Icon name="barcode_scanner" className="text-[18px] text-[#8C8889]" />
                      <input
                        value={scanInput}
                        onChange={(event) => {
                          setScanInput(event.target.value);
                          setScanError("");
                          setScanStatus("");
                        }}
                        onBlur={() => {
                          setScanError("");
                          setScanStatus("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void addProductFromCode(scanInput, "manual");
                          }
                        }}
                        placeholder="Barcode / SKU"
                        className="w-full bg-transparent font-mono text-[13px] font-semibold text-[#000000] outline-none placeholder:font-sans placeholder:text-[#8C8889]"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={scanBusy}
                      onClick={() => void addProductFromCode(scanInput, "manual")}
                      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] border border-[#11120d] bg-[#11120d] text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
                      aria-label="Add barcode"
                      title="Add barcode"
                    >
                      <Icon name="add" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="border-t border-[#CFCFD3] bg-[#FFFFFF] px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-3 text-[12px] font-bold text-[#8C8889]">
              <span>{lines.length} line(s)</span>
              <span>{nextUnits} unit(s)</span>
              <span>
                Replacement {formatNpr(nextSubtotal)}
              </span>
              <span
                className={cn(
                  "font-mono font-extrabold",
                  totalDifference > 0
                    ? "text-[#BE123C]"
                    : totalDifference < 0
                      ? "text-[#179B4D]"
                      : "text-[#000000]",
                )}
              >
                {totalDifference > 0 ? "+" : ""}
                {formatNpr(totalDifference)}
              </span>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="h-[42px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-4 text-[13px] font-extrabold text-[#000000] transition hover:bg-[#F3F4F6] disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={busy || lines.length === 0}
                className="h-[42px] rounded-[14px] border-2 border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
              >
                {busy ? "Creating..." : "Create Credit Note"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InvoiceReturnRequestModal({
  invoice,
  lines,
  reason,
  note,
  refundMethod,
  error,
  busy,
  onChangeReason,
  onChangeNote,
  onChangeRefundMethod,
  onChangeQty,
  onClose,
  onSubmit,
}: {
  invoice: AppInvoice | null;
  lines: ReturnLineState[];
  reason: ReturnReasonCode;
  note: string;
  refundMethod: ReturnRefundMethod;
  error: string;
  busy: boolean;
  onChangeReason: (value: ReturnReasonCode) => void;
  onChangeNote: (value: string) => void;
  onChangeRefundMethod: (value: ReturnRefundMethod) => void;
  onChangeQty: (invoiceItemId: string, qty: number) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!invoice) return null;

  const selectedLines = lines.filter((line) => line.qtyReturning > 0);
  const returnUnits = selectedLines.reduce(
    (sum, line) => sum + line.qtyReturning,
    0,
  );
  const estimatedRefund = selectedLines.reduce(
    (sum, line) => sum + line.qtyReturning * line.unitPrice,
    0,
  );

  return (
    <div className="fixed inset-0 z-[72]">
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />

      <div className="absolute left-1/2 top-1/2 flex max-h-[92vh] w-[1080px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF]">
        <div className="flex flex-col gap-4 border-b border-[#CFCFD3] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
              Return request
            </div>
            <div className="mt-1 truncate text-[20px] font-extrabold text-[#000000]">
              {invoice.invoiceNo}
            </div>
            <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
              {invoice.customerName} | Paid {formatNpr(invoice.paidAmount)}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6]"
            aria-label="Close return request"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF]">
              <div className="flex items-center justify-between border-b border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3">
                <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                  Items
                </div>
                <div className="text-[12px] font-bold text-[#8C8889]">
                  {returnUnits} unit(s)
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[620px]">
                  <div className="grid grid-cols-[minmax(190px,1fr)_76px_126px_112px] gap-2 border-b border-[#E5E7EB] px-3 py-2 text-[11px] font-extrabold uppercase text-[#8C8889]">
                    <div>Item</div>
                    <div className="text-center">Sold</div>
                    <div className="text-center">Return</div>
                    <div className="text-right">Refund</div>
                  </div>

                  <div className="divide-y divide-[#E5E7EB]">
                    {lines.map((line) => (
                      <div
                        key={line.invoiceItemId}
                        className="grid grid-cols-[minmax(190px,1fr)_76px_126px_112px] items-center gap-2 px-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-extrabold text-[#000000]">
                            {line.name}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-semibold text-[#8C8889]">
                            {line.sku ? <span>SKU: {line.sku}</span> : null}
                            <span>{formatNpr(line.unitPrice)} / unit</span>
                          </div>
                        </div>

                        <div className="text-center font-mono text-[13px] font-extrabold text-[#000000]">
                          {line.qtyPurchased}
                        </div>

                        <div className="mx-auto flex h-[36px] w-[118px] items-center justify-between rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] p-1">
                          <button
                            type="button"
                            onClick={() =>
                              onChangeQty(
                                line.invoiceItemId,
                                line.qtyReturning - 1,
                              )
                            }
                            disabled={line.qtyReturning <= 0}
                            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#FFFFFF] disabled:opacity-40"
                            aria-label={`Decrease ${line.name} return quantity`}
                            title="Decrease quantity"
                          >
                            <Icon name="remove" className="text-[16px]" />
                          </button>
                          <input
                            type="number"
                            min={0}
                            max={line.qtyPurchased}
                            value={line.qtyReturning}
                            aria-label={`Return quantity for ${line.name}`}
                            onChange={(event) =>
                              onChangeQty(
                                line.invoiceItemId,
                                Number(event.target.value || 0),
                              )
                            }
                            className="h-[26px] w-[46px] min-w-0 bg-transparent text-center text-[13px] font-extrabold outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              onChangeQty(
                                line.invoiceItemId,
                                line.qtyReturning + 1,
                              )
                            }
                            disabled={line.qtyReturning >= line.qtyPurchased}
                            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#FFFFFF] disabled:opacity-40"
                            aria-label={`Increase ${line.name} return quantity`}
                            title="Increase quantity"
                          >
                            <Icon name="add" className="text-[16px]" />
                          </button>
                        </div>

                        <div className="text-right font-mono text-[13px] font-extrabold text-[#000000]">
                          {formatNpr(line.qtyReturning * line.unitPrice)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
                <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                  Reason
                </div>
                <div className="mt-3 grid gap-2">
                  {RETURN_REASON_OPTIONS.map((option) => {
                    const active = option.code === reason;
                    return (
                      <button
                        key={option.code}
                        type="button"
                        onClick={() => onChangeReason(option.code)}
                        className={cn(
                          "rounded-[12px] border px-3 py-2 text-left transition",
                          active
                            ? "border-[#11120d] bg-[#11120d] text-[#FFFFFF]"
                            : "border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] hover:bg-[#F3F4F6]",
                        )}
                      >
                        <div className="text-[12px] font-extrabold">
                          {option.label}
                        </div>
                        <div
                          className={cn(
                            "mt-0.5 text-[11px] font-semibold",
                            active ? "text-[#E5E7EB]" : "text-[#8C8889]",
                          )}
                        >
                          {option.helper}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
                <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                  Refund method
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(["CASH", "ESEWA"] as const).map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => onChangeRefundMethod(method)}
                      className={cn(
                        "h-[40px] rounded-[12px] border text-[12px] font-extrabold transition",
                        refundMethod === method
                          ? "border-[#11120d] bg-[#11120d] text-[#FFFFFF]"
                          : "border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] hover:bg-[#F3F4F6]",
                      )}
                    >
                      {method === "CASH" ? "Cash" : "eSewa"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
                <label className="block text-[12px] font-extrabold uppercase text-[#565449]">
                  Note
                </label>
                <textarea
                  value={note}
                  onChange={(event) => onChangeNote(event.target.value)}
                  placeholder="Condition, customer comment, exchange details..."
                  rows={4}
                  className="mt-2 w-full resize-none rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-4 py-3 text-[13px] font-semibold text-[#000000] outline-none transition focus:border-[#000000]"
                />
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6] p-4">
                <div className="text-[12px] font-extrabold uppercase text-[#565449]">
                  Summary
                </div>
                <div className="mt-4 space-y-3 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Items</span>
                    <span className="font-extrabold text-[#000000]">
                      {selectedLines.length} line(s)
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Units</span>
                    <span className="font-extrabold text-[#000000]">
                      {returnUnits}
                    </span>
                  </div>
                  <div className="border-t border-dashed border-[#CFCFD3]" />
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Refund est.</span>
                    <span className="font-mono font-extrabold text-[#000000]">
                      {formatNpr(estimatedRefund)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#8C8889]">Reason</span>
                    <span className="text-right font-extrabold text-[#000000]">
                      {getReturnReasonLabel(reason)}
                    </span>
                  </div>
                </div>
              </div>

              {error ? (
                <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[12px] font-semibold text-[#BE123C]">
                  {error}
                </div>
              ) : null}
            </aside>
          </div>
        </div>

        <div className="border-t border-[#CFCFD3] bg-[#FFFFFF] px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-3 text-[12px] font-bold text-[#8C8889]">
              <span>{selectedLines.length} line(s)</span>
              <span>{returnUnits} unit(s)</span>
              <span>{formatNpr(estimatedRefund)} estimated</span>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="h-[42px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-4 text-[13px] font-extrabold text-[#000000] transition hover:bg-[#F3F4F6] disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={busy || selectedLines.length === 0}
                className="h-[42px] rounded-[14px] border-2 border-[#11120d] bg-[#11120d] px-4 text-[13px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-50"
              >
                {busy ? "Submitting..." : "Submit Return"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReturnReviewModal({
  open,
  status,
  requests,
  loading,
  busyId,
  error,
  onClose,
  onRefresh,
  onChangeStatus,
  onApprove,
  onReject,
  onReverse,
}: {
  open: boolean;
  status: ReturnStatusCode;
  requests: AppReturnRequest[];
  loading: boolean;
  busyId: string | null;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onChangeStatus: (status: ReturnStatusCode) => void;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onReverse: (requestId: string) => void;
}) {
  if (!open) return null;

  const statusTabs: ReturnStatusCode[] = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "REVERSED",
  ];

  return (
    <div className="fixed inset-0 z-[71]">
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />

      <div className="absolute left-1/2 top-1/2 flex max-h-[92vh] w-[960px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF]">
        <div className="flex flex-col gap-4 border-b border-[#CFCFD3] p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
              Return review
            </div>
            <div className="mt-1 text-[20px] font-extrabold text-[#000000]">
              {getReturnStatusLabel(status)} requests
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] p-1">
              {statusTabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onChangeStatus(tab)}
                  disabled={loading && status === tab}
                  className={cn(
                    "h-[30px] rounded-[9px] px-3 text-[11px] font-extrabold transition",
                    status === tab
                      ? "bg-[#11120d] text-[#FFFFFF]"
                      : "text-[#565449] hover:bg-[#FFFFFF]",
                  )}
                >
                  {getReturnStatusLabel(tab)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="flex h-[38px] items-center justify-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[12px] font-extrabold text-[#000000] transition hover:bg-[#F3F4F6] disabled:opacity-50"
            >
              <Icon name="refresh" className="text-[16px]" />
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] transition hover:bg-[#F3F4F6]"
              aria-label="Close return review"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error ? (
            <div className="mb-4 rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[12px] font-semibold text-[#BE123C]">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] font-semibold text-[#8C8889]">
              Loading return requests...
            </div>
          ) : requests.length === 0 ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] font-semibold text-[#8C8889]">
              No {getReturnStatusLabel(status).toLowerCase()} return requests.
            </div>
          ) : (
            <div className="space-y-4">
              {requests.map((request) => (
                <div
                  key={request.id}
                  className="overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF]"
                >
                  <div className="grid gap-4 border-b border-[#E5E7EB] bg-[#F3F4F6] px-4 py-3 lg:grid-cols-[minmax(0,1fr)_170px_180px] lg:items-center">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-extrabold text-[#000000]">
                        {request.invoiceNo} | {request.customerName}
                      </div>
                      <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                        {getReturnReasonLabel(request.reason)} | Requested by{" "}
                        {request.createdByName}
                      </div>
                    </div>
                    <div className="font-mono text-[14px] font-extrabold text-[#000000] lg:text-right">
                      {formatNpr(request.refundAmount)}
                    </div>
                    <div className="flex items-center gap-2 lg:justify-end">
                      <span
                        className={cn(
                          "inline-flex h-[30px] items-center rounded-[999px] border px-3 text-[11px] font-extrabold uppercase",
                          getReturnStatusClass(request.status),
                        )}
                      >
                        {getReturnStatusLabel(request.status)}
                      </span>
                      {request.status === "PENDING" ? (
                        <>
                          <button
                            type="button"
                            disabled={busyId === request.id}
                            onClick={() => onReject(request.id)}
                            className="h-[36px] rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={busyId === request.id}
                            onClick={() => onApprove(request.id)}
                            className="h-[36px] rounded-[12px] border border-[#11120d] bg-[#11120d] px-3 text-[12px] font-extrabold text-[#FFFFFF] transition hover:bg-[#2a2c27] disabled:opacity-50"
                          >
                            Approve
                          </button>
                        </>
                      ) : null}
                      {request.status === "APPROVED" ? (
                        <button
                          type="button"
                          disabled={busyId === request.id}
                          onClick={() => onReverse(request.id)}
                          className="h-[36px] rounded-[12px] border border-[#FECDD3] bg-[#FFF1F2] px-3 text-[12px] font-extrabold text-[#BE123C] transition hover:bg-rose-100 disabled:opacity-50"
                        >
                          Reverse
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                    <div className="divide-y divide-[#E5E7EB] overflow-hidden rounded-[12px] border border-[#E5E7EB]">
                      {request.items.map((item) => (
                        <div
                          key={item.id}
                          className="grid grid-cols-[minmax(0,1fr)_70px_110px] items-center gap-3 px-3 py-2 text-[12px]"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-extrabold text-[#000000]">
                              {item.name}
                            </div>
                            <div className="mt-0.5 text-[11px] font-semibold text-[#8C8889]">
                              {item.sku || "No SKU"}
                            </div>
                          </div>
                          <div className="font-mono font-extrabold text-[#000000]">
                            x{item.qtyReturned}
                          </div>
                          <div className="text-right font-mono font-extrabold text-[#000000]">
                            {formatNpr(item.lineTotal)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2 text-[12px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-[#8C8889]">Method</span>
                        <span className="font-extrabold text-[#000000]">
                          {request.refundMethod === "ESEWA" ? "eSewa" : "Cash"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-[#8C8889]">Cashier</span>
                        <span className="text-right font-extrabold text-[#000000]">
                          {request.cashierName}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-[#8C8889]">Date</span>
                        <span className="text-right font-extrabold text-[#000000]">
                          {new Date(request.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {request.reviewedAt || request.reviewedByName ? (
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-bold text-[#8C8889]">
                            Reviewed
                          </span>
                          <span className="text-right font-extrabold text-[#000000]">
                            {request.reviewedByName || "Admin"}
                            {request.reviewedAt
                              ? ` | ${new Date(request.reviewedAt).toLocaleString()}`
                              : ""}
                          </span>
                        </div>
                      ) : null}
                      {request.note ? (
                        <div className="rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6] p-3 font-semibold text-[#565449]">
                          {request.note}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// this modal handles invoice follow-up actions like adding payments, marking fully paid, and cancelling
function InvoiceEditModal({
  invoice,
  paymentMethod,
  paymentAmount,
  paymentError,
  busy,
  onChangePaymentMethod,
  onChangePaymentAmount,
  onClose,
  onAddPayment,
  onMarkPaid,
  onCancelInvoice,
  onModifyInvoice,
}: {
  invoice: AppInvoice | null;
  paymentMethod: InvoiceEditPaymentMethod;
  paymentAmount: string;
  paymentError: string;
  busy: boolean;
  onChangePaymentMethod: (value: InvoiceEditPaymentMethod) => void;
  onChangePaymentAmount: (value: string) => void;
  onClose: () => void;
  onAddPayment: () => void;
  onMarkPaid: () => void;
  onCancelInvoice: () => void;
  onModifyInvoice: () => void;
}) {
  if (!invoice) return null;

  const paymentLocked =
    invoice.status === "Paid" || invoice.status === "Cancelled";
  const canSettle = !paymentLocked && invoice.dueAmount > 0; // only unpaid or partial invoices with due left can be updated

  return (
    <div className="fixed inset-0 z-[65]">
      <button
        type="button"
        className="absolute inset-0 bg-[#000000]/40 backdrop-blur-sm transition-all"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute left-1/2 top-1/2 w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border-2 border-[#CFCFD3] bg-[#FFFFFF]  overflow-hidden">
        <div className="p-5 border-b border-[#CFCFD3] flex items-center justify-between">
          <div>
            <div className="text-[12px] font-extrabold text-[#8C8889] uppercase ">
              Edit invoice
            </div>
            <div className="text-[18px] font-extrabold text-[#000000] mt-1">
              {invoice.invoiceNo}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-[38px] h-[38px] rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] flex items-center justify-center text-[#000000] transition"
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <div className="block text-[12px] font-extrabold text-[#8C8889] uppercase  mb-2">
              Payment method
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(["Cash", "eSewa"] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => onChangePaymentMethod(method)}
                  className={cn(
                    "h-[44px] rounded-[14px] border-2 font-extrabold transition",
                    paymentMethod === method
                      ? method === "Cash"
                        ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                        : "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
                      : "bg-[#FFFFFF] text-[#000000] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                  )}
                >
                  {method === "Cash" ? "Cash" : "eSewa"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Customer</div>
              <div className="text-[#000000] font-extrabold mt-1">
                {invoice.customerName}
              </div>
              <div className="text-[12px] text-[#8C8889] mt-1">
                {invoice.customerSubtitle}
              </div>
            </div>

            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Status</div>
              <div className="mt-2">
                <InvoiceStatusChip status={invoice.status} />
              </div>
            </div>

            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Total</div>
              <div className="font-mono font-extrabold text-[#000000] mt-1">
                {formatNpr(invoice.netTotal)}
              </div>
            </div>

            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/20 p-3">
              <div className="text-[#8C8889] font-bold">Paid / Due</div>
              <div className="font-mono font-extrabold text-[#000000] mt-1">
                {formatNpr(invoice.paidAmount)} / {formatNpr(invoice.dueAmount)}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-extrabold text-[#8C8889] uppercase  mb-2">
              Add payment amount
            </label>
            <input
              value={paymentAmount}
              onChange={(e) =>
                onChangePaymentAmount(e.target.value.replace(/[^\d.]/g, ""))
              }
              placeholder="e.g. 500"
              className={cn(
                "w-full rounded-[14px] border-2 bg-[#FFFFFF] px-4 py-3 text-[14px] font-semibold text-[#000000] outline-none transition",
                paymentError
                  ? "border-rose-500"
                  : "border-[#CFCFD3] focus:border-[#000000]",
              )}
            />
            {paymentError ? (
              <div className="mt-2 text-[12px] font-extrabold text-rose-600">
                {paymentError}
              </div>
            ) : (
              <div className="mt-2 text-[12px] text-[#8C8889]">
                Enter an amount greater than 0 and not more than the remaining
                due.
              </div>
            )}
          </div>

          {paymentMethod === "eSewa" && canSettle ? (
            <div className="rounded-[14px] border border-[#9DD8B2] bg-[#EAF8EF] px-4 py-3 text-[12px] text-[#179B4D]">
              This will redirect to the eSewa test page for the exact amount
              entered here.
            </div>
          ) : null}

          {paymentLocked ? (
            <div className="rounded-[14px] border border-[#CFCFD3] bg-[#CFCFD3]/40 px-4 py-3 text-[13px] text-[#000000] font-semibold">
              {invoice.status === "Paid"
                ? "This invoice is already fully paid."
                : "This invoice has been cancelled and can no longer be updated."}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={onAddPayment}
              disabled={busy || !canSettle}
              className="h-[46px] rounded-[14px] bg-[#000000] text-[#FFFFFF] font-extrabold hover:bg-[#8C8889] disabled:opacity-50 disabled:pointer-events-none transition"
            >
              {busy
                ? "Saving..."
                : paymentMethod === "eSewa"
                  ? "Continue to eSewa"
                  : "Add Payment"}
            </button>

            <button
              type="button"
              onClick={onMarkPaid}
              disabled={busy || !canSettle}
              className="h-[46px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] font-extrabold hover:bg-[#CFCFD3] disabled:opacity-50 disabled:pointer-events-none transition"
            >
              Mark Fully Paid (Cash)
            </button>

            <button
              type="button"
              onClick={onModifyInvoice}
              disabled={busy || invoice.status === "Cancelled"}
              className="h-[46px] rounded-[14px] border-2 border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F] font-extrabold hover:bg-amber-100 disabled:opacity-50 disabled:pointer-events-none transition"
            >
              Modify with Credit Note
            </button>

            <button
              type="button"
              onClick={onCancelInvoice}
              disabled={busy || invoice.status === "Cancelled"}
              className="h-[46px] rounded-[14px] border-2 border-rose-200 bg-rose-50 text-rose-700 font-extrabold hover:bg-rose-100 disabled:opacity-50 disabled:pointer-events-none transition"
            >
              Cancel Invoice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// this is the main invoices page
// here, cashiers and admins can view their generated invoices, search them, and open them to see details or add payments
export default function CashierInvoicesPage() {
  const { showToast } = useToast();
  const authUser = getAuthUser();
  const isAdminView = authUser?.role === "admin";
  const [activeTab, setActiveTab] = useState<"All" | InvoiceStatusLabel>("All"); // active status tab at the top of the page
  const [query, setQuery] = useState(""); // invoice search text
  const [isFilterOpen, setFilterOpen] = useState(false); // mobile/tablet filter drawer toggle
  const [onlyMine, setOnlyMine] = useState(false); // optional filter to show only invoices created by the logged-in cashier
  const [cashierFilter, setCashierFilter] = useState("All"); // admin-facing cashier selector for narrowing invoices to one cashier
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<InvoiceCustomerTypeFilter>("All"); // lets the page combine cashier and walk-in/registered filters together
  const [methodFilter, setMethodFilter] = useState<"All" | PaymentMethodLabel>(
    "All",
  );
  const [invoices, setInvoices] = useState<AppInvoice[]>([]); // full normalized invoice list before tab and page slicing
  const [loading, setLoading] = useState(true); // first-load state for the page
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    null,
  );
  const [detailInvoice, setDetailInvoice] = useState<AppInvoice | null>(null); // invoice shown in the read-only detail modal
  const [editInvoice, setEditInvoice] = useState<AppInvoice | null>(null); // invoice currently being edited in the payment modal
  const [modifyInvoice, setModifyInvoice] = useState<AppInvoice | null>(null);
  const [modifyLines, setModifyLines] = useState<ModifyInvoiceLine[]>([]);
  const [modifyReason, setModifyReason] = useState("");
  const [modifyError, setModifyError] = useState("");
  const [editPaymentMethod, setEditPaymentMethod] =
    useState<InvoiceEditPaymentMethod>("Cash");
  const [paymentAmount, setPaymentAmount] = useState(""); // amount typed into the edit modal
  const [paymentError, setPaymentError] = useState(""); // edit modal validation or API error
  const [savingEdit, setSavingEdit] = useState(false); // blocks repeated edit actions while an invoice update is running
  const [savingModify, setSavingModify] = useState(false);
  const [pendingInvoiceAction, setPendingInvoiceAction] =
    useState<PendingInvoiceAction>(null); // stores the next payment or cancellation action waiting for confirmation
  const [showModifyConfirm, setShowModifyConfirm] = useState(false); // confirms credit-note replacement before saving it
  const [pendingVoidPaymentId, setPendingVoidPaymentId] = useState<string | null>(
    null,
  ); // stores the successful payment waiting for admin void confirmation
  const [voidPaymentPin, setVoidPaymentPin] = useState("");
  const [voidPaymentPinError, setVoidPaymentPinError] = useState("");
  const [canCashierVoidPayment, setCanCashierVoidPayment] = useState(false);
  const [voidingPaymentId, setVoidingPaymentId] = useState<string | null>(null); // tracks which payment is being voided to show loading state
  const [returnInvoice, setReturnInvoice] = useState<AppInvoice | null>(null);
  const [returnLines, setReturnLines] = useState<ReturnLineState[]>([]);
  const [returnReason, setReturnReason] =
    useState<ReturnReasonCode>("CUSTOMER_REQUEST");
  const [returnNote, setReturnNote] = useState("");
  const [returnRefundMethod, setReturnRefundMethod] =
    useState<ReturnRefundMethod>("CASH");
  const [returnError, setReturnError] = useState("");
  const [savingReturn, setSavingReturn] = useState(false);
  const [returnRequests, setReturnRequests] = useState<AppReturnRequest[]>([]);
  const [returnRequestsLoading, setReturnRequestsLoading] = useState(false);
  const [returnRequestsError, setReturnRequestsError] = useState("");
  const [showReturnReview, setShowReturnReview] = useState(false);
  const [returnReviewStatus, setReturnReviewStatus] =
    useState<ReturnStatusCode>("PENDING");
  const [pendingReturnReviewAction, setPendingReturnReviewAction] =
    useState<PendingReturnReviewAction>(null);
  const [returnReviewBusyId, setReturnReviewBusyId] = useState<string | null>(
    null,
  );
  const [adminParkedDrafts, setAdminParkedDrafts] = useState<AdminParkedDraft[]>(
    [],
  );
  const [adminCashiers, setAdminCashiers] = useState<AdminCashierOption[]>([]);
  const [adminParkedLoading, setAdminParkedLoading] = useState(false);
  const [adminParkedBusyId, setAdminParkedBusyId] = useState<string | null>(null);
  const [pendingParkedTransfer, setPendingParkedTransfer] =
    useState<PendingParkedTransfer>(null);

  // fetching a larger invoice list here lets the page search and filter on the client without constant reloads
  async function loadInvoices() {
    setInvoices(await fetchAllInvoices());
  }

  async function loadAdminParkedDrafts() {
    if (!isAdminView) return;
    setAdminParkedLoading(true);
    try {
      const data = await listParkedDraftsApi();
      setAdminParkedDrafts(
        Array.isArray(data?.drafts) ? data.drafts : [],
      );
    } catch {
      setAdminParkedDrafts([]);
    } finally {
      setAdminParkedLoading(false);
    }
  }

  async function loadAdminCashiers() {
    if (!isAdminView) return;
    const users = await listUsersApi({ role: "CASHIER" });
    const raw = Array.isArray(users) ? users : [];
    setAdminCashiers(
      raw
        .filter((user: any) => user?.isActive !== false)
        .map((user: any) => ({
          id: String(user.id),
          name: String(user.name || user.email || "Cashier"),
          isActive: user.isActive !== false,
        })),
    );
  }

  async function loadCashierPrivileges() {
    if (isAdminView) return;
    try {
      const data = await getMyCashierPrivilegesApi();
      setCanCashierVoidPayment(Boolean(data?.privilege?.canVoidPayment));
    } catch {
      setCanCashierVoidPayment(false);
    }
  }

  // this fetches one full invoice record before showing detailed data in either modal
  async function hydrateInvoice(id: string) {
    const data = await getInvoiceApi(id);
    return normalizeInvoice(data);
  }

  async function loadReturnRequests(status: ReturnStatusCode = "PENDING") {
    if (!isAdminView) return;
    setReturnReviewStatus(status);
    setReturnRequestsLoading(true);
    setReturnRequestsError("");

    try {
      const data = await listReturnRequestsApi({ status });
      const raw = Array.isArray(data?.requests) ? data.requests : [];
      setReturnRequests(raw.map(normalizeReturnRequest));
    } catch (err: any) {
      setReturnRequestsError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to load return requests.",
      );
    } finally {
      setReturnRequestsLoading(false);
    }
  }

  async function discardAdminParkedDraft(draftId: string) {
    if (adminParkedBusyId) return;
    setAdminParkedBusyId(draftId);
    try {
      await discardParkedDraftApi(draftId);
      await loadAdminParkedDrafts();
      showToast("success", "Held bill discarded.");
    } catch (err: any) {
      showToast(
        "danger",
        err?.response?.data?.error || err?.message || "Failed to discard held bill.",
      );
    } finally {
      setAdminParkedBusyId(null);
    }
  }

  async function confirmAdminParkedTransfer() {
    if (!pendingParkedTransfer || adminParkedBusyId) return;
    const { draft, cashier } = pendingParkedTransfer;
    setAdminParkedBusyId(draft.id);
    try {
      await transferParkedDraftApi(draft.id, cashier.id);
      await loadAdminParkedDrafts();
      setPendingParkedTransfer(null);
      showToast("success", "Held bill transferred.");
    } catch (err: any) {
      showToast(
        "danger",
        err?.response?.data?.error ||
          err?.message ||
          "Failed to transfer held bill.",
      );
    } finally {
      setAdminParkedBusyId(null);
    }
  }

  function requestAdminParkedTransfer(draft: AdminParkedDraft, cashierId: string) {
    if (!cashierId || cashierId === draft.cashier?.id) return;
    const cashier = adminCashiers.find((item) => item.id === cashierId);
    if (!cashier) return;
    setPendingParkedTransfer({ draft, cashier });
  }

  useEffect(() => {
    // loading the invoice list once when the page first opens
    async function load() {
      try {
        await loadInvoices();
        if (isAdminView) {
          await loadAdminCashiers();
          await loadReturnRequests();
          await loadAdminParkedDrafts();
        } else {
          await loadCashierPrivileges();
        }
      } catch {
        // this handles when the invoice list request fails, so we fall back to an empty state instead of stale data
        setInvoices([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // locks body scroll when any modal is open to prevent background scrolling
  useEffect(() => {
    if (
      detailInvoice ||
      editInvoice ||
      modifyInvoice ||
      returnInvoice ||
      showReturnReview
    ) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [detailInvoice, editInvoice, modifyInvoice, returnInvoice, showReturnReview]);

  // deriving the cashier dropdown from the loaded invoice data keeps the filter in sync without extra API calls
  const cashierOptions = useMemo(() => {
    const options = new Map<string, string>();

    invoices.forEach((invoice) => {
      if (!invoice.cashierId) return;
      if (!options.has(invoice.cashierId)) {
        options.set(invoice.cashierId, invoice.cashierName);
      }
    });

    return Array.from(options.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [invoices]);

  // computing the list of invoices after applying the search query and filters
  // we wrap this in useMemo so it only recalculates when the query or invoices change
  const scopedInvoices = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();

    return invoices
      .filter((invoice) =>
        isAdminView
          ? cashierFilter === "All"
            ? true
            : invoice.cashierId === cashierFilter
          : true,
      )
      .filter((invoice) =>
        !isAdminView && onlyMine && authUser?.id
          ? invoice.cashierId === authUser.id
          : true,
      )
      .filter((invoice) =>
        customerTypeFilter === "All"
          ? true
          : getInvoiceCustomerType(invoice) === customerTypeFilter,
      )
      .filter((invoice) =>
        methodFilter === "All" ? true : invoice.paymentMethod === methodFilter,
      )
      .filter((invoice) => {
        if (!loweredQuery) return true;

        return [
          invoice.invoiceNo,
          invoice.customerName,
          invoice.cashierName,
          invoice.itemSummary,
        ]
          .join(" ")
          .toLowerCase()
          .includes(loweredQuery);
      });
  }, [
    authUser?.id,
    cashierFilter,
    customerTypeFilter,
    invoices,
    isAdminView,
    methodFilter,
    onlyMine,
    query,
  ]);

  const filtered = useMemo(() => {
    return scopedInvoices.filter((invoice) =>
      activeTab === "All" ? true : invoice.status === activeTab,
    );
  }, [activeTab, scopedInvoices]);

  const summary = useMemo(() => calcSummary(scopedInvoices), [scopedInvoices]); // summary cards always reflect the current search and filter scope

  const [pageSize, setPageSize] = useState(20);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const pageClamped = clampPage(page, 1, totalPages);
  const hasExtraFilters = isAdminView
    ? cashierFilter !== "All" ||
      customerTypeFilter !== "All" ||
      methodFilter !== "All"
    : onlyMine || customerTypeFilter !== "All" || methodFilter !== "All";

  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped, pageSize]);
  const pageStart = filtered.length === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = filtered.length === 0 ? 0 : pageStart + pageItems.length;

  // clearing the secondary filters lets the user get back to the full invoice list quickly without disturbing search or tabs
  function clearExtraFilters() {
    setOnlyMine(false);
    setCashierFilter("All");
    setCustomerTypeFilter("All");
    setMethodFilter("All");
    setPage(1);
  }

  // fetching the full invoice details when the user clicks to view it
  async function openInvoice(id: string) {
    // we show the cached preview version first so the modal opens instantly
    const cached = invoices.find((invoice) => invoice.id === id) || null;
    setSelectedInvoiceId(id);
    setDetailInvoice(cached);

    // then we fetch the detailed version from the backend inside a try block
    try {
      const detailed = await hydrateInvoice(id);
      setDetailInvoice(detailed);
    } catch {
      setDetailInvoice(cached);
    }
  }

  function closeInvoice() {
    setSelectedInvoiceId(null);
    setDetailInvoice(null);
    setPendingVoidPaymentId(null);
  }

  // this opens the edit modal with the invoice's due amount prefilled so cashiers can settle it faster
  function openEditInvoice(invoice: AppInvoice) {
    setEditInvoice(invoice);
    setEditPaymentMethod("Cash");
    setPaymentAmount(invoice.dueAmount > 0 ? String(invoice.dueAmount) : "");
    setPaymentError("");
  }

  function openModifyInvoice(invoice: AppInvoice) {
    if (invoice.status === "Cancelled") {
      setPaymentError("Cancelled invoices cannot be modified.");
      return;
    }

    setModifyInvoice(invoice);
    setModifyLines(
      invoice.items
        .filter((item) => item.productId)
        .map((item) => ({
          productId: String(item.productId),
          name: item.name,
          sku: item.sku,
          barcode: item.barcode,
          qty: Math.max(1, item.qty),
          unitPrice: item.unitPrice,
        })),
    );
    setModifyReason("");
    setModifyError("");
  }

  // adding a new product from the search into the replacement items list
  // if the product is already in the list, we bump its quantity by 1 instead of duplicating
  function addModifyLine(product: ModifyProductResult) {
    setModifyError("");
    setModifyLines((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (existing) {
        return current.map((line) =>
          line.productId === product.id
            ? { ...line, qty: line.qty + 1 }
            : line,
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          qty: 1,
          unitPrice: product.retailPrice,
        },
      ];
    });
  }

  function closeModifyInvoice() {
    setModifyInvoice(null);
    setModifyLines([]);
    setModifyReason("");
    setModifyError("");
    setShowModifyConfirm(false);
  }

  function canRequestReturn(invoice: AppInvoice) {
    return (
      invoice.status !== "Cancelled" &&
      invoice.paidAmount > 0 &&
      invoice.items.some((item) => item.id && item.qty > 0)
    );
  }

  function openReturnRequest(invoice: AppInvoice) {
    if (!canRequestReturn(invoice)) {
      setReturnError("Only paid, non-cancelled invoices with items can be returned.");
      return;
    }

    setReturnInvoice(invoice);
    setReturnLines(
      invoice.items.map((item) => ({
        invoiceItemId: item.id,
        productId: item.productId,
        name: item.name,
        sku: item.sku,
        qtyPurchased: Math.max(0, item.qty),
        qtyReturning: 0,
        unitPrice: item.unitPrice,
      })),
    );
    setReturnReason("CUSTOMER_REQUEST");
    setReturnRefundMethod(invoice.paymentMethod === "eSewa" ? "ESEWA" : "CASH");
    setReturnNote("");
    setReturnError("");
  }

  function closeReturnRequest() {
    setReturnInvoice(null);
    setReturnLines([]);
    setReturnReason("CUSTOMER_REQUEST");
    setReturnRefundMethod("CASH");
    setReturnNote("");
    setReturnError("");
  }

  function changeReturnQty(invoiceItemId: string, qty: number) {
    setReturnError("");
    setReturnLines((current) =>
      current.map((line) => {
        if (line.invoiceItemId !== invoiceItemId) return line;
        const nextQty = Math.floor(Number(qty) || 0);
        return {
          ...line,
          qtyReturning: Math.min(
            line.qtyPurchased,
            Math.max(0, nextQty),
          ),
        };
      }),
    );
  }

  async function submitReturnRequest() {
    if (!returnInvoice || savingReturn) return;

    const selectedItems = returnLines
      .filter((line) => line.qtyReturning > 0)
      .map((line) => ({
        invoiceItemId: line.invoiceItemId,
        qty: line.qtyReturning,
      }));

    if (selectedItems.length === 0) {
      setReturnError("Select at least one item quantity to return.");
      return;
    }

    setSavingReturn(true);
    setReturnError("");

    try {
      await createReturnRequestApi({
        invoiceId: returnInvoice.id,
        reason: returnReason,
        note: returnNote.trim() || undefined,
        refundMethod: returnRefundMethod,
        items: selectedItems,
      });

      showToast("success", `Return request submitted for ${returnInvoice.invoiceNo}.`);
      closeReturnRequest();
      if (isAdminView) {
        await loadReturnRequests(returnReviewStatus);
      }
    } catch (err: any) {
      setReturnError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to submit return request.",
      );
    } finally {
      setSavingReturn(false);
    }
  }

  function openReturnReview() {
    setReturnReviewStatus("PENDING");
    setShowReturnReview(true);
    void loadReturnRequests("PENDING");
  }

  function closeReturnReview() {
    setShowReturnReview(false);
    setPendingReturnReviewAction(null);
  }

  function requestApproveReturn(requestId: string) {
    setPendingReturnReviewAction({ kind: "approve", requestId });
  }

  function requestRejectReturn(requestId: string) {
    setPendingReturnReviewAction({ kind: "reject", requestId });
  }

  function requestReverseReturn(requestId: string) {
    setPendingReturnReviewAction({ kind: "reverse", requestId });
  }

  async function confirmReturnReviewAction() {
    if (!pendingReturnReviewAction || returnReviewBusyId) return;

    const action = pendingReturnReviewAction;
    setReturnReviewBusyId(action.requestId);
    setPendingReturnReviewAction(null);
    setReturnRequestsError("");

    try {
      if (action.kind === "approve") {
        await approveReturnRequestApi(action.requestId);
      } else if (action.kind === "reverse") {
        await reverseReturnRequestApi(action.requestId);
      } else {
        await rejectReturnRequestApi(action.requestId);
      }

      await loadReturnRequests(returnReviewStatus);
      showToast(
        "success",
        action.kind === "approve"
          ? "Return approved and stock restored."
          : action.kind === "reverse"
            ? "Return reversal recorded and stock corrected."
            : "Return request rejected.",
      );
    } catch (err: any) {
      setReturnRequestsError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to review return request.",
      );
    } finally {
      setReturnReviewBusyId(null);
    }
  }

  function changeModifyQty(productId: string, qty: number) {
    setModifyError("");
    setModifyLines((current) =>
      current.map((line) =>
        line.productId === productId
          ? { ...line, qty: Math.max(1, Math.floor(Number(qty) || 1)) }
          : line,
      ),
    );
  }

  function removeModifyLine(productId: string) {
    setModifyError("");
    setModifyLines((current) =>
      current.filter((line) => line.productId !== productId),
    );
  }

  function requestSubmitModifyInvoice() {
    if (!modifyInvoice || savingModify) return;
    if (modifyLines.length === 0) {
      setModifyError("Replacement invoice needs at least one item.");
      return;
    }

    setModifyError("");
    setShowModifyConfirm(true);
  }

  async function submitModifyInvoice() {
    if (!modifyInvoice || savingModify) return;
    if (modifyLines.length === 0) {
      setModifyError("Replacement invoice needs at least one item.");
      setShowModifyConfirm(false);
      return;
    }

    setShowModifyConfirm(false);
    setSavingModify(true);
    setModifyError("");

    try {
      const result = await modifyFinalizedInvoiceApi(modifyInvoice.id, {
        customerId: modifyInvoice.customerId || null,
        reason: modifyReason.trim() || "Invoice modified",
        items: modifyLines.map((line) => ({
          productId: line.productId,
          qty: line.qty,
        })),
      });

      await loadInvoices();
      const replacementId = result?.replacementInvoice?.id;
      if (replacementId) {
        const replacement = await hydrateInvoice(replacementId);
        setDetailInvoice(replacement);
        setSelectedInvoiceId(replacementId);
      }
      closeModifyInvoice();
      closeEditInvoice();
    } catch (err: any) {
      setModifyError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to modify invoice.",
      );
    } finally {
      setSavingModify(false);
    }
  }

  // clearing the edit state here makes sure each invoice starts with a clean payment form
  function closeEditInvoice() {
    setEditInvoice(null);
    setEditPaymentMethod("Cash");
    setPaymentAmount("");
    setPaymentError("");
    setPendingInvoiceAction(null);
  }

  // voiding a successful payment — admin only
  // after voiding, we refresh both the detail invoice and the invoices list
  async function handleVoidPayment(paymentId: string) {
    if (!detailInvoice || voidingPaymentId) return;
    setVoidPaymentPin("");
    setVoidPaymentPinError("");
    setPendingVoidPaymentId(paymentId);
  }

  async function confirmVoidPayment() {
    if (!detailInvoice || !pendingVoidPaymentId || voidingPaymentId) return;
    const normalizedPin = voidPaymentPin.trim();
    if (!isAdminView && !/^\d{4}$/.test(normalizedPin)) {
      setVoidPaymentPinError("Enter the 4-digit override PIN.");
      return;
    }

    const paymentId = pendingVoidPaymentId;
    setPendingVoidPaymentId(null);
    setVoidingPaymentId(paymentId);
    try {
      await voidPaymentApi(
        detailInvoice.id,
        paymentId,
        isAdminView ? undefined : normalizedPin,
      );
      setVoidPaymentPin("");
      setVoidPaymentPinError("");
      // refresh the detail invoice and the list to reflect the updated payment status
      const refreshed = await hydrateInvoice(detailInvoice.id);
      setDetailInvoice(refreshed);
      await loadInvoices();
    } catch (err: any) {
      setPendingVoidPaymentId(paymentId);
      setVoidPaymentPinError(
        err?.response?.data?.error ||
          err?.message ||
          "Failed to void payment.",
      );
    } finally {
      setVoidingPaymentId(null);
    }
  }

  const pendingVoidPayment = useMemo(() => {
    if (!detailInvoice || !pendingVoidPaymentId) return null;
    return (
      detailInvoice.payments.find((payment) => payment.id === pendingVoidPaymentId) ||
      null
    );
  }, [detailInvoice, pendingVoidPaymentId]);

  const pendingReturnReviewRequest = useMemo(() => {
    if (!pendingReturnReviewAction) return null;
    return (
      returnRequests.find(
        (request) => request.id === pendingReturnReviewAction.requestId,
      ) || null
    );
  }, [pendingReturnReviewAction, returnRequests]);

  // we use this to validate the payment input before submitting
  // making sure they typed a number that is greater than 0 and less than or equal to the due amount
  function validatePaymentAmount(invoice: AppInvoice, overrideAmount?: number) {
    const nextAmount = overrideAmount ?? Number(paymentAmount);

    if (!Number.isFinite(nextAmount)) {
      setPaymentError("Enter a valid payment amount.");
      return null;
    }

    if (nextAmount <= 0) {
      setPaymentError("Payment amount must be greater than 0.");
      return null;
    }

    if (nextAmount > invoice.dueAmount) {
      setPaymentError("Payment amount cannot exceed the remaining due.");
      return null;
    }

    setPaymentError("");
    return nextAmount;
  }

  // reloading both the list and the specific invoice keeps the table and whichever modal is open perfectly in sync
  async function refreshInvoiceState(invoiceId: string) {
    await loadInvoices();
    const updated = await hydrateInvoice(invoiceId);

    setDetailInvoice((current) =>
      current?.id === invoiceId ? updated : current,
    );

    return updated;
  }

  // we validate first, then open a confirmation modal so the cashier can double-check before we save anything
  function handleAddPayment() {
    if (!editInvoice) return;

    const amount = validatePaymentAmount(editInvoice);
    if (amount === null) return;

    setPaymentError("");
    setPendingInvoiceAction(
      editPaymentMethod === "eSewa"
        ? { kind: "esewa-payment", amount }
        : { kind: "cash-payment", amount },
    );
  }

  // marking fully paid is also confirmed first because it immediately records the whole remaining due as cash
  function handleMarkFullyPaid() {
    if (!editInvoice) return;

    const amount = validatePaymentAmount(editInvoice, editInvoice.dueAmount);
    if (amount === null) return;

    setPaymentError("");
    setPendingInvoiceAction({ kind: "mark-paid", amount });
  }

  // invoice cancellation affects stock and payment state, so we always ask for explicit confirmation first
  function handleCancelInvoice() {
    if (!editInvoice) return;
    setPaymentError("");
    setPendingInvoiceAction({ kind: "cancel-invoice" });
  }

  // all confirmed invoice follow-up actions funnel through one executor so success and error handling stay consistent
  async function confirmPendingInvoiceAction() {
    if (!editInvoice || !pendingInvoiceAction) return;

    try {
      setSavingEdit(true);

      // eSewa uses its existing redirect-based flow after confirmation
      if (pendingInvoiceAction.kind === "esewa-payment") {
        const paymentIntent = await initiateEsewaPaymentApi({
          invoiceId: editInvoice.id,
          amount: pendingInvoiceAction.amount,
        });

        setPendingInvoiceAction(null);
        submitEsewaForm(paymentIntent);
        return;
      }

      // cancellations keep their own endpoint because they reverse stock and mark the invoice as cancelled
      if (pendingInvoiceAction.kind === "cancel-invoice") {
        await cancelInvoiceApi(editInvoice.id);
        await refreshInvoiceState(editInvoice.id);
        closeEditInvoice();
        return;
      }

      // both cash actions reuse the same payment endpoint and differ only in which amount was confirmed
      await addPaymentApi(editInvoice.id, {
        method: "CASH",
        amount: pendingInvoiceAction.amount,
        status: "SUCCESS",
      });

      await refreshInvoiceState(editInvoice.id);
      closeEditInvoice();
    } catch (error: any) {
      const fallbackMessage =
        pendingInvoiceAction.kind === "mark-paid"
          ? "Failed to mark invoice as paid."
          : pendingInvoiceAction.kind === "cancel-invoice"
            ? "Failed to cancel invoice."
            : "Failed to update invoice.";

      setPendingInvoiceAction(null);
      setPaymentError(error?.response?.data?.error || fallbackMessage);
    } finally {
      setSavingEdit(false);
    }
  }

  const pendingInvoiceActionConfig = useMemo(() => {
    if (!editInvoice || !pendingInvoiceAction) return null;

    if (pendingInvoiceAction.kind === "cash-payment") {
      return {
        title: "Add this payment?",
        message:
          "This cash payment will be recorded immediately on the selected invoice.",
        confirmLabel: "Add Payment",
        tone: "primary" as const,
        icon: "payments",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.customerName}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Amount to add</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingInvoiceAction.kind === "esewa-payment") {
      return {
        title: "Continue to eSewa?",
        message:
          "KhataSathi will create a pending payment and redirect you to the eSewa payment page.",
        confirmLabel: "Continue to eSewa",
        tone: "primary" as const,
        icon: "payments",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Customer</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.customerName}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>eSewa amount</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    if (pendingInvoiceAction.kind === "mark-paid") {
      return {
        title: "Mark this invoice fully paid?",
        message:
          "The full remaining due will be recorded as a successful cash payment.",
        confirmLabel: "Mark Fully Paid",
        tone: "primary" as const,
        icon: "check_circle",
        details: (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Invoice</span>
              <span className="font-extrabold text-slate-900">
                {editInvoice.invoiceNo}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Remaining due</span>
              <span className="font-extrabold text-slate-900">
                {formatNpr(pendingInvoiceAction.amount)}
              </span>
            </div>
          </div>
        ),
      };
    }

    return {
      title: "Cancel this invoice?",
      message:
        "This will cancel the invoice, restore the sold stock, and keep the payment history for audit review.",
      confirmLabel: "Cancel Invoice",
      tone: "danger" as const,
      icon: "warning",
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Invoice</span>
            <span className="font-extrabold text-slate-900">
              {editInvoice.invoiceNo}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Net total</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(editInvoice.netTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Paid / Due</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(editInvoice.paidAmount)} /{" "}
              {formatNpr(editInvoice.dueAmount)}
            </span>
          </div>
        </div>
      ),
    };
  }, [editInvoice, pendingInvoiceAction]);

  const pendingReturnReviewConfig = useMemo(() => {
    if (!pendingReturnReviewAction || !pendingReturnReviewRequest) return null;

    const isApprove = pendingReturnReviewAction.kind === "approve";
    const isReverse = pendingReturnReviewAction.kind === "reverse";
    const units = pendingReturnReviewRequest.items.reduce(
      (sum, item) => sum + item.qtyReturned,
      0,
    );

    return {
      title: isApprove
        ? "Approve this return?"
        : isReverse
          ? "Reverse this return?"
          : "Reject this return?",
      message: isApprove
        ? "Returned item quantities will be restored to stock and the request will be marked approved."
        : isReverse
          ? "This will remove the previously restored stock and add a refund correction entry to the invoice ledger."
          : "The return request will be closed without changing stock.",
      confirmLabel: isApprove
        ? "Approve Return"
        : isReverse
          ? "Reverse Return"
          : "Reject Return",
      tone: isApprove ? ("primary" as const) : ("danger" as const),
      icon: isApprove
        ? "assignment_turned_in"
        : isReverse
          ? "undo"
          : "block",
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Invoice</span>
            <span className="font-extrabold text-slate-900">
              {pendingReturnReviewRequest.invoiceNo}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Customer</span>
            <span className="font-extrabold text-slate-900">
              {pendingReturnReviewRequest.customerName}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Returned units</span>
            <span className="font-extrabold text-slate-900">{units}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Refund amount</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(pendingReturnReviewRequest.refundAmount)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Reason</span>
            <span className="font-extrabold text-slate-900">
              {getReturnReasonLabel(pendingReturnReviewRequest.reason)}
            </span>
          </div>
        </div>
      ),
    };
  }, [pendingReturnReviewAction, pendingReturnReviewRequest]);

  const modifyConfirmConfig = useMemo(() => {
    if (!showModifyConfirm || !modifyInvoice) return null;

    const replacementTotal = modifyLines.reduce(
      (sum, line) => sum + line.qty * line.unitPrice,
      0,
    );
    const replacementUnits = modifyLines.reduce((sum, line) => sum + line.qty, 0);
    const difference = replacementTotal - modifyInvoice.netTotal;

    return {
      title: "Create credit note?",
      message:
        "This will credit the original invoice and finalize a replacement invoice with the selected items.",
      confirmLabel: "Create Credit Note",
      details: (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>Original invoice</span>
            <span className="font-extrabold text-slate-900">
              {modifyInvoice.invoiceNo}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Customer</span>
            <span className="font-extrabold text-slate-900">
              {modifyInvoice.customerName}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Replacement</span>
            <span className="font-extrabold text-slate-900">
              {modifyLines.length} line(s), {replacementUnits} unit(s)
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Original / replacement</span>
            <span className="font-extrabold text-slate-900">
              {formatNpr(modifyInvoice.netTotal)} / {formatNpr(replacementTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Difference</span>
            <span className="font-extrabold text-slate-900">
              {difference > 0 ? "+" : ""}
              {formatNpr(difference)}
            </span>
          </div>
          <div className="border-t border-[#CFCFD3] pt-2">
            <span className="font-bold text-[#8C8889]">Reason: </span>
            <span className="font-semibold text-slate-900">
              {modifyReason.trim() || "Invoice modified"}
            </span>
          </div>
        </div>
      ),
    };
  }, [modifyInvoice, modifyLines, modifyReason, showModifyConfirm]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-[#8C8889] font-semibold">Loading invoices...</div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* we keep the date line separate from the cards so the page opens with a quick sense of "today" before the heavier data blocks */}
      <div className="text-[13px] text-[#8C8889] font-bold">
        {new Date().toLocaleDateString(undefined, {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        })}
      </div>

      {/* these summary cards give a quick invoice health overview before the user starts filtering the table */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-4 mt-4">
        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Total Sales
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {formatNpr(summary.totalSales)}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Invoices Generated
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {summary.generated}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Paid Invoices
          </div>
          <div className="text-2xl font-extrabold text-[#179B4D] mt-1">
            {summary.paid}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-[#B7791F] uppercase ">
            Partial Invoices
          </div>
          <div className="text-2xl font-extrabold text-[#B7791F] mt-1">
            {summary.partial}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-rose-700 uppercase ">
            Unpaid Invoices
          </div>
          <div className="text-2xl font-extrabold text-rose-700 mt-1">
            {summary.unpaid}
          </div>
        </div>

        <div className="rounded-2xl border border-[#CFCFD3] bg-[#FFFFFF] p-5 ">
          <div className="text-[11px] font-extrabold text-slate-500 uppercase ">
            Cancelled Invoices
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-1">
            {summary.cancelled}
          </div>
        </div>

        <div className="bg-[#FFFFFF] rounded-2xl border border-[#CFCFD3] p-5 ">
          <div className="text-[11px] font-extrabold text-[#8C8889] uppercase ">
            Outstanding Due
          </div>
          <div className="text-2xl font-extrabold text-[#000000] mt-1">
            {formatNpr(summary.outstandingDue)}
          </div>
        </div>
      </div>

      {isAdminView ? (
        <div className="mt-6 rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
                Held Bills Oversight
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] font-bold text-[#565449]">
                <span className="rounded-full border border-[#CFCFD3] bg-[#F8F9FA] px-3 py-1">
                  {adminParkedDrafts.length} held bill(s)
                </span>
                <span className="rounded-full border border-[#CFCFD3] bg-[#F8F9FA] px-3 py-1">
                  Across cashiers
                </span>
                {adminParkedDrafts.length > 0 ? (
                  <span className="rounded-full border border-[#CFCFD3] bg-[#F8F9FA] px-3 py-1 font-mono">
                    {formatNpr(
                      adminParkedDrafts.reduce(
                        (sum, draft) => sum + Number(draft.subTotal || 0),
                        0,
                      ),
                    )}{" "}
                    held
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadAdminParkedDrafts()}
              disabled={adminParkedLoading}
              className="inline-flex h-[40px] items-center justify-center gap-2 rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-4 text-[12px] font-extrabold text-[#565449] transition hover:bg-[#F3F4F6] disabled:opacity-50"
            >
              <Icon name="sync" />
              {adminParkedLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {adminParkedDrafts.length > 0 ? (
            <div className="mt-4 grid max-h-[330px] grid-cols-[repeat(auto-fit,minmax(300px,420px))] justify-start gap-3 overflow-y-auto pr-1">
              {adminParkedDrafts.map((draft) => {
                const itemCount = draft.items?.length || 0;
                const units =
                  draft.items?.reduce(
                    (sum, item) => sum + Number(item.qty || 0),
                    0,
                  ) || 0;
                const parkedAt = draft.parkedAt
                  ? new Date(draft.parkedAt).toLocaleString()
                  : "Recently parked";

                return (
                  <div
                    key={draft.id}
                    className="flex min-h-[178px] flex-col justify-between rounded-[16px] border border-[#CFCFD3] bg-[#F8F9FA] p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-[#000000]">
                            {draft.parkedLabel || draft.invoiceNo || "Held bill"}
                          </div>
                          <div className="mt-1 truncate text-[12px] font-semibold text-[#8C8889]">
                            {draft.cashier?.name || "Unknown cashier"} |{" "}
                            {draft.customer?.name || "Walk-in Customer"}
                          </div>
                        </div>
                        <div className="shrink-0 rounded-full border border-[#CFCFD3] bg-white px-2.5 py-1 font-mono text-[11px] font-extrabold text-[#000000]">
                          {formatNpr(Number(draft.subTotal || 0))}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-bold text-[#565449]">
                        <span className="rounded-full bg-white px-2 py-1">
                          {itemCount} line(s)
                        </span>
                        <span className="rounded-full bg-white px-2 py-1">
                          {units} qty
                        </span>
                        <span className="rounded-full bg-white px-2 py-1">
                          {parkedAt}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px]">
                      <div className="min-w-0">
                      <label
                        htmlFor={`transfer-held-${draft.id}`}
                        className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#8C8889]"
                      >
                        Transfer to cashier
                      </label>
                      <select
                        id={`transfer-held-${draft.id}`}
                        value={draft.cashier?.id || ""}
                        onChange={(event) =>
                          requestAdminParkedTransfer(draft, event.target.value)
                        }
                        disabled={adminParkedBusyId === draft.id}
                        className="h-[40px] rounded-[12px] border-2 border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449] outline-none transition focus:border-[#000000] disabled:opacity-50"
                        aria-label="Choose cashier to transfer this held bill"
                      >
                        <option value="">Choose cashier</option>
                        {adminCashiers.map((cashier) => (
                          <option key={cashier.id} value={cashier.id}>
                            {cashier.name}
                          </option>
                        ))}
                      </select>
                      </div>
                      <button
                        type="button"
                        onClick={() => void discardAdminParkedDraft(draft.id)}
                        disabled={adminParkedBusyId === draft.id}
                        className="mt-[20px] inline-flex h-[40px] items-center justify-center gap-2 rounded-[12px] border-2 border-rose-200 bg-rose-50 px-3 text-[12px] font-extrabold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 sm:mt-[18px]"
                      >
                        <Icon name="delete" />
                        {adminParkedBusyId === draft.id ? "Working..." : "Discard"}
                      </button>
                    </div>
                    <div className="mt-2 text-[11px] font-semibold leading-4 text-[#8C8889]">
                      Selecting another cashier opens a confirmation before this held bill moves.
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 flex min-h-[94px] items-center justify-center rounded-[16px] border border-dashed border-[#CFCFD3] bg-[#F8F9FA] px-4 py-5 text-center">
              <div>
                <div className="text-[13px] font-extrabold text-[#565449]">
                  No held bills right now
                </div>
                <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                  Parked drafts from cashiers will appear here for transfer or discard.
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* this filter card keeps tabs and search together because both change the same invoice list below */}
      <div className="mt-6 rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
              Browse Invoices
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {(["All", "Paid", "Partial", "Unpaid", "Cancelled"] as const).map(
                (tab) => {
                  const active = tab === activeTab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => {
                        setActiveTab(tab);
                        setPage(1);
                      }}
                      className={cn(
                        "px-[16px] py-[8px] rounded-[999px] border-2 text-[12px] font-extrabold transition ",
                        active
                          ? "bg-[#000000] text-[#FFFFFF] border-[#000000]"
                          : "bg-[#FFFFFF] text-[#8C8889] border-[#CFCFD3] hover:bg-[#CFCFD3]",
                      )}
                    >
                      {tab === "All" ? "All Invoices" : tab}
                    </button>
                  );
                },
              )}
            </div>
          </div>

          <div className="flex w-full flex-col gap-3 sm:flex-row xl:w-auto xl:min-w-[520px] xl:justify-end">
            <div className="w-full xl:w-[360px]">
              <div className="flex items-center gap-2 rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] px-[14px] py-[10px] focus-within:border-[#000000] transition-colors">
                <Icon name="search" className="text-[#8C8889]" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search invoice no, customer, or item..."
                  className="w-full bg-transparent text-[13px] font-semibold text-[#000000] outline-none placeholder:text-[#8C8889]"
                />
              </div>
            </div>

            {isAdminView ? (
              <button
                type="button"
                onClick={openReturnReview}
                className="flex h-[44px] items-center justify-center gap-2 rounded-[12px] border-2 border-[#9DD8B2] bg-[#EAF8EF] px-[16px] font-extrabold text-[#179B4D] transition hover:bg-[#DFF3E7] sm:self-start"
              >
                <Icon name="assignment_return" />
                <span>
                  Returns
                  {returnRequests.length > 0 ? ` (${returnRequests.length})` : ""}
                </span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => setFilterOpen((value) => !value)}
              className="h-[44px] px-[16px] rounded-[12px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] font-extrabold text-[#000000] flex items-center justify-center gap-2 transition sm:self-start"
            >
              <Icon name={isFilterOpen ? "close" : "filter_list"} />
              {isFilterOpen ? "Hide Filters" : "Filter"}
            </button>
          </div>
        </div>

        {isFilterOpen ? (
          <div className="mt-4 rounded-[18px] border border-[#E5E7EB] bg-[#F8FAFC]/80 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8C8889]">
                  Filter Options
                </div>
                <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
                  Refine the visible invoices using cashier, customer type, and payment method.
                </div>
              </div>

              <button
                type="button"
                onClick={clearExtraFilters}
                disabled={!hasExtraFilters}
                className={cn(
                  "rounded-[12px] border px-[14px] py-[9px] text-[12px] font-extrabold transition",
                  hasExtraFilters
                    ? "border-[#CFCFD3] bg-[#FFFFFF] text-[#000000] hover:bg-[#F3F4F6]"
                    : "cursor-not-allowed border-[#E5E7EB] bg-[#F8FAFC] text-[#94A3B8]",
                )}
              >
                Clear filters
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  {isAdminView ? "Cashier" : "Cashier Match"}
                </div>

                {isAdminView ? (
                  <select
                    value={cashierFilter}
                    aria-label="Filter by cashier"
                    onChange={(event) => {
                      setCashierFilter(event.target.value);
                      setPage(1);
                    }}
                    className="mt-3 h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 text-[13px] font-bold text-[#000000] outline-none focus:border-[#000000]"
                  >
                    <option value="All">All cashiers</option>
                    {cashierOptions.map((cashier) => (
                      <option key={cashier.id} value={cashier.id}>
                        {cashier.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-[12px] border border-[#CFCFD3] bg-[#FFFFFF] px-3 py-3 text-[13px] font-bold text-[#000000]">
                    <input
                      type="checkbox"
                      checked={onlyMine}
                      onChange={(event) => {
                        setOnlyMine(event.target.checked);
                        setPage(1);
                      }}
                      className="h-4 w-4 accent-[#000000]"
                    />
                    Show only my invoices
                  </label>
                )}
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Customer Type
                </div>
                <div className="mt-3 flex gap-2 flex-wrap">
                  {(["All", "Walk-in", "Registered"] as const).map((type) => {
                    const active = type === customerTypeFilter;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setCustomerTypeFilter(type);
                          setPage(1);
                        }}
                        className={cn(
                          "rounded-[12px] border px-[14px] py-[8px] text-[12px] font-extrabold transition",
                          active
                            ? "border-[#000000] bg-[#000000] text-[#FFFFFF]"
                            : "border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]",
                        )}
                      >
                        {type}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-4 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Payment Method
                </div>
                <div className="mt-3 flex gap-2 flex-wrap">
                  {(["All", "Cash", "eSewa", "None"] as const).map((method) => {
                    const active = method === methodFilter;
                    return (
                      <button
                        key={method}
                        type="button"
                        onClick={() => {
                          setMethodFilter(method);
                          setPage(1);
                        }}
                        className={cn(
                          "rounded-[12px] border px-[14px] py-[8px] text-[12px] font-extrabold transition",
                          active
                            ? "border-[#000000] bg-[#000000] text-[#FFFFFF]"
                            : "border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]",
                        )}
                      >
                        {method}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* the table uses its own card and horizontal overflow because invoice rows carry a lot of fields on one line */}
      <div className="mt-6 bg-[#FFFFFF] border-2 border-[#CFCFD3] rounded-[20px] overflow-hidden ">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-[#CFCFD3]/40 border-b-2 border-[#CFCFD3]">
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Invoice / Date
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Customer
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Summary
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase ">
                  Status & Method
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase  text-right">
                  Net Total
                </th>
                <th className="px-5 py-4 text-[11px] font-extrabold text-[#8C8889] uppercase  text-center">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#CFCFD3]">
              {pageItems.map((invoice) => (
                <tr
                  key={invoice.id}
                  className="hover:bg-[#CFCFD3]/20 transition-colors"
                >
                  <td className="px-5 py-4 align-top">
                    <div className="font-bold text-[#000000]">
                      {invoice.invoiceNo}
                    </div>
                    <div className="text-[12px] text-[#8C8889] mt-1">
                      {invoice.createdDateLabel}
                    </div>
                    <div className="text-[11px] text-[#8C8889] mt-0.5 opacity-80">
                      By {invoice.cashierName}
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#CFCFD3] border border-[#CFCFD3] flex items-center justify-center font-extrabold text-[#000000] text-xs shrink-0">
                        {invoice.customerName
                          .split(" ")
                          .slice(0, 2)
                          .map((part) => part[0])
                          .join("")
                          .toUpperCase()}
                      </div>
                      <div>
                        <div className="font-extrabold text-[#000000]">
                          {invoice.customerName}
                        </div>
                        <div className="text-[12px] text-[#8C8889] font-medium">
                          {invoice.customerSubtitle}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top max-w-[260px]">
                    <div className="inline-flex items-center gap-2 bg-[#CFCFD3]/30 border border-[#CFCFD3] px-3 py-1.5 rounded-[10px] w-full hover:bg-[#CFCFD3]/60 transition-colors">
                      <Icon
                        name="shopping_bag"
                        className="text-[14px] text-[#8C8889] shrink-0"
                      />
                      <span className="text-[12px] font-medium text-[#000000] truncate">
                        {getCompactInvoiceSummary(invoice)}
                      </span>
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top">
                    <div className="flex flex-col items-start gap-2">
                      <div className="flex items-center gap-2">
                        <InvoiceStatusChip status={invoice.status} />
                        <PaymentMethodChip
                          method={invoice.paymentMethod}
                          showIcon
                        />
                      </div>

                      {invoice.status !== "Paid" &&
                        invoice.status !== "Cancelled" &&
                        invoice.dueAmount > 0 && (
                          <div className="text-[11px] font-extrabold text-white bg-rose-600 border border-rose-600 px-2 py-0.5 rounded-md">
                            Due: {formatNpr(invoice.dueAmount)}
                          </div>
                        )}
                      {invoice.status === "Cancelled" &&
                      invoice.cancelledByName ? (
                        <div className="text-[11px] font-semibold text-slate-500">
                          Cancelled by {invoice.cancelledByName}
                          {invoice.cancelledByRole
                            ? ` (${invoice.cancelledByRole})`
                            : ""}
                        </div>
                      ) : null}
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top text-right">
                    <div className="font-mono font-extrabold text-[#000000] text-[15px]">
                      {formatNpr(invoice.netTotal)}
                    </div>
                  </td>

                  <td className="px-5 py-4 align-top">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => openInvoice(invoice.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition-colors hover:bg-[#000000] hover:text-[#FFFFFF]"
                        title="View"
                      >
                        <Icon name="visibility" className="text-[16px]" />
                      </button>

                      <button
                        onClick={() => openEditInvoice(invoice)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition-colors hover:bg-[#000000] hover:text-[#FFFFFF]"
                        title="Edit"
                      >
                        <Icon name="edit" className="text-[16px]" />
                      </button>

                      <button
                        onClick={() => openInvoicePrint(invoice.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition-colors hover:bg-[#000000] hover:text-[#FFFFFF]"
                        title="Print"
                      >
                        <Icon name="print" className="text-[16px]" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageItems.length === 0 ? (
          <div className="h-[150px] flex items-center justify-center text-[#8C8889] font-semibold">
            No invoices match your criteria.
          </div>
        ) : null}

        <PaginationBar
          page={pageClamped}
          totalPages={totalPages}
          total={filtered.length}
          start={pageStart}
          end={pageEnd}
          label="invoices"
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
          className="border-t-2"
        />
      </div>

      <InvoiceDetailModal
        open={!!selectedInvoiceId}
        invoice={detailInvoice}
        onClose={closeInvoice}
        onVoidPayment={isAdminView || canCashierVoidPayment ? handleVoidPayment : undefined}
        voidingPaymentId={voidingPaymentId}
        extraActions={
          detailInvoice ? (
            <>
              <button
                type="button"
                onClick={() => openEditInvoice(detailInvoice)}
                className="h-[44px] rounded-[14px] border-2 border-[#CFCFD3] bg-[#FFFFFF] hover:bg-[#CFCFD3] font-extrabold text-[#000000] flex items-center justify-center gap-2 transition px-4"
              >
                <Icon name="edit" />
                Edit Invoice
              </button>
              <button
                type="button"
                onClick={() => openReturnRequest(detailInvoice)}
                disabled={!canRequestReturn(detailInvoice)}
                className="h-[44px] rounded-[14px] border-2 border-[#9DD8B2] bg-[#EAF8EF] px-4 font-extrabold text-[#179B4D] transition hover:bg-[#DFF3E7] disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Icon name="assignment_return" />
                Return Items
              </button>
            </>
          ) : null
        }
      />

      <InvoiceEditModal
        invoice={editInvoice}
        paymentMethod={editPaymentMethod}
        paymentAmount={paymentAmount}
        paymentError={paymentError}
        busy={savingEdit}
        onChangePaymentMethod={setEditPaymentMethod}
        onChangePaymentAmount={setPaymentAmount}
        onClose={closeEditInvoice}
        onAddPayment={handleAddPayment}
        onMarkPaid={handleMarkFullyPaid}
        onCancelInvoice={handleCancelInvoice}
        onModifyInvoice={() => {
          if (editInvoice) openModifyInvoice(editInvoice);
        }}
      />

      <InvoiceModifyModal
        invoice={modifyInvoice}
        lines={modifyLines}
        reason={modifyReason}
        error={modifyError}
        busy={savingModify}
        onChangeReason={setModifyReason}
        onChangeQty={changeModifyQty}
        onRemoveLine={removeModifyLine}
        onAddLine={addModifyLine}
        onClose={closeModifyInvoice}
        onSubmit={requestSubmitModifyInvoice}
      />

      <InvoiceReturnRequestModal
        invoice={returnInvoice}
        lines={returnLines}
        reason={returnReason}
        note={returnNote}
        refundMethod={returnRefundMethod}
        error={returnError}
        busy={savingReturn}
        onChangeReason={setReturnReason}
        onChangeNote={setReturnNote}
        onChangeRefundMethod={setReturnRefundMethod}
        onChangeQty={changeReturnQty}
        onClose={closeReturnRequest}
        onSubmit={submitReturnRequest}
      />

      <ReturnReviewModal
        open={showReturnReview}
        status={returnReviewStatus}
        requests={returnRequests}
        loading={returnRequestsLoading}
        busyId={returnReviewBusyId}
        error={returnRequestsError}
        onClose={closeReturnReview}
        onRefresh={() => void loadReturnRequests(returnReviewStatus)}
        onChangeStatus={(status) => void loadReturnRequests(status)}
        onApprove={requestApproveReturn}
        onReject={requestRejectReturn}
        onReverse={requestReverseReturn}
      />

      {pendingParkedTransfer ? (
        <ConfirmDialog
          open={!!pendingParkedTransfer}
          title="Transfer held bill?"
          message="This will move the parked bill to the selected cashier's Held Bills list. The original cashier will no longer see it."
          confirmLabel="Transfer Held Bill"
          onConfirm={confirmAdminParkedTransfer}
          onClose={() => setPendingParkedTransfer(null)}
          tone="primary"
          icon="swap_horiz"
          details={
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span>Held bill</span>
                <span className="font-extrabold text-slate-900">
                  {pendingParkedTransfer.draft.parkedLabel ||
                    pendingParkedTransfer.draft.invoiceNo ||
                    "Held bill"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Customer</span>
                <span className="font-extrabold text-slate-900">
                  {pendingParkedTransfer.draft.customer?.name ||
                    "Walk-in Customer"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>From cashier</span>
                <span className="font-extrabold text-slate-900">
                  {pendingParkedTransfer.draft.cashier?.name ||
                    "Unknown cashier"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>To cashier</span>
                <span className="font-extrabold text-slate-900">
                  {pendingParkedTransfer.cashier.name}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[#CFCFD3] pt-2">
                <span>Bill value</span>
                <span className="font-extrabold text-slate-900">
                  {formatNpr(Number(pendingParkedTransfer.draft.subTotal || 0))}
                </span>
              </div>
            </div>
          }
          busy={adminParkedBusyId === pendingParkedTransfer.draft.id}
        />
      ) : null}

      {pendingInvoiceActionConfig ? (
        <ConfirmDialog
          open={!!pendingInvoiceActionConfig}
          title={pendingInvoiceActionConfig.title}
          message={pendingInvoiceActionConfig.message}
          confirmLabel={pendingInvoiceActionConfig.confirmLabel}
          onConfirm={confirmPendingInvoiceAction}
          onClose={() => setPendingInvoiceAction(null)}
          tone={pendingInvoiceActionConfig.tone}
          icon={pendingInvoiceActionConfig.icon}
          details={pendingInvoiceActionConfig.details}
          busy={savingEdit}
        />
      ) : null}

      {pendingReturnReviewConfig ? (
        <ConfirmDialog
          open={!!pendingReturnReviewConfig}
          title={pendingReturnReviewConfig.title}
          message={pendingReturnReviewConfig.message}
          confirmLabel={pendingReturnReviewConfig.confirmLabel}
          onConfirm={confirmReturnReviewAction}
          onClose={() => setPendingReturnReviewAction(null)}
          tone={pendingReturnReviewConfig.tone}
          icon={pendingReturnReviewConfig.icon}
          details={pendingReturnReviewConfig.details}
          busy={returnReviewBusyId === pendingReturnReviewRequest?.id}
        />
      ) : null}

      {modifyConfirmConfig ? (
        <ConfirmDialog
          open={!!modifyConfirmConfig}
          title={modifyConfirmConfig.title}
          message={modifyConfirmConfig.message}
          confirmLabel={modifyConfirmConfig.confirmLabel}
          onConfirm={submitModifyInvoice}
          onClose={() => setShowModifyConfirm(false)}
          tone="primary"
          icon="receipt_long"
          details={modifyConfirmConfig.details}
          busy={savingModify}
        />
      ) : null}

      {pendingVoidPayment ? (
        <ConfirmDialog
          open={!!pendingVoidPayment}
          title="Void this payment?"
          message="This successful payment will be marked void and the invoice payment status will be recalculated."
          confirmLabel="Void Payment"
          onConfirm={confirmVoidPayment}
          onClose={() => {
            setPendingVoidPaymentId(null);
            setVoidPaymentPin("");
            setVoidPaymentPinError("");
          }}
          tone="danger"
          icon="block"
          details={
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span>Invoice</span>
                <span className="font-extrabold text-slate-900">
                  {detailInvoice?.invoiceNo}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Payment method</span>
                <span className="font-extrabold text-slate-900">
                  {pendingVoidPayment.method}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Amount</span>
                <span className="font-extrabold text-slate-900">
                  {formatNpr(pendingVoidPayment.amount)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Status</span>
                <span className="font-extrabold text-slate-900">
                  {pendingVoidPayment.status}
                </span>
              </div>
              {!isAdminView ? (
                <div className="pt-3">
                  <label className="text-[12px] font-extrabold text-slate-600">
                    Override PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={voidPaymentPin}
                    onChange={(event) => {
                      setVoidPaymentPin(event.target.value.replace(/\D/g, "").slice(0, 4));
                      setVoidPaymentPinError("");
                    }}
                    placeholder="4 digits"
                    className="mt-2 h-[42px] w-full rounded-[12px] border border-slate-300 bg-white px-3 text-[15px] font-extrabold tracking-[4px] text-slate-900 outline-none focus:border-slate-900"
                  />
                  {voidPaymentPinError ? (
                    <div className="mt-2 text-[12px] font-bold text-rose-600">
                      {voidPaymentPinError}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          }
          busy={voidingPaymentId === pendingVoidPayment.id}
        />
      ) : null}
    </div>
  );
}
