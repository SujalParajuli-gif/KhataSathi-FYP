import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "~/components/ui/Icon";
import {
  listProductsApi,
  listCustomersApi,
  createInvoiceApi,
  addInvoiceItemApi,
  finalizeInvoiceApi,
  addPaymentApi,
} from "~/lib/api/endpoints";

type PaymentMethod = "Cash" | "eSewa";
type PaymentStatus = "Paid" | "Partial" | "Unpaid";

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  adminWholesaleDiscountPercent?: number;
  isLoyalty: boolean;
  loyaltyPercent?: number;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  brand: string;
  retailPrice: number;
  wholesalePrice: number;
  stock: number;
  active: boolean;
  imageColor?: string;
};

type CartLine = {
  productId: string;
  qty: number;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function clampNumber(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function getCustomerDiscountMode(c: Customer | null) {
  if (!c) return "NONE" as const;
  if (typeof c.adminWholesaleDiscountPercent === "number")
    return "CUSTOMER_WHOLESALE" as const;
  if (c.isLoyalty) return "LOYALTY" as const;
  return "NONE" as const;
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
  className,
  size = "md",
  title,
  fullWidth,
}: {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "success";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  title?: string;
  fullWidth?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[14px] font-bold transition-all duration-200 active:scale-[0.96] border focus:outline-none focus:ring-2 focus:ring-offset-2 backdrop-blur-sm";
  const sizes = {
    sm: "px-[12px] py-[8px] text-[12px]",
    md: "px-[16px] py-[11px] text-[13px]",
    lg: "px-[20px] py-[13px] text-[15px]",
    xl: "px-[24px] py-[17px] text-[17px]",
  };
  const styles = {
    primary:
      "bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white border-slate-700 hover:from-slate-800 hover:via-slate-700 hover:to-slate-800 shadow-lg shadow-slate-900/20 hover:shadow-xl hover:shadow-slate-900/30 focus:ring-slate-400",
    secondary:
      "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300 hover:shadow-md shadow-sm focus:ring-slate-300",
    success:
      "bg-gradient-to-br from-emerald-600 to-emerald-700 text-white border-emerald-600 hover:from-emerald-700 hover:to-emerald-800 shadow-lg shadow-emerald-600/25 hover:shadow-xl hover:shadow-emerald-600/35 focus:ring-emerald-300",
    danger:
      "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 hover:border-rose-300 shadow-sm hover:shadow-md focus:ring-rose-200",
    ghost:
      "bg-transparent text-slate-600 border-transparent hover:bg-slate-100 hover:text-slate-900",
  };

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        base,
        sizes[size],
        styles[variant],
        fullWidth && "w-full",
        className,
        disabled && "opacity-40 pointer-events-none grayscale",
      )}
    >
      {icon ? (
        <Icon name={icon} className={children ? "" : "-mx-[2px]"} />
      ) : null}
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  leftIcon,
  className,
  autoFocus,
  onEnter,
  label,
  inputMode,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leftIcon?: string;
  className?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  label?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className={className}>
      {label ? (
        <label className="block text-[11px] font-extrabold text-slate-600 uppercase tracking-wider mb-2 ml-1">
          {label}
        </label>
      ) : null}
      <div className="flex items-center gap-[10px] rounded-[14px] border-2 border-slate-200 bg-white px-[14px] py-[12px] focus-within:ring-2 focus-within:ring-slate-900/10 focus-within:border-slate-400 transition-all duration-200 shadow-sm hover:shadow-md hover:border-slate-300">
        {leftIcon ? (
          <Icon
            name={leftIcon}
            className="text-slate-400 transition-colors"
          />
        ) : null}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          className="w-full text-[14px] outline-none placeholder:text-slate-400 bg-transparent text-slate-900 font-semibold"
        />
      </div>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose" | "purple";
}) {
  const map = {
    neutral: "bg-slate-100 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    orange: "bg-orange-50 text-orange-700 border-orange-200",
    sky: "bg-sky-50 text-sky-700 border-sky-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
  };

  return (
    <span
      className={cn(
        "px-[10px] py-[4px] rounded-[10px] text-[11px] font-extrabold border shadow-sm",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex gap-2 p-1.5 bg-slate-100 rounded-[14px] border-2 border-slate-200 shadow-inner">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 py-2.5 text-[12px] rounded-[11px] font-extrabold transition-all duration-200",
              active
                ? "bg-white text-slate-900 shadow-md scale-[1.02]"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const GRADIENT_COLORS = [
  "bg-gradient-to-br from-orange-100 to-orange-200 text-orange-700",
  "bg-gradient-to-br from-yellow-100 to-yellow-200 text-yellow-700",
  "bg-gradient-to-br from-slate-200 to-slate-300 text-slate-700",
  "bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-700",
  "bg-gradient-to-br from-rose-100 to-rose-200 text-rose-700",
  "bg-gradient-to-br from-amber-100 to-amber-200 text-amber-800",
  "bg-gradient-to-br from-sky-100 to-sky-200 text-sky-700",
  "bg-gradient-to-br from-purple-100 to-purple-200 text-purple-700",
];

export default function BillingPage() {
  const [wholesaleQtyThreshold] = useState(10);
  const [loyaltyDiscountPercent] = useState(2);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [prodData, custData] = await Promise.allSettled([
          listProductsApi({ pageSize: 200, active: "true" }),
          listCustomersApi(),
        ]);

        if (prodData.status === "fulfilled" && prodData.value) {
          const raw = prodData.value.products || [];
          setProducts(
            raw.map((p: any, idx: number) => ({
              id: p.id,
              name: p.name,
              sku: p.sku || "",
              brand: p.brand?.name || "",
              retailPrice: p.retailPrice || 0,
              wholesalePrice: p.wholesalePrice || 0,
              stock: p.stock || 0,
              active: p.isActive !== false,
              imageColor: GRADIENT_COLORS[idx % GRADIENT_COLORS.length],
            })),
          );
        }

        if (custData.status === "fulfilled" && custData.value) {
          const raw = Array.isArray(custData.value)
            ? custData.value
            : custData.value.customers || [];
          setCustomers(
            raw.map((c: any) => ({
              id: c.id,
              name: c.name,
              phone: c.phone || "",
              email: c.email,
              adminWholesaleDiscountPercent:
                typeof c.wholesalePercent === "number" && c.wholesalePercent > 0
                  ? c.wholesalePercent
                  : undefined,
              isLoyalty: (c.loyaltyPercent || 0) > 0,
              loyaltyPercent: c.loyaltyPercent,
            })),
          );
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const quickGrid = useMemo(
    () => products.filter((p) => p.active).slice(0, 12),
    [products],
  );

  const [skuInput, setSkuInput] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [isCustomerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Paid");
  const [paidAmount, setPaidAmount] = useState<string>("");
  const [digitalRef, setDigitalRef] = useState("");

  const cartEndRef = useRef<HTMLDivElement>(null);
  const skuRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (cart.length > 0) {
      cartEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [cart.length]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [selectedCustomerId, customers],
  );

  const customerMode = getCustomerDiscountMode(selectedCustomer);

  const customerWholesalePct = useMemo(() => {
    if (typeof selectedCustomer?.adminWholesaleDiscountPercent !== "number")
      return undefined;
    return clampPercent(selectedCustomer.adminWholesaleDiscountPercent);
  }, [selectedCustomer]);

  const customerListFiltered = useMemo(() => {
    const s = customerQuery.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) =>
      (c.name + " " + c.phone).toLowerCase().includes(s),
    );
  }, [customers, customerQuery]);

  const productListFiltered = useMemo(() => {
    const s = productQuery.trim().toLowerCase();
    if (!s) return products.filter((p) => p.active);
    return products.filter(
      (p) => p.active && (p.name + p.sku + p.brand).toLowerCase().includes(s),
    );
  }, [products, productQuery]);

  const cartRows = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    return cart
      .map((line) => {
        const p = byId.get(line.productId);
        if (!p) return null;
        const useWholesalePrice =
          typeof customerWholesalePct !== "number" &&
          line.qty >= wholesaleQtyThreshold;
        const unit = useWholesalePrice ? p.wholesalePrice : p.retailPrice;
        return {
          ...line,
          product: p,
          unitPrice: unit,
          priceType: useWholesalePrice ? "Wholesale" : "Retail",
          lineTotal: unit * line.qty,
        };
      })
      .filter(Boolean) as Array<{
      productId: string;
      qty: number;
      product: Product;
      unitPrice: number;
      priceType: "Wholesale" | "Retail";
      lineTotal: number;
    }>;
  }, [cart, products, customerWholesalePct, wholesaleQtyThreshold]);

  const subTotal = cartRows.reduce((a, r) => a + r.lineTotal, 0);

  const subtotalDiscount = useMemo(() => {
    if (typeof customerWholesalePct === "number")
      return Math.round((subTotal * customerWholesalePct) / 100);
    if (selectedCustomer?.isLoyalty)
      return Math.round((subTotal * loyaltyDiscountPercent) / 100);
    return 0;
  }, [subTotal, customerWholesalePct, selectedCustomer, loyaltyDiscountPercent]);

  const grandTotal = Math.max(0, subTotal - subtotalDiscount);

  const paidNum = useMemo(() => {
    const n = Number(paidAmount);
    if (!Number.isFinite(n)) return 0;
    return n;
  }, [paidAmount]);

  const effectivePaidAmount =
    paymentStatus === "Paid"
      ? grandTotal
      : paymentStatus === "Unpaid"
        ? 0
        : clampNumber(paidNum, 0, grandTotal);

  const balanceDue = Math.max(0, grandTotal - effectivePaidAmount);

  const showEsewaDetails =
    paymentMethod === "eSewa" && paymentStatus !== "Unpaid";

  const canConfirm = cartRows.length > 0 && !submitting;

  function addToCart(productId: string, qty = 1) {
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.productId === productId);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + qty };
        return copy;
      }
      return [...prev, { productId, qty }];
    });
    setProductQuery("");
    skuRef.current?.focus();
  }

  function changeQty(productId: string, val: number) {
    setCart((prev) =>
      prev.map((x) =>
        x.productId === productId ? { ...x, qty: Math.max(1, val) } : x,
      ),
    );
  }

  function removeLine(productId: string) {
    setCart((prev) => prev.filter((x) => x.productId !== productId));
  }

  function addBySku() {
    const s = skuInput.trim();
    if (!s) return;
    const p = products.find((x) => x.active && x.sku === s);
    if (p) {
      addToCart(p.id, 1);
      setSkuInput("");
    }
  }

  function resetBill() {
    setCart([]);
    setSelectedCustomerId(null);
    setPaymentMethod("Cash");
    setPaymentStatus("Paid");
    setPaidAmount("");
    setSkuInput("");
    setProductQuery("");
    setDigitalRef("");
    setCustomerSearchOpen(false);
    setCustomerQuery("");
    skuRef.current?.focus();
  }

  async function confirm() {
    if (!canConfirm) return;
    setSubmitting(true);

    try {
      const invoiceRes = await createInvoiceApi(
        selectedCustomerId || undefined,
      );
      const invoiceId = invoiceRes.id || invoiceRes.invoice?.id;

      if (!invoiceId) {
        setSubmitting(false);
        return;
      }

      for (const line of cartRows) {
        await addInvoiceItemApi(invoiceId, line.productId, line.qty, line.unitPrice);
      }

      await finalizeInvoiceApi(invoiceId, subtotalDiscount);

      if (paymentStatus !== "Unpaid") {
        const method =
          paymentMethod === "eSewa" ? "ESEWA" : "CASH";
        await addPaymentApi(invoiceId, {
          method,
          amount: effectivePaidAmount,
          reference: digitalRef || undefined,
        });
      }

      resetBill();
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err) {
      console.error("Billing confirm error:", err);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function isTypingTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        skuRef.current?.focus();
        return;
      }
      if (e.key === "F4") {
        e.preventDefault();
        setPaymentMethod("Cash");
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        setPaymentMethod("eSewa");
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        resetBill();
        return;
      }
      if (e.key === "Enter") {
        if (!canConfirm) return;
        e.preventDefault();
        confirm();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canConfirm,
    grandTotal,
    paymentMethod,
    paymentStatus,
    digitalRef,
    balanceDue,
    effectivePaidAmount,
    showEsewaDetails,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[90vh]">
        <div className="text-slate-400 font-semibold">Loading billing data...</div>
      </div>
    );
  }

  return (
    <>
    <div className="w-full h-[90vh] bg-gradient-to-br from-slate-100 via-slate-50 to-slate-100 flex flex-col md:flex-row overflow-hidden font-sans text-slate-800 rounded-[24px] shadow-2xl border-2 border-slate-200 relative">
      <div className="flex-1 flex flex-col min-w-0 bg-gradient-to-br from-white to-slate-50 border-r-2 border-slate-200">
        <div className="p-5 bg-white/80 backdrop-blur-md border-b-2 border-slate-200 shadow-lg shadow-slate-900/5">
          <div className="grid grid-cols-12 gap-4 items-end">
            <div className="col-span-4">
              <Input
                label="Scan SKU"
                value={skuInput}
                onChange={setSkuInput}
                placeholder="Barcode / SKU"
                leftIcon="qr_code_scanner"
                onEnter={addBySku}
                className="font-mono"
                inputRef={skuRef}
                autoFocus
              />
            </div>

            <div className="col-span-8 relative">
              <Input
                label="Search"
                value={productQuery}
                onChange={setProductQuery}
                placeholder="Search product name, brand..."
                leftIcon="search"
                inputRef={searchRef}
              />

              {productQuery ? (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl border-2 border-slate-200 max-h-[420px] overflow-y-auto z-50">
                  {productListFiltered.length === 0 ? (
                    <div className="p-8 text-center text-slate-500 font-medium">
                      No products found
                    </div>
                  ) : (
                    <div className="p-3 space-y-2">
                      {productListFiltered.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => addToCart(p.id)}
                          className="w-full text-left p-4 hover:bg-gradient-to-r hover:from-slate-50 hover:to-slate-100 rounded-xl flex items-center justify-between gap-4 group transition-all duration-200 border border-transparent hover:border-slate-200 hover:shadow-md"
                        >
                          <div className="min-w-0">
                            <div className="font-extrabold text-slate-800 truncate text-[15px]">
                              {p.name}
                            </div>
                            <div className="text-xs text-slate-500 truncate mt-1">
                              {p.brand} • SKU: {p.sku} • Stock: {p.stock}
                            </div>
                          </div>
                          <div className="flex items-center gap-4 shrink-0">
                            <span className="font-mono font-bold text-slate-700 text-[14px]">
                              {formatNpr(p.retailPrice)}
                            </span>
                            <div className="bg-slate-100 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold group-hover:bg-slate-900 group-hover:text-white transition-all duration-200 shadow-sm">
                              Add
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Pill tone="sky">Quick Select</Pill>
              <div className="text-xs text-slate-500 font-medium">
                Tap tiles to add faster than typing.
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {selectedCustomer ? (
                <Pill tone="purple">
                  Customer: {selectedCustomer.name.split(" ")[0]}
                </Pill>
              ) : (
                <Pill tone="neutral">Guest</Pill>
              )}

              {customerMode === "CUSTOMER_WHOLESALE" ? (
                <Pill tone="orange">Subtotal wholesale %</Pill>
              ) : selectedCustomer?.isLoyalty ? (
                <Pill tone="green">Loyalty {loyaltyDiscountPercent}%</Pill>
              ) : (
                <Pill tone="neutral">
                  Wholesale qty ≥ {wholesaleQtyThreshold}
                </Pill>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 bg-gradient-to-br from-slate-50/70 to-white/70">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-slate-600 uppercase tracking-wide">
              Quick Select
            </h3>
            <div className="text-xs text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full font-bold border border-slate-200">
              Showing {quickGrid.length} items
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {quickGrid.map((p) => {
              const low = p.stock <= 10;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addToCart(p.id)}
                  className="relative flex flex-col items-start text-left p-5 rounded-2xl border-2 border-slate-200 bg-white shadow-md hover:shadow-xl hover:border-slate-300 hover:-translate-y-1 transition-all duration-200 active:scale-[0.97] h-[122px] group overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-transparent to-slate-50/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />
                  <div className="flex items-start justify-between w-full gap-2 relative z-10">
                    <div className="min-w-0">
                      <div className="font-extrabold text-slate-800 leading-tight line-clamp-2 text-[14px]">
                        {p.name}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1.5 truncate font-medium">
                        {p.brand} • {p.sku}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <div
                        className={cn(
                          "h-10 w-10 rounded-xl border-2 flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform duration-200",
                          p.imageColor ||
                            "bg-gradient-to-br from-slate-100 to-slate-200 text-slate-700",
                          "border-white",
                        )}
                        aria-hidden="true"
                      >
                        <Icon name="inventory_2" />
                      </div>
                      <div
                        className={cn(
                          "h-2.5 w-2.5 rounded-full shadow-sm",
                          low ? "bg-rose-500 animate-pulse" : "bg-emerald-500",
                        )}
                        title={low ? "Low stock" : "In stock"}
                      />
                    </div>
                  </div>
                  <div className="w-full flex items-end justify-between mt-auto relative z-10">
                    <div className="text-[10px] text-slate-600 font-bold bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200 shadow-sm">
                      Stock {p.stock}
                    </div>
                    <div className="font-mono font-extrabold text-slate-800 text-[14px]">
                      {formatNpr(p.retailPrice)}
                    </div>
                  </div>
                  {low ? (
                    <div className="absolute top-4 left-4 z-10">
                      <Pill tone="rose">LOW</Pill>
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          {quickGrid.length === 0 ? (
            <div className="h-[160px] flex items-center justify-center text-slate-400 text-sm font-medium">
              No items available
            </div>
          ) : null}
        </div>
      </div>

      <div className="w-full md:w-[420px] flex flex-col bg-white shadow-2xl relative z-20 border-l border-slate-100">
        <div className="flex-shrink-0 p-4 border-b-2 border-slate-100 bg-gradient-to-br from-slate-50/50 to-white">
          {!isCustomerSearchOpen ? (
            <div className="flex items-center justify-between bg-white border-2 border-slate-200 rounded-2xl p-3 shadow-md hover:shadow-lg transition-shadow duration-200">
              <div className="flex items-center gap-3 overflow-hidden">
                <div
                  className={cn(
                    "w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0 border-2 shadow-sm",
                    selectedCustomer
                      ? "bg-gradient-to-br from-indigo-50 to-indigo-100 text-indigo-700 border-indigo-200"
                      : "bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500 border-slate-300",
                  )}
                >
                  <Icon
                    name={selectedCustomer ? "person" : "person_off"}
                  />
                </div>
                <div className="min-w-0">
                  <div className="font-extrabold text-slate-900 truncate text-[15px]">
                    {selectedCustomer
                      ? selectedCustomer.name
                      : "Walk-in Customer"}
                  </div>
                  <div className="text-xs text-slate-500 truncate flex items-center gap-2 mt-0.5">
                    {selectedCustomer
                      ? selectedCustomer.phone
                      : "No customer selected"}
                    {selectedCustomer?.isLoyalty ? (
                      <Icon
                        name="verified"
                        className="text-[13px] text-emerald-500"
                      />
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {customerMode === "CUSTOMER_WHOLESALE" ? (
                      <Pill tone="orange">
                        Wholesale {customerWholesalePct}%
                      </Pill>
                    ) : null}
                    {selectedCustomer?.isLoyalty ? (
                      <Pill tone="green">Loyalty</Pill>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedCustomer ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="close"
                    title="Clear customer"
                    onClick={() => setSelectedCustomerId(null)}
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  title="Select customer"
                  onClick={() => setCustomerSearchOpen(true)}
                />
              </div>
            </div>
          ) : (
            <div className="bg-white border-2 border-indigo-300 rounded-2xl p-3 shadow-lg">
              <div className="flex items-center gap-2 mb-3">
                <Input
                  value={customerQuery}
                  onChange={setCustomerQuery}
                  placeholder="Find customer..."
                  autoFocus
                  leftIcon="search"
                  className="flex-1"
                />
                <Button
                  size="sm"
                  icon="close"
                  onClick={() => setCustomerSearchOpen(false)}
                  title="Close"
                />
              </div>
              <div className="max-h-[160px] overflow-y-auto space-y-1.5">
                {customerListFiltered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelectedCustomerId(c.id);
                      setCustomerSearchOpen(false);
                    }}
                    className="w-full text-left px-3 py-2.5 text-sm hover:bg-indigo-50 rounded-xl flex justify-between items-center transition-colors duration-150 border border-transparent hover:border-indigo-100"
                  >
                    <span className="font-semibold text-slate-800">
                      {c.name}
                    </span>
                    <span className="text-slate-400 font-medium">
                      {c.phone}
                    </span>
                  </button>
                ))}
                {customerListFiltered.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 text-center font-medium">
                    No results
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-slate-50/30 p-3 space-y-2 relative">
          {cartRows.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 select-none">
              <Icon
                name="receipt_long"
                className="text-7xl mb-3 opacity-20"
              />
              <p className="font-bold text-[15px]">Ticket Empty</p>
              <p className="text-xs mt-1">Add items to start billing</p>
            </div>
          ) : (
            cartRows.map((row) => (
              <div
                key={row.productId}
                className="group relative flex items-center gap-2.5 p-2.5 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-white transition-all duration-200 bg-slate-50/50 shadow-sm hover:shadow-md"
              >
                <div className="flex flex-col items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => changeQty(row.productId, row.qty + 1)}
                    className="w-6 h-6 rounded-lg bg-white border border-slate-300 text-slate-600 flex items-center justify-center hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-all duration-150 text-xs font-bold shadow-sm active:scale-90"
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                  <span className="text-xs font-extrabold w-6 text-center text-slate-900">
                    {row.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => changeQty(row.productId, row.qty - 1)}
                    disabled={row.qty <= 1}
                    className="w-6 h-6 rounded-lg bg-white border border-slate-300 text-slate-600 flex items-center justify-center hover:bg-rose-500 hover:text-white hover:border-rose-500 transition-all duration-150 disabled:opacity-30 text-xs font-bold shadow-sm active:scale-90"
                    aria-label="Decrease quantity"
                  >
                    -
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="font-bold text-slate-900 leading-tight truncate text-[13px]">
                      {row.product.name}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-slate-500 font-medium">
                      <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                        {formatNpr(row.unitPrice)}/u
                      </span>
                      {row.priceType === "Wholesale" ? (
                        <span className="font-extrabold text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded border border-sky-200">
                          WHL
                        </span>
                      ) : null}
                      <span className="text-slate-400">
                        SKU {row.product.sku}
                      </span>
                    </div>
                    <div className="font-mono font-extrabold text-slate-900 text-[14px] shrink-0">
                      {formatNpr(row.lineTotal)}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(row.productId)}
                  className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-500 hover:text-white flex items-center justify-center transition-all duration-150 border border-rose-200 hover:border-rose-500 shadow-sm shrink-0 active:scale-90"
                  title="Remove"
                  aria-label="Remove item"
                >
                  <Icon name="close" className="text-[14px]" />
                </button>
              </div>
            ))
          )}
          <div ref={cartEndRef} />
        </div>

        <div className="flex-shrink-0 bg-white border-t border-slate-200 shadow-[0_-6px_22px_rgba(0,0,0,0.06)]">
          <div className="px-5 pt-4 pb-3 space-y-2 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <span className="font-mono font-bold">{formatNpr(subTotal)}</span>
            </div>
            {subtotalDiscount > 0 ? (
              <div className="flex justify-between text-rose-600">
                <span className="flex items-center gap-1 font-bold">
                  <Icon name="local_offer" className="text-[14px]" />
                  Discount
                </span>
                <span className="font-mono font-extrabold">
                  -{formatNpr(subtotalDiscount)}
                </span>
              </div>
            ) : null}
            <div className="border-t border-dashed border-slate-300 my-2" />
            <div className="flex justify-between items-end">
              <span className="text-slate-900 font-extrabold text-lg">
                Total
              </span>
              <span className="font-mono font-extrabold text-3xl text-slate-900 tracking-tight">
                {formatNpr(grandTotal)}
              </span>
            </div>
            {paymentStatus === "Partial" ? (
              <div className="flex justify-between text-xs px-3 py-2 bg-rose-50 border border-rose-100 rounded-xl text-rose-700">
                <span>Balance Due</span>
                <span className="font-extrabold font-mono">
                  {formatNpr(balanceDue)}
                </span>
              </div>
            ) : null}
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-200 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentMethod("Cash")}
                className={cn(
                  "flex flex-col items-center justify-center p-3 rounded-2xl border transition-all",
                  paymentMethod === "Cash"
                    ? "bg-slate-900 text-white border-slate-900 shadow-md ring-2 ring-slate-200"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100",
                )}
              >
                <Icon name="payments" />
                <span className="text-xs font-extrabold mt-1">CASH</span>
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod("eSewa")}
                className={cn(
                  "flex flex-col items-center justify-center p-3 rounded-2xl border transition-all",
                  paymentMethod === "eSewa"
                    ? "bg-emerald-600 text-white border-emerald-600 shadow-md ring-2 ring-emerald-100"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100",
                )}
              >
                <Icon name="qr_code_2" />
                <span className="text-xs font-extrabold mt-1">ESEWA</span>
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">
                  Payment Status
                </div>
                {paymentMethod === "eSewa" ? (
                  <div className="text-[11px] font-bold text-slate-500">
                    Sandbox record
                  </div>
                ) : null}
              </div>
              <Segmented
                value={paymentStatus}
                onChange={(v) => {
                  setPaymentStatus(v as PaymentStatus);
                  if (v !== "Partial") setPaidAmount("");
                }}
                options={[
                  { value: "Paid", label: "Paid" },
                  { value: "Partial", label: "Partial" },
                  { value: "Unpaid", label: "Unpaid" },
                ]}
              />
            </div>

            {paymentStatus === "Partial" ? (
              <Input
                label="Amount paid"
                value={paidAmount}
                onChange={(v) => setPaidAmount(v.replace(/[^\d.]/g, ""))}
                placeholder="e.g. 500"
                leftIcon="currency_rupee"
                inputMode="numeric"
              />
            ) : null}

            {showEsewaDetails ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[12px] font-extrabold text-emerald-900">
                      eSewa Payment (Sandbox)
                    </div>
                    <div className="text-[11px] text-emerald-800/80 mt-1">
                      Record the eSewa transaction reference below.
                    </div>
                  </div>
                  <Pill tone="green">QR</Pill>
                </div>
                <div className="mt-3 grid grid-cols-[92px_1fr] gap-3 items-center">
                  <div className="rounded-2xl bg-white border border-emerald-200 p-2 flex items-center justify-center">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=KHATASATHI-ESEWA-SANDBOX|AMOUNT:${
                        paymentStatus === "Partial"
                          ? Math.round(effectivePaidAmount)
                          : Math.round(grandTotal)
                      }`}
                      alt="eSewa QR"
                      className="h-[86px] w-[86px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-[11px] text-emerald-900/80">
                      Amount:{" "}
                      <span className="font-extrabold">
                        {formatNpr(
                          paymentStatus === "Partial"
                            ? effectivePaidAmount
                            : grandTotal,
                        )}
                      </span>
                    </div>
                    <Input
                      label="Transaction ref"
                      value={digitalRef}
                      onChange={setDigitalRef}
                      placeholder="e.g. ESW-7X889..."
                      leftIcon="receipt"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1 border border-slate-300 text-slate-600"
                onClick={resetBill}
                disabled={
                  !canConfirm && !selectedCustomer && !skuInput && !productQuery
                }
                icon="restart_alt"
              >
                Reset
              </Button>
              <Button
                variant={paymentMethod === "eSewa" ? "success" : "primary"}
                className="flex-[2]"
                size="lg"
                icon={
                  paymentStatus === "Unpaid" ? "receipt_long" : "check_circle"
                }
                disabled={!canConfirm}
                onClick={confirm}
              >
                {submitting
                  ? "Creating..."
                  : paymentStatus === "Paid"
                    ? `Pay ${formatNpr(grandTotal)}`
                    : paymentStatus === "Partial"
                      ? `Confirm (${formatNpr(effectivePaidAmount)})`
                      : "Create Unpaid Invoice"}
              </Button>
            </div>

            <div className="pt-2 text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
              <span className="font-semibold">Shortcuts:</span>
              <span>F2 Search</span>
              <span>F3 SKU</span>
              <span>F4 Cash</span>
              <span>F5 eSewa</span>
              <span>F9 Reset</span>
              <span>Enter Confirm</span>
            </div>
          </div>
        </div>
      </div>
    </div>

      {showSuccess && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 shadow-lg">
            <span className="material-symbols-rounded text-emerald-600" style={{ fontSize: "22px" }}>check_circle</span>
            <span className="text-[14px] font-semibold text-emerald-800">Invoice created successfully!</span>
          </div>
        </div>
      )}
    </>
  );
}
