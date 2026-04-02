import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Icon from "~/components/ui/Icon";
import {
  downloadAnalyticsCsvApi,
  getAnalyticsReportApi,
} from "~/lib/api/endpoints";
import {
  downloadCsvBlob,
  exportAnalyticsWorkbook,
} from "~/lib/analyticsExport";
import { formatNpr } from "~/lib/invoices";
import {
  getRangeFromPreset,
  paymentMethodLabel,
  paymentStatusLabel,
  type AnalyticsFilters,
  type AnalyticsPaymentMethod,
  type AnalyticsPaymentStatus,
  type AnalyticsRangePreset,
  type AnalyticsReport,
} from "~/lib/reports";

type RangeSelection = AnalyticsRangePreset | "custom";

const PAYMENT_COLORS: Record<AnalyticsPaymentMethod, string> = {
  CASH: "#11120d",
  ESEWA: "#179b4d",
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function pct(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function shorten(value: string, max = 18) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function errorMessage(error: any) {
  return (
    error?.response?.data?.error ||
    error?.message ||
    "Unable to load analytics right now."
  );
}

function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[24px] border border-[#CFCFD3] bg-white ">
      <div className="flex flex-col gap-3 border-b border-[#CFCFD3] px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-[15px] font-extrabold text-[#000000]">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  tone,
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: string;
  tone: string;
}) {
  return (
    <div className="rounded-[20px] border border-[#CFCFD3] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
            {title}
          </div>
          <div className="mt-2 text-[26px] font-extrabold  text-[#000000]">
            {value}
          </div>
          <div className="mt-2 text-[12px] font-semibold text-[#8C8889]">
            {subtitle}
          </div>
        </div>
        <div
          className={cn(
            "flex h-[44px] w-[44px] items-center justify-center rounded-[14px] border text-[20px]",
            tone,
          )}
        >
          <Icon name={icon} className="text-[20px]" />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  primary = false,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border px-4 text-[13px] font-extrabold transition disabled:cursor-not-allowed disabled:opacity-50",
        primary
          ? "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27]"
          : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
      )}
    >
      <Icon name={icon} className="text-[18px]" />
      {label}
    </button>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[280px] items-center justify-center rounded-[18px] border border-dashed border-[#CFCFD3] bg-[#F3F4F6]/70 px-4 py-6 text-center text-[13px] font-semibold text-[#8C8889]">
      {message}
    </div>
  );
}

