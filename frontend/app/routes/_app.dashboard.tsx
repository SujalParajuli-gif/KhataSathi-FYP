import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import CardShell from "~/components/ui/CardShell";
import GIcon from "~/components/ui/GIcon";
import SectionTitle from "~/components/ui/SectionTitle";
import DashboardSalesOverview, {
  type DashboardActivityPoint,
  type RangeKey,
} from "~/components/blocks/dashboard/DashboardSalesOverview";
import {
  getAnalyticsReportApi,
  salesSummaryApi,
  listInvoicesApi,
  getLowStockApi,
  listProductsApi,
} from "~/lib/api/endpoints";
import { getAuthUser } from "~/lib/auth";
import {
  getRangeFromPreset,
  paymentMethodLabel,
  type AnalyticsOperations,
  type AnalyticsReport,
  type AnalyticsTopProduct,
} from "~/lib/reports";

// this type represents one KPI card shown at the top of the dashboard
type Kpi = {
  iconName: string;
  iconBgClass: string;
  value: string;
  label: string;
  badgeText?: string;
  badgeIconName?: string;
  badgeClass?: string;
};

type InvoiceRow = {
  invoiceNo: string;
  customer: string;
  cashier: string;
  date: string;
  total: string;
  status: "Paid" | "Partial" | "Unpaid";
};

type PaymentSummaryRow = {
  label: string;
  value: string;
  icon: string;
  iconBg: string;
};

type AlertRow = {
  title: string;
  time: string;
  icon: string;
  tag: "CRITICAL" | "LOW" | "INFO" | "SYSTEM";
};

type TopProductsByRange = Record<RangeKey, AnalyticsTopProduct[]>;

// this shows the payment status badge used in the recent invoices table
function StatusPill({ status }: { status: "Paid" | "Partial" | "Unpaid" }) {
  const map = {
    Paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
    Partial: "bg-amber-50 text-amber-700 border-amber-100",
    Unpaid: "bg-rose-50 text-rose-700 border-rose-100",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-md px-[8px] py-[3px] text-[11px] font-bold border uppercase  ${map[status]}`}
    >
      {status}
    </span>
  );
}

// this renders the small alert severity badge used in the alerts panel
function AlertsPill({
  label,
}: {
  label: "CRITICAL" | "LOW" | "INFO" | "SYSTEM";
}) {
  const map = {
    CRITICAL: "bg-rose-100 text-rose-700 border-rose-200",
    LOW: "bg-orange-100 text-orange-700 border-orange-200",
    INFO: "bg-sky-100 text-sky-700 border-sky-200",
    SYSTEM: "bg-slate-100 text-slate-700 border-slate-200",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-md px-[6px] py-[2px] text-[10px] font-extrabold border leading-none ${map[label]}`}
    >
      {label}
    </span>
  );
}

// this returns the icon color for each alert severity so the alert rows stay readable at a glance
function alertIconTone(label: "CRITICAL" | "LOW" | "INFO" | "SYSTEM") {
  const map = {
    CRITICAL: "text-rose-600",
    LOW: "text-orange-500",
    INFO: "text-sky-600",
    SYSTEM: "text-slate-500",
  } as const;

  return map[label];
}

