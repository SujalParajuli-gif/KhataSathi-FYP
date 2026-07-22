import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Icon from "~/components/ui/Icon";
import { ConfirmDialog } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import { MobileFilterTabs } from "~/components/ui/MobileFilters";
import { useToast } from "~/components/ui/Toast";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import {
  approveCustomerDiscountRequestApi,
  createCustomerApi,
  deactivateCustomerApi,
  deleteCustomerDiscountApi,
  getCustomerDiscountDeleteSafetyApi,
  getBusinessSettingsApi,
  listCustomerDiscountRequestsApi,
  listCustomersApi,
  rejectCustomerDiscountRequestApi,
  updateCustomerApi,
  type CustomerDiscountDeleteSafety,
  type CustomerDiscountRequest,
} from "~/lib/api/endpoints";
import { formatDateLabel, formatNpr } from "~/lib/invoices";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

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

const DEFAULT_PURCHASE_SUMMARY: PurchaseSummary = {
  lastPurchaseLabel: "No purchase history yet",
  purchaseCount: 0,
  purchaseHistoryState: "empty",
};

// standard tailwind helper
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// forces discount percentages to stay strictly within 0 to 100
// we don't want admins setting a 200% discount and owing the customer money
function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// cleanly rounds and formats percentages for UI
function formatPct(v: number) {
  return `${Math.round(v)}%`;
}

// helper to quickly check if a customer has an active wholesale rate
function hasWholesale(c: Customer) {
  return typeof c.adminWholesaleDiscountPercent === "number";
}

// checks if a customer will actually receive loyalty
// since wholesale overrides loyalty, being a loyalty member doesn't matter if you have wholesale
function isEffectiveLoyalty(c: Customer) {
  return c.isLoyalty && !hasWholesale(c);
}

// determines what string label describes the customer's current discount state
function getDiscountMode(c: Customer): DiscountMode {
  if (hasWholesale(c)) return "ADMIN_WHOLESALE";
  if (c.isLoyalty) return "LOYALTY";
  return "NONE";
}

function getCustomerDiscountKind(c: Customer): "LOYALTY" | "WHOLESALE" | null {
  const mode = getDiscountMode(c);
  if (mode === "ADMIN_WHOLESALE") return "WHOLESALE";
  if (mode === "LOYALTY") return "LOYALTY";
  return null;
}

// extracts up to 2 initials from a customer name to put inside the avatar circle
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

// normalizes the customer API response into a standard array format
function normalizeCustomerList(data: any) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.customers)) return data.customers;
  return [];
}

function purchaseSummaryFromCustomer(customer: any): PurchaseSummary {
  const summary = customer?.purchaseSummary;
  const purchaseCount = Number(summary?.completedCount || 0);
  if (purchaseCount > 0 && summary?.latestCompletedAt) {
    return {
      purchaseCount,
      purchaseHistoryState: "history",
      lastPurchaseLabel: `${purchaseCount} purchase${purchaseCount === 1 ? "" : "s"} | ${formatNpr(
        Number(summary.latestCompletedNetTotal || 0),
      )} on ${formatDateLabel(String(summary.latestCompletedAt))}`,
    };
  }
  if (summary?.state === "cancelled_only") {
    return {
      purchaseCount: 0,
      purchaseHistoryState: "cancelled_only",
      lastPurchaseLabel: "No completed purchase yet. Latest invoice was cancelled.",
    };
  }
  return DEFAULT_PURCHASE_SUMMARY;
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
        "rounded-[28px] border border-slate-200/80 bg-white ",
        className,
      )}
    >
      {children}
    </div>
  );
}

// this is the shared button component used for the discounts page actions and modal footer buttons
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
        ? "border border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:opacity-90"
        : "border border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]";

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

// this is the search box used to filter customers by name, phone, email, and purchase text
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
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8C8889] transition-colors group-focus-within:text-[#000000]"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by customer, phone, or email"
        aria-label="Search by customer, phone, or email"
        className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white pl-10 pr-4 text-[13px] font-semibold text-[#000000] outline-none transition placeholder:text-[#8C8889] focus:border-[#11120d]"
      />
    </div>
  );
}

