import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "~/components/ui/Icon";
import ProductImage from "~/components/ui/ProductImage";
import { DialogButton, ModalFrame, SuccessDialog } from "~/components/ui/Modal";
import {
  listProductsApi,
  listCustomersApi,
  createInvoiceApi,
  addInvoiceItemApi,
  finalizeInvoiceApi,
  addPaymentApi,
  initiateEsewaPaymentApi,
} from "~/lib/api/endpoints";
import { submitEsewaForm } from "~/lib/esewa";
import { openInvoicePrint } from "~/lib/invoices";

type PaymentMethod = "Cash" | "eSewa";
type PaymentStatus = "Paid" | "Partial" | "Unpaid";

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  isLoyalty: boolean;
  loyaltyPercent?: number;
  wholesalePercent?: number;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  brand: string;
  retailPrice: number;
  wholesalePrice: number;
  wholesaleQtyThreshold?: number;
  stock: number;
  lowStockThreshold?: number;
  active: boolean;
  imageUrl?: string;
  imageColor?: string;
};

type CartLine = {
  productId: string;
  qty: number;
};

type StoredBillingCart = {
  cart: CartLine[];
  savedAt: string;
};

const BILLING_CART_STORAGE_KEY = "khatasathi_billing_cart";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// reading the saved billing cart from localStorage lets us restore the cashier's cart after route changes
// invalid or corrupted payloads are discarded so they do not break the billing screen
function readStoredBillingCart() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(BILLING_CART_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredBillingCart> | null;
    if (!parsed || !Array.isArray(parsed.cart)) {
      window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
      return null;
    }

    const normalizedCart = parsed.cart
      .map((line) => {
        const productId = String(line?.productId || "").trim();
        const qty = Math.floor(Number(line?.qty || 0));

        if (!productId || !Number.isFinite(qty) || qty < 1) {
          return null;
        }

        return { productId, qty };
      })
      .filter(Boolean) as CartLine[];

    if (normalizedCart.length === 0) {
      window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
      return null;
    }

    return {
      cart: normalizedCart,
      savedAt:
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : new Date().toISOString(),
    };
  } catch {
    window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
    return null;
  }
}

// saving only the cart lines keeps the persisted billing payload small and focused on what the cashier expects to keep
function writeStoredBillingCart(cart: CartLine[]) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    BILLING_CART_STORAGE_KEY,
    JSON.stringify({
      cart,
      savedAt: new Date().toISOString(),
    } satisfies StoredBillingCart),
  );
}

// clearing the stored billing cart is used after successful checkout and whenever the cashier intentionally empties the cart
function clearStoredBillingCart() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BILLING_CART_STORAGE_KEY);
}

// we use this to format numbers as Nepalese Rupees (NPR)
// without this it looks like plain text "1500" instead of "NPR 1,500"
function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

// we use this to keep percentages between 0 and 100
// so an admin can't accidentally type a 200% discount and break the math
function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// same idea as clampPercent but for random minimums and maximums
function clampNumber(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

// this checks what kind of discount the selected customer gets
// we prioritize admin wholesale first, then fallback to loyalty
function getCustomerDiscountMode(c: Customer | null) {
  if (!c) return "NONE" as const;
  if ((c.wholesalePercent || 0) > 0) return "ADMIN_WHOLESALE" as const;
  if ((c.loyaltyPercent || 0) > 0) return "LOYALTY" as const;
  return "NONE" as const;
}

// wholesale pricing has two modes that cannot both be active at the same time:
// 1. customer-level wholesale % — admin assigns a discount percent to the customer
// 2. qty-based wholesale — the product switches to wholesale price if quantity meets the threshold
// this function only handles case 2, and it returns false when case 1 is active
// because both modes applying together would give a double discount
function shouldUseQuantityWholesalePrice(
  customer: Customer | null,
  product: Product,
  qty: number,
) {
  const hasCustomerWholesale =
    clampPercent(customer?.wholesalePercent || 0) > 0;
  if (hasCustomerWholesale) return false;
  return qty >= Math.max(1, product.wholesaleQtyThreshold || 1);
}

function getSubtotalDiscountMeta(customer: Customer | null) {
  // this decides which subtotal-level discount label and helper text should be shown in the billing summary
  const wholesalePercent = clampPercent(customer?.wholesalePercent || 0);
  if (wholesalePercent > 0) {
    return {
      mode: "ADMIN_WHOLESALE" as const,
      percent: wholesalePercent,
      label: `Customer Wholesale (${wholesalePercent}%)`,
      helper:
        "Customer wholesale discount is applied on subtotal and disables quantity-based wholesale pricing.",
    };
  }

  const loyaltyPercent = clampPercent(customer?.loyaltyPercent || 0);
  if (loyaltyPercent > 0) {
    return {
      mode: "LOYALTY" as const,
      percent: loyaltyPercent,
      label: `Loyalty Discount (${loyaltyPercent}%)`,
      helper:
        "Quantity-based wholesale pricing can still apply on items before loyalty is deducted from subtotal.",
    };
  }

  return {
    mode: "NONE" as const,
    percent: 0,
    label: "Discount",
    helper: "No customer-specific subtotal discount is active.",
  };
}

// this is the shared button component used across the billing page and payment modal
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
    "inline-flex items-center justify-center gap-[8px] rounded-[14px] border font-bold transition active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2";
  const sizes = {
    sm: "px-[12px] py-[8px] text-[12px]",
    md: "px-[16px] py-[11px] text-[13px]",
    lg: "px-[20px] py-[13px] text-[15px]",
    xl: "px-[24px] py-[17px] text-[17px]",
  };
  const styles = {
    primary:
      "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27] focus:ring-slate-300",
    secondary:
      "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000] focus:ring-slate-200",
    success:
      "border-[#9DD8B2] bg-[#179B4D] text-white hover:bg-[#138441] focus:ring-emerald-200",
    danger:
      "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100 focus:ring-rose-200",
    ghost:
      "border-transparent bg-transparent text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
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

// this is the shared text input used for scanner input, search, and payment amount fields
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
  invalid,
  helperText,
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
  invalid?: boolean;
  helperText?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <label className="block text-[11px] font-extrabold text-slate-600 uppercase  mb-2 ml-1">
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          "flex items-center gap-[10px] rounded-[14px] border bg-white px-[14px] py-[12px] transition",
          invalid
            ? "border-rose-300 focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-100"
            : "border-[#CFCFD3] focus-within:border-[#11120d] focus-within:ring-2 focus-within:ring-black/5",
        )}
      >
        {leftIcon ? (
          <Icon name={leftIcon} className="text-slate-400 transition-colors" />
        ) : null}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          onKeyDown={(e) => {
            // this handles Enter for fields that should trigger an immediate billing action
            if (e.key === "Enter" && onEnter) onEnter();
          }}
          className="w-full text-[14px] outline-none placeholder:text-slate-400 bg-transparent text-slate-900 font-semibold"
        />
      </div>
      {helperText ? (
        <div
          className={cn(
            "mt-2 ml-1 text-[12px] font-semibold",
            invalid ? "text-rose-600" : "text-slate-500",
          )}
        >
          {helperText}
        </div>
      ) : null}
    </div>
  );
}

