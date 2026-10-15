import { formatBillingMoney } from "~/lib/billingWorkspace";
import { ModalFrame } from "~/components/ui/Modal";
import React, { useState, useEffect, useRef } from "react";
import Icon from "~/components/ui/Icon";

import {
  getCustomerReceivablesSummaryApi,
  createQuickCustomerApi,
  type CustomerReceivablesSummaryResponse,
} from "~/lib/api/endpoints";

export interface CustomerOption {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  panNo?: string | null;
  address?: string | null;
  loyaltyPercent?: number | null;
  wholesalePercent?: number | null;
}

interface BillingCustomerSummaryProps {
  onOpenQrGallery?: () => void;
  searchOpen: boolean;
  onChangeSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedCustomer: CustomerOption | null;
  onSelectCustomer: (customer: CustomerOption | null) => void;
  customers: CustomerOption[];
  onSearchCustomers?: (query: string) => void;
  searchResults?: CustomerOption[] | null;
  searchLoading?: boolean;
  searchError?: string | null;
  subTotal: number;
  discountLabel?: string;
  discountPercent: number;
  discountAmount: number;
  payableTotal: number;
  onReviewInWorksheet: () => void;
  onOpenCustomerHistory: () => void;
  onOpenDueHistory: () => void;
  cartItemCount: number;
  canReviewWorksheet: boolean;
  canConfirm?: boolean;
  pendingCheckout?: any;
  onPayNow?: () => void;
  recentPurchase?: { productName: string; qty: number; appliedUnitPrice: number; invoiceDate?: string | null };
  paymentMethod: "CASH" | "FONEPAY" | "BANK" | "OTHER";
  onChangePaymentMethod: (value: "CASH" | "FONEPAY" | "BANK") => void;
  amountReceived: string;
  onChangeAmountReceived: (value: string) => void;
}