// this wraps standard text input styling for the add/edit customer modal
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
          aria-label={placeholder || "Text input"}
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

// this handles numeric input for discount percentages and keeps the value inside optional min/max limits
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
      aria-label={placeholder || "Number input"}
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

// this is the shared modal wrapper used for creating and editing customer discount profiles
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
  useBodyScrollLock(open);

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
        <div className="w-full max-w-[860px] overflow-hidden rounded-[28px] border border-slate-200 bg-white ">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
            <div>
              <div className="text-[11px] font-extrabold uppercase  text-slate-400">
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

// this renders the small rounded badges used throughout the discounts page
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

// this shows the customer's current pricing mode at a glance
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

// this is the pill-style filter button used above the customer list
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
          ? "border-slate-900 bg-slate-900 text-white "
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
            className={cn("text-[11px] font-extrabold uppercase ", labelTone)}
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#9DD8B2] bg-[#EAF8EF] px-2.5 py-1 text-[11px] font-extrabold text-[#179B4D]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#179B4D]" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#CFCFD3] bg-[#F3F4F6] px-2.5 py-1 text-[11px] font-bold text-[#8C8889]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#8C8889]" />
      Inactive
    </span>
  );
}

// this shows whether the customer currently gets wholesale, loyalty, or no special rule
function DiscountBadge({ customer }: { customer: Customer }) {
  const mode = getDiscountMode(customer);

  if (mode === "ADMIN_WHOLESALE") {
    return (
      <span className="inline-flex rounded-[8px] border border-[#F6D28B] bg-[#FFF7E8] px-2.5 py-1 text-[11px] font-bold text-[#B7791F]">
        Wholesale %
      </span>
    );
  }

  if (mode === "LOYALTY") {
    return (
      <span className="inline-flex rounded-[8px] border border-[#9DD8B2] bg-[#EAF8EF] px-2.5 py-1 text-[11px] font-bold text-[#179B4D]">
        Loyalty %
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-[8px] border border-[#CFCFD3] bg-[#F3F4F6] px-2.5 py-1 text-[11px] font-bold text-[#8C8889]">
      No discount
    </span>
  );
}

// this keeps the small action buttons in the table layout consistent
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
          ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:opacity-90"
          : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Icon name={icon} sizePx={15} className="text-inherit" />
      <span>{label}</span>
    </button>
  );
}

// this explains the customer's recent purchase history state in a compact badge
function PurchaseBadge({ customer }: { customer: Customer }) {
  if (customer.purchaseHistoryState === "history") {
    return <Pill tone="sky">{customer.purchaseCount} completed invoices</Pill>;
  }
  if (customer.purchaseHistoryState === "cancelled_only") {
    return <Pill tone="rose">Cancelled history only</Pill>;
  }
  return <Pill>No invoice history</Pill>;
}

// this is the full customer summary card shown in the card layout view
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
    <div className="rounded-[26px] border border-slate-200 bg-white p-5  transition hover:border-slate-300 ">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            <div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] bg-slate-900 text-[15px] font-extrabold text-white ">
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
          <div className="text-[11px] font-extrabold uppercase  text-slate-400">
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
          <div className="text-[11px] font-extrabold uppercase  text-slate-400">
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
          <div className="text-[11px] font-extrabold uppercase  text-slate-400">
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
            <div className="text-[11px] font-extrabold uppercase  text-slate-400">
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

