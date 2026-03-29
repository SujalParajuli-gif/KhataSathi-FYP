import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Icon from "~/components/ui/Icon";
import { ConfirmDialog } from "~/components/ui/Modal";
import {
  createCustomerApi,
  deactivateCustomerApi,
  listCustomersApi,
  listInvoicesApi,
  updateCustomerApi,
} from "~/lib/api/endpoints";
import { formatDateLabel, formatNpr } from "~/lib/invoices";

type DiscountMode = "ADMIN_WHOLESALE" | "LOYALTY" | "NONE";
type PurchaseHistoryState = "history" | "cancelled_only" | "empty";

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  isActive: boolean;
  isLoyalty: boolean;
  adminWholesaleDiscountPercent?: number;
  lastPurchaseLabel: string;
  purchaseCount: number;
  purchaseHistoryState: PurchaseHistoryState;
};

type DiscountFormErrors = Partial<Record<"name" | "phone" | "email", string>>;

type PurchaseSummary = {
  lastPurchaseLabel: string;
  purchaseCount: number;
  purchaseHistoryState: PurchaseHistoryState;
};

const LS_KEYS = {
  loyaltyDiscountPercent: "ks_loyaltyDiscountPercent",
};

const DEFAULT_PURCHASE_SUMMARY: PurchaseSummary = {
  lastPurchaseLabel: "No purchase history yet",
  purchaseCount: 0,
  purchaseHistoryState: "empty",
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function readInt(key: string, fallback: number) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function formatPct(v: number) {
  return `${Math.round(v)}%`;
}

function hasWholesale(c: Customer) {
  return typeof c.adminWholesaleDiscountPercent === "number";
}

function isEffectiveLoyalty(c: Customer) {
  return c.isLoyalty && !hasWholesale(c);
}

function getDiscountMode(c: Customer): DiscountMode {
  if (hasWholesale(c)) return "ADMIN_WHOLESALE";
  if (c.isLoyalty) return "LOYALTY";
  return "NONE";
}

function getInitials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "CU"
  );
}

function normalizeCustomerList(data: any) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.customers)) return data.customers;
  return [];
}

function isInvoiceCancelled(raw: any) {
  const status = String(raw?.paymentStatus || raw?.status || "").toUpperCase();
  return status === "CANCELLED" || status === "CANCELED";
}

function isFinalizedInvoice(raw: any) {
  return String(raw?.status || "").toUpperCase() === "FINALIZED";
}

async function loadAllInvoices() {
  const all: any[] = [];
  const pageSize = 100;
  let page = 1;

  while (true) {
    const data = await listInvoicesApi({ page, pageSize });
    const batch = Array.isArray(data?.invoices) ? data.invoices : [];
    const total = Number(data?.total || 0);
    all.push(...batch);

    if (batch.length === 0) break;
    if (total > 0 && all.length >= total) break;
    if (batch.length < pageSize) break;

    page += 1;
  }

  return all;
}

function buildPurchaseLookup(rawInvoices: any[]) {
  const grouped = new Map<string, any[]>();

  rawInvoices.forEach((invoice) => {
    const customerId = invoice?.customer?.id || invoice?.customerId;
    if (!customerId) return;

    const bucket = grouped.get(customerId) || [];
    bucket.push(invoice);
    grouped.set(customerId, bucket);
  });

  const lookup = new Map<string, PurchaseSummary>();

  grouped.forEach((items, customerId) => {
    const sorted = [...items].sort(
      (a, b) =>
        new Date(b?.createdAt || 0).getTime() -
        new Date(a?.createdAt || 0).getTime(),
    );
    const finalized = sorted.filter(isFinalizedInvoice);
    const validPurchases = finalized.filter(
      (invoice) => !isInvoiceCancelled(invoice),
    );
    const latest = validPurchases[0];

    if (latest) {
      const purchaseCount = validPurchases.length;
      const createdAt = String(latest.createdAt || new Date().toISOString());
      const amount = Number(latest.netTotal || latest.total || 0);
      lookup.set(customerId, {
        purchaseCount,
        purchaseHistoryState: "history",
        lastPurchaseLabel: `${purchaseCount} purchase${
          purchaseCount === 1 ? "" : "s"
        } • ${formatNpr(amount)} on ${formatDateLabel(createdAt)}`,
      });
      return;
    }

    if (finalized.length > 0) {
      lookup.set(customerId, {
        purchaseCount: 0,
        purchaseHistoryState: "cancelled_only",
        lastPurchaseLabel:
          "No completed purchase yet. Latest invoice was cancelled.",
      });
      return;
    }

    lookup.set(customerId, DEFAULT_PURCHASE_SUMMARY);
  });

  return lookup;
}

