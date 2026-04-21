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

// tailwind standard joiner
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// makes decimal numbers look nice as percentages (e.g. 15.5 -> 16%)
function formatPct(n: number) {
  return `${Math.round(n)}%`;
}

// keeping the page number inside valid limits prevents filter changes from landing on empty pages
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// this generates a quick lookup table combining invoices by customer
// so we don't have to scan the entire invoice array thousands of times for every customer row
function buildLastPurchaseLookup(invoices: any[]) {
  const lookup = new Map<string, string>();

  // walking through the invoices once and storing the first hit for each customer
  // this works because the API list is already ordered newest first for this page's use case
  for (const invoice of invoices) {
    const customerId = invoice?.customer?.id || invoice?.customerId;
    if (!customerId || lookup.has(customerId)) continue;

    const amount = Number(invoice?.netTotal || invoice?.total || 0); // using net total first because that is the amount the customer actually paid
    const createdAt = String(invoice?.createdAt || ""); // date label is optional, so we store an empty string if the field is missing

    lookup.set(
      customerId,
      createdAt
        ? `${formatNpr(amount)} on ${formatDateLabel(createdAt)}`
        : formatNpr(amount),
    );
  }

  return lookup;
}

// this small metric card keeps the summary numbers at the top of the page visually consistent
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
      "border-[#CFCFD3] bg-white text-[#000000] icon-bg-[#F3F4F6] icon-text-[#565449]",
    orange:
      "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F] icon-bg-[#F6D28B] icon-text-[#B7791F]",
    dark: "border-slate-800 bg-slate-900 text-white icon-bg-white/10 icon-text-white",
  };
  const palette = styles[tone].split(" ");

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[20px] border p-5 ",
        palette[2],
        palette[1],
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase  opacity-60">
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

// this renders the shared search input for filtering discount rows by customer details
function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative group w-full md:w-[320px]">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8C8889] transition-colors group-focus-within:text-[#000000]">
        <Icon name="search" />
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search customers..."
        className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white pl-10 pr-4 text-[13px] font-semibold text-[#000000] outline-none transition-all placeholder:text-[#8C8889] focus:border-[#11120d]"
      />
    </div>
  );
}

// this controls the active discount tab and shows the count inside a small badge when needed
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
          : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-[6px] px-1.5 py-0.5 text-[10px]",
            active
              ? "bg-white/20 text-white"
              : "bg-[#F3F4F6] text-[#8C8889]",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// this shows whether the related customer account is still active in the system
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

