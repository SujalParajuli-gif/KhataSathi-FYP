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
import { getRangeFromPreset } from "~/lib/reports";

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

function StatusPill({ status }: { status: "Paid" | "Partial" | "Unpaid" }) {
  const map = {
    Paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
    Partial: "bg-amber-50 text-amber-700 border-amber-100",
    Unpaid: "bg-rose-50 text-rose-700 border-rose-100",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-md px-[8px] py-[3px] text-[11px] font-bold border uppercase tracking-wider ${map[status]}`}
    >
      {status}
    </span>
  );
}

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

function alertIconTone(label: "CRITICAL" | "LOW" | "INFO" | "SYSTEM") {
  const map = {
    CRITICAL: "text-rose-600",
    LOW: "text-orange-500",
    INFO: "text-sky-600",
    SYSTEM: "text-slate-500",
  } as const;

  return map[label];
}

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
      className="flex w-full items-center justify-center gap-[8px] rounded-[12px] border border-[var(--app-border)] bg-white px-[12px] py-[10px] text-[13px] font-bold text-[var(--app-text-soft)] transition-all active:scale-[0.98] hover:bg-[var(--app-surface-muted)]"
    >
      <GIcon name={icon} sizePx={18} className="text-slate-500" />
      <span>{text}</span>
    </button>
  );
}

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

function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummaryRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [activityData, setActivityData] = useState<DashboardActivityPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState("");

  const [range, setRange] = useState<RangeKey>("today");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const weeklyRange = getRangeFromPreset("week");

        const [salesData, analyticsData, invoiceData, lowStockData, productData] =
          await Promise.allSettled([
            salesSummaryApi(weeklyRange.from, weeklyRange.to),
            getAnalyticsReportApi(weeklyRange),
            listInvoicesApi({ page: 1, pageSize: 5 }),
            getLowStockApi(),
            listProductsApi({ page: 1, pageSize: 1 }),
          ]);

        if (cancelled) return;

        const builtKpis: Kpi[] = [];

        if (salesData.status === "fulfilled" && salesData.value) {
          const s = salesData.value;
          builtKpis.push({
            iconName: "payments",
            iconBgClass: "bg-[var(--app-surface-muted)] text-[var(--app-text)]",
            value: formatNpr(s.totalRevenue || s.totalSales || 0),
            label: "Total Sales (7d)",
            badgeText: `${s.invoiceCount || 0} invoices`,
            badgeIconName: "receipt_long",
            badgeClass: "bg-[var(--app-surface-muted)] text-[var(--app-text)] border-[var(--app-border)]",
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
          const raw = invoiceData.value.invoices || [];
          const rows: InvoiceRow[] = raw.map((inv: any) => ({
            invoiceNo: inv.invoiceNo || inv.id,
            customer: inv.customer?.name || "Walk-in",
            cashier: inv.cashier?.name || "—",
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

        const builtPayment: PaymentSummaryRow[] = [];
        if (analyticsData.status === "fulfilled" && analyticsData.value?.summary) {
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
            iconBg: "bg-[var(--app-warning-bg)] text-[var(--app-warning-text)]",
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
            value: formatNpr(Math.max(0, (s.totalRevenue || s.totalSales || 0) - (s.totalPaid || s.totalCollected || 0))),
            icon: "pending",
            iconBg: "bg-[var(--app-warning-bg)] text-[var(--app-warning-text)]",
          });
        }
        setPaymentSummary(builtPayment);
      } catch {
        // silently fail
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadChart() {
      setChartLoading(true);
      setChartError("");

      try {
        const preset =
          range === "today" ? "today" : range === "week" ? "week" : "month";
        const analytics = await getAnalyticsReportApi(getRangeFromPreset(preset));

        if (cancelled) return;

        const nextData: DashboardActivityPoint[] = Array.isArray(analytics?.salesOverTime)
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
            error?.response?.data?.error || "Could not load dashboard activity.",
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
    <div className="min-w-0 space-y-[20px] overflow-x-hidden font-sans antialiased text-slate-900 pb-10">
      <div className="grid min-w-0 grid-cols-1 gap-[20px] lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-[20px]">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-[16px]">
            {kpis.map((k) => (
              <CardShell key={k.label}>
                <div className="p-[18px]">
                  <div className="flex items-start justify-between gap-[10px]">
                    <div
                      className={`h-[42px] w-[42px] rounded-[12px] flex items-center justify-center shadow-inner ${k.iconBgClass}`}
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

                  <div className="mt-[16px] text-[22px] font-extrabold text-slate-900 tracking-tight">
                    {k.value}
                  </div>
                  <div className="mt-[2px] text-[12px] font-bold text-slate-400 uppercase tracking-wide">
                    {k.label}
                  </div>
                </div>
              </CardShell>
            ))}
          </div>

          <CardShell className="min-w-0">
            <div className="px-[20px] py-[18px] flex items-center justify-between border-b border-[var(--app-border)]/60">
              <SectionTitle title="Recent Invoices" />
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                Last 7 days
              </div>
            </div>

            <div className="min-w-0 overflow-x-auto px-[10px] pb-[10px]">
              <table className="w-full min-w-[680px] text-left">
                <thead>
                  <tr className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">
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
                    <tr key={row.invoiceNo} className="group transition-colors hover:bg-[var(--app-surface-muted)]/70">
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
        </div>

        <div className="min-w-0 space-y-[20px]">
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
            <div className="px-[20px] py-[18px] border-b border-[var(--app-border)]/60">
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

          <CardShell>
            <div className="flex items-center justify-between border-b border-[var(--app-border)]/60 px-[20px] py-[18px]">
              <SectionTitle title="Alerts" />
              {alerts.length > 0 && (
                <div className="h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.4)]" />
              )}
            </div>

            <div className="p-[20px] pt-2 space-y-1">
              {alerts.length === 0 ? (
                <div className="text-[13px] text-slate-400 py-4 text-center">
                  No alerts
                </div>
              ) : (
                alerts.map((a, idx) => (
                  <div key={idx} className="group relative -mx-2 flex cursor-pointer items-start gap-3 rounded-xl p-2.5 transition-all duration-200 hover:bg-[var(--app-surface-muted)] hover:shadow-[inset_3px_0_0_0_#11120d]">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] transition-colors group-hover:bg-white">
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
                      <p className="truncate text-[10px] font-bold uppercase tracking-tight text-slate-400 group-hover:text-slate-500">
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
