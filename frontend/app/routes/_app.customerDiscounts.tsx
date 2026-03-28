import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { listCustomersApi, listInvoicesApi } from "~/lib/api/endpoints";
import { formatDateLabel, formatNpr } from "~/lib/invoices";

type DiscountType = "Wholesale %" | "Loyalty %";

type CustomerDiscount = {
  id: string;
  customerName: string;
  phone: string;
  type: DiscountType;
  valuePercent: number;
  note?: string;
  lastPurchaseLabel: string;
  active: boolean;
  updatedAtLabel: string;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatPct(n: number) {
  return `${Math.round(n)}%`;
}

function buildLastPurchaseLookup(invoices: any[]) {
  const lookup = new Map<string, string>();

  for (const invoice of invoices) {
    const customerId = invoice?.customer?.id || invoice?.customerId;
    if (!customerId || lookup.has(customerId)) continue;

    const amount = Number(invoice?.netTotal || invoice?.total || 0);
    const createdAt = String(invoice?.createdAt || "");

    lookup.set(
      customerId,
      createdAt
        ? `${formatNpr(amount)} on ${formatDateLabel(createdAt)}`
        : formatNpr(amount),
    );
  }

  return lookup;
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: string;
  tone?: "neutral" | "orange" | "dark";
}) {
  const styles = {
    neutral:
      "border-[var(--app-border)] bg-white text-[var(--app-text)] icon-bg-[var(--app-surface-muted)] icon-text-[var(--app-text-soft)]",
    orange:
      "border-[var(--app-warning-border)] bg-[var(--app-warning-bg)] text-[var(--app-warning-text)] icon-bg-[var(--app-warning-border)] icon-text-[var(--app-warning-text)]",
    dark: "border-slate-800 bg-slate-900 text-white icon-bg-white/10 icon-text-white",
  };
  const palette = styles[tone].split(" ");

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[20px] border p-5 shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]",
        palette[2],
        palette[1],
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider opacity-60">
            {label}
          </div>
          <div className={cn("text-3xl font-extrabold", palette[2])}>
            {value}
          </div>
        </div>
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-[14px]",
            palette[3],
          )}
        >
          <Icon name={icon} className={cn("text-[20px]", palette[2])} />
        </div>
      </div>
      <div className="mt-3 text-[12px] font-medium opacity-90">{sub}</div>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative group w-full md:w-[320px]">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-text-muted)] transition-colors group-focus-within:text-[var(--app-text)]">
        <Icon name="search" />
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search customers..."
        className="h-[44px] w-full rounded-[12px] border border-[var(--app-border)] bg-white pl-10 pr-4 text-[13px] font-semibold text-[var(--app-text)] outline-none transition-all placeholder:text-[var(--app-text-muted)] focus:border-[#11120d]"
      />
    </div>
  );
}

function TabButton({
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
        "flex h-[36px] items-center gap-2 rounded-full border px-4 text-[12px] font-bold transition-all",
        active
          ? "border-[#11120d] bg-[#11120d] text-white"
          : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-[6px] px-1.5 py-0.5 text-[10px]",
            active
              ? "bg-white/20 text-white"
              : "bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]",
          )}
        >
          {count}
        </span>
      )}
    </button>
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