// this renders the small status badges used for customer mode, payment hints, and stock indicators
function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose" | "purple";
}) {
  const map = {
    neutral: "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]",
    green: "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]",
    orange: "bg-[#FFF7E8] text-[#B7791F] border-[#F6D28B]",
    sky: "bg-slate-100 text-slate-700 border-slate-200",
    rose: "bg-[#FFF1F2] text-[#BE123C] border-[#FECDD3]",
    purple: "bg-slate-100 text-slate-700 border-slate-200",
  };

  return (
    <span
      className={cn(
        "rounded-[10px] border px-[10px] py-[4px] text-[11px] font-extrabold whitespace-nowrap",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

// this segmented control is used for payment method and payment status switches inside the modal
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
    <div className="flex gap-2 rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-[6px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-[11px] py-2.5 text-[12px] font-extrabold transition",
              active
                ? "bg-[#FFFFFF] text-[#000000] "
                : "text-[#8C8889] hover:bg-[rgba(255,255,255,0.8)] hover:text-[#000000]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// the POS billing module
// we wrote this to handle adding items to a cart, selecting customers, applying discounts, and generating invoices
export default function BillingPage() {
  const [customers, setCustomers] = useState<Customer[]>([]); // full customer list available for billing selection
  const [products, setProducts] = useState<Product[]>([]); // active product list loaded for cart and search
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [submitting, setSubmitting] = useState(false); // blocks repeated invoice creation while checkout is running
  const [showSuccess, setShowSuccess] = useState(false); // controls the success dialog after a bill is created
  const [lastCreatedInvoiceId, setLastCreatedInvoiceId] = useState<
    string | null
  >(null); // saved so the success dialog can open the correct invoice for print

  // fetching products and customers when the page first loads
  // we use Promise.allSettled so one failing API call does not block the other from completing
  useEffect(() => {
    async function load() {
      try {
        async function fetchAllActiveProducts() {
          // this loops through every products page because the billing screen needs the full active catalog for search and barcode scans
          const pageSize = 300;
          let page = 1;
          let total = 0;
          const collected: any[] = [];

          do {
            const response = await listProductsApi({
              page,
              pageSize,
              active: "true",
            });
            const items = Array.isArray(response?.products)
              ? response.products
              : [];
            collected.push(...items);
            total = Number(response?.total ?? collected.length);
            page += 1;

            if (items.length === 0) break;
          } while (collected.length < total);

          return collected;
        }

        const [prodData, custData] = await Promise.allSettled([
          fetchAllActiveProducts(),
          listCustomersApi(true),
        ]);

        if (prodData.status === "fulfilled" && prodData.value) {
          // mapping the raw API products into the exact shape the billing cart logic expects
          const raw = prodData.value;
          setProducts(
            raw.map((p: any) => ({
              id: p.id,
              name: p.name,
              sku: p.sku || "",
              barcode: p.barcode || "",
              brand: p.brand?.name || "",
              retailPrice: p.retailPrice || 0,
              wholesalePrice: p.wholesalePrice || 0,
              wholesaleQtyThreshold: p.wholesaleQtyThreshold || 1,
              stock: p.stock || 0,
              lowStockThreshold: p.lowStockThreshold || 0,
              active: p.isActive !== false,
              imageUrl: p.imageUrl || "",
            })),
          );
        }

        if (custData.status === "fulfilled" && custData.value) {
          // mapping customers into a lighter billing shape keeps the rest of the page simpler
          const raw = Array.isArray(custData.value)
            ? custData.value
            : custData.value.customers || [];
          setCustomers(
            raw.map((c: any) => ({
              id: c.id,
              name: c.name,
              phone: c.phone || "",
              email: c.email,
              isLoyalty: (c.loyaltyPercent || 0) > 0,
              loyaltyPercent: c.loyaltyPercent,
              wholesalePercent: c.wholesalePercent,
            })),
          );
        }
      } catch {
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const [skuInput, setSkuInput] = useState(""); // scanner/manual barcode input
  const [productQuery, setProductQuery] = useState(""); // text search for the product picker
  const [isCustomerSearchOpen, setCustomerSearchOpen] = useState(false); // controls the customer search modal/dropdown
  const [customerQuery, setCustomerQuery] = useState(""); // search text inside the customer picker
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [cart, setCart] = useState<CartLine[]>([]); // raw cart lines before product details and pricing are joined in
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("Cash"); // current payment method selected in the modal
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Paid"); // current paid/partial/unpaid selection
  const [paidAmount, setPaidAmount] = useState<string>(""); // manual partial payment amount typed by the cashier
  const [paymentError, setPaymentError] = useState(""); // payment modal validation message
  const [billingError, setBillingError] = useState(""); // main billing error shown above the cart or form
  const [showPaymentModal, setShowPaymentModal] = useState(false); // controls the final payment confirmation modal
  const [showEsewaQr, setShowEsewaQr] = useState(true); // keeps the eSewa QR panel visible when that method is chosen
  const [cartPersistenceReady, setCartPersistenceReady] = useState(false); // prevents the autosave effect from clearing storage before the first restore pass finishes

  const skuRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // finding the selected customer object once here keeps discount and label logic simple below
  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [selectedCustomerId, customers],
  );

  const customerMode = getCustomerDiscountMode(selectedCustomer); // quick label for whether this customer uses loyalty, wholesale, or no special rate
  const subtotalDiscountMeta = useMemo(
    () => getSubtotalDiscountMeta(selectedCustomer),
    [selectedCustomer],
  );

  // filtering the customer list based on the search query
  // we wrap this in useMemo so it only recalculates when the query or customers change
  const customerListFiltered = useMemo(() => {
    const s = customerQuery.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) =>
      (c.name + " " + c.phone).toLowerCase().includes(s),
    );
  }, [customers, customerQuery]);

  // filtering the product list based on the search query
  const productListFiltered = useMemo(() => {
    const s = productQuery.trim().toLowerCase();
    if (!s) return products.filter((p) => p.active);
    return products.filter(
      (p) =>
        p.active &&
        `${p.name} ${p.sku} ${p.barcode || ""} ${p.brand}`
          .toLowerCase()
          .includes(s),
    );
  }, [products, productQuery]);

  const manualResults = useMemo(
    () => productListFiltered.slice(0, productQuery.trim() ? 40 : 24),
    [productListFiltered, productQuery],
  );

  // this lookup table lets cart calculations find products by id without scanning the full products array every time
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  // restoring the saved cart once on mount keeps billing work intact even after route changes or refreshes
  useEffect(() => {
    const storedCart = readStoredBillingCart();
    if (storedCart?.cart.length) {
      setCart(storedCart.cart);
    }
    setCartPersistenceReady(true);
  }, []);

  // once the latest product catalog is available, we reconcile the restored cart against active products and current stock
  useEffect(() => {
    if (products.length === 0 || cart.length === 0) return;

    const normalizedCart = cart
      .map((line) => {
        const product = productsById.get(line.productId);
        if (!product || !product.active || product.stock <= 0) {
          return null;
        }

        const qty = clampNumber(line.qty, 1, product.stock);
        return { productId: line.productId, qty };
      })
      .filter(Boolean) as CartLine[];

    const cartChanged =
      normalizedCart.length !== cart.length ||
      normalizedCart.some(
        (line, index) =>
          line.productId !== cart[index]?.productId || line.qty !== cart[index]?.qty,
      );

    if (cartChanged) {
      setCart(normalizedCart);
    }
  }, [cart, products, productsById]);

  // persisting the cart on every cart change makes route changes safe while still clearing storage when the cart is emptied
  useEffect(() => {
    if (!cartPersistenceReady) return;

    if (cart.length === 0) {
      clearStoredBillingCart();
      return;
    }

    writeStoredBillingCart(cart);
  }, [cart, cartPersistenceReady]);

  // joining cart lines with product data here is what gives us unit price, pricing mode, and line totals for each row
  const cartRows = useMemo(() => {
    return cart
      .map((line) => {
        const p = productsById.get(line.productId);
        if (!p) return null;
        const useWholesalePrice = shouldUseQuantityWholesalePrice(
          selectedCustomer,
          p,
          line.qty,
        );
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
  }, [cart, productsById, selectedCustomer]);

  const subTotal = cartRows.reduce((a, r) => a + r.lineTotal, 0); // total before any customer-level subtotal discount is applied

  // we calculate the subtotal discount amount before grand total
  const subtotalDiscount = useMemo(() => {
    if (subtotalDiscountMeta.percent > 0) {
      return Math.round((subTotal * subtotalDiscountMeta.percent) / 100);
    }
    return 0;
  }, [subTotal, subtotalDiscountMeta.percent]);

  const grandTotal = Math.max(0, subTotal - subtotalDiscount); // final amount the customer needs to pay, clamped to 0 so it never goes negative

  const paidNum = useMemo(() => {
    const n = Number(paidAmount);
    if (!Number.isFinite(n)) return 0;
    return n;
  }, [paidAmount]);

  // payment status controls the real paid amount:
  // 1. Paid means the full grand total is treated as received
  // 2. Unpaid means nothing is received yet
  // 3. Partial uses the typed amount, clamped so it never goes below 0 or above the grand total
  const effectivePaidAmount =
    paymentStatus === "Paid"
      ? grandTotal
      : paymentStatus === "Unpaid"
        ? 0
        : clampNumber(paidNum, 0, grandTotal);

  const balanceDue = Math.max(0, grandTotal - effectivePaidAmount); // remaining amount still due after the chosen payment state is applied

  const showEsewaDetails =
    paymentMethod === "eSewa" && paymentStatus !== "Unpaid";

  const canConfirm = cartRows.length > 0 && !submitting; // final guard for whether checkout can run right now
  const hasBillDraft =
    cartRows.length > 0 || !!selectedCustomer || !!skuInput || !!productQuery;

  // we use this helper so every cart-related validation message goes through one consistent state update
  function showCartIssue(message: string) {
    setBillingError(message);
  }

  // this checks how many units of one product are already in the current cart
  function getCurrentQty(productId: string) {
    return cart.find((line) => line.productId === productId)?.qty || 0;
  }

  // this adds one product into the cart while checking stock, active status, and current quantity first
  function addToCart(productId: string, qty = 1) {
    const product = productsById.get(productId);
    // this handles when the product is inactive or missing from the lookup table
    if (!product || !product.active) {
      showCartIssue("That product is not available for billing.");
      return;
    }
    if (product.stock <= 0) {
      showCartIssue(`"${product.name}" is out of stock.`);
      return;
    }

    const currentQty = getCurrentQty(productId);
    // we block adding more once the cart quantity would pass the live stock count
    if (currentQty >= product.stock) {
      showCartIssue(
        `"${product.name}" has only ${product.stock} item(s) in stock.`,
      );
      return;
    }

    // updating the cart either bumps an existing line or adds a new one for the scanned/searched product
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.productId === productId);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          qty: Math.min(product.stock, copy[idx].qty + qty),
        };
        return copy;
      }
      return [...prev, { productId, qty: Math.min(product.stock, qty) }];
    });
    setProductQuery("");
    setBillingError("");
    skuRef.current?.focus();
  }

  // this changes the quantity of an item already in the cart
  // and validates that we don't exceed the available stock
  function changeQty(productId: string, val: number) {
    const product = productsById.get(productId);
    const maxQty = Math.max(1, product?.stock || 1);
    if (product && val > product.stock) {
      showCartIssue(
        `"${product.name}" has only ${product.stock} item(s) in stock.`,
      );
    } else {
      setBillingError("");
    }
    setCart((prev) =>
      prev.map((x) =>
        x.productId === productId
          ? { ...x, qty: clampNumber(val, 1, maxQty) }
          : x,
      ),
    );
  }

  function removeLine(productId: string) {
    setCart((prev) => prev.filter((x) => x.productId !== productId));
  }

  function addBySku() {
    const s = skuInput.trim();
    if (!s) return;
    const normalized = s.toLowerCase(); // matching in lowercase lets barcode and SKU search stay case-insensitive
    // searching both SKU and barcode helps the cashier use whichever code is available on the product
    const p = products.find(
      (x) =>
        x.active &&
        (x.sku.toLowerCase() === normalized ||
          (x.barcode || "").toLowerCase() === normalized),
    );
    if (p) {
      addToCart(p.id, 1);
      setSkuInput("");
    } else {
      showCartIssue(`No active product found for "${s}".`);
    }
  }

  // we use this to clear all current cart data when a transaction finishes or is cancelled manually
  // the stored cart is cleared here too so the next visit starts fresh on purpose
  function resetBill() {
    clearStoredBillingCart();
    setCart([]);
    setSelectedCustomerId(null);
    setPaymentMethod("Cash");
    setPaymentStatus("Paid");
    setPaidAmount("");
    setSkuInput("");
    setProductQuery("");
    setPaymentError("");
    setBillingError("");
    setCustomerSearchOpen(false);
    setCustomerQuery("");
    setShowPaymentModal(false);
    setShowEsewaQr(true);
    skuRef.current?.focus();
  }

  function openPaymentFlow(nextMethod?: PaymentMethod) {
    // this handles when someone tries to open payment without any cart lines
    if (cartRows.length === 0) {
      setBillingError("Add at least one product before opening payment.");
      return;
    }
    // when a shortcut button passes a payment method, we switch the modal into that method before opening it
    if (nextMethod) {
      setPaymentMethod(nextMethod);
      if (nextMethod === "eSewa") setShowEsewaQr(true);
    }
    setBillingError("");
    setPaymentError("");
    setShowPaymentModal(true);
  }

  function closePaymentFlow() {
    setShowPaymentModal(false);
    setPaymentError("");
  }

  // partial payments need extra validation because the cashier types the received amount manually
  function validatePaymentBeforeConfirm() {
    setPaymentError("");
    setBillingError("");

    if (paymentStatus !== "Partial") {
      return true;
    }

    const amount = Number(paidAmount);
    if (!paidAmount.trim()) {
      setPaymentError("Enter the amount received for a partial payment.");
      return false;
    }
    if (!Number.isFinite(amount)) {
      setPaymentError("Enter a valid payment amount.");
      return false;
    }
    if (amount <= 0) {
      setPaymentError("Payment amount must be greater than 0.");
      return false;
    }
    if (amount >= grandTotal) {
      setPaymentError("Use Paid when the full invoice amount is received.");
      return false;
    }

    return true;
  }

  async function confirm() {
    // stopping here prevents double submits and blocks invalid partial payment states
    if (!canConfirm) return;
    if (!validatePaymentBeforeConfirm()) return;
    setSubmitting(true);

    try {
      // creating the invoice header first gives us the invoice id needed for items, finalize, and payment steps
      const invoiceRes = await createInvoiceApi(
        selectedCustomerId || undefined,
      );
      const invoiceId = invoiceRes.id || invoiceRes.invoice?.id;

      // this handles when the backend does not return a usable invoice id after creation
      if (!invoiceId) {
        setSubmitting(false);
        return;
      }

      // adding each cart line one by one so the backend stores the exact products and quantities in the invoice
      for (const line of cartRows) {
        await addInvoiceItemApi(invoiceId, line.productId, line.qty);
      }

      // finalizing after all items are saved lets the backend calculate totals with the subtotal discount included
      await finalizeInvoiceApi(invoiceId, subtotalDiscount);

      // recording payment only when the invoice is not unpaid and the effective amount is above 0
      if (paymentStatus !== "Unpaid" && effectivePaidAmount > 0) {
        if (paymentMethod === "eSewa") {
          // for eSewa we ask the backend for a signed payment intent, then hand control to the gateway form
          const paymentIntent = await initiateEsewaPaymentApi({
            invoiceId,
            amount: effectivePaidAmount,
          });

          submitEsewaForm(paymentIntent);
          return;
        }

        await addPaymentApi(invoiceId, {
          method: "CASH",
          amount: effectivePaidAmount,
          status: "SUCCESS",
        });
      }

      // clearing the draft only after the full invoice flow succeeds avoids losing the cart on failure
      setShowPaymentModal(false);
      resetBill();

      setLastCreatedInvoiceId(invoiceId);
      setShowSuccess(true);
    } catch (err: any) {
      console.error("Billing confirm error:", err);
      setBillingError(
        err?.response?.data?.error || "Failed to create invoice.",
      );
    } finally {
      // re-enabling billing actions whether checkout succeeded or failed
      setSubmitting(false);
    }
  }

  // setting up global hotkeys (F2, F4, F5, F9, Enter) so the cashier can work fully via keyboard
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
        openPaymentFlow("Cash");
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        openPaymentFlow("eSewa");
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
        if (showPaymentModal) {
          confirm();
        } else {
          openPaymentFlow();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canConfirm,
    grandTotal,
    paymentMethod,
    paymentStatus,
    balanceDue,
    effectivePaidAmount,
    showEsewaDetails,
    showPaymentModal,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[90vh]">
        <div className="text-slate-400 font-semibold">
          Loading billing data...
        </div>
      </div>
    );
  }

  return (
    <>
      {/* this two-panel shell keeps product picking on the left and the live bill summary on the right for fast cashier work */}
      <div className="relative flex h-[90vh] w-full flex-col overflow-hidden rounded-[28px] border border-[#CFCFD3] bg-[#FFFFFF] font-sans text-slate-800  md:flex-row">
        <div className="flex min-w-0 flex-1 flex-col border-r border-[#CFCFD3] bg-[#FFFFFF]">
          <div className="border-b border-[#CFCFD3] bg-[#FFFFFF] px-[20px] py-[20px]">
            <div className="flex flex-col">
              {/* we keep scanner input and manual search together in the top strip because they are the two fastest ways to add products */}
              <div className="grid grid-cols-12 gap-4 items-start">
                <div className="col-span-5">
                  <Input
                    label="Scan SKU / Barcode"
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
                <div className="col-span-7">
                  <Input
                    label="Manual Search"
                    value={productQuery}
                    onChange={setProductQuery}
                    placeholder="Search product name, SKU, barcode, brand..."
                    leftIcon="search"
                    inputRef={searchRef}
                  />
                </div>
              </div>
              <div className="mt-2 flex justify-end"></div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {selectedCustomer ? (
                  <Pill tone="purple">
                    Customer: {selectedCustomer.name.split(" ")[0]}
                  </Pill>
                ) : (
                  <Pill tone="neutral">Guest</Pill>
                )}

                {customerMode === "ADMIN_WHOLESALE" ? (
                  <>
                    <Pill tone="orange">
                      Wholesale{" "}
                      {clampPercent(selectedCustomer?.wholesalePercent || 0)}%
                    </Pill>
                    <Pill tone="neutral">Qty wholesale disabled</Pill>
                  </>
                ) : customerMode === "LOYALTY" ? (
                  <>
                    <Pill tone="green">
                      Loyalty{" "}
                      {clampPercent(selectedCustomer?.loyaltyPercent || 0)}%
                    </Pill>
                    <Pill tone="neutral">Qty wholesale can combine</Pill>
                  </>
                ) : (
                  <Pill tone="neutral">Per-product wholesale pricing</Pill>
                )}
              </div>
            </div>
          </div>

          {/* this list area gets a softer gray background so the clickable product cards stand apart from the white header above */}
          <div className="flex-1 overflow-y-auto bg-[rgba(243,244,246,0.55)] p-[20px]">
            <div className="mb-[20px] flex items-center justify-between">
              <h3 className="text-[14px] font-extrabold uppercase  text-[#565449]">
                Manual Add List
              </h3>
              <div className="rounded-full border border-[#CFCFD3] bg-[#FFFFFF] px-[12px] py-[6px] text-[12px] font-bold text-[#8C8889]">
                Showing {manualResults.length} items
              </div>
            </div>

            {/* these product cards stay in a compact grid so cashiers can scan quickly without huge vertical gaps */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-3">
              {manualResults.map((p) => {
                const low =
                  p.stock > 0 &&
                  p.stock <= Math.max(0, p.lowStockThreshold || 0);
                const outOfStock = p.stock <= 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={outOfStock}
                    onClick={() => addToCart(p.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-[12px] text-left transition",
                      outOfStock
                        ? "opacity-60 cursor-not-allowed grayscale"
                        : "hover:border-slate-300 hover:bg-[rgba(243,244,246,0.8)]",
                    )}
                  >
                    <div className="relative flex h-[48px] w-[48px] shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]">
                      <ProductImage
                        src={p.imageUrl}
                        alt={p.name}
                        className="flex h-full w-full items-center justify-center"
                        iconClassName="text-[#565449]"
                      />
                      <div
                        className={cn(
                          "absolute right-1 top-1 h-3 w-3 rounded-full border-2 border-white",
                          outOfStock
                            ? "bg-slate-400"
                            : low
                              ? "bg-rose-500"
                              : "bg-emerald-500",
                        )}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <div className="font-extrabold text-slate-800 truncate text-[13px]">
                          {p.name}
                        </div>
                        {low && !outOfStock && <Pill tone="rose">LOW</Pill>}
                        {outOfStock && <Pill tone="neutral">OUT</Pill>}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate font-medium">
                        {p.brand} | SKU: {p.sku}
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <div className="flex items-center gap-2 text-[10px] text-slate-500 font-semibold">
                          <span className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                            Stock {p.stock}
                          </span>
                          <span>
                            Wholesale &gt;={" "}
                            {Math.max(1, p.wholesaleQtyThreshold || 1)}
                          </span>
                        </div>
                        <div className="font-mono font-extrabold text-slate-800 text-[13px]">
                          {formatNpr(p.retailPrice)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {manualResults.length === 0 ? (
              <div className="h-[160px] flex items-center justify-center text-slate-400 text-sm font-medium">
                No items available
              </div>
            ) : null}
          </div>
        </div>

        <div className="relative z-20 flex w-full flex-col border-l border-[#CFCFD3] bg-[#FFFFFF] md:w-[420px]">
          <div className="flex-shrink-0 border-b border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
            {!isCustomerSearchOpen ? (
              <div className="flex items-center justify-between rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-[12px] transition">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div
                    className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0 border",
                      selectedCustomer
                        ? "border-[#CFCFD3] bg-[#F3F4F6] text-[#000000]"
                        : "border-[#CFCFD3] bg-[#F3F4F6] text-[#8C8889]",
                    )}
                  >
                    <Icon name={selectedCustomer ? "person" : "person_off"} />
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
                      {selectedCustomer?.isLoyalty ||
                      clampPercent(selectedCustomer?.wholesalePercent || 0) >
                        0 ? (
                        <Icon
                          name="verified"
                          className="text-[13px] text-emerald-500"
                        />
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {clampPercent(selectedCustomer?.wholesalePercent || 0) >
                      0 ? (
                        <Pill tone="orange">
                          Wholesale{" "}
                          {clampPercent(
                            selectedCustomer?.wholesalePercent || 0,
                          )}
                          %
                        </Pill>
                      ) : null}
                      {customerMode === "LOYALTY" ? (
                        <Pill tone="green">
                          Loyalty{" "}
                          {clampPercent(selectedCustomer?.loyaltyPercent || 0)}%
                        </Pill>
                      ) : null}
                      {selectedCustomer?.isLoyalty &&
                      customerMode === "ADMIN_WHOLESALE" ? (
                        <Pill tone="neutral">Loyalty overridden</Pill>
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
              <div className="rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF] p-[12px]">
                <div className="mb-[12px] flex items-center gap-2">
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
                      className="flex w-full items-center justify-between rounded-xl border border-transparent px-[12px] py-[10px] text-left text-[14px] transition hover:border-[#CFCFD3] hover:bg-[#F3F4F6]"
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

          <div className="relative flex-1 space-y-2 overflow-y-auto bg-[rgba(243,244,246,0.35)] p-[12px]">
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
                  className="flex flex-col gap-2 rounded-[16px] border border-[#CFCFD3] bg-[#FFFFFF] p-[12px]  transition hover:border-slate-300"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-extrabold text-slate-800 leading-tight truncate text-[13px]">
                        {row.product.name}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-slate-500 font-medium mt-1">
                        <span className="rounded border border-[#CFCFD3] bg-[#F3F4F6] px-[6px] py-[2px]">
                          {formatNpr(row.unitPrice)}/u
                        </span>
                        {row.priceType === "Wholesale" ? (
                          <span className="font-extrabold text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded border border-sky-200">
                            WHL
                          </span>
                        ) : null}
                        <span>SKU {row.product.sku}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(row.productId)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 transition hover:bg-rose-100 hover:text-rose-600"
                      title="Remove"
                      aria-label="Remove item"
                    >
                      <Icon name="close" className="text-[14px]" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between mt-1 border-t border-slate-100 pt-2">
                    <div className="flex items-center gap-1 rounded-[10px] border border-[#CFCFD3] bg-[#F3F4F6] p-[4px]">
                      <button
                        type="button"
                        onClick={() => changeQty(row.productId, row.qty - 1)}
                        disabled={row.qty <= 1}
                        className="flex h-[24px] w-[24px] items-center justify-center rounded-[6px] border border-[#CFCFD3] bg-[#FFFFFF] text-lg font-medium leading-none  transition hover:text-rose-600 disabled:opacity-40"
                        aria-label="Decrease quantity"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, row.product.stock)}
                        value={row.qty}
                        onChange={(e) =>
                          changeQty(row.productId, Number(e.target.value || 1))
                        }
                        className="w-8 bg-transparent text-center text-[13px] font-extrabold text-slate-800 outline-none"
                        aria-label={`Quantity for ${row.product.name}`}
                      />
                      <button
                        type="button"
                        onClick={() => changeQty(row.productId, row.qty + 1)}
                        disabled={row.qty >= row.product.stock}
                        className="flex h-[24px] w-[24px] items-center justify-center rounded-[6px] border border-[#CFCFD3] bg-[#FFFFFF] text-lg font-medium leading-none  transition hover:text-emerald-600 disabled:opacity-40"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                    <div className="font-mono font-extrabold text-slate-900 text-[14px]">
                      {formatNpr(row.lineTotal)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex-shrink-0 bg-white border-t border-slate-200 ">
            <div className="px-5 pt-4 pb-3 space-y-2 text-sm">
              <div className="flex justify-between text-slate-500">
                <span>Subtotal</span>
                <span className="font-mono font-bold">
                  {formatNpr(subTotal)}
                </span>
              </div>
              {subtotalDiscount > 0 ? (
                <div className="flex justify-between text-rose-600">
                  <span className="flex items-center gap-1 font-bold">
                    <Icon name="local_offer" className="text-[14px]" />
                    {subtotalDiscountMeta.label}
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
                <span className="font-mono font-extrabold text-3xl text-slate-900 ">
                  {formatNpr(grandTotal)}
                </span>
              </div>
              {customerMode !== "NONE" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                  {subtotalDiscountMeta.helper}
                </div>
              ) : null}
            </div>

            <div className="space-y-3 border-t border-[#CFCFD3] bg-[rgba(243,244,246,0.85)] p-[16px]">
              {billingError ? (
                <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-[12px] py-[8px] text-[12px] font-semibold text-[#BE123C]">
                  {billingError}
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="flex-1 border border-[#CFCFD3]"
                  onClick={resetBill}
                  disabled={!hasBillDraft}
                  icon="restart_alt"
                >
                  Clear Cart
                </Button>
                <Button
                  variant={paymentMethod === "eSewa" ? "success" : "primary"}
                  className="flex-[2]"
                  size="lg"
                  icon={paymentMethod === "eSewa" ? "qr_code_2" : "payments"}
                  disabled={!canConfirm}
                  onClick={() => openPaymentFlow()}
                >
                  {paymentMethod === "eSewa"
                    ? "Continue to eSewa"
                    : `Pay ${formatNpr(grandTotal)}`}
                </Button>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-[4px] text-[11px] text-[#8C8889]">
                <span className="font-semibold">Shortcuts:</span>
                <span>F2 Search</span>
                <span>F3 SKU</span>
                <span>F4 Cash</span>
                <span>F5 eSewa</span>
                <span>F9 Reset</span>
                <span>Enter Pay</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ModalFrame
        open={showPaymentModal}
        onClose={closePaymentFlow}
        title="Confirm payment"
        description="Products cannot be added after finalizing invoice so verify properly before proceeding to confirm it."
        maxWidthClass="max-w-[720px]"
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-[18px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.75)] p-[16px]">
              <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                Items
              </div>
              <div className="mt-[8px] text-[24px] font-extrabold text-[#000000]">
                {cartRows.length}
              </div>
              <div className="mt-[4px] text-[12px] font-semibold text-[#8C8889]">
                {cart.reduce((sum, line) => sum + line.qty, 0)} units in cart
              </div>
            </div>
            <div className="rounded-[18px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.75)] p-[16px]">
              <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                Customer
              </div>
              <div className="mt-[8px] text-[16px] font-extrabold text-[#000000]">
                {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
              </div>
              <div className="mt-[4px] text-[12px] font-semibold text-[#8C8889]">
                {selectedCustomer
                  ? selectedCustomer.phone || "No phone on file"
                  : "No customer selected"}
              </div>
            </div>
            <div className="rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
              <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                Total
              </div>
              <div className="mt-[8px] font-mono text-[24px] font-extrabold text-[#000000]">
                {formatNpr(grandTotal)}
              </div>
              <div className="mt-[4px] text-[12px] font-semibold text-[#8C8889]">
                Subtotal {formatNpr(subTotal)}
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[320px_320px]">
            <div className="space-y-4">
              <div>
                <div className="mb-[8px] text-[11px] font-extrabold uppercase  text-[#8C8889]">
                  Payment method
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("Cash")}
                    className={cn(
                      "rounded-[18px] border px-4 py-4 text-left transition",
                      paymentMethod === "Cash"
                        ? "border-[#11120d] bg-[#11120d] text-white"
                        : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]",
                    )}
                  >
                    <Icon name="payments" />
                    <div className="mt-3 text-[13px] font-extrabold">Cash</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod("eSewa");
                      setShowEsewaQr(true);
                    }}
                    className={cn(
                      "rounded-[18px] border px-4 py-4 text-left transition",
                      paymentMethod === "eSewa"
                        ? "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]"
                        : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]",
                    )}
                  >
                    <Icon name="qr_code_2" />
                    <div className="mt-3 text-[13px] font-extrabold">eSewa</div>
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Payment status
                  </div>
                  {paymentMethod === "eSewa" ? (
                    <div className="text-[11px] font-bold text-[#8C8889]">
                      Redirects to the eSewa test payment page
                    </div>
                  ) : null}
                </div>
                <Segmented
                  value={paymentStatus}
                  onChange={(v) => {
                    setPaymentStatus(v as PaymentStatus);
                    setBillingError("");
                    if (v !== "Partial") {
                      setPaidAmount("");
                      setPaymentError("");
                    }
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
                  onChange={(v) => {
                    setPaidAmount(v.replace(/[^\d.]/g, ""));
                    setPaymentError("");
                    setBillingError("");
                  }}
                  placeholder="e.g. 500"
                  leftIcon="currency_rupee"
                  inputMode="numeric"
                  invalid={!!paymentError}
                  helperText={
                    paymentError ||
                    `Enter an amount greater than 0 and less than ${formatNpr(grandTotal)}.`
                  }
                />
              ) : null}

              <div className="rounded-[18px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.75)] p-[16px] text-[12px] font-semibold text-[#565449]">
                {paymentStatus === "Unpaid"
                  ? "This will create the invoice without adding a payment yet."
                  : paymentMethod === "eSewa"
                    ? "Confirm to create the invoice and continue to the eSewa test payment page for this amount."
                    : "Confirm to finalize the invoice and record the payment immediately."}
              </div>
            </div>

            <div className="space-y-4">
              {showEsewaDetails ? (
                <div className="rounded-[22px] border border-[#9DD8B2] bg-[rgba(234,248,239,0.8)] p-[16px]">
                  <div className="text-center text-[11px] font-extrabold uppercase  text-[#179B4D]">
                    Scan To Pay
                  </div>
                  {showEsewaQr ? (
                    <div className="mt-[12px] overflow-hidden rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] p-[16px]">
                      <img
                        src="/assets/images/esewa/qr.png"
                        alt="eSewa QR code"
                        className="mx-auto h-[280px] w-[280px] max-w-full object-contain"
                        onError={() => setShowEsewaQr(false)}
                      />
                    </div>
                  ) : (
                    <div className="mt-[12px] rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] py-[40px] text-center text-[13px] font-semibold text-[#8C8889]">
                      eSewa QR is unavailable right now, but you can still
                      continue to the eSewa test page to complete the payment.
                    </div>
                  )}
                  <div className="mt-[16px] rounded-[18px] border border-[#CFCFD3] bg-[#FFFFFF] px-[16px] py-[12px] text-center">
                    <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                      Billing amount
                    </div>
                    <div className="mt-[8px] font-mono text-[24px] font-extrabold text-[#000000]">
                      {formatNpr(
                        paymentStatus === "Partial"
                          ? effectivePaidAmount
                          : grandTotal,
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-[22px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.75)] p-[16px]">
                  <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Settlement summary
                  </div>
                  <div className="mt-[16px] space-y-[12px] text-[13px] font-semibold text-[#565449]">
                    <div className="flex items-center justify-between">
                      <span>Subtotal</span>
                      <span className="font-mono text-[#000000]">
                        {formatNpr(subTotal)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Discount</span>
                      <span className="font-mono text-[#000000]">
                        -{formatNpr(subtotalDiscount)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Collected now</span>
                      <span className="font-mono text-[#000000]">
                        {formatNpr(effectivePaidAmount)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Due after bill</span>
                      <span className="font-mono text-[#000000]">
                        {formatNpr(balanceDue)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {billingError ? (
                <div className="rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-[12px] py-[8px] text-[12px] font-semibold text-[#BE123C]">
                  {billingError}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <DialogButton onClick={closePaymentFlow}>Back</DialogButton>
            <DialogButton
              onClick={confirm}
              variant={paymentMethod === "eSewa" ? "primary" : "primary"}
              icon={
                paymentStatus === "Unpaid"
                  ? "receipt_long"
                  : paymentMethod === "eSewa"
                    ? "qr_code_2"
                    : "check_circle"
              }
              disabled={!canConfirm || submitting}
            >
              {submitting
                ? "Creating..."
                : paymentStatus === "Paid"
                  ? `Pay ${formatNpr(grandTotal)}`
                  : paymentStatus === "Partial"
                    ? `Confirm ${formatNpr(effectivePaidAmount)}`
                    : "Create Unpaid Invoice"}
            </DialogButton>
          </div>
        </div>
      </ModalFrame>

      <SuccessDialog
        open={showSuccess}
        title="Invoice created successfully"
        message="The invoice has been finalized and recorded in KhataSathi."
        onClose={() => setShowSuccess(false)}
        actionLabel="Continue Billing"
        secondaryAction={
          lastCreatedInvoiceId ? (
            <DialogButton
              onClick={() => openInvoicePrint(lastCreatedInvoiceId)}
              icon="print"
            >
              Print Invoice
            </DialogButton>
          ) : null
        }
      />
    </>
  );
}
