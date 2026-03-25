import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { listCustomersApi } from "~/lib/api/endpoints";

// --- Types ---
type DiscountType = "Wholesale %" | "Loyalty %";

type CustomerDiscount = {
  id: string;
  customerName: string;
  phone: string;
  type: DiscountType;
  valuePercent: number;
  note?: string;
  active: boolean;
  updatedAtLabel: string;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatPct(n: number) {
  return `${Math.round(n)}%`;
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
  tone?: "neutral" | "orange" | "blue";
}) {
  const colors = {
    neutral: "bg-white text-slate-900 icon-slate-100 icon-text-slate-500",
    orange:
      "bg-orange-50/50 text-orange-900 icon-orange-100 icon-text-orange-600",
    blue: "bg-blue-50/50 text-blue-900 icon-blue-100 icon-text-blue-600",
  };
  const c = colors[tone];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[20px] p-5 border border-slate-100 shadow-sm transition-all hover:shadow-md",
        c.split(" ")[0], // bg color
      )}
    >
      <div className="flex justify-between items-start">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider opacity-60 mb-1">
            {label}
          </div>
          <div className={cn("text-3xl font-extrabold", c.split(" ")[1])}>
            {value}
          </div>
        </div>
        <div
          className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center",
            c.split(" ")[2], // icon bg
          )}
        >
          <Icon name={icon} className={cn("text-[20px]", c.split(" ")[3])} />
        </div>
      </div>
      <div className="mt-3 text-[12px] font-medium opacity-70">{sub}</div>
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
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-orange-500 transition-colors">
        <Icon name="search" />
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search customers..."
        className="w-full h-[44px] pl-10 pr-4 rounded-[12px] bg-slate-50 border border-slate-200 text-[13px] font-semibold text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 outline-none transition-all"
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
      onClick={onClick}
      className={cn(
        "h-[36px] px-4 rounded-full text-[12px] font-bold border transition-all flex items-center gap-2",
        active
          ? "bg-slate-900 text-white border-slate-900 shadow-lg shadow-slate-900/20"
          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "px-1.5 py-0.5 rounded-[6px] text-[10px]",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
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
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 text-[11px] font-extrabold">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-50 text-slate-500 border border-slate-200 text-[11px] font-bold">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Inactive
    </span>
  );
}

// --- Main Page ---

export default function CustomerDiscountsPage() {
  const [rows, setRows] = useState<CustomerDiscount[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const data = await listCustomersApi();
        const items = Array.isArray(data) ? data : data.customers || [];
        const mapped: CustomerDiscount[] = [];
        for (const c of items) {
          if (c.loyaltyPercent > 0) {
            mapped.push({
              id: c.id + "-loyalty",
              customerName: c.name,
              phone: c.phone || "—",
              type: "Loyalty %",
              valuePercent: c.loyaltyPercent,
              note: "Customer loyalty rate",
              active: c.isActive,
              updatedAtLabel: new Date(c.updatedAt || c.createdAt || Date.now()).toLocaleDateString(),
            });
          }
          if (c.wholesalePercent > 0) {
            mapped.push({
              id: c.id + "-wholesale",
              customerName: c.name,
              phone: c.phone || "—",
              type: "Wholesale %",
              valuePercent: c.wholesalePercent,
              note: "Customer wholesale rate",
              active: c.isActive,
              updatedAtLabel: new Date(c.updatedAt || c.createdAt || Date.now()).toLocaleDateString(),
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

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "wholesale" | "loyalty">("all");

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQuery = !s
        ? true
        : (r.customerName + " " + r.phone + " " + r.type + " " + (r.note || ""))
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

  // Counts for tabs
  const countWholesale = rows.filter((r) => r.type === "Wholesale %").length;
  const countLoyalty = rows.filter((r) => r.type === "Loyalty %").length;

  return (
    <div className="min-h-screen bg-slate-50/50 p-6 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-extrabold text-slate-900 tracking-tight">
              Discount Management
            </h1>
            <p className="text-slate-500 text-[13px] font-medium mt-1">
              View and audit customer-specific discount rules applicable at
              billing.
            </p>
          </div>

          <div className="flex items-center gap-4 text-[11px] font-bold text-slate-500 bg-white px-4 py-2 rounded-full border border-slate-200 shadow-sm">
            <div className="flex items-center gap-1.5">
              <Icon name="info" className="text-orange-500 text-[14px]" />
              <span>Wholesale overrides Loyalty</span>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Total Customers"
            value={rows.length}
            sub="Registered in discount system"
            icon="groups"
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
            tone="blue"
          />
        </div>

        {/* Main Content Area */}
        <div className="bg-white rounded-[24px] shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
          {/* Toolbar */}
          <div className="p-5 border-b border-slate-100 bg-white flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 overflow-x-auto w-full md:w-auto pb-2 md:pb-0 hide-scrollbar">
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

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-6 py-4 text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                    Customer Details
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                    Discount Type
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                    Rate
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                    Note
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400">
                        <Icon
                          name="search_off"
                          className="text-[32px] mb-2 opacity-50"
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
                      className="group hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 font-extrabold text-[12px]">
                            {row.customerName.charAt(0)}
                          </div>
                          <div>
                            <div className="text-[13px] font-bold text-slate-900 group-hover:text-orange-600 transition-colors">
                              {row.customerName}
                            </div>
                            <div className="text-[11px] font-semibold text-slate-500">
                              {row.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "px-2.5 py-1 rounded-[8px] text-[11px] font-bold border",
                            row.type === "Wholesale %"
                              ? "bg-orange-50 text-orange-700 border-orange-100"
                              : "bg-blue-50 text-blue-700 border-blue-100",
                          )}
                        >
                          {row.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-extrabold text-slate-900">
                            {formatPct(row.valuePercent)}
                          </span>
                          <span className="text-[10px] font-semibold text-slate-400">
                            on subtotal
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge active={row.active} />
                        <div className="text-[10px] font-medium text-slate-400 mt-1 pl-1">
                          {row.updatedAtLabel}
                        </div>
                      </td>
                      <td className="px-6 py-4 max-w-[300px]">
                        <div className="text-[12px] font-medium text-slate-600 leading-snug">
                          {row.note || (
                            <span className="text-slate-300 italic">
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

          {/* Footer / Pagination Area */}
          <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/30 flex items-center justify-between">
            <div className="text-[11px] font-bold text-slate-400">
              Showing {filtered.length} records
            </div>
            {/* Pagination  */}
            <div className="flex gap-1">
              <button className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:border-slate-300 transition">
                <Icon name="chevron_left" className="text-[16px]" />
              </button>
              <button className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:border-slate-300 transition">
                <Icon name="chevron_right" className="text-[16px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