export default function BillingCustomerSummary({
  searchOpen: isCustomerSearchOpen,
  onChangeSearchOpen: setIsCustomerSearchOpen,
  onOpenQrGallery,
  selectedCustomer,
  onSelectCustomer,
  customers,
  onSearchCustomers,
  searchResults,
  searchLoading,
  searchError,
  subTotal,
  discountLabel,
  discountPercent,
  discountAmount,
  payableTotal,
  onReviewInWorksheet,
  onOpenCustomerHistory,
  onOpenDueHistory,
  cartItemCount,
  canReviewWorksheet,
  canConfirm,
  pendingCheckout,
  onPayNow,
  recentPurchase,
  paymentMethod,
  onChangePaymentMethod: setPaymentMethod,
  amountReceived,
  onChangeAmountReceived: setAmountReceived,
}: BillingCustomerSummaryProps) {
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  // Inline Quick Add Customer State
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [quickAddress, setQuickAddress] = useState("");
  const [quickPan, setQuickPan] = useState("");
  const [quickEmail, setQuickEmail] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [createCustomerError, setCreateCustomerError] = useState<string | null>(null);

  // Payment Selection State matching Mockup
  const numericReceived = parseFloat(amountReceived) || 0;
  const rounding = Math.round((payableTotal-Math.max(0,subTotal-discountAmount))*100)/100;
  const changeDue = Math.max(0, numericReceived - payableTotal);

  // Receivables Summary State (Scoped for Cashier/POS)
  const [receivablesSummary, setReceivablesSummary] = useState<CustomerReceivablesSummaryResponse | null>(null);
  const [loadingReceivables, setLoadingReceivables] = useState(false);
  const [receivablesError, setReceivablesError] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectedCustomer?.id) {
      setReceivablesSummary(null);
      return;
    }

    let isMounted = true;
    setReceivablesSummary(null);
    setReceivablesError(false);
    setLoadingReceivables(true);

    getCustomerReceivablesSummaryApi(selectedCustomer.id)
      .then((res) => {
        if (isMounted) setReceivablesSummary(res);
      })
      .catch((err) => {
        console.warn("Could not load customer receivables summary:", err);
        if (isMounted) { setReceivablesSummary(null); setReceivablesError(true); }
      })
      .finally(() => {
        if (isMounted) setLoadingReceivables(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCustomer?.id]);


  const handleCreateCustomerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateCustomerError(null);

    const trimmedName = quickName.trim();
    const trimmedPhone = quickPhone.trim();
    const trimmedAddress = quickAddress.trim();

    // STRICT VALIDATION: name, phone, address are required!
    if (!trimmedName) {
      setCreateCustomerError("Customer name is required.");
      return;
    }
    if (!trimmedPhone) {
      setCreateCustomerError("Phone number is required.");
      return;
    }
    if (!trimmedAddress) {
      setCreateCustomerError("Customer address is required.");
      return;
    }

    try {
      setCreatingCustomer(true);
      const created = await createQuickCustomerApi({
        name: trimmedName,
        phone: trimmedPhone,
        address: trimmedAddress,
        email: quickEmail.trim() || undefined,
        panNo: quickPan.trim() || undefined,
      });

      onSelectCustomer(created);
      setIsQuickAddOpen(false);
      setIsCustomerSearchOpen(false);
      setQuickName("");
      setQuickPhone("");
      setQuickAddress("");
      setQuickPan("");
      setQuickEmail("");
    } catch (err: any) {
      setCreateCustomerError(err?.message || "Failed to create customer.");
    } finally {
      setCreatingCustomer(false);
    }
  };

  const filteredCustomers = searchResults ?? customers.filter((c) => {
    if (!customerSearchQuery.trim()) return true;
    const q = customerSearchQuery.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.phone && c.phone.includes(q)) ||
      (c.panNo && c.panNo.toLowerCase().includes(q))
    );
  });

  return (
    <div className="billing-summary-stack" data-customer-mode={selectedCustomer?"selected":"walk-in"}><div className="billing-summary-content"><div className="billing-summary-card billing-customer-section">
      {/* Header: Customer & Summary with Change Link */}
      <div className="flex items-center justify-between border-b border-line pb-2">
        <h2 className="text-[14px] font-semibold text-ink">Customer & Summary</h2>
        <button
          type="button"
          onClick={() => {
            setIsCustomerSearchOpen((v) => !v);
          }}
          className="billing-customer-action"
        >
          {isCustomerSearchOpen ? "Close" : selectedCustomer ? "Change" : "Select"}
        </button>
      </div>

      {/* Selected Customer Card or Search Selector */}
      <div className="relative">
        {selectedCustomer && !isCustomerSearchOpen ? (
          <div className="rounded-lg border border-line bg-white p-3 space-y-2 shadow-2xs">
            {/* Top row: Avatar + Name + Subtitle + Close button */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600">
                  <Icon name="person" className="text-[24px]" />
                </div>
                <div>
                  <div className="font-semibold text-[14px] text-ink">
                    {selectedCustomer.name}
                  </div>
                  <div className="text-[12px] text-muted">
                    {selectedCustomer.phone || "No phone"} {selectedCustomer.address ? `· ${selectedCustomer.address}` : ""}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onSelectCustomer(null)}
                className="rounded-md p-1 text-muted hover:bg-inset hover:text-ink transition"
                title="Deselect customer (switch to Walk-In)"
                aria-label="Deselect customer"
              >
                <Icon name="close" className="text-[16px]" />
              </button>
            </div>

            {recentPurchase && <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-950"><div className="flex justify-between gap-2"><span className="font-medium">Recent purchase</span><button type="button" onClick={onOpenCustomerHistory} className="text-blue-700 hover:underline">View history</button></div><p className="mt-1">{recentPurchase.productName} · {recentPurchase.qty} at {formatBillingMoney(recentPurchase.appliedUnitPrice)}{recentPurchase.invoiceDate ? ` · ${new Date(recentPurchase.invoiceDate).toLocaleDateString("en-GB", {timeZone:"Asia/Kathmandu"})}` : ""}</p></div>}

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="rounded-md bg-inset px-2 py-0.5 text-[12px] font-semibold text-muted">
                {selectedCustomer.wholesalePercent ? "Wholesale customer" : "Retail customer"}
              </span>
            </div>

            {/* Debt Separation Invariant: Previous Due Badge */}
            {receivablesError ? <p role="status" className="text-xs text-amber-800">Previous due: unavailable. Open customer history to inspect.</p> : receivablesSummary?.state === "NEEDS_REVIEW" ? <p role="status" className="text-xs text-amber-800">Previous due: needs review</p> : loadingReceivables ? (
              <div className="text-[12px] text-muted flex items-center gap-1 pt-1">
                <Icon name="refresh" className="animate-spin text-[13px]" />
                <span>Checking customer ledger…</span>
              </div>
            ) : receivablesSummary?.hasDue ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-[12px] space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-amber-900 font-medium">
                    <Icon name="account_balance_wallet" className="text-[14px] text-amber-700" />
                    <span>Previous due: Exists</span>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenDueHistory}
                    className="text-[12px] font-medium text-amber-800 underline hover:text-black"
                  >
                    View Invoices &rarr;
                  </button>
                </div>
                <p className="text-[12px] text-amber-800 leading-tight">
                  Previous debt is separate from this sale.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          /* Walk-In Card or Closed Search */
          !isCustomerSearchOpen && (
            <div
              onClick={() => {
                setIsCustomerSearchOpen(true);
                  }}
              className="flex items-center justify-between rounded-lg border border-line bg-inset p-2.5 cursor-pointer hover:bg-inset transition"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e4edf6] text-muted">
                  <Icon name="storefront" className="text-[18px]" />
                </div>
                <div>
                  <div className="font-medium text-[13px] text-ink">Walk-in Customer</div>
                  <div className="text-[12px] text-muted">Standard counter retail sale</div>
                </div>
              </div>
              <span className="text-[12px] font-medium text-blue-600 hover:underline">Select</span>
            </div>
          )
        )}

        {/* Inline Customer Search & Dropdown Picker (Previous familiar UI restored) */}
        <ModalFrame presentation="billing" open={isCustomerSearchOpen} onClose={() => setIsCustomerSearchOpen(false)} title="Choose customer" description="Search the customer directory or create a new customer." maxWidthClass="max-w-[560px]">
          <div className="billing-customer-picker space-y-3">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-muted">
                <Icon name="search" className="text-[16px]" />
              </span>
              <input
                ref={searchInputRef}
                data-modal-initial-focus
                type="text"
                autoFocus
                value={customerSearchQuery}
                onChange={(e) => {
                  setCustomerSearchQuery(e.target.value);
                  if (onSearchCustomers) onSearchCustomers(e.target.value);
                }}
                placeholder="Find by name, phone, or 9-digit PAN..."
                className="w-full rounded-lg border border-line bg-white py-1.5 pl-8 pr-7 text-[13px] font-medium text-ink placeholder-[#8C8889] focus:border-action focus:outline-none"
              />
              {customerSearchQuery && (
                <button
                  type="button"
                  onClick={() => setCustomerSearchQuery("")}
                  className="absolute inset-y-0 right-0 flex items-center pr-2 text-muted hover:text-ink"
                >
                  <Icon name="close" className="text-[14px]" />
                </button>
              )}
            </div>

            {/* List options */}
            <div className="billing-customer-options">
              {/* Option: Walk-in */}
              <button type="button" aria-label="Use walk-in customer"
                onClick={() => {
                  onSelectCustomer(null);
                  setIsCustomerSearchOpen(false);
                }}
                aria-pressed={!selectedCustomer}
                className="billing-customer-option"
              >
                <Icon name="storefront" className="text-[16px] text-muted" />
                <span className="font-medium">Walk-In Customer (Default)</span><span className="billing-option-check" aria-hidden="true">{!selectedCustomer?"●":"○"}</span>
              </button>

              {/* Filtered list */}
              {searchLoading && <p role="status" className="p-3 text-sm text-muted">Searching customers…</p>}
              {searchError && <p role="alert" className="p-3 text-sm text-rose-700">{searchError}</p>}
              {!searchLoading && filteredCustomers.slice(0, 15).map((cust) => (
                <button type="button" aria-label={`Select ${cust.name}`}
                  key={cust.id}
                  aria-pressed={selectedCustomer?.id===cust.id}
                  onClick={() => {
                    onSelectCustomer(cust);
                    setIsCustomerSearchOpen(false);
                  }}
                  className="billing-customer-option text-left"
                >
                  <div className="font-medium text-ink">{cust.name}</div>
                  <div className="text-[12px] text-muted font-sans">
                    {cust.phone || "No phone"} {cust.panNo ? `· PAN: ${cust.panNo}` : ""} {cust.address ? `· ${cust.address}` : ""}
                  </div>
                </button>
              ))}

              {filteredCustomers.length === 0 && customerSearchQuery && (
                <div className="p-2 text-center text-[12px] text-muted">
                  No matching customers found.
                </div>
              )}
            </div>

            {/* Inline Add Customer Expandable Section */}
            <div className="border-t border-line pt-2">
              {!isQuickAddOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsQuickAddOpen(true);
                    setCreateCustomerError(null);
                  }}
                  className="w-full rounded-lg border border-dashed border-[#9CA3AF] px-3 py-2 text-left text-[12px] font-medium text-[#374151] hover:bg-[#F8FAFC] flex items-center justify-center gap-1.5 transition"
                >
                  <Icon name="add" className="text-[14px]" />
                  <span>+ Add a customer</span>
                </button>
              ) : (
                <ModalFrame presentation="billing" open={isQuickAddOpen} dismissOnBackdrop={false} onClose={() => {if(!creatingCustomer){setIsQuickAddOpen(false);requestAnimationFrame(()=>searchInputRef.current?.focus());}}} title="Create customer" description="Full name, phone and address are required." dialogClassName="billing-create-customer" maxWidthClass="max-w-[640px]">
                <form aria-label="New customer" onSubmit={handleCreateCustomerSubmit} className="billing-dialog-form space-y-4">
                  {createCustomerError && (
                    <div role="alert" className="rounded border border-rose-200 bg-rose-50 p-1.5 text-[12px] text-rose-700">
                      {createCustomerError}
                    </div>
                  )}

                  <div>
                    <label htmlFor="billing-customer-name" className="block text-[12px] font-medium text-muted">
                      Full Name <span className="text-rose-600">*</span>
                    </label>
                    <input data-modal-initial-focus id="billing-customer-name"
                      type="text"
                      required
                      value={quickName}
                      onChange={(e) => setQuickName(e.target.value)}
                      placeholder="e.g. Ramesh Shrestha"
                      className="w-full rounded border border-line bg-white px-2 py-1 text-[12px] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label htmlFor="billing-customer-phone" className="block text-[12px] font-medium text-muted">
                      Phone Number <span className="text-rose-600">*</span>
                    </label>
                    <input id="billing-customer-phone"
                      type="text"
                      required
                      value={quickPhone}
                      onChange={(e) => setQuickPhone(e.target.value)}
                      placeholder="e.g. 9841234567"
                      className="w-full rounded border border-line bg-white px-2 py-1 text-[12px] font-sans focus:outline-none"
                    />
                  </div>

                  <div>
                    <label htmlFor="billing-customer-address" className="block text-[12px] font-medium text-muted">
                      Address <span className="text-rose-600">*</span>
                    </label>
                    <input id="billing-customer-address"
                      type="text"
                      required
                      value={quickAddress}
                      onChange={(e) => setQuickAddress(e.target.value)}
                      placeholder="e.g. Kalanki, Kathmandu"
                      className="w-full rounded border border-line bg-white px-2 py-1 text-[12px] focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <label htmlFor="billing-customer-pan" className="block text-[12px] font-medium text-muted">
                        PAN (optional)
                      </label>
                      <input id="billing-customer-pan"
                        type="text"
                        value={quickPan}
                        onChange={(e) => setQuickPan(e.target.value)}
                        placeholder="9-digit PAN"
                        className="w-full rounded border border-line bg-white px-2 py-1 text-[12px] font-sans focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="billing-customer-email" className="block text-[12px] font-medium text-muted">
                        Email (optional)
                      </label>
                      <input id="billing-customer-email"
                        type="email"
                        value={quickEmail}
                        onChange={(e) => setQuickEmail(e.target.value)}
                        placeholder="email@domain.com"
                        className="w-full rounded border border-line bg-white px-2 py-1 text-[12px] focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={creatingCustomer}
                    className="billing-dialog-primary w-full"
                  >
                    {creatingCustomer ? "Saving customer..." : "Save & Select Customer"}
                  </button>
                </form>
                </ModalFrame>
              )}
            </div>
          </div>
        </ModalFrame>
      </div>

      </div>
      {/* Financial Calculations Strip */}
      <div className="billing-summary-card billing-totals-section">
        {!selectedCustomer&&<h3>Totals</h3>}
        <div className="flex items-center justify-between text-[13px] text-muted">
          <span className="billing-summary-label">Subtotal</span>
          <span className="font-sans font-medium">{formatBillingMoney(subTotal)}</span>
        </div>

        {discountAmount > 0 && (
          <div className="flex items-center justify-between text-[13px] text-emerald-700">
            <span>{discountLabel||`Discount (${discountPercent}%)`}</span>
            <span className="font-sans font-medium">- {formatBillingMoney(discountAmount)}</span>
          </div>
        )}

        {rounding !== 0 && <div className="flex items-center justify-between text-sm"><span title="Automatic adjustment to the nearest whole rupee after discount">Rounding adjustment</span><span>{rounding > 0 ? "+" : "−"}{formatBillingMoney(Math.abs(rounding))}</span></div>}
        <div className="flex items-baseline justify-between border-t border-line pt-2">
          <span className="text-[14px] font-semibold text-ink">Total Payable</span>
          <div className="text-right">

            <span className="text-[28px] font-semibold tracking-tight text-ink">
              {formatBillingMoney(payableTotal)}
            </span>
          </div>
        </div>
      </div>

      <div className="billing-summary-card billing-payment-section">
      {/* Payment Method Selector Matching Mockup (Cash, Fonepay, Bank) */}
      <div className="space-y-1.5">
        <label className="billing-payment-heading">
          Payment Method
        </label>
        <div className="billing-payment-methods">
          <button
            type="button"
            aria-pressed={paymentMethod === "CASH"} onClick={() => setPaymentMethod("CASH")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 px-1 text-[12px] font-medium transition shadow-2xs ${
              paymentMethod === "CASH"
                ? "billing-payment-selected"
                : "border border-line bg-white text-ink hover:bg-inset"
            }`}
          >
            <Icon name="payments" className="text-[14px]" />
            <span>Cash</span>
          </button>

          <button
            type="button"
            title="Fonepay" aria-pressed={paymentMethod === "FONEPAY"}
            onClick={() => setPaymentMethod("FONEPAY")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 px-1 text-[12px] font-medium transition shadow-2xs ${
              paymentMethod === "FONEPAY"
                ? "billing-payment-selected"
                : "border border-line bg-white text-ink hover:bg-inset"
            }`}
          >
            <img src="/assets/images/fonepay.png" alt="" className="billing-fonepay-logo" />
            <span className="sr-only">Fonepay</span>
          </button>

          <button
            type="button"
            aria-pressed={paymentMethod === "BANK"} onClick={() => setPaymentMethod("BANK")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 px-1 text-[12px] font-medium transition shadow-2xs ${
              paymentMethod === "BANK"
                ? "billing-payment-selected"
                : "border border-line bg-white text-ink hover:bg-inset"
            }`}
          >
            <Icon name="account_balance" className="text-[14px]" />
            <span>Bank</span>
          </button>
        </div>
      </div>

      {paymentMethod !== "CASH" && onOpenQrGallery && <button type="button" onClick={onOpenQrGallery} className="billing-payment-qr"><Icon name="qr_code_2" sizePx={18}/>View payment QRs</button>}
      {/* Amount Received & Change Due */}
      {paymentMethod === "CASH" ? <><div className="space-y-2 border-t border-line pt-2 text-[13px]">
        <div className="flex items-center justify-between">
          <label htmlFor="billing-cash-received" className="billing-summary-label">Cash received</label>
          <div className="flex w-40 items-center gap-1 rounded-lg border border-line px-2"><span>रु</span>
            <input id="billing-cash-received" min="0" aria-label="Cash received"
              type="number"
              step="any"
              value={amountReceived}
              onChange={(e) => setAmountReceived(e.target.value)}
              className="w-full rounded-lg border border-line px-2.5 py-1 text-right font-sans text-[13px] font-medium text-ink focus:border-action focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="billing-summary-label">Change</span>
          <span className="font-sans text-[16px] font-medium text-[#16A34A]">
            {formatBillingMoney(changeDue)}
          </span>
        </div>
      </div>

      </> : <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Confirm receipt and enter the {paymentMethod === "FONEPAY" ? "Fonepay" : "bank transfer"} reference in payment review.</p>}
      {paymentMethod === "CASH" && <>
      {numericReceived > 0 && numericReceived < payableTotal && <p className="billing-cash-shortfall" role="status">Short by {formatBillingMoney(payableTotal-numericReceived)}. Choose partial payment in payment review.</p>}
      <p className="text-xs text-muted">Cash entry is a draft until the sale is recorded.</p>
      </>}
      {/* Primary Action Button: "RECOVER CHECKOUT" or "PAY NOW" */}
      </div></div><div className="billing-review-action border-t border-line pt-2 space-y-1.5">
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => {
            if (pendingCheckout && onPayNow) {
              onPayNow();
            } else {
              onReviewInWorksheet();
            }
          }}
          className="w-full flex items-center justify-between rounded-lg bg-action px-4 py-3 text-white shadow-md hover:bg-black transition disabled:opacity-40"
        >
          <div className="flex items-center gap-2">
            <Icon name={pendingCheckout ? "sync" : "shopping_bag"} className="text-[18px]" />
            <span className="text-[13px] font-semibold tracking-wide">
              {pendingCheckout ? "Recover checkout" : "Review in Worksheet"}
            </span>
          </div>
          <span className="rounded bg-white/20 px-2 py-0.5 text-[12px] font-sans font-medium text-white">
            Shift + Enter
          </span>
        </button>


      </div>
    </div>
  );
}
