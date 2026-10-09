import React from "react";
import { ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import type { EnabledPaymentAccountDto } from "~/lib/api/paymentAccounts";
import type { ExternalDocumentType } from "~/lib/api/manualBills";
import type { GatewayDisplayResponse } from "~/lib/api/endpoints";

export type PaymentMethod = "Cash" | "Fonepay" | "eSewa" | "Split" | "Bank Transfer";
export type PaymentStatus = "Paid" | "Partial" | "Unpaid";

export type SplitPaymentDraft = {
  id: string;
  method: "CASH" | "FONEPAY" | "ESEWA" | "BANK_TRANSFER";
  amount: string;
  tenderedAmount: string;
  reference?: string;
  receivingAccountId?: string;
  receivingAccountVersion?: number;
  receivingAccountLabel?: string;
  manualReceiptConfirmed?: boolean;
};

export type ConfirmPaymentCustomer = {
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  panNo?: string | null;
  address?: string | null;
} | null;

export interface ConfirmPaymentModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
  stockRefreshBusy: boolean;
  canConfirm: boolean;

  // Cart & Customer context
  cartRows: Array<any>;
  cart: Array<{ qty: number; [key: string]: any }>;
  selectedCustomer: ConfirmPaymentCustomer;

  // Financial summary
  payableTotal: number;
  subTotal: number;
  subtotalDiscount: number;
  hasPriceOverrides: boolean;
  overrideDiffIsReduction: boolean;
  overrideDiffLabel: string;
  overrideDiffDisplay: string;
  effectivePaidAmount: number;
  balanceDue: number;
  cashDueAmount: number;

  // Payment method & status
  paymentMethod: PaymentMethod;
  setPaymentMethod: (method: PaymentMethod) => void;
  paymentStatus: PaymentStatus;
  setPaymentStatus: (status: PaymentStatus) => void;
  paidAmount: string;
  setPaidAmount: (val: string) => void;

  // Cash method
  cashTendered: string;
  setCashTendered: (val: string) => void;
  changeDue: number;
  cashShort: number;

  // Fonepay method
  fonepayReference: string;
  setFonepayReference: (val: string) => void;
  receivingAccountId: string;
  setReceivingAccountId: (val: string) => void;
  setReceivingAccountVersion: (val: number | null) => void;
  setReceivingAccountLabel: (val: string) => void;
  manualReceiptConfirmed: boolean;
  setManualReceiptConfirmed: (val: boolean) => void;
  fonepayConfirmed: boolean;
  setFonepayConfirmed: (val: boolean) => void;
  enabledPaymentAccounts: EnabledPaymentAccountDto[];

  // Bank Transfer method
  bankTransferReference: string;
  setBankTransferReference: (val: string) => void;

  // Split payment method
  splitPayments: SplitPaymentDraft[];
  updateSplitPayment: (id: string, updates: Partial<SplitPaymentDraft>) => void;
  removeSplitPayment: (id: string) => void;
  addSplitPayment: (method: SplitPaymentDraft["method"]) => void;
  isSplitBalanced: boolean;
  splitBalance: number;
  splitCashNum: number;
  splitEsewaAmount: number;
  splitFonepayAmount: number;
  splitTotal: number;
  ensureDefaultSplitPayments: () => void;

  // Notes & Paper Bill record
  invoiceNote: string;
  setInvoiceNote: (val: string) => void;
  paperDraftBillNo: string;
  setPaperDraftBillNo: (val: string) => void;
  paperDraftDocumentType: ExternalDocumentType;
  setPaperDraftDocumentType: (val: ExternalDocumentType) => void;
  paperDraftBillDate: string;
  setPaperDraftBillDate: (val: string) => void;
  paperDraftChoice: string;
  setPaperDraftChoice: (val: "RECORD_AFTER_SAVE" | "LATER") => void;
  storageLimitationWarning: string | null;

  // Gateway & Dialog triggers
  gatewayDisplay?: GatewayDisplayResponse | null;
  setShowEsewaQr: (val: boolean) => void;
  setIsQrGalleryOpen: (val: boolean) => void;
  loadEnabledPaymentAccounts: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<EnabledPaymentAccountDto[]>;

  // Errors & Candidate state
  paymentError: string;
  setPaymentError: (val: string) => void;
  billingError: string;
  setBillingError: (val: string) => void;
  setReviewedCandidate: (val: any) => void;

  // Tone & Status display
  paymentStateTone: string;
  paymentStateTitle: string;
  paymentStateDetail: string;

  // Formatting helpers
  formatNpr: (n: number) => string;
  formatQty: (q: number) => string;
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function ConfirmPaymentModal({
  open,
  onClose,
  onConfirm,
  submitting,
  stockRefreshBusy,
  canConfirm,
  cartRows,
  cart,
  selectedCustomer,
  payableTotal,
  subTotal,
  subtotalDiscount,
  hasPriceOverrides,
  overrideDiffIsReduction,
  overrideDiffLabel,
  overrideDiffDisplay,
  effectivePaidAmount,
  balanceDue,
  cashDueAmount,
  paymentMethod,
  setPaymentMethod,
  paymentStatus,
  setPaymentStatus,
  paidAmount,
  setPaidAmount,
  cashTendered,
  setCashTendered,
  changeDue,
  cashShort,
  fonepayReference,
  setFonepayReference,
  receivingAccountId,
  setReceivingAccountId,
  setReceivingAccountVersion,
  setReceivingAccountLabel,
  manualReceiptConfirmed,
  setManualReceiptConfirmed,
  fonepayConfirmed,
  setFonepayConfirmed,
  enabledPaymentAccounts,
  bankTransferReference,
  setBankTransferReference,
  splitPayments,
  updateSplitPayment,
  removeSplitPayment,
  addSplitPayment,
  isSplitBalanced,
  splitBalance,
  splitCashNum,
  splitEsewaAmount,
  splitFonepayAmount,
  splitTotal,
  ensureDefaultSplitPayments,
  invoiceNote,
  setInvoiceNote,
  paperDraftBillNo,
  setPaperDraftBillNo,
  paperDraftDocumentType,
  setPaperDraftDocumentType,
  paperDraftBillDate,
  setPaperDraftBillDate,
  paperDraftChoice,
  setPaperDraftChoice,
  storageLimitationWarning,
  gatewayDisplay,
  setShowEsewaQr,
  setIsQrGalleryOpen,
  loadEnabledPaymentAccounts,
  paymentError,
  setPaymentError,
  billingError,
  setBillingError,
  setReviewedCandidate,
  paymentStateTone,
  paymentStateTitle,
  paymentStateDetail,
  formatNpr,
  formatQty,
}: ConfirmPaymentModalProps) {
  const totalItemCount = cartRows.length;
  const totalQtyCount = cart.reduce((sum, line) => sum + (line.qty || 0), 0);

  const primaryCtaLabel = submitting
    ? "Creating..."
    : stockRefreshBusy
      ? "Checking stock..."
      : paymentMethod === "Split"
        ? "CONFIRM SPLIT PAYMENT (Shift + Enter)"
        : paymentStatus === "Partial"
          ? "SAVE PARTIAL PAYMENT (Shift + Enter)"
          : paymentStatus === "Unpaid"
            ? "CREATE UNPAID INVOICE (Shift + Enter)"
            : paymentMethod === "Fonepay"
              ? "CONFIRM FONEPAY (Shift + Enter)"
              : paymentMethod === "eSewa"
                ? "CONTINUE TO ESEWA (Shift + Enter)"
                : "FINAL CHECKOUT (Shift + Enter)";

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title="Confirm Payment"
      description="Finalize payment and record the physical bill details"
      maxWidthClass="max-w-[1020px]"
      headerActions={
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
            4 of 4
          </span>
          <button
            type="button"
            onClick={() => {
              setIsQrGalleryOpen(true);
              void loadEnabledPaymentAccounts();
            }}
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#CFCFD3] bg-white px-2.5 py-1 text-[11px] font-bold text-[#565449] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
          >
            <Icon name="qr_code_scanner" className="text-[14px]" />
            <span>QR Gallery</span>
          </button>
        </div>
      }
      footer={
        <div className="flex flex-col sm:flex-row w-full items-center justify-between gap-3 bg-slate-50 py-1">
          <div className="flex items-center space-x-2 text-xs text-slate-500">
            <Icon name="info" className="text-[16px] text-slate-400 shrink-0" />
            <span>This stores internal records and manual bill references; it does not generate a tax invoice.</span>
          </div>

          <div className="flex items-center space-x-3 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex h-[42px] px-4 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 transition hover:bg-slate-100 shadow-sm"
            >
              <Icon name="arrow_back" className="text-[16px]" /> Back
            </button>
            <button
              type="button"
              disabled={!canConfirm || submitting || stockRefreshBusy}
              onClick={onConfirm}
              className="flex h-[42px] px-5 items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-xs font-bold text-white transition-all shadow-sm hover:shadow disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="lock" className="text-[16px]" />
              {primaryCtaLabel}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 text-slate-800">
        {/* Top 3 Metric Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {/* Card 1: Items & Qty */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <Icon name="shopping_cart" className="text-[20px]" />
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  Items &amp; Qty
                </p>
                <p className="text-sm font-bold text-slate-800">
                  {totalItemCount} {totalItemCount === 1 ? "item" : "items"} • {formatQty(totalQtyCount)} qty
                </p>
              </div>
            </div>
            <Icon name="chevron_right" className="text-[18px] text-slate-300" />
          </div>

          {/* Card 2: Customer */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 bg-white shadow-sm min-w-0">
            <div className="flex items-center space-x-3 min-w-0 truncate">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                <Icon name="person" className="text-[20px]" />
              </div>
              <div className="min-w-0 truncate">
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  Customer
                </p>
                <p className="text-sm font-bold text-slate-800 truncate">
                  {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  {selectedCustomer
                    ? selectedCustomer.phone || selectedCustomer.email || "Registered Customer"
                    : "Direct Walk-in Sale"}
                </p>
              </div>
            </div>
            <Icon name="chevron_right" className="text-[18px] text-slate-300 ml-1 shrink-0" />
          </div>

          {/* Card 3: Amount Due */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/50 shadow-sm">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 font-bold text-[14px]">
                Rs.
              </div>
              <div>
                <p className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wider">
                  Amount Due
                </p>
                <p className="text-base font-bold text-slate-900 font-mono tracking-tight">
                  {formatNpr(payableTotal)}
                </p>
              </div>
            </div>
            <Icon name="chevron_right" className="text-[18px] text-emerald-300 shrink-0" />
          </div>
        </div>

        {/* Main 2-Column Split Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          {/* LEFT COLUMN: Payment Configuration & Specific Gateway Details */}
          <div className="lg:col-span-7 flex flex-col justify-between space-y-4">
            <div className="space-y-4">
              {/* Step 1: Select Payment Method */}
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  1. Select Payment Method
                </span>
                <div className="grid grid-cols-5 gap-2">
                  {/* Cash */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Cash");
                      if (paymentStatus === "Paid") setCashTendered(String(payableTotal));
                      setPaymentError("");
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center p-2 rounded-xl transition-all cursor-pointer min-h-[58px]",
                      paymentMethod === "Cash"
                        ? "border-2 border-blue-600 bg-white shadow-sm ring-2 ring-blue-500/10 font-bold text-slate-900"
                        : "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 font-medium text-slate-700",
                    )}
                  >
                    <Icon name="payments" className="text-[20px] mb-0.5 text-slate-600" />
                    <span className="text-xs">Cash</span>
                  </button>

                  {/* Fonepay */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Fonepay");
                      setShowEsewaQr(false);
                      setPaymentError("");
                      void loadEnabledPaymentAccounts();
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center p-2 rounded-xl transition-all cursor-pointer min-h-[58px]",
                      paymentMethod === "Fonepay"
                        ? "border-2 border-rose-500 bg-rose-50/20 shadow-sm ring-2 ring-rose-500/10 font-bold text-slate-900"
                        : "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 font-medium text-slate-700",
                    )}
                  >
                    <img
                      src="/assets/images/fonepay.png"
                      alt="Fonepay"
                      className="h-[18px] max-w-[56px] object-contain mb-1"
                    />
                    <span className="text-xs">Fonepay</span>
                  </button>

                  {/* eSewa */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("eSewa");
                      setShowEsewaQr(true);
                      setPaymentError("");
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center p-2 rounded-xl transition-all cursor-pointer min-h-[58px]",
                      paymentMethod === "eSewa"
                        ? "border-2 border-emerald-600 bg-emerald-50/20 shadow-sm ring-2 ring-emerald-500/10 font-bold text-slate-900"
                        : "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 font-medium text-slate-700",
                    )}
                  >
                    <img
                      src="/assets/images/esewa/logo.png"
                      alt="eSewa"
                      className="h-5 w-5 rounded-full object-contain mb-1"
                    />
                    <span className="text-xs">eSewa</span>
                  </button>

                  {/* Bank Transfer */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Bank Transfer");
                      setShowEsewaQr(false);
                      setPaymentError("");
                      void loadEnabledPaymentAccounts();
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center p-2 rounded-xl transition-all cursor-pointer min-h-[58px]",
                      paymentMethod === "Bank Transfer"
                        ? "border-2 border-blue-600 bg-white shadow-sm ring-2 ring-blue-500/10 font-bold text-slate-900"
                        : "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 font-medium text-slate-700",
                    )}
                  >
                    <Icon name="account_balance" className="text-[20px] mb-0.5 text-blue-600" />
                    <span className="text-xs leading-tight text-center">
                      Bank{" "}<br />
                      <span className="text-[10px] text-slate-500 font-normal">Transfer</span>
                    </span>
                  </button>

                  {/* Split */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("Split");
                      setPaymentStatus("Paid");
                      setShowEsewaQr(true);
                      setPaymentError("");
                      ensureDefaultSplitPayments();
                      void loadEnabledPaymentAccounts();
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center p-2 rounded-xl transition-all cursor-pointer min-h-[58px]",
                      paymentMethod === "Split"
                        ? "border-2 border-blue-600 bg-white shadow-sm ring-2 ring-blue-500/10 font-bold text-blue-700"
                        : "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 font-medium text-slate-700",
                    )}
                  >
                    <Icon name="call_split" className="text-[20px] mb-0.5 text-slate-600" />
                    <span className="text-xs">Split</span>
                  </button>
                </div>
              </div>

              {/* Step 2: Payment Status */}
              {paymentMethod !== "Split" && (
                <div className="space-y-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    2. Payment Status
                  </span>
                  <div className="inline-flex w-full bg-slate-100 p-1 rounded-xl border border-slate-200" role="group">
                    {(["Paid", "Partial", "Unpaid"] as PaymentStatus[]).map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => {
                          setPaymentStatus(status);
                          setBillingError("");
                          if (paymentMethod === "Cash" && status === "Paid") {
                            setCashTendered(String(payableTotal));
                          }
                          if (status !== "Partial") {
                            setPaidAmount("");
                            setPaymentError("");
                          }
                        }}
                        className={cn(
                          "flex-1 py-1.5 px-3 text-xs rounded-lg transition-colors",
                          paymentStatus === status
                            ? "font-bold text-blue-700 bg-white shadow-sm border border-slate-200"
                            : "font-medium text-slate-600 hover:text-slate-900",
                        )}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Step 3: Specific Payment Details */}
            <div className="space-y-3 flex-1 flex flex-col justify-between pt-1">
              {/* A. CASH METHOD */}
              {paymentMethod === "Cash" && (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      3. Cash Payment Details
                    </h2>
                  </div>

                  {paymentStatus === "Paid" ? (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Amount Received <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative rounded-lg shadow-sm">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 font-bold text-sm">
                            Rs.
                          </div>
                          <input
                            type="text"
                            autoFocus
                            value={cashTendered}
                            onChange={(e) => {
                              setCashTendered(e.target.value.replace(/[^\d.]/g, ""));
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="0.00"
                            className="w-full text-base font-mono font-bold text-slate-900 bg-white border border-slate-300 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                          />
                        </div>
                      </div>

                      {/* Quick Cash Tender Pills */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          type="button"
                          onClick={() => {
                            setCashTendered(String(cashDueAmount));
                            setPaymentError("");
                            setBillingError("");
                          }}
                          className="px-2.5 py-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md border border-blue-200 transition-colors"
                        >
                          Exact
                        </button>
                        <button
                          type="button"
                          disabled={500 < cashDueAmount}
                          onClick={() => {
                            setCashTendered("500");
                            setPaymentError("");
                            setBillingError("");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-slate-100 rounded-md border border-slate-200 transition-colors"
                        >
                          Rs. 500
                        </button>
                        <button
                          type="button"
                          disabled={1000 < cashDueAmount}
                          onClick={() => {
                            setCashTendered("1000");
                            setPaymentError("");
                            setBillingError("");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-slate-100 rounded-md border border-slate-200 transition-colors"
                        >
                          Rs. 1,000
                        </button>
                        <button
                          type="button"
                          disabled={2000 < cashDueAmount}
                          onClick={() => {
                            setCashTendered("2000");
                            setPaymentError("");
                            setBillingError("");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-slate-100 rounded-md border border-slate-200 transition-colors"
                        >
                          Rs. 2,000
                        </button>
                        <button
                          type="button"
                          disabled={5000 < cashDueAmount}
                          onClick={() => {
                            setCashTendered("5000");
                            setPaymentError("");
                            setBillingError("");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-slate-100 rounded-md border border-slate-200 transition-colors"
                        >
                          Rs. 5,000
                        </button>
                      </div>

                      {/* Cash Short Alert if short */}
                      {cashShort > 0 && !!cashTendered && (
                        <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-xl">
                          <div className="flex items-center space-x-2">
                            <Icon name="warning" className="text-[18px] text-amber-600" />
                            <span className="text-xs font-bold text-amber-900">Cash Short</span>
                          </div>
                          <span className="text-sm font-bold font-mono text-amber-800">
                            Need {formatNpr(cashShort)} more
                          </span>
                        </div>
                      )}

                      {/* Change Due Card */}
                      <div className="flex items-center justify-between p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl">
                        <div className="flex items-center space-x-2.5">
                          <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
                            <Icon name="payments" className="text-[18px]" />
                          </div>
                          <span className="text-xs font-bold text-emerald-950">Change Due</span>
                        </div>
                        <span className="text-base font-bold font-mono text-emerald-800 tracking-tight">
                          {formatNpr(changeDue)}
                        </span>
                      </div>
                    </div>
                  ) : paymentStatus === "Partial" ? (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Amount Paid <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative rounded-lg shadow-sm">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 font-bold text-sm">
                            Rs.
                          </div>
                          <input
                            type="text"
                            autoFocus
                            value={paidAmount}
                            onChange={(e) => {
                              setPaidAmount(e.target.value.replace(/[^\d.]/g, ""));
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="e.g. 500"
                            className="w-full text-base font-mono font-bold text-slate-900 bg-white border border-slate-300 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                        </div>
                        <p className="text-[11px] text-slate-500">
                          Enter amount greater than 0 and less than {formatNpr(payableTotal)}.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
                      Unpaid invoice: Total {formatNpr(payableTotal)} will remain as outstanding customer credit.
                    </div>
                  )}
                </>
              )}

              {/* B. FONEPAY METHOD */}
              {paymentMethod === "Fonepay" && (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      3. Fonepay Payment Details
                    </h2>
                    <span className="text-[11px] text-rose-600 font-semibold flex items-center gap-1">
                      <Icon name="verified" className="text-[14px]" /> QR Merchant verified
                    </span>
                  </div>

                  {paymentStatus !== "Unpaid" ? (
                    <div className="space-y-3">
                      {paymentStatus === "Partial" && (
                        <div className="space-y-1">
                          <label className="block text-xs font-semibold text-slate-700">
                            Amount Paid <span className="text-rose-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={paidAmount}
                            onChange={(e) => {
                              setPaidAmount(e.target.value.replace(/[^\d.]/g, ""));
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="e.g. 500"
                            className="w-full text-sm font-mono font-bold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                        </div>
                      )}

                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Reference / Transaction ID <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative rounded-lg shadow-sm">
                          <input
                            type="text"
                            value={fonepayReference}
                            onChange={(e) => {
                              setFonepayReference(e.target.value.slice(0, 160));
                              setManualReceiptConfirmed(false);
                              setReviewedCandidate(null);
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="Transaction ID, payer phone, or cashier note"
                            className="w-full text-sm font-mono tracking-wider font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 pr-10 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                          <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400">
                            <Icon name="receipt_long" className="text-[18px]" />
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          Required for manual Fonepay collection and invoice audit history.
                        </p>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Store Receiving Destination <span className="text-slate-400 font-normal">(Optional)</span>
                        </label>
                        <ProjectSelect
                          value={receivingAccountId}
                          onChange={(e) => {
                            const val = e.target.value;
                            const selected = enabledPaymentAccounts.find(
                              (a) =>
                                a.id === val &&
                                a.supportedSettlement === true &&
                                a.confirmationMode === "MANUAL_RECEIPT" &&
                                a.settlementMethod === "FONEPAY",
                            );
                            setReceivingAccountId(val);
                            setReceivingAccountVersion(selected?.version ?? null);
                            setReceivingAccountLabel(selected?.providerLabel ?? "");
                            setManualReceiptConfirmed(false);
                            setReviewedCandidate(null);
                            setPaymentError("");
                          }}
                          className="h-[36px] w-full text-xs font-medium text-slate-800"
                        >
                          <option value="">Receiving destination not recorded</option>
                          {enabledPaymentAccounts
                            .filter(
                              (a) =>
                                a.supportedSettlement === true &&
                                a.confirmationMode === "MANUAL_RECEIPT" &&
                                a.settlementMethod === "FONEPAY",
                            )
                            .map((acc) => (
                              <option key={acc.id} value={acc.id}>
                                {acc.providerLabel} ({acc.accountIdentifier || acc.accountHolder || "Manual Fonepay"})
                              </option>
                            ))}
                        </ProjectSelect>
                      </div>

                      {receivingAccountId ? (
                        <div className="flex items-start space-x-2.5 p-2 bg-blue-50/50 border border-blue-200/80 rounded-lg">
                          <input
                            type="checkbox"
                            checked={manualReceiptConfirmed}
                            onChange={(e) => {
                              setManualReceiptConfirmed(e.target.checked);
                              setReviewedCandidate(null);
                              setPaymentError("");
                            }}
                            id="fonepay-dest-verify"
                            className="w-4 h-4 mt-0.5 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer"
                          />
                          <label htmlFor="fonepay-dest-verify" className="text-xs font-medium text-slate-700 cursor-pointer select-none">
                            I checked this receiving account and received{" "}
                            {formatNpr(paymentStatus === "Paid" ? payableTotal : Number(paidAmount) || 0)}
                          </label>
                        </div>
                      ) : null}

                      <div className="flex items-start space-x-2.5 p-2.5 bg-rose-50/50 border border-rose-200/80 rounded-lg">
                        <input
                          type="checkbox"
                          checked={fonepayConfirmed}
                          onChange={(e) => {
                            setFonepayConfirmed(e.target.checked);
                            setReviewedCandidate(null);
                            setPaymentError("");
                          }}
                          id="verify-fonepay-sms"
                          className="w-4 h-4 mt-0.5 text-rose-600 border-slate-300 rounded focus:ring-rose-500 cursor-pointer"
                        />
                        <label htmlFor="verify-fonepay-sms" className="text-xs font-medium text-slate-800 select-none cursor-pointer">
                          I have verified the Fonepay merchant SMS / app payment confirmation
                        </label>
                      </div>

                      <div className="flex items-center justify-between p-3 bg-rose-50 border border-rose-200 rounded-xl">
                        <div className="flex items-center space-x-2">
                          <img
                            src="/assets/images/fonepay.png"
                            alt="Fonepay"
                            className="h-4 max-w-[48px] object-contain"
                          />
                          <span className="text-xs font-bold text-rose-950">Fonepay collection</span>
                        </div>
                        <span className="text-sm font-bold font-mono text-rose-900 tracking-tight">
                          {formatNpr(paymentStatus === "Paid" ? payableTotal : Number(paidAmount) || 0)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
                      Unpaid invoice: Total {formatNpr(payableTotal)} will remain as outstanding customer credit.
                    </div>
                  )}
                </>
              )}

              {/* C. ESEWA METHOD */}
              {paymentMethod === "eSewa" && (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      3. eSewa Payment Details
                    </h2>
                  </div>

                  {paymentStatus !== "Unpaid" ? (
                    <div className="space-y-3">
                      {paymentStatus === "Partial" && (
                        <div className="space-y-1">
                          <label className="block text-xs font-semibold text-slate-700">
                            Amount Paid <span className="text-rose-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={paidAmount}
                            onChange={(e) => {
                              setPaidAmount(e.target.value.replace(/[^\d.]/g, ""));
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="e.g. 500"
                            className="w-full text-sm font-mono font-bold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                        </div>
                      )}

                      <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-xl flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <img
                            src="/assets/images/esewa/logo.png"
                            alt="eSewa"
                            className="h-7 w-7 rounded-full object-contain"
                          />
                          <div>
                            <p className="text-xs font-bold text-slate-900">
                              {gatewayDisplay?.esewa?.label || "eSewa Gateway"}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {gatewayDisplay?.esewa?.environment === "SANDBOX"
                                ? "Demo test credentials will be used; no real funds deducted."
                                : "Gateway environment is not confirmed."}
                            </p>
                          </div>
                        </div>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                          {gatewayDisplay?.esewa?.environment === "SANDBOX" ? "● Sandbox" : "Unknown"}
                        </span>
                      </div>

                      <div className="flex items-center justify-between p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                        <div className="flex items-center space-x-2">
                          <img
                            src="/assets/images/esewa/logo.png"
                            alt="eSewa"
                            className="h-5 w-5 rounded-full object-contain"
                          />
                          <span className="text-xs font-bold text-emerald-950">eSewa Pending Allocation</span>
                        </div>
                        <span className="text-sm font-bold font-mono text-emerald-800 tracking-tight">
                          {formatNpr(paymentStatus === "Paid" ? payableTotal : Number(paidAmount) || 0)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
                      Unpaid invoice: Total {formatNpr(payableTotal)} will remain as outstanding customer credit.
                    </div>
                  )}
                </>
              )}

              {/* D. BANK TRANSFER METHOD */}
              {paymentMethod === "Bank Transfer" && (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      3. Bank Transfer Details
                    </h2>
                  </div>

                  {paymentStatus !== "Unpaid" ? (
                    <div className="space-y-3">
                      {paymentStatus === "Partial" && (
                        <div className="space-y-1">
                          <label className="block text-xs font-semibold text-slate-700">
                            Amount Paid <span className="text-rose-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={paidAmount}
                            onChange={(e) => {
                              setPaidAmount(e.target.value.replace(/[^\d.]/g, ""));
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="e.g. 500"
                            className="w-full text-sm font-mono font-bold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                        </div>
                      )}

                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Voucher / Transfer Reference <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative rounded-lg shadow-sm">
                          <input
                            type="text"
                            value={bankTransferReference}
                            onChange={(e) => {
                              setBankTransferReference(e.target.value.slice(0, 160));
                              setManualReceiptConfirmed(false);
                              setReviewedCandidate(null);
                              setPaymentError("");
                              setBillingError("");
                            }}
                            placeholder="Voucher no., transfer remarks, or bank branch"
                            className="w-full text-sm font-mono font-bold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-2 pr-10 focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                          <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400">
                            <Icon name="account_balance" className="text-[18px]" />
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          Required for bank transfer settlement and invoice history.
                        </p>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-xs font-semibold text-slate-700">
                          Store Receiving Destination <span className="text-slate-400 font-normal">(Optional)</span>
                        </label>
                        <ProjectSelect
                          value={receivingAccountId}
                          onChange={(e) => {
                            const val = e.target.value;
                            const selected = enabledPaymentAccounts.find(
                              (a) =>
                                a.id === val &&
                                a.supportedSettlement === true &&
                                a.confirmationMode === "MANUAL_RECEIPT" &&
                                a.settlementMethod === "BANK_TRANSFER",
                            );
                            setReceivingAccountId(val);
                            setReceivingAccountVersion(selected?.version ?? null);
                            setReceivingAccountLabel(selected?.providerLabel ?? "");
                            setManualReceiptConfirmed(false);
                            setReviewedCandidate(null);
                            setPaymentError("");
                          }}
                          className="h-[36px] w-full text-xs font-medium text-slate-800"
                        >
                          <option value="">Receiving destination not recorded</option>
                          {enabledPaymentAccounts
                            .filter(
                              (a) =>
                                a.supportedSettlement === true &&
                                a.confirmationMode === "MANUAL_RECEIPT" &&
                                a.settlementMethod === "BANK_TRANSFER",
                            )
                            .map((acc) => (
                              <option key={acc.id} value={acc.id}>
                                {acc.providerLabel} ({acc.accountIdentifier || acc.accountHolder || "Bank Account"})
                              </option>
                            ))}
                        </ProjectSelect>
                      </div>

                      {receivingAccountId ? (
                        <div className="flex items-start space-x-2.5 p-2 bg-blue-50/50 border border-blue-200/80 rounded-lg">
                          <input
                            type="checkbox"
                            checked={manualReceiptConfirmed}
                            onChange={(e) => {
                              setManualReceiptConfirmed(e.target.checked);
                              setReviewedCandidate(null);
                              setPaymentError("");
                            }}
                            id="bank-dest-verify"
                            className="w-4 h-4 mt-0.5 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer"
                          />
                          <label htmlFor="bank-dest-verify" className="text-xs font-medium text-slate-700 cursor-pointer select-none">
                            I checked this receiving account and received{" "}
                            {formatNpr(paymentStatus === "Paid" ? payableTotal : Number(paidAmount) || 0)}
                          </label>
                        </div>
                      ) : null}

                      <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-xl">
                        <div className="flex items-center space-x-2">
                          <Icon name="account_balance" className="text-[18px] text-blue-700" />
                          <span className="text-xs font-bold text-blue-950">Bank transfer collection</span>
                        </div>
                        <span className="text-sm font-bold font-mono text-blue-900 tracking-tight">
                          {formatNpr(paymentStatus === "Paid" ? payableTotal : Number(paidAmount) || 0)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
                      Unpaid invoice: Total {formatNpr(payableTotal)} will remain as outstanding customer credit.
                    </div>
                  )}
                </>
              )}

              {/* E. SPLIT PAYMENT METHOD */}
              {paymentMethod === "Split" && (
                <div className="flex flex-col flex-1 justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                        3. Split Payment Details
                      </h2>
                      <div
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-[11px] font-bold",
                          isSplitBalanced
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                            : "bg-amber-100 text-amber-800 border border-amber-200",
                        )}
                      >
                        {isSplitBalanced
                          ? "✓ Balanced"
                          : splitBalance > 0
                            ? `${formatNpr(splitBalance)} short`
                            : `${formatNpr(Math.abs(splitBalance))} over`}
                      </div>
                    </div>

                    {/* Split Multi-Tender Rows Table Container */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden text-xs shadow-sm bg-white">
                      <div className="space-y-2 p-2">
                        {splitPayments.map((row) => {
                          const amountNum = Number(row.amount || 0);
                          const tenderedNum = Number(row.tenderedAmount || 0);
                          const rowChange = row.method === "CASH" ? Math.max(0, tenderedNum - amountNum) : 0;
                          const compatibleAccounts =
                            row.method === "FONEPAY"
                              ? enabledPaymentAccounts.filter(
                                  (a) =>
                                    a.supportedSettlement === true &&
                                    a.confirmationMode === "MANUAL_RECEIPT" &&
                                    a.settlementMethod === "FONEPAY",
                                )
                              : row.method === "BANK_TRANSFER"
                                ? enabledPaymentAccounts.filter(
                                    (a) =>
                                      a.supportedSettlement === true &&
                                      a.confirmationMode === "MANUAL_RECEIPT" &&
                                      a.settlementMethod === "BANK_TRANSFER",
                                  )
                                : [];

                          return (
                            <div
                              key={row.id}
                              className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50/50 p-2 md:grid-cols-[115px_minmax(0,1fr)_minmax(0,1fr)_32px]"
                            >
                              <ProjectSelect
                                value={row.method}
                                onChange={(e) =>
                                  updateSplitPayment(row.id, {
                                    method: e.target.value as SplitPaymentDraft["method"],
                                  })
                                }
                                className="h-[32px] rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-bold text-slate-800 outline-none"
                              >
                                <option value="CASH">Cash</option>
                                <option value="FONEPAY">Fonepay</option>
                                <option value="BANK_TRANSFER">Bank Transfer</option>
                                <option value="ESEWA">eSewa</option>
                              </ProjectSelect>

                              <input
                                value={row.amount}
                                onChange={(e) =>
                                  updateSplitPayment(row.id, {
                                    amount: e.target.value.replace(/[^\d.]/g, ""),
                                  })
                                }
                                inputMode="numeric"
                                placeholder="Amount"
                                className="h-[32px] rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-mono font-bold text-slate-800 outline-none focus:ring-1 focus:ring-blue-500"
                              />

                              {row.method === "CASH" ? (
                                <input
                                  value={row.tenderedAmount}
                                  onChange={(e) =>
                                    updateSplitPayment(row.id, {
                                      tenderedAmount: e.target.value.replace(/[^\d.]/g, ""),
                                    })
                                  }
                                  inputMode="numeric"
                                  placeholder="Tendered"
                                  className="h-[32px] rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-mono font-bold text-slate-800 outline-none focus:ring-1 focus:ring-blue-500"
                                />
                              ) : row.method === "FONEPAY" || row.method === "BANK_TRANSFER" ? (
                                <input
                                  value={row.reference || ""}
                                  onChange={(e) =>
                                    updateSplitPayment(row.id, {
                                      reference: e.target.value.slice(0, 160),
                                    })
                                  }
                                  placeholder={row.method === "FONEPAY" ? "Fonepay ref" : "Bank ref"}
                                  className="h-[32px] rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-mono font-bold text-slate-800 outline-none focus:ring-1 focus:ring-blue-500"
                                />
                              ) : (
                                <div className="flex h-[32px] items-center rounded-lg border border-slate-200 bg-emerald-50 px-2 text-[10px] font-bold text-emerald-800">
                                  Online intent
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={() => removeSplitPayment(row.id)}
                                aria-label={`Remove ${row.method === "CASH" ? "cash" : row.method === "ESEWA" ? "eSewa" : row.method === "FONEPAY" ? "Fonepay" : "Bank Transfer"} payment row`}
                                disabled={splitPayments.length <= 1}
                                className="flex h-[32px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-rose-600 disabled:opacity-40"
                              >
                                <Icon name="close" className="text-[14px]" />
                              </button>

                              {(row.method === "FONEPAY" || row.method === "BANK_TRANSFER") && (
                                <div className="md:col-span-4 flex flex-col gap-1.5 pt-1 border-t border-slate-100">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold text-slate-600 shrink-0">
                                      Receiving:
                                    </span>
                                    <ProjectSelect
                                      value={row.receivingAccountId || ""}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        const acc = compatibleAccounts.find((a) => a.id === val);
                                        updateSplitPayment(row.id, {
                                          receivingAccountId: val || undefined,
                                          receivingAccountVersion: acc?.version ?? undefined,
                                          receivingAccountLabel: acc?.providerLabel ?? undefined,
                                          manualReceiptConfirmed: false,
                                        });
                                      }}
                                      className="h-[28px] flex-1 text-[10px] font-medium text-slate-800"
                                    >
                                      <option value="">Receiving destination not recorded</option>
                                      {compatibleAccounts.map((acc) => (
                                        <option key={acc.id} value={acc.id}>
                                          {acc.providerLabel} ({acc.accountIdentifier || acc.accountHolder || "Manual"})
                                        </option>
                                      ))}
                                    </ProjectSelect>
                                  </div>

                                  {row.receivingAccountId ? (
                                    <label className="flex items-center gap-2 text-[10px] font-medium text-slate-700 cursor-pointer pl-1">
                                      <input
                                        type="checkbox"
                                        checked={Boolean(row.manualReceiptConfirmed)}
                                        onChange={(e) =>
                                          updateSplitPayment(row.id, {
                                            manualReceiptConfirmed: e.target.checked,
                                          })
                                        }
                                        className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                      />
                                      <span>
                                        I checked this receiving account and received{" "}
                                        {formatNpr(Number(row.amount) || 0)}
                                      </span>
                                    </label>
                                  ) : null}
                                </div>
                              )}

                              {row.method === "CASH" && rowChange > 0 && (
                                <div className="md:col-span-4 text-[10px] font-bold text-emerald-700">
                                  Return change {formatNpr(rowChange)} for this cash row.
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {splitPayments.some((row) => row.method === "FONEPAY") && (
                      <div className="flex items-start space-x-2.5 p-2 bg-rose-50/50 border border-rose-200/80 rounded-lg">
                        <input
                          type="checkbox"
                          checked={fonepayConfirmed}
                          onChange={(e) => {
                            setFonepayConfirmed(e.target.checked);
                            setReviewedCandidate(null);
                            setPaymentError("");
                          }}
                          id="split-fonepay-confirmed"
                          className="w-4 h-4 mt-0.5 text-rose-600 border-slate-300 rounded focus:ring-rose-500 cursor-pointer"
                        />
                        <label htmlFor="split-fonepay-confirmed" className="text-xs font-medium text-slate-800 select-none cursor-pointer">
                          I have verified the Fonepay merchant payment notification
                        </label>
                      </div>
                    )}

                    {/* Add row buttons */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => addSplitPayment("CASH")}
                        className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 transition-colors"
                      >
                        + Cash
                      </button>
                      <button
                        type="button"
                        onClick={() => addSplitPayment("ESEWA")}
                        disabled={splitPayments.some((row) => row.method === "ESEWA")}
                        className="px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-40 rounded-lg border border-emerald-200 transition-colors"
                      >
                        + eSewa
                      </button>
                      <button
                        type="button"
                        onClick={() => addSplitPayment("FONEPAY")}
                        disabled={splitPayments.some((row) => row.method === "FONEPAY")}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-40 rounded-lg border border-rose-200 transition-colors"
                      >
                        + Fonepay
                      </button>
                      <button
                        type="button"
                        onClick={() => addSplitPayment("BANK_TRANSFER")}
                        className="px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors"
                      >
                        + Bank Transfer row
                      </button>
                    </div>
                  </div>

                  {/* Balanced status banner aligned flush to bottom (no dead whitespace) */}
                  <div
                    className={cn(
                      "flex items-center justify-between p-3.5 rounded-xl border shadow-sm mt-auto",
                      isSplitBalanced
                        ? "bg-emerald-50 border-emerald-200"
                        : "bg-amber-50 border-amber-200",
                    )}
                  >
                    <div className="flex items-center space-x-2.5">
                      <div
                        className={cn(
                          "w-7 h-7 rounded-lg flex items-center justify-center",
                          isSplitBalanced ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
                        )}
                      >
                        <Icon name={isSplitBalanced ? "balance" : "warning"} className="text-[18px]" />
                      </div>
                      <div>
                        <p className={cn("text-xs font-bold", isSplitBalanced ? "text-emerald-950" : "text-amber-950")}>
                          {isSplitBalanced ? "Split Payment Balanced" : "Split Balance Unbalanced"}
                        </p>
                        <p className={cn("text-[10px]", isSplitBalanced ? "text-emerald-800" : "text-amber-800")}>
                          {isSplitBalanced
                            ? "Total allocated equals the payable amount."
                            : splitBalance > 0
                              ? `${formatNpr(splitBalance)} remaining to allocate.`
                              : `${formatNpr(Math.abs(splitBalance))} allocated over total.`}
                        </p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "text-base font-bold font-mono tracking-tight",
                        isSplitBalanced ? "text-emerald-800" : "text-amber-800",
                      )}
                    >
                      {formatNpr(payableTotal)}
                    </span>
                  </div>
                </div>
              )}

              {/* Invoice Note */}
              <div className="pt-2">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-700">
                    Invoice Note <span className="text-[10px] text-slate-400 font-normal">(Optional)</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    {invoiceNote.length} / 120
                  </div>
                </div>
                <input
                  type="text"
                  value={invoiceNote}
                  onChange={(e) => setInvoiceNote(e.target.value.slice(0, 120))}
                  placeholder="Add a short note for this invoice..."
                  className="h-[36px] w-full rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Settlement Summary & Paper Bill Record */}
          <div className="lg:col-span-5 space-y-4">
            {/* Settlement Summary Card */}
            <article className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="flex items-center space-x-1.5">
                  <Icon name="receipt" className="text-[16px] text-slate-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Settlement Summary
                  </h3>
                </div>
                <span className="text-[10px] font-medium text-slate-400 font-mono">NPR</span>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal ({totalItemCount} {totalItemCount === 1 ? "item" : "items"})</span>
                  <span className="font-mono text-slate-800 font-semibold">
                    {formatNpr(subTotal)}
                  </span>
                </div>

                {subtotalDiscount > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>Discount</span>
                    <span className="font-mono font-semibold">
                      -{formatNpr(subtotalDiscount)}
                    </span>
                  </div>
                )}

                {hasPriceOverrides && (
                  <div
                    className={cn(
                      "flex justify-between font-semibold",
                      overrideDiffIsReduction ? "text-rose-600" : "text-amber-600",
                    )}
                  >
                    <span>{overrideDiffLabel}</span>
                    <span className="font-mono">{overrideDiffDisplay}</span>
                  </div>
                )}

                <div className="border-t border-slate-200 pt-1.5 flex justify-between font-bold text-slate-900 text-sm">
                  <span>Payable Total</span>
                  <span className="font-mono text-slate-950 font-bold">
                    {formatNpr(payableTotal)}
                  </span>
                </div>

                {/* Method Specific Breakdown */}
                {paymentMethod === "Split" ? (
                  <>
                    <div className="flex justify-between text-blue-700 pt-1">
                      <span>Cash collected</span>
                      <span className="font-mono font-bold">{formatNpr(splitCashNum)}</span>
                    </div>
                    {splitEsewaAmount > 0 && (
                      <div className="flex justify-between text-emerald-700">
                        <span>eSewa (Pending Gateway)</span>
                        <span className="font-mono font-bold">{formatNpr(splitEsewaAmount)}</span>
                      </div>
                    )}
                    {splitFonepayAmount > 0 && (
                      <div className="flex justify-between text-rose-700">
                        <span>Fonepay amount</span>
                        <span className="font-mono font-bold">{formatNpr(splitFonepayAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-slate-800 border-t border-slate-200 pt-1 font-semibold">
                      <span>Total Allocated</span>
                      <span className="font-mono font-bold">{formatNpr(splitTotal)}</span>
                    </div>
                    {!isSplitBalanced && (
                      <div className="flex justify-between text-amber-700 font-bold">
                        <span>Split balance</span>
                        <span className="font-mono">
                          {splitBalance > 0
                            ? `${formatNpr(splitBalance)} short`
                            : `${formatNpr(Math.abs(splitBalance))} over`}
                        </span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex justify-between font-semibold text-emerald-700 pt-1">
                      <span>Total Collected</span>
                      <span className="font-mono font-bold">{formatNpr(effectivePaidAmount)}</span>
                    </div>
                    {balanceDue > 0 && (
                      <div className="flex justify-between font-semibold text-amber-700">
                        <span>Balance Due</span>
                        <span className="font-mono font-bold">{formatNpr(balanceDue)}</span>
                      </div>
                    )}
                  </>
                )}

                {/* Cash Method Change or Short */}
                {paymentMethod === "Cash" && paymentStatus === "Paid" && (
                  <div
                    className={cn(
                      "flex items-center justify-between rounded-lg border p-2 mt-1",
                      changeDue > 0
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : cashShort > 0
                          ? "bg-amber-50 border-amber-200 text-amber-800"
                          : "bg-white border-slate-200 text-slate-600",
                    )}
                  >
                    <span className="font-bold text-xs">
                      {cashShort > 0 ? "Cash Short" : "Change Due"}
                    </span>
                    <span className="font-mono font-bold text-sm">
                      {formatNpr(cashShort > 0 ? cashShort : changeDue)}
                    </span>
                  </div>
                )}
              </div>

              {/* Status Pill Card */}
              <div
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border p-2.5 mt-2",
                  paymentStateTone === "success"
                    ? "border-emerald-200 bg-emerald-50"
                    : paymentStateTone === "warning"
                      ? "border-amber-200 bg-amber-50"
                      : paymentStateTone === "fonepay"
                        ? "border-rose-200 bg-rose-50"
                        : paymentStateTone === "esewa"
                          ? "border-emerald-200 bg-emerald-50"
                          : "border-slate-200 bg-white",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    paymentStateTone === "success"
                      ? "bg-emerald-100 text-emerald-700"
                      : paymentStateTone === "warning"
                        ? "bg-amber-100 text-amber-700"
                        : paymentStateTone === "fonepay"
                          ? "bg-white text-rose-600"
                          : paymentStateTone === "esewa"
                            ? "bg-white text-emerald-600"
                            : "bg-blue-100 text-blue-700",
                  )}
                >
                  {paymentStateTone === "fonepay" ? (
                    <img
                      src="/assets/images/fonepay.png"
                      alt="Fonepay"
                      className="h-3.5 max-w-[22px] object-contain"
                    />
                  ) : paymentStateTone === "esewa" ? (
                    <img
                      src="/assets/images/esewa/logo.png"
                      alt="eSewa"
                      className="h-4 w-4 object-contain rounded-full"
                    />
                  ) : (
                    <Icon
                      name={
                        paymentMethod === "Split"
                          ? "call_split"
                          : paymentStatus === "Unpaid"
                            ? "receipt_long"
                            : paymentStatus === "Partial"
                              ? "pending_actions"
                              : "task_alt"
                      }
                      className="text-[16px]"
                    />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-900 leading-tight">
                    {paymentStateTitle}
                  </div>
                  <div className="truncate text-[10px] font-medium text-slate-500">
                    {paymentStateDetail}
                  </div>
                </div>
              </div>
            </article>

            {/* Paper Bill Record Card (#FFFBF5 Warm amber card) */}
            <article className="p-4 rounded-xl border border-amber-200 bg-[#FFFBF5] space-y-3 shadow-sm">
              <div className="flex items-start space-x-2">
                <div className="w-7 h-7 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon name="history_edu" className="text-[16px]" />
                </div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-950">
                    Paper Bill Record
                  </h3>
                  <p className="text-[11px] text-amber-800/80">
                    Used to record physical handwritten bill reference.
                  </p>
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="block text-[11px] font-semibold text-slate-700">
                      Manual Bill No.
                    </label>
                    <input
                      type="text"
                      value={paperDraftBillNo}
                      onChange={(e) => setPaperDraftBillNo(e.target.value)}
                      placeholder="e.g. PB-2080-001"
                      className="w-full text-xs font-mono font-bold text-slate-800 bg-white border border-amber-200 rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-amber-500 outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[11px] font-semibold text-slate-700">
                      Document Type
                    </label>
                    <ProjectSelect
                      value={paperDraftDocumentType}
                      onChange={(e) =>
                        setPaperDraftDocumentType(e.target.value as ExternalDocumentType)
                      }
                      className="h-[31px] w-full text-xs font-medium text-slate-800 bg-white border border-amber-200 rounded-lg px-2"
                    >
                      <option value="PAN_INVOICE">PAN Invoice</option>
                      <option value="VAT_TAX_INVOICE">VAT Tax Invoice</option>
                      <option value="ABBREVIATED_TAX_INVOICE">Abbreviated Tax Invoice</option>
                      <option value="OTHER_MANUAL_SALES_DOCUMENT">Other Manual Sales Document</option>
                    </ProjectSelect>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-slate-700">
                    Bill Date
                  </label>
                  <ProjectDateInput
                    value={paperDraftBillDate}
                    onChange={(e) => setPaperDraftBillDate(e.target.value)}
                    className="h-[31px] w-full text-xs font-medium text-slate-800 bg-white border border-amber-200 rounded-lg px-2"
                  />
                </div>

                {paperDraftBillNo.trim() ? (
                  <div className="mt-2 pt-2 border-t border-amber-200/60 flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-700">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="paperDraftChoice"
                        value="RECORD_AFTER_SAVE"
                        checked={paperDraftChoice === "RECORD_AFTER_SAVE"}
                        onChange={() => setPaperDraftChoice("RECORD_AFTER_SAVE")}
                        className="text-amber-600 focus:ring-amber-500"
                      />
                      <span>Record immediately on save</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="paperDraftChoice"
                        value="LATER"
                        checked={paperDraftChoice === "LATER"}
                        onChange={() => setPaperDraftChoice("LATER")}
                        className="text-amber-600 focus:ring-amber-500"
                      />
                      <span>Save for later follow-up</span>
                    </label>
                  </div>
                ) : null}

                {storageLimitationWarning ? (
                  <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] font-medium text-amber-900">
                    <Icon name="warning" className="mr-1 inline text-[13px] text-amber-700" />
                    {storageLimitationWarning}
                  </div>
                ) : null}
              </div>
            </article>
          </div>
        </div>

        {/* Global Payment / Billing Error Banner */}
        {(paymentError || billingError) && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-700 flex items-center space-x-2">
            <Icon name="error" className="text-[16px] text-rose-600 shrink-0" />
            <span>{paymentError || billingError}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