// the admin view of all special customer discount rates mapped in the system
// helps cashiers and admins quickly lookup if someone is a loyalty or wholesale buyer
export default function CustomerDiscountsPage() {
  const [rows, setRows] = useState<CustomerDiscount[]>([]); // stores the flattened loyalty and wholesale rows shown in the table
  const [query, setQuery] = useState(""); // keeps the current customer search text
  const [tab, setTab] = useState<"all" | "wholesale" | "loyalty">("all"); // tracks whether the user is viewing all, wholesale-only, or loyalty-only rows
  const [page, setPage] = useState(1); // current page for the customer discount table

  // fetching customer data and all recent invoices to calculate the "Last Purchase" values
  useEffect(() => {
    async function load() {
      try {
        // loading both customers and finalized invoices together because the table needs data from both sources
        const [customerData, invoiceData] = await Promise.all([
          listCustomersApi(),
          listInvoicesApi({ status: "FINALIZED", pageSize: 500 }),
        ]);

        const customers = Array.isArray(customerData)
          ? customerData
          : customerData?.customers || []; // supporting both direct arrays and wrapped API responses
        const invoices = Array.isArray(invoiceData?.invoices)
          ? invoiceData.invoices
          : []; // falling back to an empty list keeps the rest of the mapping code safe
        const lastPurchaseLookup = buildLastPurchaseLookup(invoices); // this lets each customer row read its last purchase in O(1) time

        const mapped: CustomerDiscount[] = [];

        // some customers can appear twice in this final table:
        // 1. once for loyalty, if they have a loyalty rate
        // 2. once for wholesale, if they have a wholesale rate
        // we keep them separate because the page is showing discount rules, not unique customer records
        for (const customer of customers) {
          // adding a loyalty rule row only when the customer actually has a loyalty percent above 0
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

          // adding a wholesale rule row separately because wholesale and loyalty are shown as different rule types in the table
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

        // replacing the full table data after both API calls and the flattening step finish
        setRows(mapped);
      } catch (err) {
        console.error("Failed to load discount data", err);
      }
    }

    load();
  }, []);

  // filtering the table based on active tabs and search text
  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    return rows.filter((r) => {
      // matching against a combined string lets one search box cover name, phone, type, and notes together
      const matchesQuery = !s
        ? true
        : `${r.customerName} ${r.phone} ${r.type} ${r.note || ""}`
            .toLowerCase()
            .includes(s);

      // this handles which tab is active so we only keep the discount type the user asked for
      const matchesTab =
        tab === "all"
          ? true
          : tab === "wholesale"
            ? r.type === "Wholesale %"
            : r.type === "Loyalty %";

      return matchesQuery && matchesTab;
    });
  }, [rows, query, tab]);

  const pageSize = 10; // keeping the page size aligned with the other admin tables makes scanning easier
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = clampPage(page, 1, totalPages);
  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped]);

  const countWholesale = rows.filter((r) => r.type === "Wholesale %").length; // count badge for the wholesale tab
  const countLoyalty = rows.filter((r) => r.type === "Loyalty %").length; // count badge for the loyalty tab

  // resetting back to page 1 after changing search or tabs keeps the table from showing empty trailing pages
  useEffect(() => {
    setPage(1);
  }, [query, tab]);

  useEffect(() => {
    setPage((current) => clampPage(current, 1, totalPages));
  }, [totalPages]);

  return (
    <div className="min-h-full rounded-[28px] bg-[#F1F1F1] p-6 text-[#000000]">
      <div className="mx-auto max-w-6xl space-y-9">
        {/* this header keeps the title on one side and the rule reminder pill on the other when there is enough space */}
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-[24px] font-extrabold  text-[#000000]">
              Admin set Customer Discounts
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[#8C8889]">
              View customer-specific discount rules applicable at billing.
            </p>
          </div>

          <div className="flex items-center gap-4 rounded-full border border-[#CFCFD3] bg-white px-4 py-2 text-[11px] font-bold text-[#8C8889] ">
            <div className="flex items-center gap-1.5">
              <Icon
                name="info"
                className="text-[14px] text-[#B7791F]"
              />
              <span>Wholesale overrides Loyalty</span>
            </div>
          </div>
        </div>

        {/* the stats row gives a quick summary before the user gets into the full discount table */}
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

        {/* this large card combines tabs, search, and the table so the whole lookup flow feels connected */}
        <div className="overflow-hidden rounded-[24px] border border-[#CFCFD3] bg-white ">
          <div className="flex flex-col items-center justify-between gap-4 border-b border-[#CFCFD3] bg-white p-5 md:flex-row">
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
                <tr className="border-b border-[#CFCFD3] bg-[#F3F4F6]/70">
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Customer Details
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Discount Type
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Rate
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Last Purchase
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Status
                  </th>
                  <th className="px-6 py-4 text-[11px] font-extrabold uppercase  text-[#8C8889]">
                    Note
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#CFCFD3]/60">
                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="flex flex-col items-center justify-center text-[#8C8889]">
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
                  pageItems.map((row) => (
                    <tr
                      key={row.id}
                      className="group transition-colors hover:bg-[#F3F4F6]/70"
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#CFCFD3] bg-[#F3F4F6] text-[12px] font-extrabold text-[#565449]">
                            {row.customerName.charAt(0)}
                          </div>
                          <div>
                            <div className="text-[13px] font-bold text-[#000000] transition-colors group-hover:text-[#565449]">
                              {row.customerName}
                            </div>
                            <div className="text-[11px] font-semibold text-[#8C8889]">
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
                              ? "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]"
                              : "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]",
                          )}
                        >
                          {row.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-extrabold text-[#000000]">
                            {formatPct(row.valuePercent)}
                          </span>
                          <span className="text-[10px] font-semibold text-[#8C8889]">
                            on subtotal
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="max-w-[220px] text-[12px] font-semibold leading-6 text-[#565449]">
                          {row.lastPurchaseLabel}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge active={row.active} />
                        <div className="mt-1 pl-1 text-[10px] font-medium text-[#8C8889]">
                          {row.updatedAtLabel}
                        </div>
                      </td>
                      <td className="max-w-[300px] px-6 py-4">
                        <div className="text-[12px] font-medium leading-snug text-[#565449]">
                          {row.note || (
                            <span className="italic text-[#8C8889]/60">
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

          <div className="flex items-center justify-between border-t border-[#CFCFD3] bg-[#F3F4F6]/40 px-6 py-4">
            <div className="text-[11px] font-bold text-[#8C8889]">
              Showing {pageItems.length} of {filtered.length} records
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() =>
                  setPage((current) => clampPage(current - 1, 1, totalPages))
                }
                disabled={pageClamped <= 1}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-[#CFCFD3] bg-white text-[#8C8889] transition hover:border-[#8C8889] hover:text-[#000000] disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon name="chevron_left" className="text-[16px]" />
              </button>
              {Array.from({ length: totalPages })
                .slice(0, 8)
                .map((_, index) => {
                  const pageNumber = index + 1;
                  const active = pageNumber === pageClamped;

                  return (
                    <button
                      key={pageNumber}
                      type="button"
                      onClick={() => setPage(pageNumber)}
                      className={cn(
                        "flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-[11px] font-extrabold transition",
                        active
                          ? "border-[#11120d] bg-[#11120d] text-white"
                          : "border-[#CFCFD3] bg-white text-[#8C8889] hover:border-[#8C8889] hover:text-[#000000]",
                      )}
                    >
                      {pageNumber}
                    </button>
                  );
                })}
              <button
                type="button"
                onClick={() =>
                  setPage((current) => clampPage(current + 1, 1, totalPages))
                }
                disabled={pageClamped >= totalPages}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-[#CFCFD3] bg-white text-[#8C8889] transition hover:border-[#8C8889] hover:text-[#000000] disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon name="chevron_right" className="text-[16px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

