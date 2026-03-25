import React, { useMemo, useState, useEffect } from "react";
import Icon from "~/components/ui/Icon";
import {
  listCustomersApi,
  createCustomerApi,
  updateCustomerApi,
  listAuditLogsApi,
} from "~/lib/api/endpoints";

type DiscountMode = "ADMIN_WHOLESALE" | "LOYALTY" | "NONE";

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;

  // loyalty eligibility badge (effective only if adminWholesaleDiscountPercent is NOT set)
  isLoyalty: boolean;

  // if set, applied on subtotal (retail-based) during billing
  adminWholesaleDiscountPercent?: number;

  lastPurchaseLabel: string;
};

type AuditItem = {
  id: string;
  title: string;
  desc?: string;
  timeLabel: string;
};

const LS_KEYS = {
  wholesaleQtyThreshold: "ks_wholesaleQtyThreshold",
  loyaltyDiscountPercent: "ks_loyaltyDiscountPercent",
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] bg-white border border-slate-200/70 shadow-sm">
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
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition";
  const styles =
    variant === "primary"
      ? "bg-orange-600 text-white border-orange-600 hover:bg-orange-700"
      : variant === "danger"
        ? "bg-white text-rose-600 border-rose-200 hover:bg-rose-50"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(base, styles, disabled && "opacity-50 pointer-events-none")}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  leftIcon,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leftIcon?: string;
}) {
  return (
    <div className="flex items-center gap-[8px] rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px]">
      {leftIcon ? (
        <Icon name={leftIcon} className="text-slate-500" />
      ) : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-[14px] outline-none placeholder:text-slate-400"
      />
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
        if (raw === "") return onChange("");
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        if (typeof min === "number" && n < min) return onChange(min);
        if (typeof max === "number" && n > max) return onChange(max);
        onChange(n);
      }}
      className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] text-[14px] outline-none placeholder:text-slate-400"
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
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
        aria-label="Close overlay"
      />
      <div className="absolute inset-0 flex items-center justify-center p-[14px]">
        <div className="w-full max-w-[920px] rounded-[16px] bg-white border border-slate-200 shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-[18px] py-[14px] border-b border-slate-100">
            <div className="text-[15px] font-semibold text-slate-900">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-[36px] w-[36px] rounded-[12px] border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center"
              aria-label="Close modal"
            >
              <Icon name="close" className="text-slate-700" />
            </button>
          </div>

          <div className="px-[18px] py-[16px]">{children}</div>

          {footer ? (
            <div className="px-[18px] py-[14px] border-t border-slate-100 bg-slate-50/40">
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
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky";
}) {
  const map: Record<typeof tone, string> = {
    neutral: "bg-slate-50 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    orange: "bg-orange-50 text-orange-700 border-orange-100",
    sky: "bg-sky-50 text-sky-700 border-sky-100",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

function hasWholesale(c: Customer) {
  return typeof c.adminWholesaleDiscountPercent === "number";
}

function isEffectiveLoyalty(c: Customer) {
  return c.isLoyalty && !hasWholesale(c);
}

function getDiscountMode(c: Customer): DiscountMode {
  if (hasWholesale(c)) return "ADMIN_WHOLESALE";
  if (c.isLoyalty) return "LOYALTY"; // effective (because no wholesale)
  return "NONE";
}

function DiscountModeLabel({ mode }: { mode: DiscountMode }) {
  if (mode === "ADMIN_WHOLESALE")
    return <Pill tone="orange">Wholesale % (Customer)</Pill>;
  if (mode === "LOYALTY") return <Pill tone="green">Loyalty</Pill>;
  return <Pill>None</Pill>;
}

function formatPct(v?: number) {
  if (typeof v !== "number") return "-";
  return `${v}%`;
}

function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
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

export default function DiscountsPage() {
  const [wholesaleQtyThreshold, setWholesaleQtyThreshold] = useState(10);
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(2);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setWholesaleQtyThreshold(readInt(LS_KEYS.wholesaleQtyThreshold, 10));
    setLoyaltyDiscountPercent(readInt(LS_KEYS.loyaltyDiscountPercent, 2));
  }, []);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const [custData, auditData] = await Promise.allSettled([
          listCustomersApi(),
          listAuditLogsApi({ pageSize: 5 }),
        ]);

        if (custData.status === "fulfilled" && custData.value) {
          const raw = Array.isArray(custData.value) ? custData.value : [];
          setCustomers(
            raw.map((c: any) => ({
              id: c.id,
              name: c.name || "Unknown",
              phone: c.phone || "",
              email: c.email,
              isLoyalty: !!c.loyaltyPercent,
              adminWholesaleDiscountPercent: c.wholesalePercent || undefined,
              lastPurchaseLabel: "—",
            })),
          );
        }

        if (auditData.status === "fulfilled" && auditData.value) {
          const logs = auditData.value.logs || [];
          setAudit(
            logs.map((l: any, idx: number) => ({
              id: l.id || `a${idx}`,
              title: l.action || "Activity",
              desc:
                l.details && typeof l.details === "string"
                  ? l.details
                  : undefined,
              timeLabel: new Date(l.createdAt).toLocaleDateString(),
            })),
          );
        }
      } catch {} finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // filters
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"all" | DiscountMode>("all");
  const [onlyLoyalty, setOnlyLoyalty] = useState(false); // effective loyalty

  // modal state
  // modal state
  const [openEdit, setOpenEdit] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [searchPhone, setSearchPhone] = useState("");
  const [searchEmail, setSearchEmail] = useState("");

  const [applyCustId, setApplyCustId] = useState<string | null>(null);

  // form fields
  const [fName, setFName] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fIsLoyalty, setFIsLoyalty] = useState(false);
  const [fWholesaleDiscount, setFWholesaleDiscount] = useState<number | "">("");

  const formHasWholesale = typeof fWholesaleDiscount === "number";

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();

    return customers.filter((c) => {
      if (s) {
        const blob = `${c.name} ${c.phone} ${c.email || ""}`.toLowerCase();
        if (!blob.includes(s)) return false;
      }

      const m = getDiscountMode(c);
      if (mode !== "all" && m !== mode) return false;

      // IMPORTANT: "Loyalty only" = effective loyalty (loyal badge AND no wholesale)
      if (onlyLoyalty && !isEffectiveLoyalty(c)) return false;

      return true;
    });
  }, [customers, q, mode, onlyLoyalty]);

  const stats = useMemo(() => {
    const total = customers.length;
    const adminWholesale = customers.filter(
      (c) => getDiscountMode(c) === "ADMIN_WHOLESALE",
    ).length;
    const loyalty = customers.filter(
      (c) => getDiscountMode(c) === "LOYALTY",
    ).length; // effective loyalty only
    const none = customers.filter((c) => getDiscountMode(c) === "NONE").length;
    return { total, adminWholesale, loyalty, none };
  }, [customers]);

  function openEditCustomer(c: Customer) {
    setEditingId(c.id);
    setFName(c.name);
    setFPhone(c.phone);
    setFEmail(c.email || "");

    setFWholesaleDiscount(
      typeof c.adminWholesaleDiscountPercent === "number"
        ? c.adminWholesaleDiscountPercent
        : "",
    );

    // If wholesale exists, loyalty is not effective. Keep badge value, but UI will disable it anyway.
    setFIsLoyalty(c.isLoyalty && !hasWholesale(c));

    setOpenEdit(true);
  }

  function openAddCustomer() {
    setEditingId(null);
    setFName("");
    setFPhone("");
    setFEmail("");
    setFIsLoyalty(false);
    setFWholesaleDiscount("");
    setOpenEdit(true);
  }

  function closeEdit() {
    setOpenEdit(false);
  }

  async function saveCustomer() {
    const name = fName.trim();
    const phone = fPhone.trim();
    const email = fEmail.trim();
    if (!name || !phone) return;

    const discount =
      typeof fWholesaleDiscount === "number"
        ? clampPercent(fWholesaleDiscount)
        : undefined;

    // ENFORCEMENT:
    // - If wholesale% is set -> loyalty must be false (loyalty is not applicable)
    // - If loyalty is true -> wholesale% must be undefined (handled in UI too)
    const nextIsLoyalty = typeof discount === "number" ? false : fIsLoyalty;

    const modeAfter: DiscountMode =
      typeof discount === "number"
        ? "ADMIN_WHOLESALE"
        : nextIsLoyalty
          ? "LOYALTY"
          : "NONE";

    const desc =
      modeAfter === "ADMIN_WHOLESALE"
        ? `Wholesale discount set to ${discount}% (subtotal-level, retail-based when customer discount is used). Loyalty is disabled when wholesale % exists.`
        : modeAfter === "LOYALTY"
          ? `Customer is loyalty eligible. Loyalty discount applies only if no customer wholesale % is set.`
          : `Customer has no discount rule set.`;

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
          prev.map((c) =>
            c.id === editingId
              ? {
                  ...c,
                  name,
                  phone,
                  email: email || undefined,
                  isLoyalty: nextIsLoyalty,
                  adminWholesaleDiscountPercent: discount,
                }
              : c,
          ),
        );

        setAudit((prev) => [
          {
            id: `aud_${Date.now()}`,
            title: `Updated discount profile: ${name}`,
            desc,
            timeLabel: "Just now",
          },
          ...prev,
        ]);

        setOpenEdit(false);
        return;
      }

      const newCust = await createCustomerApi({
        name,
        phone,
        email: email || undefined,
        loyaltyPercent: nextIsLoyalty ? loyaltyDiscountPercent : 0,
        wholesalePercent: discount || 0,
      });

      setCustomers((prev) => [
        {
          id: newCust.id,
          name,
          phone,
          email: email || undefined,
          isLoyalty: nextIsLoyalty,
          adminWholesaleDiscountPercent: discount,
          lastPurchaseLabel: "—",
        },
        ...prev,
      ]);

      setAudit((prev) => [
        {
          id: `aud_${Date.now()}`,
          title: `Added customer: ${name}`,
          desc,
          timeLabel: "Just now",
        },
        ...prev,
      ]);

      setOpenEdit(false);
    } catch {
      // Intentionally swallow errors so UI flow isn't interrupted in MVP
    }
  }

  async function clearCustomerDiscount(id: string) {
    const c = customers.find((x) => x.id === id);
    if (!c) return;

    try {
      await updateCustomerApi(id, { wholesalePercent: 0 });
      setCustomers((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, adminWholesaleDiscountPercent: undefined } : x,
        ),
      );

      setAudit((prev) => [
        {
          id: `aud_${Date.now()}`,
          title: `Removed customer wholesale discount: ${c.name}`,
          desc: "Customer wholesale % cleared. Loyalty will apply only if loyalty is enabled for this customer.",
          timeLabel: "Just now",
        },
        ...prev,
      ]);
    } catch {}
  }

  // UI enforcement handlers
  function onWholesaleChange(v: number | "") {
    setFWholesaleDiscount(v);

    // If admin types a wholesale %, automatically turn off loyalty.
    if (typeof v === "number") {
      setFIsLoyalty(false);
    }
  }

  function onToggleLoyalty(next: boolean) {
    // If admin turns on loyalty, automatically clear wholesale %.
    if (next) setFWholesaleDiscount("");
    setFIsLoyalty(next);
  }

  return (
    <div className="space-y-[14px]">
      {/* Summary + rule explanation */}
      <Card>
        <div className="p-[16px] space-y-[12px]">
          <div className="flex items-start justify-between gap-[12px] flex-wrap">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-slate-900">
                Discounts
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Discounts are applied on the{" "}
                <span className="font-semibold">subtotal</span> during billing
                (cashier screen).
              </div>
            </div>

            <div className="flex items-center gap-[10px] flex-wrap justify-end">
              <Button
                icon="person_add"
                variant="primary"
                onClick={openAddCustomer}
              >
                Add Customer
              </Button>
            </div>
          </div>

          {/* small stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-[10px]">
            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[12px] text-slate-600 font-semibold">
                Total
              </div>
              <div className="text-[16px] font-bold text-slate-900 mt-[2px]">
                {stats.total}
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[12px] text-slate-600 font-semibold">
                Wholesale %
              </div>
              <div className="text-[16px] font-bold text-slate-900 mt-[2px]">
                {stats.adminWholesale}
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[12px] text-slate-600 font-semibold">
                Loyalty
              </div>
              <div className="text-[16px] font-bold text-slate-900 mt-[2px]">
                {stats.loyalty}
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[12px] text-slate-600 font-semibold">
                No Discount
              </div>
              <div className="text-[16px] font-bold text-slate-900 mt-[2px]">
                {stats.none}
              </div>
            </div>
          </div>

          {/* rules preview */}
          <div className="rounded-[14px] border border-slate-200 p-[12px] bg-slate-50/40">
            <div className="text-[13px] font-semibold text-slate-900">
              Billing rules (your MVP)
            </div>
            <ul className="mt-[8px] space-y-[6px] text-[12px] text-slate-700">
              <li className="flex items-start gap-[8px]">
                <span className="mt-[2px] h-[6px] w-[6px] rounded-full bg-orange-500 shrink-0" />
                If a customer has{" "}
                <span className="font-semibold">Wholesale %</span> set, we keep
                base prices as <span className="font-semibold">retail</span> and
                apply the customer percent on subtotal.
              </li>
              <li className="flex items-start gap-[8px]">
                <span className="mt-[2px] h-[6px] w-[6px] rounded-full bg-orange-500 shrink-0" />
                For new/normal customers, item price becomes wholesale only when
                quantity reaches{" "}
                <span className="font-semibold">{wholesaleQtyThreshold}</span>{" "}
                (threshold set in Settings).
              </li>
              <li className="flex items-start gap-[8px]">
                <span className="mt-[2px] h-[6px] w-[6px] rounded-full bg-orange-500 shrink-0" />
                Loyalty discount is{" "}
                <span className="font-semibold">{loyaltyDiscountPercent}%</span>{" "}
                on subtotal and applies only if customer has{" "}
                <span className="font-semibold">no</span> Wholesale % set.
              </li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Filters + list */}
      <Card>
        <div className="p-[16px] space-y-[12px]">
          <div className="flex flex-col lg:flex-row lg:items-center gap-[12px]">
            <div className="flex-1">
              <Input
                value={q}
                onChange={setQ}
                placeholder="Search customer (name / phone / email)..."
                leftIcon="search"
              />
            </div>

            <div className="flex items-center gap-[10px] flex-wrap justify-end">
              <div className="flex items-center gap-[8px] rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px]">
                <Icon name="tune" className="text-slate-500" />
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as any)}
                  className="text-[14px] outline-none bg-transparent"
                >
                  <option value="all">All</option>
                  <option value="ADMIN_WHOLESALE">
                    Wholesale % (Customer)
                  </option>
                  <option value="LOYALTY">Loyalty</option>
                  <option value="NONE">No Discount</option>
                </select>
              </div>

              <label className="inline-flex items-center gap-[8px] text-[13px] font-semibold text-slate-700 select-none">
                <input
                  type="checkbox"
                  checked={onlyLoyalty}
                  onChange={(e) => setOnlyLoyalty(e.target.checked)}
                  className="h-[16px] w-[16px]"
                />
                Loyalty only (effective)
              </label>
            </div>
          </div>

          <div className="overflow-x-auto rounded-[14px] border border-slate-200">
            <table className="w-full min-w-[920px] text-left">
              <thead>
                <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100 bg-slate-50/60">
                  <th className="px-[12px] py-[12px]">Customer</th>
                  <th className="px-[12px] py-[12px]">Phone</th>
                  <th className="px-[12px] py-[12px]">Discount Rule</th>
                  <th className="px-[12px] py-[12px]">Wholesale %</th>
                  <th className="px-[12px] py-[12px]">Loyalty</th>
                  <th className="px-[12px] py-[12px]">Last Purchase</th>
                  <th className="px-[12px] py-[12px] text-right">Action</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {filtered.map((c) => {
                  const m = getDiscountMode(c);
                  const w = hasWholesale(c);
                  const effLoyal = isEffectiveLoyalty(c);

                  return (
                    <tr key={c.id} className="text-[14px] hover:bg-slate-50/60">
                      <td className="px-[12px] py-[14px]">
                        <div className="font-semibold text-slate-900">
                          {c.name}
                        </div>
                        <div className="text-[12px] text-slate-500">
                          {c.email || "—"}
                        </div>
                      </td>

                      <td className="px-[12px] py-[14px] text-slate-700">
                        {c.phone}
                      </td>

                      <td className="px-[12px] py-[14px]">
                        <DiscountModeLabel mode={m} />
                      </td>

                      <td className="px-[12px] py-[14px] text-slate-900 font-semibold">
                        {formatPct(c.adminWholesaleDiscountPercent)}
                      </td>

                      <td className="px-[12px] py-[14px]">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
                            effLoyal
                              ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                              : c.isLoyalty && w
                                ? "bg-orange-50 text-orange-700 border-orange-100"
                                : "bg-slate-50 text-slate-600 border-slate-200",
                          )}
                          title={
                            c.isLoyalty && w
                              ? "Loyalty badge exists but wholesale % overrides it. Loyalty will not apply."
                              : effLoyal
                                ? "Loyalty will apply (no customer wholesale % set)."
                                : "Not loyalty."
                          }
                        >
                          {effLoyal
                            ? "Yes"
                            : c.isLoyalty && w
                              ? "Overridden"
                              : "No"}
                        </span>
                      </td>

                      <td className="px-[12px] py-[14px] text-slate-700">
                        {c.lastPurchaseLabel}
                      </td>

                      <td className="px-[12px] py-[14px]">
                        <div className="flex items-center justify-end gap-[8px]">
                          <button
                            type="button"
                            onClick={() => openEditCustomer(c)}
                            className="h-[36px] w-[36px] rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
                            aria-label="Edit customer discount"
                          >
                            <Icon
                              name="edit"
                              className="text-slate-700"
                            />
                          </button>

                          <button
                            type="button"
                            onClick={() => clearCustomerDiscount(c.id)}
                            disabled={!w}
                            className={cn(
                              "h-[36px] w-[36px] rounded-[10px] border bg-white inline-flex items-center justify-center",
                              w
                                ? "border-rose-200 hover:bg-rose-50"
                                : "border-slate-200 opacity-40 pointer-events-none",
                            )}
                            aria-label="Clear customer wholesale discount"
                            title={
                              w ? "Clear wholesale %" : "No wholesale % set"
                            }
                          >
                            <Icon
                              name="delete"
                              className="text-rose-600"
                            />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-[12px] py-[22px] text-[14px] text-slate-600"
                    >
                      No customers match your filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* Activity panel */}
      <Card>
        <div className="p-[16px] space-y-[10px]">
          <div className="flex items-center justify-between gap-[10px] flex-wrap">
            <div>
              <div className="text-[15px] font-semibold text-slate-900">
                Discount activity
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                These entries will later come from audit logs.
              </div>
            </div>

            <Button
              icon="add_alert"
              onClick={() =>
                setAudit((prev) => [
                  {
                    id: `aud_${Date.now()}`,
                    title: "Sample entry",
                    desc: "This is a placeholder until backend audit logs are connected.",
                    timeLabel: "Just now",
                  },
                  ...prev,
                ])
              }
            >
              Add sample
            </Button>
          </div>

          <div className="space-y-[8px]">
            {audit.slice(0, 8).map((a) => (
              <div
                key={a.id}
                className="rounded-[14px] border border-slate-200 p-[12px] hover:bg-slate-50/60 transition"
              >
                <div className="flex items-start justify-between gap-[10px]">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-slate-900">
                      {a.title}
                    </div>
                    {a.desc ? (
                      <div className="text-[12px] text-slate-600 mt-[2px]">
                        {a.desc}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-slate-500 shrink-0">
                    {a.timeLabel}
                  </div>
                </div>
              </div>
            ))}

            {audit.length === 0 ? (
              <div className="text-[14px] text-slate-600">No activity yet.</div>
            ) : null}
          </div>
        </div>
      </Card>

      {/* Add/Edit modal */}
      <ModalShell
        open={openEdit}
        title={editingId ? "Edit Customer Discount" : "Add Customer"}
        onClose={closeEdit}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={closeEdit}>Cancel</Button>
            <Button variant="primary" icon="save" onClick={saveCustomer}>
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-[12px]">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-[12px]">
            <div className="space-y-[6px]">
              <div className="text-[12px] font-semibold text-slate-600">
                Customer name
              </div>
              <Input
                value={fName}
                onChange={setFName}
                placeholder="e.g. Ram Bahadur"
              />
            </div>

            <div className="space-y-[6px]">
              <div className="text-[12px] font-semibold text-slate-600">
                Phone
              </div>
              <Input
                value={fPhone}
                onChange={setFPhone}
                placeholder="+977 98XXXXXXXX"
              />
            </div>

            <div className="space-y-[6px] lg:col-span-2">
              <div className="text-[12px] font-semibold text-slate-600">
                Email (optional)
              </div>
              <Input
                value={fEmail}
                onChange={setFEmail}
                placeholder="name@email.com"
              />
            </div>
          </div>

          <div className="rounded-[14px] border border-slate-200 p-[12px]">
            <div className="text-[14px] font-semibold text-slate-900">
              Customer wholesale discount %
            </div>
            <div className="text-[12px] text-slate-600 mt-[2px]">
              If set, this percent is applied on the subtotal (retail-based)
              during billing.
            </div>

            <div className="mt-[10px] max-w-[260px]">
              <NumberInput
                value={fWholesaleDiscount}
                onChange={onWholesaleChange}
                min={0}
                max={100}
                placeholder="e.g. 5"
              />
            </div>

            <div className="mt-[10px] text-[12px] text-slate-600">
              If this is set, loyalty discount will not be used for this
              customer (loyalty will be turned off).
            </div>
          </div>

          <div className="rounded-[14px] border border-slate-200 p-[12px]">
            <div className="flex items-start justify-between gap-[12px]">
              <div>
                <div className="text-[14px] font-semibold text-slate-900">
                  Loyalty eligible
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Loyalty discount ({loyaltyDiscountPercent}%) applies on
                  subtotal only when customer has no wholesale % set.
                </div>
              </div>

              <label
                className={cn(
                  "inline-flex items-center gap-[8px] text-[13px] font-semibold select-none",
                  formHasWholesale ? "text-slate-400" : "text-slate-700",
                )}
                title={
                  formHasWholesale ? "Disabled because Wholesale % is set" : ""
                }
              >
                <input
                  type="checkbox"
                  checked={fIsLoyalty}
                  disabled={formHasWholesale}
                  onChange={(e) => onToggleLoyalty(e.target.checked)}
                  className="h-[16px] w-[16px]"
                />
                Enable
              </label>
            </div>

            <div className="mt-[10px] rounded-[12px] border border-slate-200 bg-slate-50/40 p-[10px]">
              <div className="text-[12px] text-slate-700">
                Current rule preview:
              </div>
              <div className="mt-[4px] text-[12px] text-slate-700">
                • If customer wholesale % is set → apply that % on subtotal
                (retail-based).
              </div>
              <div className="text-[12px] text-slate-700">
                • Else if loyalty enabled → apply {loyaltyDiscountPercent}% on
                subtotal.
              </div>
              <div className="text-[12px] text-slate-700">
                • Else → no subtotal discount.
              </div>
              <div className="mt-[6px] text-[12px] text-slate-500">
                Wholesale item pricing still depends on qty threshold (
                {wholesaleQtyThreshold}) for normal customers.
              </div>
            </div>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}