export default function CustomerDiscountsPage() {
  const [rows, setRows] = useState<CustomerDiscount[]>([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "wholesale" | "loyalty">("all");

  useEffect(() => {
    async function load() {
      try {
        const [customerData, invoiceData] = await Promise.all([
          listCustomersApi(),
          listInvoicesApi({ status: "FINALIZED", pageSize: 500 }),
        ]);

        const customers = Array.isArray(customerData)
          ? customerData
          : customerData?.customers || [];
        const invoices = Array.isArray(invoiceData?.invoices)
          ? invoiceData.invoices
          : [];
        const lastPurchaseLookup = buildLastPurchaseLookup(invoices);

        const mapped: CustomerDiscount[] = [];

        for (const customer of customers) {
          if (customer.loyaltyPercent > 0) {
            mapped.push({
              id: `${customer.id}-loyalty`,
              customerName: customer.name,
              phone: customer.phone || "No phone on file",
              type: "Loyalty %",
              valuePercent: customer.loyaltyPercent,
              note: "Customer loyalty rate",
              lastPurchaseLabel:
                lastPurchaseLookup.get(customer.id) || "No purchases yet",
              active: customer.isActive,
              updatedAtLabel: new Date(
                customer.updatedAt || customer.createdAt || Date.now(),
              ).toLocaleDateString(),
            });
          }

          if (customer.wholesalePercent > 0) {
            mapped.push({
              id: `${customer.id}-wholesale`,
              customerName: customer.name,
              phone: customer.phone || "No phone on file",
              type: "Wholesale %",
              valuePercent: customer.wholesalePercent,
              note: "Customer wholesale rate",
              lastPurchaseLabel:
                lastPurchaseLookup.get(customer.id) || "No purchases yet",
              active: customer.isActive,
              updatedAtLabel: new Date(
                customer.updatedAt || customer.createdAt || Date.now(),
              ).toLocaleDateString(),
            });
          }
        }

        setRows(mapped);
      } catch (err) {
        console.error("Failed to load discount data", err);
      }
    }

    load();
  }, []);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQuery = !s
        ? true
        : `${r.customerName} ${r.phone} ${r.type} ${r.note || ""}`
            .toLowerCase()
            .includes(s);

      const matchesTab =
        tab === "all"
          ? true
          : tab === "wholesale"
            ? r.type === "Wholesale %"
            : r.type === "Loyalty %";

      return matchesQuery && matchesTab;
    });
  }, [rows, query, tab]);

  const countWholesale = rows.filter((r) => r.type === "Wholesale %").length;
  const countLoyalty = rows.filter((r) => r.type === "Loyalty %").length;

  return (
    <div className="min-h-full rounded-[28px] bg-[var(--app-page-bg)] p-6 text-[var(--app-text)]">
      <div className="mx-auto max-w-6xl space-y-9">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-[24px] font-extrabold tracking-tight text-[var(--app-text)]">
              Admin set Customer Discounts
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[var(--app-text-muted)]">
              View customer-specific discount rules applicable at billing.
            </p>
          </div>

          <div className="flex items-center gap-4 rounded-full border border-[var(--app-border)] bg-white px-4 py-2 text-[11px] font-bold text-[var(--app-text-muted)] shadow-sm">
            <div className="flex items-center gap-1.5">
              <Icon
                name="info"
                className="text-[14px] text-[var(--app-warning-text)]"
              />
              <span>Wholesale overrides Loyalty</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard
            label="Total Customers"
            value={rows.length}
            sub="Registered in discount system"
            icon="groups"
            tone="dark"
          />
          <StatCard
            label="Wholesale Accounts"
            value={
              rows.filter((x) => x.type === "Wholesale %" && x.active).length
            }
            sub="Custom admin-set rates"
            icon="storefront"
            tone="orange"
          />
          <StatCard
            label="Loyalty Members"
            value={
              rows.filter((x) => x.type === "Loyalty %" && x.active).length
            }
            sub="Using standard loyalty %"
            icon="loyalty"
            tone="neutral"
          />
        </div>

        <div className="overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]">
          <div className="flex flex-col items-center justify-between gap-4 border-b border-[var(--app-border)] bg-white p-5 md:flex-row">
            <div className="hide-scrollbar flex w-full items-center gap-2 overflow-x-auto pb-2 md:w-auto md:pb-0">
              <TabButton
                label="All Discounts"
                active={tab === "all"}
                onClick={() => setTab("all")}
                count={rows.length}
              />
              <TabButton
                label="Wholesale"
                active={tab === "wholesale"}
                onClick={() => setTab("wholesale")}
                count={countWholesale}
              />
              <TabButton
                label="Loyalty"
                active={tab === "loyalty"}
                onClick={() => setTab("loyalty")}
                count={countLoyalty}
              />
            </div>
            <SearchInput value={query} onChange={setQuery} />
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
                    Note
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--app-border)]/60">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-[var(--app-text-muted)]">
                        <Icon
                          name="search_off"
                          className="mb-2 text-[32px] opacity-50"
                        />
                        <span className="text-[13px] font-semibold">
                          No discounts found matching your search.
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => (
                    <tr
                      key={row.id}
                      className="group transition-colors hover:bg-[var(--app-surface-muted)]/70"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-surface-muted)] text-[12px] font-extrabold text-[var(--app-text-soft)]">
                            {row.customerName.charAt(0)}
                          </div>
                          <div>
                            <div className="text-[13px] font-bold text-[var(--app-text)] transition-colors group-hover:text-[var(--app-text-soft)]">
                              {row.customerName}
                            </div>
                            <div className="text-[11px] font-semibold text-[var(--app-text-muted)]">
                              {row.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "rounded-[8px] border px-2.5 py-1 text-[11px] font-bold",
                            row.type === "Wholesale %"
                              ? "border-[var(--app-warning-border)] bg-[var(--app-warning-bg)] text-[var(--app-warning-text)]"
                              : "border-[var(--app-success-border)] bg-[var(--app-success-bg)] text-[var(--app-success-text)]",
                          )}
                        >
                          {row.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-extrabold text-[var(--app-text)]">
                            {formatPct(row.valuePercent)}
                          </span>
                          <span className="text-[10px] font-semibold text-[var(--app-text-muted)]">
                            on subtotal
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="max-w-[220px] text-[12px] font-semibold leading-6 text-[var(--app-text-soft)]">
                          {row.lastPurchaseLabel}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge active={row.active} />
                        <div className="mt-1 pl-1 text-[10px] font-medium text-[var(--app-text-muted)]">
                          {row.updatedAtLabel}
                        </div>
                      </td>
                      <td className="max-w-[300px] px-6 py-4">
                        <div className="text-[12px] font-medium leading-snug text-[var(--app-text-soft)]">
                          {row.note || (
                            <span className="italic text-[var(--app-text-muted)]/60">
                              No notes added
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-[var(--app-border)] bg-[var(--app-surface-muted)]/40 px-6 py-4">
            <div className="text-[11px] font-bold text-[var(--app-text-muted)]">
              Showing {filtered.length} records
            </div>
            <div className="flex gap-1">
              <button className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-white text-[var(--app-text-muted)] transition hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]">
                <Icon name="chevron_left" className="text-[16px]" />
              </button>
              <button className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-white text-[var(--app-text-muted)] transition hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]">
                <Icon name="chevron_right" className="text-[16px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
