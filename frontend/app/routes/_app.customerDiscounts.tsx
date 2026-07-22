import { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { ConfirmDialog } from "~/components/ui/Modal";
import PaginationBar from "~/components/ui/PaginationBar";
import { MobileFilterTabs } from "~/components/ui/MobileFilters";
import { useToast } from "~/components/ui/Toast";
import {
  createCashierDiscountedCustomerApi,
  createCustomerDiscountRequestApi,
  deleteCustomerDiscountApi,
  getCustomerDiscountDeleteSafetyApi,
  getMyCashierPrivilegesApi,
  listCustomerDiscountRequestsApi,
  listCustomersApi,
  type CashierPrivilege,
  type CustomerDiscountDeleteSafety,
  type CustomerDiscountRequest,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import { formatDateLabel, formatNpr } from "~/lib/invoices";

type DiscountType = "Wholesale %" | "Loyalty %";

type CustomerDiscount = {
  id: string;
  customerId: string;
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

function discountKindFromRow(row: CustomerDiscount): "LOYALTY" | "WHOLESALE" {
  return row.type === "Loyalty %" ? "LOYALTY" : "WHOLESALE";
}

// keeping the page number inside valid limits prevents filter changes from landing on empty pages
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// this generates a quick lookup table combining invoices by customer
// so we don't have to scan the entire invoice array thousands of times for every customer row
function lastPurchaseLabelFromCustomer(customer: any) {
  const summary = customer?.purchaseSummary;
  if (!summary?.latestCompletedAt) return "No purchases yet";
  return `${formatNpr(Number(summary.latestCompletedNetTotal || 0))} on ${formatDateLabel(
    String(summary.latestCompletedAt),
  )}`;
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
        aria-label="Search customers"
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
  const { showToast } = useToast();
  const authUser = getAuthUser();
  const [rows, setRows] = useState<CustomerDiscount[]>([]); // stores the flattened loyalty and wholesale rows shown in the table
  const [dataLoading, setDataLoading] = useState(true);
  const [dataLoadIssue, setDataLoadIssue] = useState("");
  const [privilege, setPrivilege] = useState<CashierPrivilege | null>(null);
  const [creating, setCreating] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomerDiscount | null>(null);
  const [deleteSafety, setDeleteSafety] =
    useState<CustomerDiscountDeleteSafety | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discountRequests, setDiscountRequests] = useState<CustomerDiscountRequest[]>([]);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [discountType, setDiscountType] = useState<"LOYALTY" | "WHOLESALE">("LOYALTY");
  const [discountPercent, setDiscountPercent] = useState(2);
  const [requestReason, setRequestReason] = useState("");
  const [query, setQuery] = useState(""); // keeps the current customer search text
  const [tab, setTab] = useState<"all" | "wholesale" | "loyalty">("all"); // tracks whether the user is viewing all, wholesale-only, or loyalty-only rows
  const [page, setPage] = useState(1); // current page for the customer discount table
  const [pageSize, setPageSize] = useState(20);
  const [showAddPanel, setShowAddPanel] = useState(false); // toggle state for the add customer form
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });

  async function loadDiscountData(options?: { signal?: AbortSignal }) {
    setDataLoading(true);
    setDataLoadIssue("");
    try {
      const [customerResult, privilegeResult, requestResult] = await Promise.allSettled([
        listCustomersApi(undefined, options),
        getMyCashierPrivilegesApi(options),
        listCustomerDiscountRequestsApi(undefined, options),
      ]);

      if (options?.signal?.aborted) return;

      if (privilegeResult.status === "fulfilled") {
        setPrivilege(privilegeResult.value.privilege);
      }
      if (requestResult.status === "fulfilled") {
        setDiscountRequests(
          Array.isArray(requestResult.value.requests)
            ? requestResult.value.requests
            : [],
        );
      }

      if (customerResult.status === "fulfilled") {
        const customerData = customerResult.value;
        const customers = Array.isArray(customerData)
          ? customerData
          : customerData?.customers || []; // supporting both direct arrays and wrapped API responses
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
              customerId: customer.id,
              customerName: customer.name,
              phone: customer.phone || "No phone on file",
              type: "Loyalty %",
              valuePercent: customer.loyaltyPercent,
              note: "Customer loyalty rate",
              lastPurchaseLabel: lastPurchaseLabelFromCustomer(customer),
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
              customerId: customer.id,
              customerName: customer.name,
              phone: customer.phone || "No phone on file",
              type: "Wholesale %",
              valuePercent: customer.wholesalePercent,
              note: "Customer wholesale rate",
              lastPurchaseLabel: lastPurchaseLabelFromCustomer(customer),
              active: customer.isActive,
              updatedAtLabel: new Date(
                customer.updatedAt || customer.createdAt || Date.now(),
              ).toLocaleDateString(),
            });
          }
        }

        // Only replace the customer table when that request succeeded. This
        // preserves the last valid rows while another request is cooling down.
        setRows(mapped);
      }

      const rejected = [customerResult, privilegeResult, requestResult].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected.length > 0) {
        const rateLimited = rejected.some((result) =>
          isRateLimitError(result.reason),
        );
        if (rateLimited) requestRateLimitRecovery();
        setDataLoadIssue(
          rateLimited
            ? "Discount data is temporarily paused and will refresh automatically."
            : "Some discount data could not be loaded. Please try again.",
        );
      }
    } finally {
      if (!options?.signal?.aborted) setDataLoading(false);
    }
  }

  // fetching customer data and all recent invoices to calculate the "Last Purchase" values
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadDiscountData({ signal: controller.signal }),
      100,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [rateLimitRecoveryKey]);

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

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageClamped = clampPage(page, 1, totalPages);
  const pageItems = useMemo(() => {
    const start = (pageClamped - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageClamped, pageSize]);
  const pageStart = filtered.length === 0 ? 0 : (pageClamped - 1) * pageSize;
  const pageEnd = filtered.length === 0 ? 0 : pageStart + pageItems.length;

  const countWholesale = rows.filter((r) => r.type === "Wholesale %").length; // count badge for the wholesale tab
  const countLoyalty = rows.filter((r) => r.type === "Loyalty %").length; // count badge for the loyalty tab

  // resetting back to page 1 after changing search or tabs keeps the table from showing empty trailing pages
  useEffect(() => {
    setPage(1);
  }, [query, tab]);

  useEffect(() => {
    setPage((current) => clampPage(current, 1, totalPages));
  }, [totalPages]);

  const canCreateDiscountedCustomer = privilege?.canCreateDiscountedCustomer === true;
  const canRequestDiscount = privilege?.canRequestCustomerDiscount !== false;
  const canDeleteDiscounts =
    authUser?.role === "admin" || authUser?.role === "manager";
  const activeMaxDiscount =
    discountType === "WHOLESALE"
      ? Number(privilege?.maxCustomerWholesalePercent ?? 0)
      : Number(privilege?.maxCustomerLoyaltyPercent ?? 0);

  function closeDeleteDialog() {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteSafety(null);
    setDeleteLoading(false);
  }

  async function openDeleteDialog(row: CustomerDiscount) {
    if (!canDeleteDiscounts) {
      showToast("danger", "Only admins and managers can delete customer discounts.");
      return;
    }

    setDeleteTarget(row);
    setDeleteSafety(null);
    setDeleteLoading(true);
    try {
      const safety = await getCustomerDiscountDeleteSafetyApi(
        row.customerId,
        discountKindFromRow(row),
      );
      setDeleteSafety(safety);
    } catch (err: any) {
      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Could not check whether this discount can be deleted.";
      showToast("danger", message);
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  }

  async function confirmDeleteDiscount() {
    if (!deleteTarget || deleteBusy) return;

    if (!deleteSafety?.canDelete) {
      closeDeleteDialog();
      return;
    }

    try {
      setDeleteBusy(true);
      const result = await deleteCustomerDiscountApi(
        deleteTarget.customerId,
        discountKindFromRow(deleteTarget),
      );
      showToast(result.changed ? "success" : "info", result.message);
      closeDeleteDialog();
      await loadDiscountData();
    } catch (err: any) {
      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Failed to delete customer discount.";
      const safety = err?.response?.data?.safety as
        | CustomerDiscountDeleteSafety
        | undefined;
      if (safety) {
        setDeleteSafety(safety);
      }
      showToast("danger", message);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function createDiscountedCustomer() {
    if (!canCreateDiscountedCustomer || creating) return;

    const name = newCustomerName.trim();
    const phone = newCustomerPhone.trim();
    const email = newCustomerEmail.trim();
    const percent = Number(discountPercent);

    if (!name || !phone) {
      showToast("danger", "Customer name and phone are required.");
      return;
    }
    if (!Number.isFinite(percent) || percent <= 0 || percent > activeMaxDiscount) {
      showToast("danger", `Discount must be between 1% and ${activeMaxDiscount}%.`);
      return;
    }

    try {
      setCreating(true);
      await createCashierDiscountedCustomerApi({
        name,
        phone,
        email: email || undefined,
        discountType,
        discountPercent: percent,
      });
      showToast("success", "Discounted customer created. Admin has been notified.");
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerEmail("");
      setDiscountPercent(discountType === "WHOLESALE" ? Math.min(5, activeMaxDiscount) : Math.min(2, activeMaxDiscount));
      await loadDiscountData();
    } catch (err: any) {
      showToast(
        "danger",
        err?.response?.data?.error ||
          err?.message ||
          "Failed to create discounted customer.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function requestDiscountedCustomer() {
    if (!canRequestDiscount || requesting) return;

    const name = newCustomerName.trim();
    const phone = newCustomerPhone.trim();
    const email = newCustomerEmail.trim();
    const reason = requestReason.trim();
    const percent = Number(discountPercent);

    if (!name || !phone) {
      showToast("danger", "Customer name and phone are required.");
      return;
    }
    if (!reason) {
      showToast("danger", "Add a short reason for admin approval.");
      return;
    }
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      showToast("danger", "Discount must be between 1% and 100%.");
      return;
    }

    try {
      setRequesting(true);
      await createCustomerDiscountRequestApi({
        name,
        phone,
        email: email || undefined,
        discountType,
        discountPercent: percent,
        reason,
      });
      showToast("success", "Discount request sent to admin.");
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerEmail("");
      setRequestReason("");
      setDiscountPercent(discountType === "WHOLESALE" ? 5 : 2);
      const requestData = await listCustomerDiscountRequestsApi();
      setDiscountRequests(Array.isArray(requestData.requests) ? requestData.requests : []);
    } catch (err: any) {
      showToast(
        "danger",
        err?.response?.data?.error ||
          err?.message ||
          "Failed to send discount request.",
      );
    } finally {
      setRequesting(false);
    }
  }

  return (
    <>
    <div className="space-y-[14px] text-[#000000]">
      <div className="space-y-[14px]">
        {/* this header keeps the title on one side and the rule reminder pill on the other when there is enough space */}
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h1 className="text-[24px] font-extrabold  text-[#000000]">
              Customer Discounts
            </h1>
            <p className="mt-1 text-[13px] font-medium text-[#8C8889]">
              Create, request, and review customer-specific discount rules.
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

        {/* the stats row stays above the form so cashiers see the current discount base first */}
        <div className="bg-white rounded-[18px] border border-[#CFCFD3] p-5 md:p-6 shadow-sm">
          {dataLoadIssue ? (
            <div className="mb-4 flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
              <Icon name="schedule" className="mt-0.5 shrink-0 text-[16px]" />
              <span>{dataLoadIssue}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-5 md:gap-6">
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-slate-900">
                {dataLoading && rows.length === 0 ? "..." : rows.length} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Total</span>
              </span>
              <div className="h-1 w-12 bg-slate-800 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-orange-600">
                {dataLoading && rows.length === 0 ? "..." : rows.filter((x) => x.type === "Wholesale %" && x.active).length} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Wholesale</span>
              </span>
              <div className="h-1 w-12 bg-orange-500 mt-2 rounded-full"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xl md:text-2xl font-extrabold text-emerald-600">
                {dataLoading && rows.length === 0 ? "..." : rows.filter((x) => x.type === "Loyalty %" && x.active).length} <span className="text-xs md:text-sm font-semibold text-slate-400 ml-1 uppercase tracking-wider">Loyalty</span>
              </span>
              <div className="h-1 w-12 bg-emerald-500 mt-2 rounded-full"></div>
            </div>
          </div>
        </div>

        <div className="rounded-[22px] border border-[#CFCFD3] bg-white">
          <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-[17px] font-extrabold text-[#000000]">
                Add discounted customer
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] font-semibold text-[#8C8889]">
                <span>Trusted cashiers can create directly. Other allowed cashiers can request approval.</span>
                {canCreateDiscountedCustomer ? (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-extrabold text-emerald-700">
                    Direct create enabled
                  </span>
                ) : canRequestDiscount ? (
                  <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-extrabold text-blue-700">
                    Request approval enabled
                  </span>
                ) : (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-extrabold text-amber-700">
                    Admin permission required
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAddPanel((value) => !value)}
              className={cn(
                "inline-flex h-[38px] shrink-0 items-center justify-center gap-2 rounded-[12px] px-4 text-[12px] font-extrabold transition",
                showAddPanel
                  ? "bg-[#11120d] text-white"
                  : "border border-[#11120d] bg-[#FFFFFF] text-[#11120d] hover:bg-[#F3F4F6]"
              )}
            >
              <Icon
                name={showAddPanel ? "expand_less" : "person_add"}
                className="text-[16px]"
              />
              {showAddPanel ? "Hide" : "Add customer"}
            </button>
          </div>

          {showAddPanel && (
            <div className="border-t border-[#E5E7EB] bg-[#F8FAFC] p-5 rounded-b-[22px]">
              {canCreateDiscountedCustomer ? (
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr_1.2fr_170px_130px_auto] lg:items-end">
              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Customer Name
                </div>
                <input
                  value={newCustomerName}
                  onChange={(event) => setNewCustomerName(event.target.value)}
                  placeholder="e.g. Ramesh Sharma"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Phone
                </div>
                <input
                  value={newCustomerPhone}
                  onChange={(event) => setNewCustomerPhone(event.target.value)}
                  placeholder="Required"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Email
                </div>
                <input
                  value={newCustomerEmail}
                  onChange={(event) => setNewCustomerEmail(event.target.value)}
                  placeholder="Optional"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Type
                </div>
                <ProjectSelect
                  value={discountType}
                  onChange={(event) => {
                    const nextType = event.target.value as "LOYALTY" | "WHOLESALE";
                    setDiscountType(nextType);
                    const nextMax =
                      nextType === "WHOLESALE"
                        ? Number(privilege?.maxCustomerWholesalePercent ?? 0)
                        : Number(privilege?.maxCustomerLoyaltyPercent ?? 0);
                    setDiscountPercent((current) =>
                      canCreateDiscountedCustomer ? Math.min(current, nextMax) : current,
                    );
                  }}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                >
                  <option value="LOYALTY">Loyalty</option>
                  <option value="WHOLESALE">Wholesale</option>
                </ProjectSelect>
              </label>

              <label className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                    Discount %
                  </div>
                  <div className="text-[10px] font-bold text-[#8C8889]">
                    Max {activeMaxDiscount}%
                  </div>
                </div>
                <input
                  type="number"
                  min={1}
                  max={activeMaxDiscount}
                  value={discountPercent}
                  onChange={(event) => setDiscountPercent(Number(event.target.value))}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <button
                type="button"
                onClick={createDiscountedCustomer}
                disabled={creating || activeMaxDiscount <= 0}
                className="inline-flex h-[44px] items-center justify-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-50"
              >
                <Icon name="person_add" className="text-[18px]" />
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          ) : canRequestDiscount ? (
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr_1fr_130px_auto] lg:items-end">
              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Customer Name
                </div>
                <input
                  value={newCustomerName}
                  onChange={(event) => setNewCustomerName(event.target.value)}
                  placeholder="e.g. Ramesh Sharma"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Phone
                </div>
                <input
                  value={newCustomerPhone}
                  onChange={(event) => setNewCustomerPhone(event.target.value)}
                  placeholder="Required"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Email
                </div>
                <input
                  value={newCustomerEmail}
                  onChange={(event) => setNewCustomerEmail(event.target.value)}
                  placeholder="Optional"
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Type
                </div>
                <ProjectSelect
                  value={discountType}
                  onChange={(event) => setDiscountType(event.target.value as "LOYALTY" | "WHOLESALE")}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                >
                  <option value="LOYALTY">Loyalty</option>
                  <option value="WHOLESALE">Wholesale</option>
                </ProjectSelect>
              </label>

              <label className="space-y-2">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Discount %
                </div>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={discountPercent}
                  onChange={(event) => setDiscountPercent(Number(event.target.value))}
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <label className="space-y-2 lg:col-span-4">
                <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                  Reason for admin
                </div>
                <input
                  value={requestReason}
                  onChange={(event) => setRequestReason(event.target.value)}
                  placeholder="e.g. Regular wholesale buyer, referred by owner..."
                  className="h-[44px] w-full rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#11120d]"
                />
              </label>

              <button
                type="button"
                onClick={requestDiscountedCustomer}
                disabled={requesting}
                className="inline-flex h-[44px] items-center justify-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:pointer-events-none disabled:opacity-50"
              >
                <Icon name="send" className="text-[18px]" />
                {requesting ? "Sending..." : "Request"}
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-[16px] border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] font-semibold text-slate-500">
              Ask admin to enable direct create or request permission under Settings {'>'} Cashier Controls.
            </div>
          )}
            </div>
          )}
        </div>

        {discountRequests.length > 0 ? (
          <div className="rounded-[22px] border border-[#CFCFD3] bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-extrabold text-[#000000]">
                  My recent requests
                </h2>
                <p className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                  Admin decisions appear here and in Alerts.
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-extrabold text-slate-600">
                {discountRequests.filter((request) => request.status === "PENDING").length} pending
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {discountRequests.slice(0, 6).map((request) => {
                const statusTone =
                  request.status === "APPROVED"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : request.status === "REJECTED"
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : "border-amber-200 bg-amber-50 text-amber-700";

                return (
                  <div
                    key={request.id}
                    className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-extrabold text-slate-900">
                          {request.customerName}
                        </div>
                        <div className="mt-1 text-[11px] font-semibold text-slate-500">
                          {request.phone}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-extrabold ${statusTone}`}>
                        {request.status}
                      </span>
                    </div>
                    <div className="mt-3 text-[12px] font-bold text-slate-700">
                      {request.discountPercent}% {request.discountType.toLowerCase()}
                    </div>
                    {request.adminNote ? (
                      <div className="mt-2 text-[11px] font-semibold text-slate-500">
                        Admin: {request.adminNote}
                      </div>
                    ) : request.reason ? (
                      <div className="mt-2 text-[11px] font-semibold text-slate-500">
                        Reason: {request.reason}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* this large card combines tabs, search, and the table so the whole lookup flow feels connected */}
        <div className="overflow-hidden rounded-[24px] border border-[#CFCFD3] bg-white ">
          <div className="flex flex-col items-center justify-between gap-4 border-b border-[#CFCFD3] bg-white p-5 md:flex-row">
            <MobileFilterTabs
              className="lg:hidden"
              ariaLabel="Customer discount type"
              value={tab}
              onChange={setTab}
              items={[
                { value: "all", label: "All Discounts", count: rows.length },
                { value: "wholesale", label: "Wholesale", count: countWholesale },
                { value: "loyalty", label: "Loyalty", count: countLoyalty },
              ]}
            />
            <div className="hide-scrollbar hidden w-full items-center gap-2 overflow-x-auto pb-2 lg:flex lg:w-auto lg:pb-0">
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
                  <th className="px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Note
                  </th>
                  <th className="px-4 py-3 text-center text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E7EB]">
                {dataLoading && rows.length === 0 ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index}>
                      <td colSpan={7} className="px-4 py-3">
                        <div className="h-12 animate-pulse rounded-[12px] bg-[#F3F4F6]" />
                      </td>
                    </tr>
                  ))
                ) : pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center">
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
                      className="group transition-colors hover:bg-[#ECEFF3]"
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[#DADDE3] bg-[#F3F4F6] text-[13px] font-extrabold text-[#565449]">
                            {row.customerName.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[14px] font-extrabold text-[#000000]">
                              {row.customerName}
                            </div>
                            <div className="mt-0.5 truncate text-[13px] font-semibold text-[#8C8889]">
                              {row.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
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
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-extrabold text-[#000000]">
                            {formatPct(row.valuePercent)}
                          </span>
                          <span className="text-[10px] font-semibold text-[#8C8889]">
                            on subtotal
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="max-w-[220px] text-[12px] font-semibold leading-6 text-[#565449]">
                          {row.lastPurchaseLabel}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <StatusBadge active={row.active} />
                        <div className="mt-1 pl-1 text-[10px] font-medium text-[#8C8889]">
                          {row.updatedAtLabel}
                        </div>
                      </td>
                      <td className="max-w-[300px] px-4 py-3 align-top">
                        <div className="text-[12px] font-medium leading-snug text-[#565449]">
                          {row.note || (
                            <span className="italic text-[#8C8889]/60">
                              No notes added
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center justify-center gap-2">
                          {canDeleteDiscounts ? (
                            <button
                              type="button"
                              onClick={() => openDeleteDialog(row)}
                              className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-[#11120d] hover:text-[#FFFFFF]"
                              title="Delete discount"
                              aria-label={`Delete ${row.type} for ${row.customerName}`}
                            >
                              <Icon name="delete" className="text-[17px]" />
                            </button>
                          ) : (
                            <span className="text-[11px] font-extrabold text-[#8C8889]">
                              Admin managed
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

          <div className="space-y-3 p-3 lg:hidden">
            {pageItems.map((row) => (
              <div
                key={row.id}
                className="rounded-[16px] border border-[#DADDE3] bg-[#FFFFFF] p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-extrabold text-[#000000]">
                      {row.customerName}
                    </div>
                    <div className="mt-1 text-[13px] font-semibold text-[#8C8889]">
                      {row.phone}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-[8px] border px-2.5 py-1 text-[11px] font-bold",
                      row.type === "Wholesale %"
                        ? "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]"
                        : "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]",
                    )}
                  >
                    {row.type}
                  </span>
                </div>
                
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">Rate</div>
                    <div className="mt-0.5 text-[14px] font-extrabold text-[#000000]">{formatPct(row.valuePercent)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">Status</div>
                    <div className="mt-1"><StatusBadge active={row.active} /></div>
                  </div>
                </div>

                <div className="mt-4 border-t border-[#E5E7EB] pt-4">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-[#565449]">
                        {row.lastPurchaseLabel}
                      </div>
                    </div>
                    <div className="ml-4 shrink-0">
                      {canDeleteDiscounts ? (
                        <button
                          type="button"
                          onClick={() => openDeleteDialog(row)}
                          className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] transition hover:bg-[#11120d] hover:text-[#FFFFFF]"
                          title="Delete discount"
                          aria-label={`Delete ${row.type} for ${row.customerName}`}
                        >
                          <Icon name="delete" className="text-[17px]" />
                        </button>
                      ) : (
                        <span className="text-[11px] font-extrabold text-[#8C8889]">
                          Admin
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {pageItems.length === 0 && !dataLoading && (
              <div className="py-8 text-center">
                <div className="text-[#8C8889]">
                  <span className="text-[13px] font-semibold">No discounts found.</span>
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
            label="discount records"
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
            className="bg-[#F3F4F6]/40 px-6"
          />
        </div>
      </div>
    </div>
    <ConfirmDialog
      open={Boolean(deleteTarget)}
      title={
        deleteSafety?.canDelete
          ? "Delete customer discount"
          : "Discount delete check"
      }
      message={
        deleteLoading
          ? "Checking purchase history before this discount can be changed."
          : deleteSafety?.canDelete
            ? `This will remove the ${deleteTarget?.type.toLowerCase()} for ${deleteTarget?.customerName}. The customer record will stay active.`
            : deleteSafety?.reason ||
              "This discount cannot be deleted right now."
      }
      confirmLabel={deleteSafety?.canDelete ? "Delete Discount" : "Close"}
      cancelLabel={deleteSafety?.canDelete ? "Cancel" : "Back"}
      tone={deleteSafety?.canDelete ? "danger" : "primary"}
      icon={deleteSafety?.canDelete ? "delete" : "info"}
      busy={deleteLoading || deleteBusy}
      onClose={closeDeleteDialog}
      onConfirm={confirmDeleteDiscount}
      details={
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[14px] border border-[#CFCFD3] bg-white p-3">
              <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">
                Customer
              </div>
              <div className="mt-1 text-[13px] font-extrabold text-[#000000]">
                {deleteTarget?.customerName || "-"}
              </div>
            </div>
            <div className="rounded-[14px] border border-[#CFCFD3] bg-white p-3">
              <div className="text-[10px] font-extrabold uppercase text-[#8C8889]">
                Current discount
              </div>
              <div className="mt-1 text-[13px] font-extrabold text-[#000000]">
                {deleteTarget
                  ? `${deleteTarget.type} ${formatPct(deleteTarget.valuePercent)}`
                  : "-"}
              </div>
            </div>
          </div>
          <div
            className={cn(
              "rounded-[14px] border p-3 text-[12px] font-bold",
              deleteLoading
                ? "border-[#CFCFD3] bg-white text-[#565449]"
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
      }
    />
    </>
  );
}