// this callout card is used to explain how the billing rules behave
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
  const { showToast } = useToast();
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(2); // saved business-level loyalty percent used for display and comparison
  const [customers, setCustomers] = useState<Customer[]>([]); // full customer list with derived purchase summary fields
  const [discountRequests, setDiscountRequests] = useState<CustomerDiscountRequest[]>([]);
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestPercents, setRequestPercents] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true); // first-load state for the page
  const [loadError, setLoadError] = useState(""); // fetch error shown when initial data loading fails

  const [query, setQuery] = useState(""); // search text for customer filtering
  const [mode, setMode] = useState<"all" | DiscountMode>("all"); // active pricing-mode filter tab
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [openEdit, setOpenEdit] = useState(false); // controls the create/edit customer modal
  const [editingId, setEditingId] = useState<string | null>(null); // null means add flow, otherwise edit the matching customer
  const [pendingDeactivateCustomer, setPendingDeactivateCustomer] =
    useState<Customer | null>(null);
  const [deactivateBusy, setDeactivateBusy] = useState(false); // blocks repeated deactivate requests while the confirm dialog is running
  const [deleteTargetCustomer, setDeleteTargetCustomer] =
    useState<Customer | null>(null);
  const [deleteSafety, setDeleteSafety] =
    useState<CustomerDiscountDeleteSafety | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [fName, setFName] = useState(""); // modal field: customer name
  const [fPhone, setFPhone] = useState(""); // modal field: phone number
  const [fEmail, setFEmail] = useState(""); // modal field: optional email
  const [fIsLoyalty, setFIsLoyalty] = useState(false); // modal field: whether loyalty should stay active
  const [fWholesaleDiscount, setFWholesaleDiscount] = useState<number | "">(""); // modal field: wholesale percent override
  const [formErrors, setFormErrors] = useState<DiscountFormErrors>({}); // field-level add/edit validation errors
  const [formSubmitError, setFormSubmitError] = useState(""); // top-level add/edit mutation error
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  const formHasWholesale = typeof fWholesaleDiscount === "number"; // used to show when wholesale is overriding loyalty in the form

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    // loading customers, invoices, and business settings together because this page combines all three
    async function load() {
      setLoading(true);
      setLoadError("");

      const [customerResult, settingsResult, requestResult] = await Promise.allSettled([
          listCustomersApi(undefined, { signal: controller.signal }),
          getBusinessSettingsApi(),
          listCustomerDiscountRequestsApi("PENDING", { signal: controller.signal }),
        ]);

      if (!active || controller.signal.aborted) return;

      if (settingsResult.status === "fulfilled") {
        setLoyaltyDiscountPercent(
          clampPercent(Number(settingsResult.value?.loyaltyDiscountPercent ?? 2)),
        );
      }

      if (requestResult.status === "fulfilled") {
        const requests = Array.isArray(requestResult.value.requests)
          ? requestResult.value.requests
          : [];
        setDiscountRequests(requests);
        setRequestPercents(
          Object.fromEntries(requests.map((request) => [request.id, request.discountPercent])),
        );
      }

      if (customerResult.status === "fulfilled") {
        const rawCustomers = normalizeCustomerList(customerResult.value); // supporting either direct arrays or wrapped API responses
        setCustomers(
          rawCustomers.map((customer: any) => {
            // combining server customer data with our derived purchase summary creates the final page row shape
            const purchaseSummary = purchaseSummaryFromCustomer(customer);

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
      }

      const rejected = [customerResult, settingsResult, requestResult].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected.length > 0) {
        const rateLimited = rejected.some((result) => isRateLimitError(result.reason));
        if (rateLimited) requestRateLimitRecovery();
        setLoadError(
          rateLimited
            ? "Discount data is temporarily paused and will refresh automatically."
            : "Some discount records could not be loaded right now.",
        );
      }

      if (active) setLoading(false);
    }

    const timer = window.setTimeout(() => void load(), 100);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [rateLimitRecoveryKey]);

  const filtered = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();

    return customers.filter((customer) => {
      // one search input matches against identity fields plus purchase history text
      if (loweredQuery) {
        const haystack = `${customer.name} ${customer.phone} ${
          customer.email || ""
        } ${customer.lastPurchaseLabel}`.toLowerCase();
        if (!haystack.includes(loweredQuery)) return false;
      }

      const customerMode = getDiscountMode(customer); // wholesale, loyalty, or none
      if (mode !== "all" && customerMode !== mode) return false;

      return true;
    });
  }, [customers, mode, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = clampPage(page, 1, totalPages);
  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped, pageSize]);
  const pageStart = filtered.length === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = filtered.length === 0 ? 0 : pageStart + pageItems.length;

  useEffect(() => {
    setPage(1);
  }, [query, mode]);

  useEffect(() => {
    setPage((current) => clampPage(current, 1, totalPages));
  }, [totalPages]);

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

  // opening edit mode copies the selected customer into the modal fields so the user can adjust the rule safely
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

  // opening add mode resets every modal field back to a fresh customer state
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

  // closing the modal clears any stale validation or submit error from the previous attempt
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

    // these validation checks keep obviously bad customer data from reaching the backend
    if (!name) nextErrors.name = "Customer name is required.";
    if (!phone) nextErrors.phone = "Phone is required.";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.email = "Enter a valid email address.";
    }

    setFormErrors(nextErrors);
    setFormSubmitError("");

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
    setPendingDeactivateCustomer(customer);
  }

  function closeDeleteDialog() {
    if (deleteBusy) return;
    setDeleteTargetCustomer(null);
    setDeleteSafety(null);
    setDeleteLoading(false);
  }

  async function requestDeleteDiscount(customer: Customer) {
    const discountKind = getCustomerDiscountKind(customer);
    if (!discountKind) {
      showToast("info", `${customer.name} has no active discount to delete.`);
      return;
    }

    setDeleteTargetCustomer(customer);
    setDeleteSafety(null);
    setDeleteLoading(true);

    try {
      const safety = await getCustomerDiscountDeleteSafetyApi(
        customer.id,
        discountKind,
      );
      setDeleteSafety(safety);
    } catch (err: any) {
      showToast(
        "danger",
        err?.response?.data?.error ||
          err?.message ||
          "Could not check this discount before deleting.",
      );
      setDeleteTargetCustomer(null);
    } finally {
      setDeleteLoading(false);
    }
  }

  async function confirmDeleteDiscount() {
    const customer = deleteTargetCustomer;
    const discountKind = customer ? getCustomerDiscountKind(customer) : null;
    if (!customer || !discountKind || deleteBusy) return;

    if (!deleteSafety?.canDelete) {
      closeDeleteDialog();
      return;
    }

    setDeleteBusy(true);
    try {
      const result = await deleteCustomerDiscountApi(customer.id, discountKind);
      setCustomers((prev) =>
        prev.map((item) =>
          item.id === customer.id
            ? {
                ...item,
                isLoyalty:
                  discountKind === "LOYALTY" ? false : item.isLoyalty,
                adminWholesaleDiscountPercent:
                  discountKind === "WHOLESALE"
                    ? undefined
                    : item.adminWholesaleDiscountPercent,
              }
            : item,
        ),
      );
      showToast(result.changed ? "success" : "info", result.message);
      closeDeleteDialog();
    } catch (err: any) {
      const safety = err?.response?.data?.safety as
        | CustomerDiscountDeleteSafety
        | undefined;
      if (safety) setDeleteSafety(safety);
      showToast(
        "danger",
        err?.response?.data?.error ||
          err?.message ||
          "Failed to delete customer discount.",
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  async function reactivateCustomer(customer: Customer) {
    if (customer.isActive || deactivateBusy) return;
    setDeactivateBusy(true);

    try {
      await updateCustomerApi(customer.id, { isActive: true });
      setCustomers((prev) =>
        prev.map((item) =>
          item.id === customer.id ? { ...item, isActive: true } : item,
        ),
      );
      showToast("success", `${customer.name} reactivated.`);
    } catch {
      showToast("danger", `Failed to reactivate ${customer.name}.`);
    } finally {
      setDeactivateBusy(false);
    }
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
      showToast("success", `${customer.name} deactivated.`);
    } catch {
      showToast("danger", `Failed to deactivate ${customer.name}.`);
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

  async function approveDiscountRequest(request: CustomerDiscountRequest) {
    if (requestBusyId) return;
    setRequestBusyId(request.id);

    try {
      const approved = await approveCustomerDiscountRequestApi(request.id, {
        discountPercent: requestPercents[request.id] ?? request.discountPercent,
        adminNote: requestNotes[request.id]?.trim() || undefined,
      });
      const customerId = approved.approvedCustomerId || approved.approvedCustomer?.id;
      const nextPercent = Number(approved.discountPercent || request.discountPercent);

      if (customerId) {
        setCustomers((current) => {
          const exists = current.some((customer) => customer.id === customerId);
          const nextCustomer: Customer = {
            id: customerId,
            name: approved.customerName,
            phone: approved.phone,
            email: approved.email || undefined,
            isActive: true,
            isLoyalty: approved.discountType === "LOYALTY",
            adminWholesaleDiscountPercent:
              approved.discountType === "WHOLESALE" ? nextPercent : undefined,
            ...DEFAULT_PURCHASE_SUMMARY,
          };

          return exists
            ? current.map((customer) =>
                customer.id === customerId
                  ? {
                      ...customer,
                      name: approved.customerName,
                      phone: approved.phone,
                      email: approved.email || undefined,
                      isActive: true,
                      isLoyalty: approved.discountType === "LOYALTY",
                      adminWholesaleDiscountPercent:
                        approved.discountType === "WHOLESALE" ? nextPercent : undefined,
                    }
                  : customer,
              )
            : [nextCustomer, ...current];
        });
      }

      setDiscountRequests((current) =>
        current.filter((item) => item.id !== request.id),
      );
      showToast("success", "Discount request approved.");
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Failed to approve discount request.",
      );
    } finally {
      setRequestBusyId(null);
    }
  }

  async function rejectDiscountRequest(request: CustomerDiscountRequest) {
    if (requestBusyId) return;
    setRequestBusyId(request.id);

    try {
      await rejectCustomerDiscountRequestApi(request.id, {
        adminNote: requestNotes[request.id]?.trim() || undefined,
      });
      setDiscountRequests((current) =>
        current.filter((item) => item.id !== request.id),
      );
      showToast("success", "Discount request rejected.");
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
          error?.message ||
          "Failed to reject discount request.",
      );
    } finally {
      setRequestBusyId(null);
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
    <div className="space-y-[14px] text-[#000000]">
      <div className="space-y-[14px]">
        {/* this header keeps the page title separate from the rule reminder pill so the pricing rule stays visible without feeling heavy */}
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-[24px] font-extrabold  text-[#000000]">
              Customer Discounts
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[#8C8889]">
              Add, edit, and manage customer discount rules for billing.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-1.5 rounded-full border border-[#CFCFD3] bg-white px-4 py-2 text-[11px] font-bold text-[#8C8889] ">
              <Icon name="info" className="text-[14px] text-[#B7791F]" />
              <span>Wholesale overrides loyalty</span>
            </div>
          </div>
        </div>

        {/* these metric cards summarize the rule breakdown before the user starts browsing individual customers */}
        <div className="bg-white rounded-[18px] border border-[#CFCFD3] p-5 md:p-6 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-6">
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-slate-900">
                {loading && customers.length === 0 ? "..." : stats.total} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Total</span>
              </span>
              <div className="h-1 w-12 bg-slate-800 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-orange-600">
                {loading && customers.length === 0 ? "..." : stats.adminWholesale} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Wholesale</span>
              </span>
              <div className="h-1 w-12 bg-orange-500 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-emerald-600">
                {loading && customers.length === 0 ? "..." : stats.loyalty} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Loyalty</span>
              </span>
              <div className="h-1 w-12 bg-emerald-500 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-slate-600">
                {loading && customers.length === 0 ? "..." : stats.none} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Standard</span>
              </span>
              <div className="h-1 w-12 bg-slate-400 mt-2 rounded-full"></div>
            </div>
          </div>
        </div>

        {discountRequests.length > 0 ? (
          <div className="rounded-[24px] border border-[#CFCFD3] bg-white p-5">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-[17px] font-extrabold text-[#000000]">
                  Pending cashier discount requests
                </h2>
                <p className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                  Approving creates or updates the customer discount profile and notifies the cashier.
                </p>
              </div>
              <Pill tone="orange">{discountRequests.length} pending</Pill>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {discountRequests.map((request) => (
                <div
                  key={request.id}
                  className="rounded-[18px] border border-slate-200 bg-slate-50/70 p-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-extrabold text-slate-900">
                        {request.customerName}
                      </div>
                      <div className="mt-1 text-[12px] font-semibold text-slate-500">
                        {request.phone}
                        {request.email ? ` | ${request.email}` : ""}
                      </div>
                      <div className="mt-2 text-[12px] font-semibold text-slate-600">
                        Requested by {request.requestedBy?.name || "Cashier"} on{" "}
                        {new Date(request.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <Pill tone={request.discountType === "WHOLESALE" ? "orange" : "green"}>
                      {request.discountType} {request.discountPercent}%
                    </Pill>
                  </div>

                  {request.reason ? (
                    <div className="mt-3 rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-600">
                      {request.reason}
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-3 md:grid-cols-[130px_1fr]">
                    <label className="space-y-1">
                      <div className="text-[11px] font-extrabold uppercase text-slate-400">
                        Final %
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={requestPercents[request.id] ?? request.discountPercent}
                        onChange={(event) =>
                          setRequestPercents((current) => ({
                            ...current,
                            [request.id]: Number(event.target.value),
                          }))
                        }
                        className="h-[42px] w-full rounded-[12px] border border-slate-200 bg-white px-3 text-[13px] font-bold outline-none focus:border-slate-900"
                      />
                    </label>
                    <label className="space-y-1">
                      <div className="text-[11px] font-extrabold uppercase text-slate-400">
                        Admin note
                      </div>
                      <input
                        value={requestNotes[request.id] || ""}
                        onChange={(event) =>
                          setRequestNotes((current) => ({
                            ...current,
                            [request.id]: event.target.value,
                          }))
                        }
                        placeholder="Optional note for cashier"
                        className="h-[42px] w-full rounded-[12px] border border-slate-200 bg-white px-3 text-[13px] font-semibold outline-none focus:border-slate-900"
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                      variant="danger"
                      icon="close"
                      disabled={requestBusyId === request.id}
                      onClick={() => void rejectDiscountRequest(request)}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      icon="check_circle"
                      disabled={requestBusyId === request.id}
                      onClick={() => void approveDiscountRequest(request)}
                    >
                      {requestBusyId === request.id ? "Working..." : "Approve"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* this main management card groups filters and customer records into one clear pricing-rules workspace */}
        <div className="overflow-hidden rounded-[24px] border border-[#CFCFD3] bg-white ">
          <div className="flex flex-col gap-4 border-b border-[#CFCFD3] bg-white p-5 xl:flex-row xl:items-center xl:justify-between">
            <MobileFilterTabs
              className="lg:hidden"
              ariaLabel="Discount type"
              value={mode}
              onChange={setMode}
              items={[
                { value: "all", label: "All Discounts", count: stats.total },
                { value: "ADMIN_WHOLESALE", label: "Wholesale", count: stats.adminWholesale },
                { value: "LOYALTY", label: "Loyalty", count: stats.loyalty },
                { value: "NONE", label: "No discount", count: stats.none },
              ]}
            />
            <div className="hide-scrollbar hidden w-full items-center gap-2 overflow-x-auto pb-2 xl:flex xl:w-auto xl:pb-0">
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

          {loadError ? (
            <div className="px-5 pt-5 pb-2">
              <div className="rounded-[16px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[13px] font-semibold text-[#BE123C]">
                {loadError}
              </div>
            </div>
          ) : null}

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[940px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#DADDE3] bg-[#F8FAFC]">
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Customer Details
                  </th>
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Discount Type
                  </th>
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Rate
                  </th>
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Last Purchase
                  </th>
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Status
                  </th>
                  <th className="px-4 py-3 text-center text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E7EB]">
                {loading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index}>
                      <td colSpan={6} className="px-4 py-3">
                        <div className="h-12 animate-pulse rounded-[12px] bg-[#F3F4F6]" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-[#8C8889]">
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
                  pageItems.map((customer) => {
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
                        className="group transition-colors hover:bg-[#ECEFF3]"
                      >
                        <td className="px-4 py-3 align-top">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#DADDE3] bg-[#F3F4F6] text-[13px] font-extrabold text-[#565449]">
                              {getInitials(customer.name).charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-extrabold text-[#000000]">
                                {customer.name}
                              </div>
                              <div className="truncate mt-0.5 text-[13px] font-semibold text-[#8C8889]">
                                {customer.phone || "No phone on file"}
                              </div>
                              <div className="truncate text-[11px] font-medium text-[#8C8889]/80">
                                {customer.email || "No email on file"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <DiscountBadge customer={customer} />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col">
                            <span className="text-[14px] font-extrabold text-[#000000]">
                              {rate}
                            </span>
                            <span className="text-[10px] font-semibold text-[#8C8889]">
                              {discountMode === "NONE"
                                ? "standard"
                                : "on subtotal"}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div
                            className={cn(
                              "max-w-[240px] text-[12px] font-semibold leading-6",
                              customer.purchaseHistoryState === "history"
                                ? "text-[#565449]"
                                : customer.purchaseHistoryState ===
                                    "cancelled_only"
                                  ? "text-[#BE123C]"
                                  : "text-[#8C8889]",
                            )}
                          >
                            {customer.lastPurchaseLabel}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <StatusBadge active={customer.isActive} />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditCustomer(customer)}
                              className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-[#11120d] hover:text-[#FFFFFF]"
                              title="Edit customer"
                              aria-label={`Edit ${customer.name}`}
                            >
                              <Icon name="edit" className="text-[17px]" />
                            </button>
                            {discountMode !== "NONE" ? (
                              <button
                                type="button"
                                onClick={() => requestDeleteDiscount(customer)}
                                disabled={deleteBusy || deleteLoading}
                                className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-rose-600 hover:text-[#FFFFFF] disabled:opacity-50"
                                title="Delete discount"
                                aria-label={`Delete discount for ${customer.name}`}
                              >
                                <Icon name="delete" className="text-[17px]" />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                customer.isActive
                                  ? requestDeactivateCustomer(customer)
                                  : void reactivateCustomer(customer)
                              }
                              disabled={deactivateBusy}
                              className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-[#11120d] hover:text-[#FFFFFF] disabled:opacity-50"
                              title={customer.isActive ? "Deactivate customer" : "Reactivate customer"}
                              aria-label={customer.isActive ? `Deactivate ${customer.name}` : `Reactivate ${customer.name}`}
                            >
                              <Icon name={customer.isActive ? "block" : "check_circle"} className="text-[17px]" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-3 lg:hidden">
            {pageItems.map((customer) => {
              const discountMode = getDiscountMode(customer);
              const rate =
                discountMode === "ADMIN_WHOLESALE"
                  ? formatPct(customer.adminWholesaleDiscountPercent || 0)
                  : discountMode === "LOYALTY"
                    ? formatPct(loyaltyDiscountPercent)
                    : "—";

              return (
                <div
                  key={customer.id}
                  className="rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-extrabold text-[#000000]">
                        {customer.name}
                      </div>
                      <div className="mt-1 text-[13px] font-semibold text-[#8C8889]">
                        {customer.phone || "No phone on file"}
                      </div>
                    </div>
                    <DiscountBadge customer={customer} />
                  </div>
                  
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">Rate</div>
                      <div className="mt-0.5 text-[14px] font-extrabold text-[#000000]">{rate}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">Status</div>
                      <div className="mt-1"><StatusBadge active={customer.isActive} /></div>
                    </div>
                  </div>

                  <div className="mt-4 border-t border-[#E5E7EB] pt-4">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div
                          className={cn(
                            "truncate text-[12px] font-semibold",
                            customer.purchaseHistoryState === "history"
                              ? "text-[#565449]"
                              : customer.purchaseHistoryState === "cancelled_only"
                                ? "text-[#BE123C]"
                                : "text-[#8C8889]"
                          )}
                        >
                          {customer.lastPurchaseLabel}
                        </div>
                      </div>
                      <div className="ml-4 flex shrink-0 items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEditCustomer(customer)}
                          className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-[#11120d] hover:text-[#FFFFFF]"
                          title="Edit customer"
                        >
                          <Icon name="edit" className="text-[17px]" />
                        </button>
                        {discountMode !== "NONE" ? (
                          <button
                            type="button"
                            onClick={() => requestDeleteDiscount(customer)}
                            disabled={deleteBusy || deleteLoading}
                            className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-rose-600 hover:text-[#FFFFFF] disabled:opacity-50"
                            title="Delete discount"
                          >
                            <Icon name="delete" className="text-[17px]" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {pageItems.length === 0 && !loading && (
              <div className="py-8 text-center">
                <div className="text-[#8C8889]">
                  <span className="text-[13px] font-semibold">No customers found.</span>
                </div>
              </div>
            )}
          </div>

          <PaginationBar
            page={pageClamped}
            totalPages={totalPages}
            total={filtered.length}
            start={pageStart}
            end={pageEnd}
            label="customer records"
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
            className="bg-[#F3F4F6]/40 px-6"
          />
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
                <div className="text-[12px] font-extrabold uppercase  text-slate-400">
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
                <div className="text-[12px] font-extrabold uppercase  text-slate-400">
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
                <div className="text-[12px] font-extrabold uppercase  text-slate-400">
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
                  <div className="text-[12px] font-extrabold uppercase  text-slate-400">
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
                    <div className="text-[12px] font-extrabold uppercase  text-slate-400">
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
          open={!!deleteTargetCustomer}
          title={
            deleteSafety?.canDelete
              ? "Delete discount?"
              : "Discount delete check"
          }
          message={
            deleteLoading
              ? "Checking purchase history before this discount can be deleted."
              : deleteSafety?.canDelete
                ? `This removes only the ${getCustomerDiscountKind(deleteTargetCustomer!)?.toLowerCase()} discount for ${deleteTargetCustomer?.name}. The customer profile stays in the system.`
                : deleteSafety?.reason ||
                  "This discount cannot be deleted right now."
          }
          confirmLabel={deleteSafety?.canDelete ? "Delete Discount" : "Close"}
          cancelLabel={deleteSafety?.canDelete ? "Cancel" : "Back"}
          tone={deleteSafety?.canDelete ? "danger" : "primary"}
          icon={deleteSafety?.canDelete ? "delete" : "info"}
          onConfirm={confirmDeleteDiscount}
          onClose={closeDeleteDialog}
          busy={deleteLoading || deleteBusy}
          details={
            deleteTargetCustomer ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[14px] border border-slate-200 bg-white p-3">
                    <div className="text-[10px] font-extrabold uppercase text-slate-400">
                      Customer
                    </div>
                    <div className="mt-1 text-[13px] font-extrabold text-slate-900">
                      {deleteTargetCustomer.name}
                    </div>
                    <div className="mt-1 text-[11px] font-semibold text-slate-500">
                      {deleteTargetCustomer.phone || "No phone on file"}
                    </div>
                  </div>
                  <div className="rounded-[14px] border border-slate-200 bg-white p-3">
                    <div className="text-[10px] font-extrabold uppercase text-slate-400">
                      Discount
                    </div>
                    <div className="mt-1 text-[13px] font-extrabold text-slate-900">
                      {getCustomerDiscountKind(deleteTargetCustomer) ===
                      "WHOLESALE"
                        ? `Wholesale ${formatPct(deleteTargetCustomer.adminWholesaleDiscountPercent || 0)}`
                        : `Loyalty ${formatPct(loyaltyDiscountPercent)}`}
                    </div>
                  </div>
                </div>
                <div
                  className={cn(
                    "rounded-[14px] border px-3 py-2 text-[12px] font-bold",
                    deleteLoading
                      ? "border-slate-200 bg-white text-slate-600"
                      : deleteSafety?.canDelete
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]",
                  )}
                >
                  {deleteLoading
                    ? "Checking..."
                    : deleteSafety?.canDelete
                      ? "No finalized purchase history found. This discount can be deleted safely."
                      : deleteSafety?.purchaseCount
                        ? `Blocked by ${deleteSafety.references.join(", ")}.`
                        : "No active discount was found to delete."}
                </div>
              </div>
            ) : null
          }
        />

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