function Surface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[28px] border border-slate-200/80 bg-white shadow-[0_18px_60px_-36px_rgba(15,23,42,0.35)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
  className,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[12px] px-4 py-3 text-[13px] font-extrabold transition active:scale-[0.99]";
  const styles =
    variant === "primary"
      ? "border border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27] hover:border-[#2a2c27]"
      : variant === "danger"
        ? "border border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:opacity-90"
        : "border border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        base,
        styles,
        className,
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative group w-full md:w-[320px]">
      <Icon
        name="search"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)] transition-colors group-focus-within:text-[var(--app-text)]"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by customer, phone, or email"
        className="h-[44px] w-full rounded-[12px] border border-[var(--app-border)] bg-white pl-10 pr-4 text-[13px] font-semibold text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-text-muted)] focus:border-[#11120d]"
      />
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  leftIcon,
  invalid,
  helperText,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leftIcon?: string;
  invalid?: boolean;
  helperText?: string;
}) {
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-3 rounded-[16px] border bg-white px-4 py-3 transition",
          invalid
            ? "border-rose-300 ring-4 ring-rose-500/10"
            : "border-slate-200 focus-within:border-orange-300 focus-within:ring-4 focus-within:ring-orange-500/10",
        )}
      >
        {leftIcon ? <Icon name={leftIcon} className="text-slate-400" /> : null}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent text-[14px] font-semibold text-slate-900 outline-none placeholder:text-slate-400"
        />
      </div>
      {helperText ? (
        <div
          className={cn(
            "mt-2 text-[12px] font-bold",
            invalid ? "text-rose-600" : "text-slate-500",
          )}
        >
          {helperText}
        </div>
      ) : null}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  placeholder,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange("");
          return;
        }

        const next = Number(raw);
        if (!Number.isFinite(next)) return;
        if (typeof min === "number" && next < min) {
          onChange(min);
          return;
        }
        if (typeof max === "number" && next > max) {
          onChange(max);
          return;
        }
        onChange(next);
      }}
      className="h-[52px] w-full rounded-[16px] border border-slate-200 bg-white px-4 text-[14px] font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-500/10"
    />
  );
}