function SafeChartFrame({
  className,
  children,
}: {
  className: string;
  children: React.ReactElement<{ width?: number; height?: number }>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let frameId = 0;
    const update = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const nextWidth = Math.floor(rect.width);
        const nextHeight = Math.floor(rect.height);
        setSize((current) =>
          current.width === nextWidth && current.height === nextHeight
            ? current
            : { width: nextWidth, height: nextHeight },
        );
      });
    };

    update();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => update());
      observer.observe(node);

      return () => {
        cancelAnimationFrame(frameId);
        observer.disconnect();
      };
    }

    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className={cn("min-w-0", className)}>
      <div ref={containerRef} className="h-full w-full overflow-hidden">
        {size.width > 0 && size.height > 0
          ? React.cloneElement(children, {
              width: size.width,
              height: size.height,
            })
          : null}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const initialPreset: AnalyticsRangePreset = "month";
  const [rangeSelection, setRangeSelection] =
    useState<RangeSelection>(initialPreset);
  const [draftFilters, setDraftFilters] = useState<AnalyticsFilters>({
    ...getRangeFromPreset(initialPreset),
  });
  const [filters, setFilters] = useState<AnalyticsFilters>({
    ...getRangeFromPreset(initialPreset),
  });
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [exportBusy, setExportBusy] = useState<"" | "excel" | "csv">("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const analyticsResponse = await getAnalyticsReportApi(filters);
        if (!cancelled) setReport(analyticsResponse as AnalyticsReport);
      } catch (err) {
        if (!cancelled) {
          setReport(null);
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const salesData = useMemo(() => report?.salesOverTime || [], [report]);
  const paymentData = useMemo(
    () => (report?.paymentDistribution || []).filter((item) => item.amount > 0),
    [report],
  );
  const brandData = useMemo(
    () =>
      (report?.brandPerformance || []).slice(0, 6).map((item) => ({
        ...item,
        label: shorten(item.brandName || "Unbranded", 14),
      })),
    [report],
  );
  const topProductsData = useMemo(
    () =>
      (report?.topProducts || [])
        .slice(0, 8)
        .map((item) => ({ ...item, label: shorten(item.name, 18) })),
    [report],
  );
  const topCustomersData = useMemo(
    () =>
      (report?.topCustomers || [])
        .slice(0, 8)
        .map((item) => ({ ...item, label: shorten(item.name, 18) })),
    [report],
  );
  const cashierChartData = useMemo(
    () =>
      (report?.cashierPerformance || [])
        .slice(0, 8)
        .map((item) => ({ ...item, label: shorten(item.name, 18) })),
    [report],
  );
  const hasData = !!report && report.summary.invoiceCount > 0;

  function setDraft(
    next: Partial<AnalyticsFilters>,
    nextRange?: RangeSelection,
  ) {
    setDraftFilters((current) => ({ ...current, ...next }));
    if (nextRange) setRangeSelection(nextRange);
    setFilterError("");
  }

  function apply(next: AnalyticsFilters) {
    if (!next.from || !next.to)
      return setFilterError("Select both a start and end date.");
    if (next.from > next.to)
      return setFilterError(
        "The start date must be on or before the end date.",
      );
    setFilterError("");
    setFilters({
      from: next.from,
      to: next.to,
      cashierId: next.cashierId || undefined,
      paymentStatus: next.paymentStatus || undefined,
    });
  }

  function pickPreset(preset: AnalyticsRangePreset) {
    const next = { ...draftFilters, ...getRangeFromPreset(preset) };
    setRangeSelection(preset);
    setDraftFilters(next);
    apply(next);
  }

  async function exportExcel() {
    if (!report) return;
    try {
      setExportBusy("excel");
      await exportAnalyticsWorkbook(report);
    } finally {
      setExportBusy("");
    }
  }

  async function exportCsv() {
    if (!report) return;
    try {
      setExportBusy("csv");
      const blob = await downloadAnalyticsCsvApi(filters);
      downloadCsvBlob(report, blob);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExportBusy("");
    }
  }

  return (
    <div className="space-y-6 pb-8 text-slate-900">
      <Panel
        title="Analytics"
        subtitle="Real revenue, collections, discounts, customer, brand, and cashier performance from finalized invoices."
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon="table_view"
              label={
                exportBusy === "excel" ? "Preparing Excel..." : "Export Excel"
              }
              onClick={exportExcel}
              disabled={!report || loading || exportBusy !== ""}
            />
            <ActionButton
              icon="download"
              label={exportBusy === "csv" ? "Preparing CSV..." : "Export CSV"}
              onClick={exportCsv}
              disabled={!report || loading || exportBusy !== ""}
              primary
            />
          </div>
        }
      >
        <div className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap gap-2">
            {(
              ["today", "week", "month", "quarter"] as AnalyticsRangePreset[]
            ).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => pickPreset(preset)}
                className={cn(
                  "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                  rangeSelection === preset
                    ? "border-[#11120d] bg-[#11120d] text-white"
                    : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] hover:text-[#000000]",
                )}
              >
                {preset === "today"
                  ? "Today"
                  : preset === "week"
                    ? "Last 7 days"
                    : preset === "month"
                      ? "Last 30 days"
                      : "Last 90 days"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:flex xl:flex-wrap xl:items-center">
            <input
              type="date"
              value={draftFilters.from}
              onChange={(e) => setDraft({ from: e.target.value }, "custom")}
              className="h-[44px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[220px]"
            />
            <input
              type="date"
              value={draftFilters.to}
              onChange={(e) => setDraft({ to: e.target.value }, "custom")}
              className="h-[44px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[220px]"
            />
            <select
              value={draftFilters.cashierId || ""}
              onChange={(e) =>
                setDraft({ cashierId: e.target.value || undefined })
              }
              className="h-[44px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[220px]"
            >
              <option value="">All cashiers</option>
              {(report?.cashiers || []).map((cashier) => (
                <option key={cashier.id} value={cashier.id}>
                  {cashier.name}
                </option>
              ))}
            </select>
            <select
              value={draftFilters.paymentStatus || ""}
              onChange={(e) =>
                setDraft({
                  paymentStatus:
                    (e.target.value as AnalyticsPaymentStatus) || undefined,
                })
              }
              className="h-[44px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[220px]"
            >
              <option value="">All payment statuses</option>
              {(
                [
                  "PAID",
                  "PARTIALLY_PAID",
                  "UNPAID",
                  "CANCELLED",
                ] as AnalyticsPaymentStatus[]
              ).map((status) => (
                <option key={status} value={status}>
                  {paymentStatusLabel(status)}
                </option>
              ))}
            </select>
            <div className="flex gap-2 xl:w-[180px]">
              <ActionButton
                icon="sync"
                label="Apply"
                onClick={() => apply(draftFilters)}
              />
              <ActionButton
                icon="restart_alt"
                label="Reset"
                onClick={() => {
                  const next = { ...getRangeFromPreset(initialPreset) };
                  setRangeSelection(initialPreset);
                  setDraftFilters(next);
                  apply(next);
                }}
              />
            </div>
          </div>

          {filterError ? (
            <div className="rounded-[16px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[13px] font-semibold text-[#BE123C]">
              {filterError}
            </div>
          ) : null}
        </div>
      </Panel>

      {loading && !report ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-[132px] animate-pulse rounded-[20px] border border-[#CFCFD3] bg-white/70"
            />
          ))}
        </div>
      ) : error ? (
        <Panel title="Analytics unavailable">
          <div className="px-5 py-10 text-[14px] font-semibold text-[#BE123C]">
            {error}
          </div>
        </Panel>
      ) : !report || !hasData ? (
        <Panel
          title={
            report?.summary.cancelledInvoiceCount
              ? "Only cancelled invoices matched"
              : "No analytics data"
          }
        >
          <div className="px-5 py-10 text-[14px] font-semibold text-[#8C8889]">
            {report?.summary.cancelledInvoiceCount
              ? "Cancelled invoices matched the current filters, but cancelled invoices are excluded from sales analytics totals."
              : "No finalized invoice data was found for this range."}
          </div>
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
            <MetricCard
              title="Net Sales"
              value={formatNpr(report.summary.netSales)}
              subtitle={`${report.summary.invoiceCount} sales invoices`}
              icon="payments"
              tone="border-[#11120d] bg-[#11120d] text-white"
            />
            <MetricCard
              title="Collected"
              value={formatNpr(report.summary.collectedTotal)}
              subtitle={`${pct(report.summary.collectionRate)} collected`}
              icon="task_alt"
              tone="border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]"
            />
            <MetricCard
              title="Outstanding Due"
              value={formatNpr(report.summary.dueTotal)}
              subtitle={`${report.summary.unpaidInvoiceCount + report.summary.partiallyPaidInvoiceCount} invoices still open`}
              icon="hourglass_top"
              tone="border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]"
            />
            <MetricCard
              title="Discount Given"
              value={formatNpr(report.summary.discountTotal)}
              subtitle={`${pct(report.summary.discountRate)} of gross sales`}
              icon="percent"
              tone="border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]"
            />
            <MetricCard
              title="Avg Basket"
              value={formatNpr(report.summary.averageBasketSize)}
              subtitle={`${report.summary.itemsSold} items sold`}
              icon="shopping_bag"
              tone="border-[#CFCFD3] bg-[#F3F4F6] text-[#565449]"
            />
            <MetricCard
              title="Customers"
              value={String(report.summary.customerCount)}
              subtitle={`${report.summary.walkInInvoiceCount} walk-in invoices`}
              icon="groups"
              tone="border-[#CFCFD3] bg-[#F3F4F6] text-[#565449]"
            />
          </div>

          <div className="space-y-5 xl:flex xl:items-start xl:gap-5 xl:space-y-0">
            <div className="xl:min-w-0 xl:flex-1">
              <Panel
                title="Revenue vs collection"
                subtitle="Revenue and collected cash across the selected range, with invoice volume for context."
              >
                <SafeChartFrame className="h-[365px] px-3 py-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={salesData}
                      margin={{ top: 12, right: 20, left: 4, bottom: 4 }}
                    >
                      <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{
                          fill: "#8c8889",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <YAxis
                        yAxisId="money"
                        tickFormatter={(value) => compact(value)}
                        tick={{
                          fill: "#8c8889",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <YAxis
                        yAxisId="count"
                        orientation="right"
                        tick={{
                          fill: "#8c8889",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <Tooltip
                        content={({ active, payload, label }) =>
                          active && payload?.[0]?.payload ? (
                            <div className="rounded-[16px] border border-[#CFCFD3] bg-white px-4 py-3 ">
                              <div className="text-[12px] font-extrabold uppercase  text-[#8C8889]">
                                {label}
                              </div>
                              <div className="mt-2 space-y-1 text-[13px] font-semibold text-[#565449]">
                                <div>
                                  Revenue:{" "}
                                  {formatNpr(payload[0].payload.revenue)}
                                </div>
                                <div>
                                  Collected:{" "}
                                  {formatNpr(payload[0].payload.collected)}
                                </div>
                                <div>
                                  Due: {formatNpr(payload[0].payload.due)}
                                </div>
                                <div>
                                  Invoices: {payload[0].payload.invoices}
                                </div>
                              </div>
                            </div>
                          ) : null
                        }
                      />
                      <Area
                        yAxisId="money"
                        type="monotone"
                        dataKey="revenue"
                        stroke="#11120d"
                        fill="#11120d"
                        fillOpacity={0.12}
                        strokeWidth={3}
                      />
                      <Area
                        yAxisId="money"
                        type="monotone"
                        dataKey="collected"
                        stroke="#179b4d"
                        fill="#eaf8ef"
                        fillOpacity={0.95}
                        strokeWidth={3}
                      />
                      <Bar
                        yAxisId="count"
                        dataKey="invoices"
                        fill="#cfcfd3"
                        radius={[6, 6, 0, 0]}
                        maxBarSize={28}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </SafeChartFrame>

                <div className="flex h-[280px] flex-col border-t border-[#CFCFD3] px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[14px] font-extrabold text-[#000000]">
                        Items sold and discount trend
                      </div>
                      <div className="mt-1 text-[12px] font-medium leading-[20px] text-[#8C8889]">
                        Tracks item movement against discount given across the
                        same selected range.
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 pt-[2px] text-[12px] font-semibold text-[#565449]">
                      <div className="inline-flex items-center gap-2">
                        <span className="h-[10px] w-[10px] rounded-full bg-[#179B4D]" />
                        Items sold
                      </div>
                      <div className="inline-flex items-center gap-2">
                        <span className="h-[10px] w-[10px] rounded-full bg-[#B7791F]" />
                        Discount
                      </div>
                    </div>
                  </div>

                  <SafeChartFrame className="min-h-0 flex-1 pt-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={salesData}
                        margin={{ top: 6, right: 12, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="label"
                          tick={{
                            fill: "#8c8889",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                          axisLine={{ stroke: "#cfcfd3" }}
                          tickLine={{ stroke: "#cfcfd3" }}
                        />
                        <YAxis
                          yAxisId="count"
                          allowDecimals={false}
                          tick={{
                            fill: "#8c8889",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                          axisLine={{ stroke: "#cfcfd3" }}
                          tickLine={{ stroke: "#cfcfd3" }}
                        />
                        <YAxis
                          yAxisId="money"
                          orientation="right"
                          tickFormatter={(value) => compact(value)}
                          tick={{
                            fill: "#8c8889",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                          axisLine={{ stroke: "#cfcfd3" }}
                          tickLine={{ stroke: "#cfcfd3" }}
                        />
                        <Tooltip
                          content={({ active, payload, label }) =>
                            active && payload?.[0]?.payload ? (
                              <div className="rounded-[16px] border border-[#CFCFD3] bg-white px-4 py-3">
                                <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
                                  {label}
                                </div>
                                <div className="mt-2 space-y-1 text-[13px] font-semibold text-[#565449]">
                                  <div>
                                    Items sold:{" "}
                                    {payload[0].payload.itemsSold || 0}
                                  </div>
                                  <div>
                                    Discount:{" "}
                                    {formatNpr(
                                      payload[0].payload.discount || 0,
                                    )}
                                  </div>
                                  <div>
                                    Avg basket:{" "}
                                    {formatNpr(
                                      payload[0].payload.averageBasket || 0,
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : null
                          }
                        />
                        <Line
                          yAxisId="count"
                          type="monotone"
                          dataKey="itemsSold"
                          stroke="#179B4D"
                          strokeWidth={3}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                        <Line
                          yAxisId="money"
                          type="monotone"
                          dataKey="discount"
                          stroke="#B7791F"
                          strokeWidth={3}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </SafeChartFrame>
                </div>
              </Panel>
            </div>

            <div className="space-y-5 xl:w-[420px] xl:flex-none">
              <Panel
                title="Payment mix"
                subtitle="Successful payments recorded against invoices in the selected range."
              >
                <div className="grid grid-cols-1 gap-4 px-4 py-5 md:grid-cols-[200px_168px]">
                  <SafeChartFrame className="h-[210px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={paymentData}
                          dataKey="amount"
                          nameKey="method"
                          innerRadius={52}
                          outerRadius={78}
                          paddingAngle={3}
                        >
                          {paymentData.map((slice) => (
                            <Cell
                              key={slice.method}
                              fill={PAYMENT_COLORS[slice.method]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: any, _name, item: any) => [
                            formatNpr(Number(value || 0)),
                            paymentMethodLabel(item.payload.method),
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </SafeChartFrame>
                  <div className="space-y-3">
                    {paymentData.length === 0 ? (
                      <div className="rounded-[16px] border border-dashed border-[#CFCFD3] bg-[#F3F4F6]/70 px-4 py-6 text-[13px] font-semibold text-[#8C8889]">
                        No successful payments were recorded in this range.
                      </div>
                    ) : (
                      paymentData.map((slice) => (
                        <div
                          key={slice.method}
                          className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/60 px-4 py-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <span
                                className="h-3 w-3 rounded-full"
                                style={{
                                  backgroundColor: PAYMENT_COLORS[slice.method],
                                }}
                              />
                              <div className="text-[13px] font-extrabold text-[#000000]">
                                {paymentMethodLabel(slice.method)}
                              </div>
                            </div>
                            <div className="text-[12px] font-semibold text-[#8C8889]">
                              {slice.count} payments
                            </div>
                          </div>
                          <div className="mt-2 text-[16px] font-extrabold text-[#000000]">
                            {formatNpr(slice.amount)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </Panel>

              <Panel
                title="Brand performance"
                subtitle="Revenue by brand from sold invoice items."
              >
                {brandData.length === 0 ? (
                  <div className="h-[280px] px-3 py-4">
                    <EmptyChart message="No brand-linked sales were recorded in this range." />
                  </div>
                ) : (
                  <SafeChartFrame className="h-[280px] px-3 py-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={brandData}
                        layout="vertical"
                        margin={{ top: 8, right: 20, left: 10, bottom: 8 }}
                      >
                        <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                        <XAxis
                          type="number"
                          tickFormatter={(value) => compact(value)}
                          tick={{
                            fill: "#8c8889",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                          axisLine={{ stroke: "#cfcfd3" }}
                          tickLine={{ stroke: "#cfcfd3" }}
                        />
                        <YAxis
                          type="category"
                          dataKey="label"
                          width={96}
                          tick={{
                            fill: "#565449",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                          axisLine={{ stroke: "#cfcfd3" }}
                          tickLine={{ stroke: "#cfcfd3" }}
                        />
                        <Tooltip
                          formatter={(value: any) =>
                            formatNpr(Number(value || 0))
                          }
                          labelFormatter={(_, payload) =>
                            payload?.[0]?.payload?.brandName || "Brand"
                          }
                        />
                        <Bar
                          dataKey="revenue"
                          fill="#11120d"
                          radius={[0, 8, 8, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </SafeChartFrame>
                )}
              </Panel>
            </div>
          </div>

          <Panel
            title="Top products"
            subtitle="Best-selling products by revenue in the selected range."
          >
            {topProductsData.length === 0 ? (
              <div className="h-[360px] px-3 py-4">
                <EmptyChart message="No product sales were recorded for this range." />
              </div>
            ) : (
              <SafeChartFrame className="h-[360px] px-3 py-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topProductsData}
                    layout="vertical"
                    margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => compact(value)}
                      tick={{ fill: "#8c8889", fontSize: 12, fontWeight: 700 }}
                      axisLine={{ stroke: "#cfcfd3" }}
                      tickLine={{ stroke: "#cfcfd3" }}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={124}
                      tick={{ fill: "#565449", fontSize: 12, fontWeight: 700 }}
                      axisLine={{ stroke: "#cfcfd3" }}
                      tickLine={{ stroke: "#cfcfd3" }}
                    />
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.[0]?.payload ? (
                          <div className="rounded-[16px] border border-[#CFCFD3] bg-white px-4 py-3 ">
                            <div className="text-[13px] font-extrabold text-[#000000]">
                              {payload[0].payload.name}
                            </div>
                            <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
                              {payload[0].payload.brandName || "Unbranded"} |
                              SKU {payload[0].payload.sku || "N/A"}
                            </div>
                            <div className="mt-2 space-y-1 text-[12px] font-semibold text-[#565449]">
                              <div>
                                Revenue: {formatNpr(payload[0].payload.revenue)}
                              </div>
                              <div>Qty sold: {payload[0].payload.qty}</div>
                              <div>
                                Invoices: {payload[0].payload.invoiceCount}
                              </div>
                            </div>
                          </div>
                        ) : null
                      }
                    />
                    <Bar
                      dataKey="revenue"
                      fill="#11120d"
                      radius={[0, 9, 9, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </SafeChartFrame>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel
              title="Top customers"
              subtitle="Customers generating the most revenue in this range."
            >
              {topCustomersData.length === 0 ? (
                <div className="h-[340px] px-3 py-4">
                  <EmptyChart message="No customer-linked sales were recorded in this range." />
                </div>
              ) : (
                <SafeChartFrame className="h-[340px] px-3 py-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topCustomersData}
                      layout="vertical"
                      margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        tickFormatter={(value) => compact(value)}
                        tick={{
                          fill: "#8c8889",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={124}
                        tick={{
                          fill: "#565449",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <Tooltip
                        content={({ active, payload }) =>
                          active && payload?.[0]?.payload ? (
                            <div className="rounded-[16px] border border-[#CFCFD3] bg-white px-4 py-3 ">
                              <div className="text-[13px] font-extrabold text-[#000000]">
                                {payload[0].payload.name}
                              </div>
                              <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
                                {payload[0].payload.phone ||
                                  "No phone recorded"}
                              </div>
                              <div className="mt-2 space-y-1 text-[12px] font-semibold text-[#565449]">
                                <div>
                                  Revenue:{" "}
                                  {formatNpr(payload[0].payload.revenue)}
                                </div>
                                <div>
                                  Collected:{" "}
                                  {formatNpr(payload[0].payload.collected)}
                                </div>
                                <div>
                                  Due: {formatNpr(payload[0].payload.due)}
                                </div>
                                <div>
                                  Invoices: {payload[0].payload.invoiceCount}
                                </div>
                              </div>
                            </div>
                          ) : null
                        }
                      />
                      <Bar
                        dataKey="revenue"
                        fill="#179b4d"
                        radius={[0, 9, 9, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </SafeChartFrame>
              )}
            </Panel>

            <Panel
              title="Cashier performance"
              subtitle="Revenue and discounts by cashier, with collections and basket quality in the tooltip."
            >
              {cashierChartData.length === 0 ? (
                <div className="h-[340px] px-3 py-4">
                  <EmptyChart message="No cashier activity was recorded in this range." />
                </div>
              ) : (
                <SafeChartFrame className="h-[340px] px-3 py-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={cashierChartData}
                      layout="vertical"
                      margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#e3e5e8" strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        tickFormatter={(value) => compact(value)}
                        tick={{
                          fill: "#8c8889",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={124}
                        tick={{
                          fill: "#565449",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        axisLine={{ stroke: "#cfcfd3" }}
                        tickLine={{ stroke: "#cfcfd3" }}
                      />
                      <Tooltip
                        content={({ active, payload }) =>
                          active && payload?.[0]?.payload ? (
                            <div className="rounded-[16px] border border-[#CFCFD3] bg-white px-4 py-3 ">
                              <div className="text-[13px] font-extrabold text-[#000000]">
                                {payload[0].payload.name}
                              </div>
                              <div className="mt-2 space-y-1 text-[12px] font-semibold text-[#565449]">
                                <div>
                                  Revenue:{" "}
                                  {formatNpr(payload[0].payload.revenue)}
                                </div>
                                <div>
                                  Collected:{" "}
                                  {formatNpr(payload[0].payload.collected)}
                                </div>
                                <div>
                                  Discount:{" "}
                                  {formatNpr(payload[0].payload.discount)}
                                </div>
                                <div>
                                  Invoices: {payload[0].payload.invoiceCount}
                                </div>
                                <div>
                                  Avg basket:{" "}
                                  {formatNpr(payload[0].payload.averageBasket)}
                                </div>
                              </div>
                            </div>
                          ) : null
                        }
                      />
                      <Bar
                        dataKey="revenue"
                        fill="#11120d"
                        radius={[0, 9, 9, 0]}
                      />
                      <Bar
                        dataKey="discount"
                        fill="#b7791f"
                        radius={[0, 9, 9, 0]}
                        barSize={10}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </SafeChartFrame>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