// this is the secondary action button used for quick dashboard shortcuts
function GhostButton({
  icon,
  text,
  onClick,
}: {
  icon: string;
  text: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-[8px] rounded-[12px] border border-[#CFCFD3] bg-white px-[12px] py-[10px] text-[13px] font-bold text-[#565449] transition-all active:scale-[0.98] hover:bg-[#F3F4F6]"
    >
      <GIcon name={icon} sizePx={18} className="text-slate-500" />
      <span>{text}</span>
    </button>
  );
}

// this is the primary action button used for the main dashboard shortcut
function PrimaryButton({
  icon = "add",
  text,
  onClick,
}: {
  icon?: string;
  text: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-[8px] rounded-[12px] bg-[#11120d] px-[12px] py-[11px] text-[13px] font-bold text-white transition-all active:scale-[0.98] hover:bg-[#2a2c27]"
    >
      <GIcon name={icon} sizePx={18} className="text-white" />
      <span>{text}</span>
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[12px] font-semibold text-slate-400">
      {text}
    </div>
  );
}

function ManagerListRow({
  title,
  detail,
  value,
}: {
  title: string;
  detail?: string;
  value?: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white p-3">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-extrabold text-slate-800">
          {title}
        </div>
        {detail ? (
          <div className="mt-1 truncate text-[11px] font-semibold text-slate-400">
            {detail}
          </div>
        ) : null}
      </div>
      {value ? (
        <div className="shrink-0 text-[13px] font-extrabold text-slate-900">
          {value}
        </div>
      ) : null}
    </div>
  );
}

// formats a number as Nepalese Rupees (NPR) with thousands separators
function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

// we use this to get today's date in YYYY-MM-DD format for API range helpers
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// this gives us a date string a fixed number of days before today
function daysAgoIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function formatShortDateTime(value?: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildManagerStockAlerts(operations?: AnalyticsOperations) {
  if (!operations) return [];

  const outOfStock = operations.stock.outOfStockProducts.slice(0, 3).map(
    (product): AlertRow => ({
      title: `Out of stock: ${product.name}`,
      time: product.sku,
      icon: "error",
      tag: "CRITICAL",
    }),
  );
  const lowStock = operations.stock.lowStockProducts
    .filter((product) => product.stock > 0)
    .slice(0, 3)
    .map(
      (product): AlertRow => ({
        title: `Low stock: ${product.name}`,
        time: `${formatCompactNumber(product.stock)} left (threshold: ${formatCompactNumber(product.lowStockThreshold)})`,
        icon: "warning",
        tag: "LOW",
      }),
    );

  return [...outOfStock, ...lowStock].slice(0, 5);
}

// the main admin dashboard page — shows KPI cards, recent invoices, alerts, and an activity chart
export default function Dashboard() {
  const navigate = useNavigate();
  const isManagerDashboard = getAuthUser()?.role === "manager";
  const [kpis, setKpis] = useState<Kpi[]>([]); // stores the KPI cards shown across the top of the dashboard
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]); // recent invoice rows for the activity table
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummaryRow[]>([]); // payment overview cards shown beside the invoice table
  const [alerts, setAlerts] = useState<AlertRow[]>([]); // latest low-stock alert rows shown in the sidebar card
  const [managerReport, setManagerReport] = useState<AnalyticsReport | null>(
    null,
  );
  const [topProductsByRange, setTopProductsByRange] =
    useState<TopProductsByRange>({
      today: [],
      week: [],
      month: [],
    });
  const [topProductRange, setTopProductRange] = useState<RangeKey>("today");
  const [activityData, setActivityData] = useState<DashboardActivityPoint[]>(
    [],
  );
  const [chartLoading, setChartLoading] = useState(true); // loading state for the sales activity chart only
  const [chartError, setChartError] = useState(""); // chart-specific error so the rest of the dashboard can still render

  const [range, setRange] = useState<RangeKey>("today"); // active time range for the chart section

  // fetching all dashboard data in parallel when the page loads
  // loading chart data separately from the rest of the dashboard lets the range selector update without refetching everything
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (isManagerDashboard) {
          const todayRange = getRangeFromPreset("today");
          const weekRange = getRangeFromPreset("week");
          const monthRange = getRangeFromPreset("month");

          const [todayData, weekData, monthData, invoiceData] =
            await Promise.allSettled([
              getAnalyticsReportApi({
                ...todayRange,
                includeOperations: true,
              }),
              getAnalyticsReportApi(weekRange),
              getAnalyticsReportApi(monthRange),
              listInvoicesApi({ page: 1, pageSize: 5 }),
            ]);

          if (cancelled) return;

          const todayReport =
            todayData.status === "fulfilled"
              ? (todayData.value as AnalyticsReport)
              : null;
          const weekReport =
            weekData.status === "fulfilled"
              ? (weekData.value as AnalyticsReport)
              : null;
          const monthReport =
            monthData.status === "fulfilled"
              ? (monthData.value as AnalyticsReport)
              : null;
          const operations = todayReport?.operations;
          const pendingRequests =
            (operations?.discountRequests.pendingCount || 0) +
            (operations?.returns.pendingCount || 0);

          setManagerReport(todayReport);
          setTopProductsByRange({
            today: todayReport?.topProducts || [],
            week: weekReport?.topProducts || [],
            month: monthReport?.topProducts || [],
          });
          setKpis([
            {
              iconName: "payments",
              iconBgClass: "bg-emerald-50 text-emerald-700",
              value: formatNpr(todayReport?.summary.netSales || 0),
              label: "Revenue Today",
              badgeText: `${todayReport?.summary.invoiceCount || 0} invoices`,
              badgeIconName: "receipt_long",
              badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-100",
            },
            {
              iconName: "receipt_long",
              iconBgClass: "bg-sky-50 text-sky-700",
              value: String(todayReport?.summary.invoiceCount || 0),
              label: "Sales Count Today",
            },
            {
              iconName: "pause_circle",
              iconBgClass: "bg-amber-50 text-amber-700",
              value: String(operations?.parkedBills.count || 0),
              label: "Parked Bills",
            },
            {
              iconName: "pending_actions",
              iconBgClass: "bg-rose-50 text-rose-700",
              value: String(pendingRequests),
              label: "Pending Requests",
              badgeText: pendingRequests > 0 ? "Review" : undefined,
              badgeIconName: pendingRequests > 0 ? "priority_high" : undefined,
              badgeClass:
                pendingRequests > 0
                  ? "bg-rose-50 text-rose-700 border-rose-100"
                  : undefined,
            },
          ]);

          setPaymentSummary([
            ...(todayReport?.paymentDistribution || []).map((payment) => ({
              label: `${paymentMethodLabel(payment.method)} collected`,
              value: formatNpr(payment.amount),
              icon: payment.method === "CASH" ? "payments" : "qr_code_2",
              iconBg:
                payment.method === "CASH"
                  ? "bg-[#F3F4F6] text-[#000000]"
                  : "bg-emerald-100 text-emerald-700",
            })),
            {
              label: "Refunds Today",
              value: formatNpr(operations?.returns.refundAmount || 0),
              icon: "assignment_return",
              iconBg: "bg-[#FFF7E8] text-[#B7791F]",
            },
          ]);
          setAlerts(buildManagerStockAlerts(operations));

          if (invoiceData.status === "fulfilled" && invoiceData.value) {
            const raw = invoiceData.value.invoices || [];
            setInvoices(
              raw.map((inv: any) => ({
                invoiceNo: inv.invoiceNo || inv.id,
                customer: inv.customer?.name || "Walk-in",
                cashier: inv.cashier?.name || "-",
                date: new Date(inv.createdAt).toLocaleDateString(),
                total: formatNpr(inv.netTotal || 0),
                status:
                  inv.paymentStatus === "PAID" || inv.status === "PAID"
                    ? "Paid"
                    : inv.paymentStatus === "PARTIALLY_PAID" ||
                        inv.status === "PARTIAL"
                      ? "Partial"
                      : "Unpaid",
              })),
            );
          }

          return;
        }

        const weeklyRange = getRangeFromPreset("week");

        // using Promise.allSettled so if one api fails, the others still load
        const [
          salesData,
          analyticsData,
          invoiceData,
          lowStockData,
          productData,
        ] = await Promise.allSettled([
          salesSummaryApi(weeklyRange.from, weeklyRange.to),
          getAnalyticsReportApi(weeklyRange),
          listInvoicesApi({ page: 1, pageSize: 5 }),
          getLowStockApi(),
          listProductsApi({ page: 1, pageSize: 1 }),
        ]);

        if (cancelled) return;

        const builtKpis: Kpi[] = []; // collecting cards gradually lets each API contribute whatever data it has

        if (salesData.status === "fulfilled" && salesData.value) {
          const s = salesData.value;
          builtKpis.push({
            iconName: "payments",
            iconBgClass: "bg-[#F3F4F6] text-[#000000]",
            value: formatNpr(s.totalRevenue || s.totalSales || 0),
            label: "Total Sales (7d)",
            badgeText: `${s.invoiceCount || 0} invoices`,
            badgeIconName: "receipt_long",
            badgeClass: "bg-[#F3F4F6] text-[#000000] border-[#CFCFD3]",
          });
          builtKpis.push({
            iconName: "receipt_long",
            iconBgClass: "bg-sky-50 text-sky-700",
            value: String(s.invoiceCount || 0),
            label: "Invoices (7d)",
          });
        }

        if (productData.status === "fulfilled" && productData.value) {
          builtKpis.push({
            iconName: "inventory_2",
            iconBgClass: "bg-emerald-50 text-emerald-700",
            value: String(productData.value.total || 0),
            label: "Total Products",
          });
        }

        if (lowStockData.status === "fulfilled" && lowStockData.value) {
          const lowItems = Array.isArray(lowStockData.value)
            ? lowStockData.value
            : [];
          builtKpis.push({
            iconName: "warning",
            iconBgClass: "bg-rose-50 text-rose-700",
            value: String(lowItems.length),
            label: "Low Stock Items",
            badgeText: lowItems.length > 0 ? "Action needed" : undefined,
            badgeIconName: lowItems.length > 0 ? "priority_high" : undefined,
            badgeClass:
              lowItems.length > 0
                ? "bg-rose-50 text-rose-700 border-rose-100"
                : undefined,
          });

          // turning the raw low-stock items into lightweight alert rows for the sidebar list
          const builtAlerts: AlertRow[] = lowItems
            .slice(0, 5)
            .map((item: any) => ({
              title: `Low stock: ${item.name || "Unknown product"}`,
              time: `${item.stock ?? 0} left (threshold: ${item.lowStockThreshold ?? 0})`,
              icon: (item.stock ?? 0) <= 0 ? "error" : "warning",
              tag: (item.stock ?? 0) <= 0 ? "CRITICAL" : "LOW",
            }));
          setAlerts(builtAlerts);
        }

        setKpis(builtKpis);

        if (invoiceData.status === "fulfilled" && invoiceData.value) {
          // mapping the recent invoices into the simplified table shape used by this page
          const raw = invoiceData.value.invoices || [];
          const rows: InvoiceRow[] = raw.map((inv: any) => ({
            invoiceNo: inv.invoiceNo || inv.id,
            customer: inv.customer?.name || "Walk-in",
            cashier: inv.cashier?.name || "-",
            date: new Date(inv.createdAt).toLocaleDateString(),
            total: formatNpr(inv.netTotal || 0),
            status:
              inv.paymentStatus === "PAID" || inv.status === "PAID"
                ? "Paid"
                : inv.paymentStatus === "PARTIALLY_PAID" ||
                    inv.status === "PARTIAL"
                  ? "Partial"
                  : "Unpaid",
          }));
          setInvoices(rows);
        }

        const builtPayment: PaymentSummaryRow[] = []; // building the payment summary from analytics first, then falling back to sales summary if needed
        if (
          analyticsData.status === "fulfilled" &&
          analyticsData.value?.summary
        ) {
          const summary = analyticsData.value.summary;
          builtPayment.push({
            label: "Total Revenue",
            value: formatNpr(summary.netSales || 0),
            icon: "account_balance",
            iconBg: "bg-emerald-100 text-emerald-700",
          });
          builtPayment.push({
            label: "Total Paid",
            value: formatNpr(summary.collectedTotal || 0),
            icon: "check_circle",
            iconBg: "bg-sky-100 text-sky-700",
          });
          builtPayment.push({
            label: "Outstanding",
            value: formatNpr(summary.dueTotal || 0),
            icon: "pending",
            iconBg: "bg-[#FFF7E8] text-[#B7791F]",
          });
        } else if (salesData.status === "fulfilled" && salesData.value) {
          const s = salesData.value;
          builtPayment.push({
            label: "Total Revenue",
            value: formatNpr(s.totalRevenue || s.totalSales || 0),
            icon: "account_balance",
            iconBg: "bg-emerald-100 text-emerald-700",
          });
          builtPayment.push({
            label: "Total Paid",
            value: formatNpr(s.totalPaid || s.totalCollected || 0),
            icon: "check_circle",
            iconBg: "bg-sky-100 text-sky-700",
          });
          builtPayment.push({
            label: "Outstanding",
            value: formatNpr(
              Math.max(
                0,
                (s.totalRevenue || s.totalSales || 0) -
                  (s.totalPaid || s.totalCollected || 0),
              ),
            ),
            icon: "pending",
            iconBg: "bg-[#FFF7E8] text-[#B7791F]",
          });
        }
        setPaymentSummary(builtPayment);
      } catch {
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [isManagerDashboard]);

  useEffect(() => {
    let cancelled = false;

    async function loadChart() {
      setChartLoading(true);
      setChartError("");

      try {
        const preset =
          range === "today" ? "today" : range === "week" ? "week" : "month";
        const analytics = await getAnalyticsReportApi(
          getRangeFromPreset(preset),
        );

        if (cancelled) return;

        const nextData: DashboardActivityPoint[] = Array.isArray(
          analytics?.salesOverTime,
        )
          ? analytics.salesOverTime.map((point: any) => ({
              label: point.label || "",
              invoices: Number(point.invoices || 0),
              itemsSold: Number(point.itemsSold || 0),
              revenue: Number(point.revenue || 0),
            }))
          : [];

        setActivityData(nextData);
      } catch (error: any) {
        if (!cancelled) {
          setActivityData([]);
          setChartError(
            error?.response?.data?.error ||
              "Could not load dashboard activity.",
          );
        }
      } finally {
        if (!cancelled) {
          setChartLoading(false);
        }
      }
    }

    loadChart();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <div className="min-w-0 space-y-[10px] overflow-x-hidden font-sans antialiased text-slate-900 pb-10">
      {/* this split layout gives most of the width to KPI, invoices, and charts while keeping quick actions and alerts on the side */}
      <div className="space-y-[20px] lg:flex lg:items-start lg:gap-[20px] lg:space-y-0">
        <div className="min-w-0 space-y-[20px] lg:min-w-0 lg:flex-1">
          {/* the KPI cards use a tight responsive grid so the most important numbers are visible immediately on page load */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-[16px]">
            {kpis.map((k) => (
              <CardShell key={k.label}>
                <div className="p-[18px]">
                  <div className="flex items-start justify-between gap-[10px]">
                    <div
                      className={`h-[42px] w-[42px] rounded-[12px] flex items-center justify-center  ${k.iconBgClass}`}
                      aria-hidden="true"
                    >
                      <GIcon name={k.iconName} sizePx={20} />
                    </div>

                    {k.badgeText ? (
                      <div
                        className={`inline-flex items-center gap-[4px] rounded-full px-[10px] py-[4px] text-[11px] font-bold border ${
                          k.badgeClass ||
                          "bg-slate-50 text-slate-600 border-slate-100"
                        }`}
                      >
                        {k.badgeIconName ? (
                          <GIcon name={k.badgeIconName} sizePx={14} />
                        ) : null}
                        <span>{k.badgeText}</span>
                      </div>
                    ) : (
                      <div className="h-[26px]" />
                    )}
                  </div>

                  <div className="mt-[16px] text-[22px] font-extrabold text-slate-900 ">
                    {k.value}
                  </div>
                  <div className="mt-[2px] text-[12px] font-bold text-slate-400 uppercase ">
                    {k.label}
                  </div>
                </div>
              </CardShell>
            ))}
          </div>

          {/* this recent invoices card stays wide and horizontally scrollable because table readability matters more than forcing columns to wrap */}
          <CardShell className="min-w-0">
            <div className="px-[20px] py-[18px] flex items-center justify-between border-b border-[#CFCFD3]/60">
              <SectionTitle title="Recent Invoices" />
              <div className="text-[11px] font-bold text-slate-400 uppercase ">
                Last 7 days
              </div>
            </div>

            <div className="min-w-0 overflow-x-auto px-[10px] pb-[10px]">
              <table className="w-full min-w-[680px] text-left">
                <thead>
                  <tr className="text-[11px] text-slate-400 font-bold uppercase ">
                    <th className="px-[10px] py-[14px]">Invoice No</th>
                    <th className="px-[10px] py-[14px]">Customer</th>
                    <th className="px-[10px] py-[14px]">Cashier</th>
                    <th className="px-[10px] py-[14px]">Date</th>
                    <th className="px-[10px] py-[14px]">Total (NPR)</th>
                    <th className="px-[10px] py-[14px]">Status</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-50">
                  {invoices.map((row) => (
                    <tr
                      key={row.invoiceNo}
                      className="group transition-colors hover:bg-[#F3F4F6]/70"
                    >
                      <td className="px-[10px] py-[14px] text-[13px] font-bold text-slate-900">
                        {row.invoiceNo}
                      </td>
                      <td className="px-[10px] py-[14px] text-[13px] font-semibold text-slate-700 italic">
                        {row.customer}
                      </td>
                      <td className="px-[10px] py-[14px] text-[13px] text-slate-600 font-medium">
                        {row.cashier}
                      </td>
                      <td className="px-[10px] py-[14px] text-[12px] text-slate-400 font-medium">
                        {row.date}
                      </td>
                      <td className="px-[10px] py-[14px] text-[14px] font-extrabold text-slate-900">
                        {row.total}
                      </td>
                      <td className="px-[10px] py-[14px]">
                        <StatusPill status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardShell>

          <DashboardSalesOverview
            range={range}
            onRangeChange={setRange}
            data={activityData}
            loading={chartLoading}
            error={chartError}
          />

          {isManagerDashboard ? (
            <div className="grid grid-cols-1 gap-[16px] xl:grid-cols-2">
              <CardShell>
                <div className="flex items-center justify-between border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Top Products" />
                  <div className="flex rounded-full border border-[#CFCFD3] bg-white p-1">
                    {(["today", "week", "month"] as RangeKey[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTopProductRange(key)}
                        className={`rounded-full px-3 py-1 text-[11px] font-extrabold capitalize transition ${
                          topProductRange === key
                            ? "bg-[#11120d] text-white"
                            : "text-slate-500 hover:bg-[#F3F4F6]"
                        }`}
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 p-[20px]">
                  {topProductsByRange[topProductRange].length === 0 ? (
                    <EmptyState text="No product sales in this range" />
                  ) : (
                    topProductsByRange[topProductRange]
                      .slice(0, 10)
                      .map((product) => (
                        <ManagerListRow
                          key={product.productId}
                          title={product.name}
                          detail={`${product.sku} - ${formatCompactNumber(product.qty)} sold`}
                          value={formatNpr(product.revenue)}
                        />
                      ))
                  )}
                </div>
              </CardShell>

              <CardShell>
                <div className="border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Cashier Sales Today" />
                </div>
                <div className="space-y-2 p-[20px]">
                  {(managerReport?.cashierPerformance || []).length === 0 ? (
                    <EmptyState text="No cashier sales today" />
                  ) : (
                    (managerReport?.cashierPerformance || [])
                      .slice(0, 8)
                      .map((cashier) => (
                        <ManagerListRow
                          key={cashier.cashierId}
                          title={cashier.name}
                          detail={`${cashier.invoiceCount} invoices - ${formatCompactNumber(cashier.itemsSold)} items`}
                          value={formatNpr(cashier.revenue)}
                        />
                      ))
                  )}
                </div>
              </CardShell>

              <CardShell>
                <div className="border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Stock Watch" />
                </div>
                <div className="space-y-3 p-[20px]">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-xl bg-rose-50 p-3 text-center">
                      <div className="text-[18px] font-extrabold text-rose-700">
                        {managerReport?.operations?.stock.outOfStockCount || 0}
                      </div>
                      <div className="text-[10px] font-bold uppercase text-rose-500">
                        Out
                      </div>
                    </div>
                    <div className="rounded-xl bg-amber-50 p-3 text-center">
                      <div className="text-[18px] font-extrabold text-amber-700">
                        {managerReport?.operations?.stock.lowStockCount || 0}
                      </div>
                      <div className="text-[10px] font-bold uppercase text-amber-600">
                        Low
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3 text-center">
                      <div className="text-[18px] font-extrabold text-slate-700">
                        {managerReport?.operations?.stock.slowMovingCount || 0}
                      </div>
                      <div className="text-[10px] font-bold uppercase text-slate-500">
                        Slow
                      </div>
                    </div>
                  </div>
                  {(managerReport?.operations?.stock.lowStockProducts || [])
                    .slice(0, 5)
                    .map((product) => (
                      <ManagerListRow
                        key={product.id}
                        title={product.name}
                        detail={`${product.sku} - threshold ${formatCompactNumber(product.lowStockThreshold)}`}
                        value={`${formatCompactNumber(product.stock)} left`}
                      />
                    ))}
                </div>
              </CardShell>

              <CardShell>
                <div className="border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Open Cash Drawers" />
                </div>
                <div className="space-y-2 p-[20px]">
                  {(managerReport?.operations?.cashDrawers.openDrawers || [])
                    .length === 0 ? (
                    <EmptyState text="No open cash drawers" />
                  ) : (
                    (managerReport?.operations?.cashDrawers.openDrawers || [])
                      .slice(0, 8)
                      .map((drawer) => (
                        <ManagerListRow
                          key={drawer.id}
                          title={drawer.cashier?.name || "Cashier"}
                          detail={`Opened ${formatShortDateTime(drawer.openedAt)}`}
                          value={formatNpr(drawer.expectedTotal || 0)}
                        />
                      ))
                  )}
                </div>
              </CardShell>
            </div>
          ) : null}
        </div>

        <div className="min-w-0 space-y-[20px] lg:w-[340px] lg:flex-none">
          <CardShell>
            <div className="p-[20px]">
              <SectionTitle title="Quick Actions" />
              <div className="mt-4 space-y-3">
                <PrimaryButton
                  icon="percent"
                  text="Manage Discounts"
                  onClick={() => navigate("/discounts")}
                />
                <GhostButton
                  icon="inventory_2"
                  text="Add Product"
                  onClick={() => navigate("/products")}
                />
                <GhostButton
                  icon="bar_chart"
                  text="View Reports"
                  onClick={() => navigate("/analytics")}
                />
                <GhostButton
                  icon="notifications"
                  text="Review Alerts"
                  onClick={() => navigate("/alerts")}
                />
              </div>
            </div>
          </CardShell>

          <CardShell>
            <div className="px-[20px] py-[18px] border-b border-[#CFCFD3]/60">
              <SectionTitle title="Payment Summary" />
            </div>

            <div className="p-[20px] space-y-3">
              {paymentSummary.map((p) => (
                <div
                  key={p.label}
                  className="flex items-center justify-between rounded-xl border border-slate-100 bg-white p-3 hover:border-slate-200 transition-colors"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${p.iconBg}`}
                      aria-hidden="true"
                    >
                      <GIcon name={p.icon} sizePx={18} />
                    </div>
                    <span className="truncate text-[13px] font-bold text-slate-700">
                      {p.label}
                    </span>
                  </div>
                  <span className="shrink-0 pl-3 text-[14px] font-extrabold text-slate-900">
                    {p.value}
                  </span>
                </div>
              ))}
            </div>
          </CardShell>

          {isManagerDashboard ? (
            <>
              <CardShell>
                <div className="border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Pending Work" />
                </div>
                <div className="space-y-2 p-[20px]">
                  <ManagerListRow
                    title="Discount Requests"
                    detail="Waiting for approval"
                    value={String(
                      managerReport?.operations?.discountRequests
                        .pendingCount || 0,
                    )}
                  />
                  <ManagerListRow
                    title="Return Requests"
                    detail="Waiting for approval"
                    value={String(
                      managerReport?.operations?.returns.pendingCount || 0,
                    )}
                  />
                  <ManagerListRow
                    title="Parked Bills"
                    detail="Held billing drafts"
                    value={String(
                      managerReport?.operations?.parkedBills.count || 0,
                    )}
                  />
                </div>
              </CardShell>

              <CardShell>
                <div className="border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
                  <SectionTitle title="Recent Stock Receives" />
                </div>
                <div className="space-y-2 p-[20px]">
                  {(managerReport?.operations?.recentStockReceives || [])
                    .length === 0 ? (
                    <EmptyState text="No stock receives in the last 7 days" />
                  ) : (
                    (managerReport?.operations?.recentStockReceives || []).map(
                      (batch) => (
                        <ManagerListRow
                          key={batch.id}
                          title={batch.supplierName}
                          detail={`${batch.lineCount} lines - ${formatShortDateTime(batch.createdAt)}`}
                          value={`${formatCompactNumber(batch.totalQty)} units`}
                        />
                      ),
                    )
                  )}
                </div>
              </CardShell>
            </>
          ) : null}

          <CardShell>
            <div className="flex items-center justify-between border-b border-[#CFCFD3]/60 px-[20px] py-[18px]">
              <SectionTitle title="Alerts" />
              {alerts.length > 0 && (
                <div className="h-2 w-2 rounded-full bg-rose-500 " />
              )}
            </div>

            <div className="p-[20px] pt-2 space-y-1">
              {alerts.length === 0 ? (
                <div className="text-[13px] text-slate-400 py-4 text-center">
                  No alerts
                </div>
              ) : (
                alerts.map((a, idx) => (
                  <div
                    key={idx}
                    className="group relative -mx-2 flex cursor-pointer items-start gap-3 rounded-xl p-2.5 transition-all duration-200 hover:bg-[#F3F4F6] "
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#CFCFD3] bg-[#F3F4F6] transition-colors group-hover:bg-white">
                      <GIcon
                        name={a.icon}
                        sizePx={18}
                        className={`${alertIconTone(a.tag)} transition-colors`}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="mb-0.5 flex min-w-0 items-start justify-between gap-2">
                        <p className="truncate text-[12px] font-bold leading-tight text-slate-800 group-hover:text-slate-900">
                          {a.title}
                        </p>
                        <div className="shrink-0">
                          <AlertsPill label={a.tag} />
                        </div>
                      </div>
                      <p className="truncate text-[10px] font-bold uppercase  text-slate-400 group-hover:text-slate-500">
                        {a.time}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardShell>
        </div>
      </div>
    </div>
  );
}