function ModalShell({
  open,
  title,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
        aria-label="Close overlay"
      />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-[860px] overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-slate-400">
                Discount Profile
              </div>
              <div className="mt-1 text-[20px] font-extrabold text-slate-900">
                {title}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-slate-200 text-slate-600 transition hover:bg-slate-50"
              aria-label="Close modal"
            >
              <Icon name="close" />
            </button>
          </div>

          <div className="px-6 py-6">{children}</div>

          {footer ? (
            <div className="border-t border-slate-100 bg-slate-50/70 px-6 py-4">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose";
}) {
  const map: Record<NonNullable<typeof tone>, string> = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    green: "border-emerald-100 bg-emerald-50 text-emerald-700",
    orange: "border-orange-100 bg-orange-50 text-orange-700",
    sky: "border-sky-100 bg-sky-50 text-sky-700",
    rose: "border-rose-100 bg-rose-50 text-rose-700",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-extrabold",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

function ModeBadge({ customer }: { customer: Customer }) {
  const mode = getDiscountMode(customer);

  if (mode === "ADMIN_WHOLESALE") {
    return <Pill tone="orange">Wholesale override</Pill>;
  }
  if (mode === "LOYALTY") {
    return <Pill tone="green">Loyalty active</Pill>;
  }
  return <Pill>Standard billing</Pill>;
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
        active
          ? "border-slate-900 bg-slate-900 text-white shadow-[0_16px_28px_-24px_rgba(15,23,42,0.9)]"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px]",
            active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: string;
  tone?: "neutral" | "orange" | "green" | "slate";
}) {
  const tones = {
    neutral:
      "border-slate-200 bg-white text-slate-900 icon-bg-slate-100 icon-text-slate-600",
    orange:
      "border-orange-100 bg-orange-50/70 text-orange-900 icon-bg-orange-100 icon-text-orange-600",
    green:
      "border-emerald-100 bg-emerald-50/70 text-emerald-900 icon-bg-emerald-100 icon-text-emerald-600",
    slate:
      "border-slate-800 bg-slate-900 text-white icon-bg-white/10 icon-text-white",
  };
  const palette = tones[tone].split(" ");
  const labelTone = tone === "slate" ? "text-white/65" : "text-current/60";
  const hintTone = tone === "slate" ? "text-white/70" : "text-current/65";

  return (
    <div className={cn("rounded-[24px] border p-5 ", palette[2], palette[1])}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className={cn(
              "text-[11px] font-extrabold uppercase tracking-[0.22em]",
              labelTone,
            )}
          >
            {label}
          </div>
          <div className="mt-3 text-[28px] font-extrabold text-current">
            {value}
          </div>
        </div>
        <div
          className={cn(
            "inline-flex h-12 w-12 items-center justify-center rounded-[18px]",
            palette[2],
          )}
        >
          <Icon name={icon} className={palette[3]} />
        </div>
      </div>
      <div className={cn("mt-3 text-[12px] font-bold", hintTone)}>{hint}</div>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-success-border)] bg-[var(--app-success-bg)] px-2.5 py-1 text-[11px] font-extrabold text-[var(--app-success-text)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-success-text)]" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-text-muted)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-text-muted)]" />
      Inactive
    </span>
  );
}

function DiscountBadge({ customer }: { customer: Customer }) {
  const mode = getDiscountMode(customer);

  if (mode === "ADMIN_WHOLESALE") {
    return (
      <span className="inline-flex rounded-[8px] border border-[var(--app-warning-border)] bg-[var(--app-warning-bg)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-warning-text)]">
        Wholesale %
      </span>
    );
  }

  if (mode === "LOYALTY") {
    return (
      <span className="inline-flex rounded-[8px] border border-[var(--app-success-border)] bg-[var(--app-success-bg)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-success-text)]">
        Loyalty %
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-[8px] border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-text-muted)]">
      No discount
    </span>
  );
}

function TableActionButton({
  icon,
  label,
  onClick,
  tone = "neutral",
  disabled = false,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  tone?: "neutral" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-[34px] items-center justify-center gap-1.5 rounded-[10px] border px-3 text-[11px] font-bold transition",
        tone === "danger"
          ? "border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:opacity-90"
          : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Icon name={icon} sizePx={15} className="text-inherit" />
      <span>{label}</span>
    </button>
  );
}

function PurchaseBadge({ customer }: { customer: Customer }) {
  if (customer.purchaseHistoryState === "history") {
    return <Pill tone="sky">{customer.purchaseCount} completed invoices</Pill>;
  }
  if (customer.purchaseHistoryState === "cancelled_only") {
    return <Pill tone="rose">Cancelled history only</Pill>;
  }
  return <Pill>No invoice history</Pill>;
}

function CustomerCard({
  customer,
  onEdit,
  onClearWholesale,
}: {
  customer: Customer;
  onEdit: () => void;
  onClearWholesale: () => void;
}) {
  const wholesale = hasWholesale(customer);
  const loyalty = isEffectiveLoyalty(customer);

  return (
    <div className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-[0_18px_44px_-36px_rgba(15,23,42,0.45)] transition hover:border-slate-300 hover:shadow-[0_22px_60px_-40px_rgba(15,23,42,0.45)]">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            <div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] bg-slate-900 text-[15px] font-extrabold text-white shadow-[0_18px_28px_-24px_rgba(15,23,42,0.9)]">
              {getInitials(customer.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="truncate text-[18px] font-extrabold text-slate-900">
                  {customer.name}
                </div>
                <ModeBadge customer={customer} />
                <PurchaseBadge customer={customer} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-semibold text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="call" sizePx={16} className="text-slate-400" />
                  {customer.phone || "No phone on file"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="mail" sizePx={16} className="text-slate-400" />
                  {customer.email || "No email on file"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <Button icon="edit" onClick={onEdit}>
            Edit profile
          </Button>
          <Button
            icon="delete"
            variant="danger"
            onClick={onClearWholesale}
            disabled={!wholesale}
          >
            Clear wholesale
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Active Rule
          </div>
          <div className="mt-3">
            <ModeBadge customer={customer} />
          </div>
          <div className="mt-3 text-[12px] font-semibold text-slate-600">
            Wholesale overrides loyalty whenever a customer-specific percent is
            set.
          </div>
        </div>

        <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Wholesale Discount
          </div>
          <div className="mt-3 text-[24px] font-extrabold text-slate-900">
            {typeof customer.adminWholesaleDiscountPercent === "number"
              ? `${customer.adminWholesaleDiscountPercent}%`
              : "None"}
          </div>
          <div className="mt-2 text-[12px] font-semibold text-slate-600">
            Applied on subtotal during billing when this profile is active.
          </div>
        </div>

        <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Loyalty Status
          </div>
          <div className="mt-3">
            {loyalty ? (
              <Pill tone="green">Eligible and active</Pill>
            ) : customer.isLoyalty && wholesale ? (
              <Pill tone="orange">Saved but overridden</Pill>
            ) : (
              <Pill>Not enabled</Pill>
            )}
          </div>
          <div className="mt-3 text-[12px] font-semibold text-slate-600">
            {loyalty
              ? "This customer receives the loyalty subtotal discount."
              : customer.isLoyalty && wholesale
                ? "Loyalty is saved, but the wholesale rule takes priority."
                : "Customer follows standard pricing unless you assign a rule."}
          </div>
        </div>

        <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
              Last Purchase
            </div>
            {customer.purchaseCount > 0 ? (
              <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-extrabold text-slate-500 ring-1 ring-slate-200">
                {customer.purchaseCount}
              </span>
            ) : null}
          </div>
          <div
            className={cn(
              "mt-3 text-[13px] font-bold leading-6",
              customer.purchaseHistoryState === "history"
                ? "text-slate-900"
                : customer.purchaseHistoryState === "cancelled_only"
                  ? "text-rose-700"
                  : "text-slate-500",
            )}
          >
            {customer.lastPurchaseLabel}
          </div>
          <div className="mt-3 text-[12px] font-semibold text-slate-600">
            Cancelled invoices are skipped when we determine the latest
            completed purchase.
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleCallout({
  icon,
  title,
  text,
  tone = "neutral",
}: {
  icon: string;
  title: string;
  text: string;
  tone?: "neutral" | "orange" | "green";
}) {
  const tones = {
    neutral: "border-slate-200 bg-slate-50/70 text-slate-700 icon-slate-100",
    orange: "border-orange-100 bg-orange-50/70 text-orange-800 icon-orange-100",
    green:
      "border-emerald-100 bg-emerald-50/70 text-emerald-800 icon-emerald-100",
  };
  const palette = tones[tone].split(" ");

  return (
    <div className={cn("rounded-[22px] border p-4", palette[0], palette[1])}>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px]",
            palette[3],
          )}
        >
          <Icon name={icon} className="text-current" />
        </div>
        <div>
          <div className="text-[13px] font-extrabold text-current">{title}</div>
          <div className="mt-1 text-[12px] font-semibold leading-6 text-current/80">
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DiscountsPage() {
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(2);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | DiscountMode>("all");

  const [openEdit, setOpenEdit] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeactivateCustomer, setPendingDeactivateCustomer] =
    useState<Customer | null>(null);
  const [deactivateBusy, setDeactivateBusy] = useState(false);

  const [fName, setFName] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fIsLoyalty, setFIsLoyalty] = useState(false);
  const [fWholesaleDiscount, setFWholesaleDiscount] = useState<number | "">("");
  const [formErrors, setFormErrors] = useState<DiscountFormErrors>({});
  const [formSubmitError, setFormSubmitError] = useState("");

  const formHasWholesale = typeof fWholesaleDiscount === "number";

  useEffect(() => {
    setLoyaltyDiscountPercent(readInt(LS_KEYS.loyaltyDiscountPercent, 2));
  }, []);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setLoadError("");

      try {
        const [customerData, invoices] = await Promise.all([
          listCustomersApi(),
          loadAllInvoices(),
        ]);

        if (!active) return;

        const purchaseLookup = buildPurchaseLookup(invoices);
        const rawCustomers = normalizeCustomerList(customerData);

        setCustomers(
          rawCustomers.map((customer: any) => {
            const purchaseSummary =
              purchaseLookup.get(customer.id) || DEFAULT_PURCHASE_SUMMARY;

            return {
              id: customer.id,
              name: customer.name || "Unknown customer",
              phone: customer.phone || "",
              email: customer.email || undefined,
              isActive: customer.isActive !== false,
              isLoyalty: Number(customer.loyaltyPercent || 0) > 0,
              adminWholesaleDiscountPercent:
                Number(customer.wholesalePercent || 0) > 0
                  ? Number(customer.wholesalePercent)
                  : undefined,
              ...purchaseSummary,
            } satisfies Customer;
          }),
        );
      } catch {
        if (!active) return;
        setCustomers([]);
        setLoadError("We could not load discount records right now.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();

    return customers.filter((customer) => {
      if (loweredQuery) {
        const haystack = `${customer.name} ${customer.phone} ${
          customer.email || ""
        } ${customer.lastPurchaseLabel}`.toLowerCase();
        if (!haystack.includes(loweredQuery)) return false;
      }

      const customerMode = getDiscountMode(customer);
      if (mode !== "all" && customerMode !== mode) return false;

      return true;
    });
  }, [customers, mode, query]);

  const stats = useMemo(() => {
    const total = customers.length;
    const adminWholesale = customers.filter(
      (customer) => getDiscountMode(customer) === "ADMIN_WHOLESALE",
    ).length;
    const loyalty = customers.filter(
      (customer) => getDiscountMode(customer) === "LOYALTY",
    ).length;
    const none = customers.filter(
      (customer) => getDiscountMode(customer) === "NONE",
    ).length;

    return { total, adminWholesale, loyalty, none };
  }, [customers]);

  function openEditCustomer(customer: Customer) {
    setEditingId(customer.id);
    setFName(customer.name);
    setFPhone(customer.phone);
    setFEmail(customer.email || "");
    setFWholesaleDiscount(
      typeof customer.adminWholesaleDiscountPercent === "number"
        ? customer.adminWholesaleDiscountPercent
        : "",
    );
    setFIsLoyalty(customer.isLoyalty && !hasWholesale(customer));
    setFormErrors({});
    setFormSubmitError("");
    setOpenEdit(true);
  }

  function openAddCustomer() {
    setEditingId(null);
    setFName("");
    setFPhone("");
    setFEmail("");
    setFIsLoyalty(false);
    setFWholesaleDiscount("");
    setFormErrors({});
    setFormSubmitError("");
    setOpenEdit(true);
  }

  function closeEdit() {
    setOpenEdit(false);
    setFormErrors({});
    setFormSubmitError("");
  }

  async function saveCustomer() {
    const name = fName.trim();
    const phone = fPhone.trim();
    const email = fEmail.trim();
    const nextErrors: DiscountFormErrors = {};

    if (!name) nextErrors.name = "Customer name is required.";
    if (!phone) nextErrors.phone = "Phone is required.";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.email = "Enter a valid email address.";
    }

    setFormErrors(nextErrors);
    setFormSubmitError("");
    setActionError("");

    if (Object.keys(nextErrors).length > 0) return;

    const discount =
      typeof fWholesaleDiscount === "number"
        ? clampPercent(fWholesaleDiscount)
        : undefined;
    const nextIsLoyalty = typeof discount === "number" ? false : fIsLoyalty;

    try {
      if (editingId) {
        await updateCustomerApi(editingId, {
          name,
          phone,
          email: email || undefined,
          loyaltyPercent: nextIsLoyalty ? loyaltyDiscountPercent : 0,
          wholesalePercent: discount || 0,
        });

        setCustomers((prev) =>
          prev.map((customer) =>
            customer.id === editingId
              ? {
                  ...customer,
                  name,
                  phone,
                  email: email || undefined,
                  isLoyalty: nextIsLoyalty,
                  adminWholesaleDiscountPercent: discount,
                }
              : customer,
          ),
        );

        closeEdit();
        return;
      }

      const created = await createCustomerApi({
        name,
        phone,
        email: email || undefined,
        loyaltyPercent: nextIsLoyalty ? loyaltyDiscountPercent : 0,
        wholesalePercent: discount || 0,
      });

      setCustomers((prev) => [
        {
          id: created.id,
          name,
          phone,
          email: email || undefined,
          isActive: created.isActive !== false,
          isLoyalty: nextIsLoyalty,
          adminWholesaleDiscountPercent: discount,
          ...DEFAULT_PURCHASE_SUMMARY,
        },
        ...prev,
      ]);

      closeEdit();
    } catch {
      setFormSubmitError("Failed to save customer discount.");
    }
  }

  function requestDeactivateCustomer(customer: Customer) {
    if (!customer.isActive) return;
    setActionError("");
    setPendingDeactivateCustomer(customer);
  }

  async function confirmDeactivateCustomer() {
    const customer = pendingDeactivateCustomer;
    if (!customer) return;
    setDeactivateBusy(true);

    try {
      await deactivateCustomerApi(customer.id);
      setCustomers((prev) =>
        prev.map((item) =>
          item.id === customer.id ? { ...item, isActive: false } : item,
        ),
      );
      setPendingDeactivateCustomer(null);
    } catch {
      setActionError(`Failed to deactivate ${customer.name}.`);
    } finally {
      setDeactivateBusy(false);
    }
  }

  async function clearCustomerDiscount(id: string) {
    const customer = customers.find((item) => item.id === id);
    if (!customer) return;

    try {
      await updateCustomerApi(id, { wholesalePercent: 0 });
      setCustomers((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, adminWholesaleDiscountPercent: undefined }
            : item,
        ),
      );
    } catch {
      setFormSubmitError(
        `Failed to clear wholesale discount for ${customer.name}.`,
      );
    }
  }

  function onWholesaleChange(value: number | "") {
    setFWholesaleDiscount(value);
    if (typeof value === "number") {
      setFIsLoyalty(false);
    }
  }

  function onToggleLoyalty(next: boolean) {
    if (next) setFWholesaleDiscount("");
    setFIsLoyalty(next);
  }

  return (
    <div className="min-h-full rounded-[28px] bg-[var(--app-page-bg)] p-6 text-[var(--app-text)]">
      <div className="mx-auto max-w-6xl space-y-9">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-[24px] font-extrabold tracking-tight text-[var(--app-text)]">
              Customer Discounts
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[var(--app-text-muted)]">
              Add, edit, and manage customer discount rules for billing.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-white px-4 py-2 text-[11px] font-bold text-[var(--app-text-muted)] shadow-sm">
              <Icon
                name="info"
                className="text-[14px] text-[var(--app-warning-text)]"
              />
              <span>Wholesale overrides loyalty</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total Customers"
            value={stats.total}
            hint="Registered in discount system"
            icon="groups"
            tone="slate"
          />
          <MetricCard
            label="Wholesale Accounts"
            value={stats.adminWholesale}
            hint="Customer-specific wholesale rates"
            icon="storefront"
            tone="orange"
          />
          <MetricCard
            label="Loyalty Members"
            value={stats.loyalty}
            hint="Using loyalty discount"
            icon="loyalty"
            tone="green"
          />
          <MetricCard
            label="Standard Billing"
            value={stats.none}
            hint="No custom discount assigned"
            icon="rule"
            tone="neutral"
          />
        </div>

        <div className="overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]">
          <div className="flex flex-col gap-4 border-b border-[var(--app-border)] bg-white p-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="hide-scrollbar flex w-full items-center gap-2 overflow-x-auto pb-2 xl:w-auto xl:pb-0">
              <FilterChip
                label="All Discounts"
                count={stats.total}
                active={mode === "all"}
                onClick={() => setMode("all")}
              />
              <FilterChip
                label="Wholesale"
                count={stats.adminWholesale}
                active={mode === "ADMIN_WHOLESALE"}
                onClick={() => setMode("ADMIN_WHOLESALE")}
              />
              <FilterChip
                label="Loyalty"
                count={stats.loyalty}
                active={mode === "LOYALTY"}
                onClick={() => setMode("LOYALTY")}
              />
              <FilterChip
                label="No discount"
                count={stats.none}
                active={mode === "NONE"}
                onClick={() => setMode("NONE")}
              />
            </div>

            <div className="flex w-full flex-col gap-3 md:flex-row md:items-center xl:w-auto">
              <SearchInput value={query} onChange={setQuery} />
              <Button
                variant="primary"
                icon="person_add"
                onClick={openAddCustomer}
                className="h-[44px] whitespace-nowrap px-4 py-0"
              >
                Add customer
              </Button>
            </div>
          </div>

          <div className="px-5 py-5">
            {loadError ? (
              <div className="mb-4 rounded-[16px] border border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] px-4 py-3 text-[13px] font-semibold text-[var(--app-danger-text)]">
                {loadError}
              </div>
            ) : null}

            {actionError ? (
              <div className="mb-4 rounded-[16px] border border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] px-4 py-3 text-[13px] font-semibold text-[var(--app-danger-text)]">
                {actionError}
              </div>
            ) : null}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--app-border)] bg-[var(--app-surface-muted)]/70">
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Customer Details
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Discount Type
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Rate
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Last Purchase
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Status
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--app-border)]/60">
                {loading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index}>
                      <td colSpan={6} className="px-6 py-4">
                        <div className="h-12 animate-pulse rounded-[12px] bg-[var(--app-surface-muted)]" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-[var(--app-text-muted)]">
                        <Icon
                          name="search_off"
                          className="mb-2 text-[32px] opacity-50"
                        />
                        <span className="text-[13px] font-semibold">
                          No customers match these filters.
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((customer) => {
                    const discountMode = getDiscountMode(customer);
                    const rate =
                      discountMode === "ADMIN_WHOLESALE"
                        ? formatPct(customer.adminWholesaleDiscountPercent || 0)
                        : discountMode === "LOYALTY"
                          ? formatPct(loyaltyDiscountPercent)
                          : "—";

                    return (
                      <tr
                        key={customer.id}
                        className="group transition-colors hover:bg-[var(--app-surface-muted)]/70"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-surface-muted)] text-[12px] font-extrabold text-[var(--app-text-soft)]">
                              {getInitials(customer.name).charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-bold text-[var(--app-text)] transition-colors group-hover:text-[var(--app-text-soft)]">
                                {customer.name}
                              </div>
                              <div className="truncate text-[11px] font-semibold text-[var(--app-text-muted)]">
                                {customer.phone || "No phone on file"}
                              </div>
                              <div className="truncate text-[11px] font-medium text-[var(--app-text-muted)]/80">
                                {customer.email || "No email on file"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <DiscountBadge customer={customer} />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className="text-[14px] font-extrabold text-[var(--app-text)]">
                              {rate}
                            </span>
                            <span className="text-[10px] font-semibold text-[var(--app-text-muted)]">
                              {discountMode === "NONE"
                                ? "standard"
                                : "on subtotal"}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div
                            className={cn(
                              "max-w-[240px] text-[12px] font-semibold leading-6",
                              customer.purchaseHistoryState === "history"
                                ? "text-[var(--app-text-soft)]"
                                : customer.purchaseHistoryState ===
                                    "cancelled_only"
                                  ? "text-[var(--app-danger-text)]"
                                  : "text-[var(--app-text-muted)]",
                            )}
                          >
                            {customer.lastPurchaseLabel}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <StatusBadge active={customer.isActive} />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <TableActionButton
                              icon="edit"
                              label="Edit"
                              onClick={() => openEditCustomer(customer)}
                            />
                            <TableActionButton
                              icon="block"
                              label={
                                customer.isActive ? "Deactivate" : "Inactive"
                              }
                              tone="danger"
                              disabled={!customer.isActive}
                              onClick={() =>
                                requestDeactivateCustomer(customer)
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-[var(--app-border)] bg-[var(--app-surface-muted)]/40 px-6 py-4">
            <div className="text-[11px] font-bold text-[var(--app-text-muted)]">
              Showing {filtered.length} records
            </div>
          </div>
        </div>

        <ModalShell
          open={openEdit}
          title={editingId ? "Edit customer discount" : "Add customer"}
          onClose={closeEdit}
          footer={
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
              <Button onClick={closeEdit}>Cancel</Button>
              <Button variant="primary" icon="save" onClick={saveCustomer}>
                Save profile
              </Button>
            </div>
          }
        >
          <div className="space-y-6">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <div className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                  Customer name
                </div>
                <Input
                  value={fName}
                  onChange={setFName}
                  placeholder="e.g. Ram Bahadur"
                  invalid={!!formErrors.name}
                  helperText={formErrors.name}
                  leftIcon="person"
                />
              </div>

              <div className="space-y-2">
                <div className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                  Phone
                </div>
                <Input
                  value={fPhone}
                  onChange={setFPhone}
                  placeholder="+977 98XXXXXXXX"
                  invalid={!!formErrors.phone}
                  helperText={formErrors.phone}
                  leftIcon="call"
                />
              </div>

              <div className="space-y-2 lg:col-span-2">
                <div className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                  Email
                </div>
                <Input
                  value={fEmail}
                  onChange={setFEmail}
                  placeholder="name@email.com"
                  invalid={!!formErrors.email}
                  helperText={formErrors.email}
                  leftIcon="mail"
                />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                    Wholesale Discount
                  </div>
                  {formHasWholesale ? (
                    <Pill tone="orange">Priority</Pill>
                  ) : null}
                </div>

                <div className="mt-4 max-w-[220px]">
                  <NumberInput
                    value={fWholesaleDiscount}
                    onChange={onWholesaleChange}
                    min={0}
                    max={100}
                    placeholder="e.g. 5"
                  />
                </div>

                <div className="mt-3 text-[12px] font-semibold text-slate-500">
                  Leave blank for loyalty or standard billing.
                </div>
              </div>

              <div className="rounded-[20px] border border-slate-200 bg-slate-50/70 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                      Loyalty Access
                    </div>
                    <div className="mt-1 text-[16px] font-extrabold text-slate-900">
                      Enable loyalty
                    </div>
                  </div>
                  <label
                    className={cn(
                      "inline-flex items-center gap-3 rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                      formHasWholesale
                        ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                        : "cursor-pointer border-emerald-200 bg-emerald-50 text-emerald-700",
                    )}
                    title={
                      formHasWholesale
                        ? "Disabled because wholesale discount is set"
                        : ""
                    }
                  >
                    <input
                      type="checkbox"
                      checked={fIsLoyalty}
                      disabled={formHasWholesale}
                      onChange={(e) => onToggleLoyalty(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Enable
                  </label>
                </div>

                <div className="mt-4 text-[12px] font-semibold leading-6 text-slate-500">
                  Applies {loyaltyDiscountPercent}% on subtotal when no
                  wholesale rate is set.
                </div>
              </div>
            </div>

            {formSubmitError ? (
              <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
                {formSubmitError}
              </div>
            ) : null}
          </div>
        </ModalShell>

        <ConfirmDialog
          open={!!pendingDeactivateCustomer}
          title="Deactivate customer?"
          message="This customer will no longer be available for active discount use until the profile is reactivated."
          confirmLabel="Deactivate Customer"
          onConfirm={confirmDeactivateCustomer}
          onClose={() => {
            if (!deactivateBusy) setPendingDeactivateCustomer(null);
          }}
          busy={deactivateBusy}
          details={
            pendingDeactivateCustomer ? (
              <div className="space-y-1">
                <div className="font-semibold text-slate-700">
                  {pendingDeactivateCustomer.name}
                </div>
                <div>
                  {pendingDeactivateCustomer.phone || "No phone on file"}
                </div>
                <div>
                  {pendingDeactivateCustomer.email || "No email on file"}
                </div>
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}
