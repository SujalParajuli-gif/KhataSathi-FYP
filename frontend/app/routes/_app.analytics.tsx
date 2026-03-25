import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import {
  salesSummaryApi,
  bestSellersApi,
  cashierSalesApi,
  listAuditLogsApi,
} from "~/lib/api/endpoints";

type RangeKey = "today" | "week" | "month";
type PaymentMethod = "Cash" | "eSewa" | "Khalti";
type InvoiceStatus = "Paid" | "Partial" | "Unpaid";

type SalePoint = {
  label: string; // "Mon" / "Tue" or "10AM"
  revenue: number;
  orders: number;
  discountNpr: number; // subtotal-level discount
};

type TopProduct = {
  id: string;
  name: string;
  sku: string;
  brand: string;
  qty: number;
  revenue: number;
};

type CashierRow = {
  id: string;
  name: string;
  orders: number;
  revenue: number;
};

type BrandSlice = {
  brand: string;
  value: number; // count or revenue
};

type AuditItem = {
  id: string;
  title: string;
  desc?: string;
  timeLabel: string;
};

type PaymentSlice = {
  method: PaymentMethod;
  value: number; // NPR amount
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

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose";
}) {
  const map: Record<typeof tone, string> = {
    neutral: "bg-slate-50 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    orange: "bg-orange-50 text-orange-700 border-orange-100",
    sky: "bg-sky-50 text-sky-700 border-sky-100",
    rose: "bg-rose-50 text-rose-700 border-rose-100",
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

function Select({
  value,
  onChange,
  options,
  leftIcon,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  leftIcon?: string;
}) {
  return (
    <div className="flex items-center gap-[8px] rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px]">
      {leftIcon ? (
        <Icon name={leftIcon} className="text-slate-500" />
      ) : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-[14px] outline-none bg-transparent w-full"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Button({
  children,
  variant = "secondary",
  onClick,
  icon,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  onClick?: () => void;
  icon?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition";
  const styles =
    variant === "primary"
      ? "bg-orange-600 text-white border-orange-600 hover:bg-orange-700"
      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";

  return (
    <button type="button" onClick={onClick} className={cn(base, styles)}>
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function Kpi({
  title,
  value,
  hint,
  icon,
  tone = "neutral",
}: {
  title: string;
  value: string;
  hint?: string;
  icon: string;
  tone?: "neutral" | "green" | "orange" | "sky" | "rose";
}) {
  const toneMap: Record<typeof tone, string> = {
    neutral: "bg-slate-50 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    orange: "bg-orange-50 text-orange-700 border-orange-100",
    sky: "bg-sky-50 text-sky-700 border-sky-100",
    rose: "bg-rose-50 text-rose-700 border-rose-100",
  };

  return (
    <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
      <div className="flex items-start justify-between gap-[10px]">
        <div>
          <div className="text-[12px] text-slate-600 font-semibold">
            {title}
          </div>
          <div className="text-[18px] font-bold text-slate-900 mt-[4px]">
            {value}
          </div>
          {hint ? (
            <div className="text-[12px] text-slate-500 mt-[2px]">{hint}</div>
          ) : null}
        </div>

        <div
          className={cn(
            "h-[36px] w-[36px] rounded-[12px] border flex items-center justify-center",
            toneMap[tone],
          )}
          aria-hidden="true"
        >
          <Icon name={icon} className="text-inherit" />
        </div>
      </div>
    </div>
  );
}

function formatNpr(n: number) {
  const s = Math.round(n).toString();
  const withComma = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NPR ${withComma}`;
}

function formatPct(n: number) {
  return `${Math.round(n * 10) / 10}%`;
}

/* Pie (brand) - your version, kept */
function PieChart({
  title,
  subtitle,
  data,
}: {
  title: string;
  subtitle?: string;
  data: BrandSlice[];
}) {
  const total = useMemo(
    () =>
      data.reduce(
        (acc, x) => acc + (Number.isFinite(x.value) ? x.value : 0),
        0,
      ),
    [data],
  );

  const slices = useMemo(() => {
    if (total <= 0) return [];

    let start = -Math.PI / 2;
    return data
      .filter((d) => d.value > 0)
      .map((d, idx) => {
        const frac = d.value / total;
        const angle = frac * Math.PI * 2;
        const end = start + angle;

        const largeArc = angle > Math.PI ? 1 : 0;

        const r = 56;
        const cx = 70;
        const cy = 70;

        const x1 = cx + r * Math.cos(start);
        const y1 = cy + r * Math.sin(start);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);

        const opacity = 0.25 + (idx % 6) * 0.12;

        const dPath = [
          `M ${cx} ${cy}`,
          `L ${x1} ${y1}`,
          `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
          "Z",
        ].join(" ");

        start = end;

        return {
          key: d.brand,
          brand: d.brand,
          value: d.value,
          frac,
          opacity,
          path: dPath,
        };
      });
  }, [data, total]);

  return (
    <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
      <div className="flex items-start justify-between gap-[10px]">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {title}
          </div>
          {subtitle ? (
            <div className="text-[12px] text-slate-600 mt-[2px]">
              {subtitle}
            </div>
          ) : null}
        </div>
        <Pill tone="orange">Pie</Pill>
      </div>

      <div className="mt-[12px] grid grid-cols-1 md:grid-cols-[160px_1fr] gap-[12px] items-center">
        <div className="flex justify-center md:justify-start">
          <svg width="140" height="140" viewBox="0 0 140 140" role="img">
            <title>Brand distribution</title>

            <circle cx="70" cy="70" r="56" fill="rgba(241,245,249,0.6)" />

            {slices.map((s) => (
              <path
                key={s.key}
                d={s.path}
                fill="rgb(249 115 22)"
                opacity={s.opacity}
                stroke="rgba(15,23,42,0.06)"
                strokeWidth="1"
              />
            ))}

            <circle cx="70" cy="70" r="30" fill="white" />

            <text
              x="70"
              y="68"
              textAnchor="middle"
              className="fill-slate-900"
              style={{ fontSize: 12, fontWeight: 700 }}
            >
              Total
            </text>
            <text
              x="70"
              y="86"
              textAnchor="middle"
              className="fill-slate-600"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              {total.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
            </text>
          </svg>
        </div>

        <div className="space-y-[8px]">
          {data.length === 0 || total <= 0 ? (
            <div className="text-[13px] text-slate-600">No data yet.</div>
          ) : (
            slices.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-[10px] rounded-[12px] border border-slate-100 p-[10px]"
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <span
                    className="h-[10px] w-[10px] rounded-full bg-orange-500"
                    style={{ opacity: s.opacity }}
                    aria-hidden="true"
                  />
                  <div className="text-[13px] font-semibold text-slate-800 truncate">
                    {s.brand}
                  </div>
                </div>
                <div className="text-[12px] font-semibold text-slate-700">
                  {formatPct(s.frac * 100)} •{" "}
                  <span className="text-slate-900">{s.value}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* Payment donut (new) */
function PaymentDonut({
  title,
  subtitle,
  data,
}: {
  title: string;
  subtitle?: string;
  data: PaymentSlice[];
}) {
  const total = useMemo(
    () =>
      data.reduce((a, x) => a + (Number.isFinite(x.value) ? x.value : 0), 0),
    [data],
  );

  const slices = useMemo(() => {
    if (total <= 0) return [];

    let start = -Math.PI / 2;
    const cx = 70;
    const cy = 70;
    const r = 56;

    return data
      .filter((d) => d.value > 0)
      .map((d, idx) => {
        const frac = d.value / total;
        const angle = frac * Math.PI * 2;
        const end = start + angle;

        const largeArc = angle > Math.PI ? 1 : 0;

        const x1 = cx + r * Math.cos(start);
        const y1 = cy + r * Math.sin(start);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);

        const opacity = 0.25 + (idx % 6) * 0.12;

        const path = [
          `M ${cx} ${cy}`,
          `L ${x1} ${y1}`,
          `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
          "Z",
        ].join(" ");

        start = end;

        return { ...d, frac, opacity, path };
      });
  }, [data, total]);

  return (
    <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
      <div className="flex items-start justify-between gap-[10px]">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {title}
          </div>
          {subtitle ? (
            <div className="text-[12px] text-slate-600 mt-[2px]">
              {subtitle}
            </div>
          ) : null}
        </div>
        <Pill tone="sky">Payments</Pill>
      </div>

      <div className="mt-[12px] grid grid-cols-1 md:grid-cols-[160px_1fr] gap-[12px] items-center">
        <div className="flex justify-center md:justify-start">
          <svg width="140" height="140" viewBox="0 0 140 140" role="img">
            <title>Payment distribution</title>

            <circle cx="70" cy="70" r="56" fill="rgba(241,245,249,0.6)" />

            {slices.map((s) => (
              <path
                key={s.method}
                d={s.path}
                fill="rgb(14 165 233)"
                opacity={s.opacity}
                stroke="rgba(15,23,42,0.06)"
                strokeWidth="1"
              />
            ))}

            <circle cx="70" cy="70" r="30" fill="white" />

            <text
              x="70"
              y="68"
              textAnchor="middle"
              className="fill-slate-900"
              style={{ fontSize: 12, fontWeight: 700 }}
            >
              Total
            </text>
            <text
              x="70"
              y="86"
              textAnchor="middle"
              className="fill-slate-600"
              style={{ fontSize: 11, fontWeight: 700 }}
            >
              {formatNpr(total).replace("NPR ", "NPR ")}
            </text>
          </svg>
        </div>

        <div className="space-y-[8px]">
          {total <= 0 ? (
            <div className="text-[13px] text-slate-600">No payments yet.</div>
          ) : (
            slices.map((s) => (
              <div
                key={s.method}
                className="flex items-center justify-between gap-[10px] rounded-[12px] border border-slate-100 p-[10px]"
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <span
                    className="h-[10px] w-[10px] rounded-full bg-sky-500"
                    style={{ opacity: s.opacity }}
                    aria-hidden="true"
                  />
                  <div className="text-[13px] font-semibold text-slate-800 truncate">
                    {s.method}
                  </div>
                </div>
                <div className="text-[12px] font-semibold text-slate-700">
                  {formatPct(s.frac * 100)} •{" "}
                  <span className="text-slate-900">{formatNpr(s.value)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>("week");
  const [cashier, setCashier] = useState<"all" | string>("all");
  const [payment, setPayment] = useState<"all" | PaymentMethod>("all");
  const [status, setStatus] = useState<"all" | InvoiceStatus>("all");

  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [cashiers, setCashiers] = useState<CashierRow[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [salesData, setSalesData] = useState<SalePoint[]>([]);

  function daysAgoIso(days: number) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  useEffect(() => {
    const days = range === "today" ? 1 : range === "week" ? 7 : 30;
    const from = daysAgoIso(days);
    const to = todayIso();

    async function load() {
      const [bestData, cashierData, auditData, summaryData] =
        await Promise.allSettled([
          bestSellersApi(from, to, 10),
          cashierSalesApi(from, to),
          listAuditLogsApi({ pageSize: 5 }),
          salesSummaryApi(from, to),
        ]);

      if (bestData.status === "fulfilled" && bestData.value) {
        const items = Array.isArray(bestData.value) ? bestData.value : [];
        setTopProducts(
          items.map((p: any, idx: number) => ({
            id: p.product?.id || p.productId || `p${idx}`,
            name: p.product?.name || p.productName || p.name || "Unknown",
            sku: p.product?.sku || p.sku || "",
            brand: p.product?.brand || p.brand || "",
            qty: p.totalQty || 0,
            revenue: p.totalRevenue || 0,
          })),
        );
      }

      if (cashierData.status === "fulfilled" && cashierData.value) {
        const items = Array.isArray(cashierData.value)
          ? cashierData.value
          : [];
        setCashiers(
          items.map((c: any, idx: number) => ({
            id: c.cashier?.id || c.userId || `c${idx}`,
            name: c.cashier?.name || c.userName || c.name || "Unknown",
            orders: c.invoiceCount || 0,
            revenue: c.totalSales || c.totalRevenue || 0,
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

      if (summaryData.status === "fulfilled" && summaryData.value) {
        const s = summaryData.value;
        setSalesData([
          {
            label: range === "today" ? "Today" : `${days}d`,
            revenue: s.totalRevenue || 0,
            orders: s.invoiceCount || 0,
            discountNpr: 0,
          },
        ]);
      }
    }
    load();
  }, [range]);

  const trend = useMemo(() => {
    if (salesData.length > 0) return salesData;
    return [];
  }, [salesData]);

  const [hover, setHover] = useState<SalePoint | null>(null);

  // discount usage (no backend source yet)
  const discountUsage = useMemo(() => {
    return {
      customerWholesaleCount: 0,
      loyaltyCount: 0,
      noneCount: 0,
      customerWholesaleNpr: 0,
      loyaltyNpr: 0,
      totalDiscountNpr: 0,
    };
  }, []);

  // brand distribution from top products (qty share)
  const brandPie = useMemo(() => {
    const map = new Map<string, number>();
    topProducts.forEach((p) => {
      map.set(p.brand, (map.get(p.brand) || 0) + p.qty);
    });
    return Array.from(map.entries())
      .map(([brand, value]) => ({ brand, value }))
      .sort((a, b) => b.value - a.value);
  }, [topProducts]);

  // payment distribution
  const paymentPie = useMemo<PaymentSlice[]>(() => {
    // Coming soon: compute from invoices table where payment_method is saved
    return [];
  }, [payment]);

  // KPI from trend
  const kpis = useMemo(() => {
    const totalRevenue = trend.reduce((a, x) => a + x.revenue, 0);
    const totalOrders = trend.reduce((a, x) => a + x.orders, 0);
    const totalDiscount = trend.reduce((a, x) => a + x.discountNpr, 0);
    const aov = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    return { totalRevenue, totalOrders, totalDiscount, aov };
  }, [trend]);

  // scale for bars
  const maxRevenue = useMemo(() => {
    const m = Math.max(...trend.map((x) => x.revenue));
    return Number.isFinite(m) && m > 0 ? m : 1;
  }, [trend]);

  // small y-axis tick values (more descriptive)
  const yTicks = useMemo(() => {
    const t0 = 0;
    const t1 = Math.round(maxRevenue * 0.25);
    const t2 = Math.round(maxRevenue * 0.5);
    const t3 = Math.round(maxRevenue * 0.75);
    const t4 = Math.round(maxRevenue * 1.0);
    return [t4, t3, t2, t1, t0];
  }, [maxRevenue]);

  return (
    <div className="space-y-[14px]">
      {/* Header + filters */}
      <Card>
        <div className="p-[16px] space-y-[12px]">
          <div className="flex items-start justify-between gap-[12px] flex-wrap">
            <div>
              <div className="text-[15px] font-semibold text-slate-900">
                Analytics
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Reports for sales, discounts, payments, and cashier performance.
              </div>
            </div>

            <div className="flex items-center gap-[10px] flex-wrap justify-end">
              <Button icon="download">Export CSV</Button>
              <Button variant="primary" icon="bar_chart">
                Generate report
              </Button>
            </div>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-[12px]">
            <Select
              value={range}
              onChange={(v) => setRange(v as RangeKey)}
              leftIcon="date_range"
              options={[
                { value: "today", label: "Today" },
                { value: "week", label: "Last 7 days" },
                { value: "month", label: "Last 30 days" },
              ]}
            />

            <Select
              value={cashier}
              onChange={(v) => setCashier(v as any)}
              leftIcon="person"
              options={[
                { value: "all", label: "All cashiers" },
                ...cashiers.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />

            <Select
              value={payment}
              onChange={(v) => setPayment(v as any)}
              leftIcon="payments"
              options={[
                { value: "all", label: "All payments" },
                { value: "Cash", label: "Cash" },
                { value: "eSewa", label: "eSewa" },
                { value: "Khalti", label: "Khalti" },
              ]}
            />

            <Select
              value={status}
              onChange={(v) => setStatus(v as any)}
              leftIcon="receipt_long"
              options={[
                { value: "all", label: "All invoice status" },
                { value: "Paid", label: "Paid" },
                { value: "Partial", label: "Partial" },
                { value: "Unpaid", label: "Unpaid" },
              ]}
            />
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-[10px]">
            <Kpi
              title="Total sales"
              value={formatNpr(kpis.totalRevenue)}
              hint={`Range: ${range}`}
              icon="payments"
              tone="orange"
            />
            <Kpi
              title="Total invoices"
              value={kpis.totalOrders.toString()}
              hint="Orders/invoices count"
              icon="receipt_long"
              tone="sky"
            />
            <Kpi
              title="Discount given"
              value={formatNpr(kpis.totalDiscount)}
              hint="Subtotal-level discounts"
              icon="percent"
              tone="green"
            />
            <Kpi
              title="Avg order value"
              value={formatNpr(kpis.aov)}
              hint="Sales / invoices"
              icon="calculate"
              tone="neutral"
            />
          </div>
        </div>
      </Card>

      {/* Charts area */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-[14px]">
        {/* Trend bar chart */}
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="flex items-start justify-between gap-[10px] flex-wrap">
              <div>
                <div className="text-[15px] font-semibold text-slate-900">
                  Sales trend
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Hover a bar to see revenue, orders, and discount.
                </div>
              </div>
              <Pill tone="orange">Revenue</Pill>
            </div>

            {/* Hover details box (makes hover meaningful) */}
            <div className="rounded-[14px] border border-slate-200 bg-white p-[12px]">
              <div className="text-[12px] font-semibold text-slate-600">
                Hover details
              </div>
              <div className="mt-[6px] text-[13px] text-slate-800">
                {hover ? (
                  <>
                    <span className="font-semibold text-slate-900">
                      {hover.label}
                    </span>{" "}
                    • {formatNpr(hover.revenue)} • Orders:{" "}
                    <span className="font-semibold">{hover.orders}</span> •
                    Discount:{" "}
                    <span className="font-semibold">
                      {formatNpr(hover.discountNpr)}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-600">
                    Move your mouse over a bar.
                  </span>
                )}
              </div>
            </div>

            {/* Bars with y-axis tick labels (more descriptive) */}
            <div className="rounded-[14px] border border-slate-200 bg-slate-50/40 p-[12px]">
              <div className="relative h-[240px]">
                {/* Y-axis tick labels */}
                <div className="absolute left-0 top-0 bottom-0 w-[86px] pr-[10px] flex flex-col justify-between">
                  {yTicks.map((t, idx) => (
                    <div
                      key={`${t}_${idx}`}
                      className="text-[11px] text-slate-500 font-semibold"
                    >
                      {formatNpr(t)}
                    </div>
                  ))}
                </div>

                {/* Chart area */}
                <div className="absolute left-[86px] right-0 top-0 bottom-0">
                  <div className="h-full flex items-end gap-[10px]">
                    {trend.map((p) => {
                      const h = Math.max(
                        6,
                        Math.round((p.revenue / maxRevenue) * 190),
                      );

                      return (
                        <div key={p.label} className="flex-1 min-w-0">
                          <div
                            className="rounded-t-[10px] bg-orange-500/60 hover:bg-orange-500 transition cursor-pointer"
                            style={{ height: h }}
                            title={`${p.label}: ${formatNpr(p.revenue)} • Orders: ${p.orders} • Discount: ${formatNpr(
                              p.discountNpr,
                            )}`}
                            onMouseEnter={() => setHover(p)}
                            onMouseLeave={() => setHover(null)}
                          />

                          {/* X label */}
                          <div className="mt-[8px] text-[11px] font-semibold text-slate-600 text-center truncate">
                            {p.label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Quick mini-stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px]">
              <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
                <div className="text-[12px] font-semibold text-slate-600">
                  Discount split (MVP)
                </div>
                <div className="mt-[8px] flex flex-wrap gap-[8px]">
                  <Pill tone="orange">
                    Customer %: {formatNpr(discountUsage.customerWholesaleNpr)}
                  </Pill>
                  <Pill tone="green">
                    Loyalty: {formatNpr(discountUsage.loyaltyNpr)}
                  </Pill>
                </div>
              </div>

              <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
                <div className="text-[12px] font-semibold text-slate-600">
                  Discount usage (count)
                </div>
                <div className="mt-[8px] flex flex-wrap gap-[8px]">
                  <Pill tone="orange">
                    {discountUsage.customerWholesaleCount} customer %
                  </Pill>
                  <Pill tone="green">{discountUsage.loyaltyCount} loyalty</Pill>
                  <Pill>{discountUsage.noneCount} none</Pill>
                </div>
              </div>

              <div className="rounded-[14px] border border-slate-200 p-[12px] bg-white">
                <div className="text-[12px] font-semibold text-slate-600">
                  Notes
                </div>
                <div className="text-[12px] text-slate-600 mt-[6px]">
                  Discount insights and payment distributions coming soon. No fabricated metrics are displayed.
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* Right side charts */}
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <PaymentDonut
              title="Payment distribution"
              subtitle="Cash vs eSewa recorded (sandbox) and others."
              data={paymentPie}
            />

            <PieChart
              title="Brand distribution"
              subtitle="Based on top products (qty share)."
              data={brandPie}
            />

            <div className="rounded-[14px] border border-slate-200 p-[12px] bg-slate-50/40">
              <div className="text-[13px] font-semibold text-slate-900">
                Why this helps
              </div>
              <div className="text-[12px] text-slate-700 mt-[6px]">
                Payments chart shows how much money is recorded digitally vs
                cash-in-hand. Brand chart shows which brands move the most.
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Tables row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-[14px]">
        {/* Top products */}
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="flex items-center justify-between gap-[10px] flex-wrap">
              <div>
                <div className="text-[15px] font-semibold text-slate-900">
                  Top products
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Best performing products in selected range.
                </div>
              </div>
              <Pill tone="sky">Table</Pill>
            </div>

            <div className="overflow-x-auto rounded-[14px] border border-slate-200">
              <table className="w-full min-w-[720px] text-left">
                <thead>
                  <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100 bg-slate-50/60">
                    <th className="px-[12px] py-[12px]">Product</th>
                    <th className="px-[12px] py-[12px]">SKU</th>
                    <th className="px-[12px] py-[12px]">Brand</th>
                    <th className="px-[12px] py-[12px]">Qty</th>
                    <th className="px-[12px] py-[12px]">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {topProducts.map((p) => (
                    <tr key={p.id} className="text-[14px] hover:bg-slate-50/60">
                      <td className="px-[12px] py-[14px] font-semibold text-slate-900">
                        {p.name}
                      </td>
                      <td className="px-[12px] py-[14px] text-slate-700">
                        {p.sku}
                      </td>
                      <td className="px-[12px] py-[14px]">
                        <Pill tone="neutral">{p.brand}</Pill>
                      </td>
                      <td className="px-[12px] py-[14px] text-slate-900 font-semibold">
                        {p.qty}
                      </td>
                      <td className="px-[12px] py-[14px] text-slate-900 font-semibold">
                        {formatNpr(p.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-[12px] text-slate-500">
              Later: add category breakdown and low-stock impact.
            </div>
          </div>
        </Card>

        {/* Cashier performance (kept) */}
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="flex items-center justify-between gap-[10px] flex-wrap">
              <div>
                <div className="text-[15px] font-semibold text-slate-900">
                  Cashier performance
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Sales and orders by cashier.
                </div>
              </div>
              <Pill tone="orange">RBAC</Pill>
            </div>

            <div className="overflow-x-auto rounded-[14px] border border-slate-200">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100 bg-slate-50/60">
                    <th className="px-[12px] py-[12px]">Cashier</th>
                    <th className="px-[12px] py-[12px]">Orders</th>
                    <th className="px-[12px] py-[12px]">Revenue</th>
                    <th className="px-[12px] py-[12px]">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cashiers.map((c) => {
                    const totalRev =
                      cashiers.reduce((a, x) => a + x.revenue, 0) || 1;
                    const share = (c.revenue / totalRev) * 100;

                    return (
                      <tr
                        key={c.id}
                        className="text-[14px] hover:bg-slate-50/60"
                      >
                        <td className="px-[12px] py-[14px] font-semibold text-slate-900">
                          {c.name}
                        </td>
                        <td className="px-[12px] py-[14px] text-slate-700 font-semibold">
                          {c.orders}
                        </td>
                        <td className="px-[12px] py-[14px] text-slate-900 font-semibold">
                          {formatNpr(c.revenue)}
                        </td>
                        <td className="px-[12px] py-[14px]">
                          <div className="flex items-center gap-[10px]">
                            <div className="h-[8px] flex-1 rounded-full bg-slate-100 overflow-hidden border border-slate-200">
                              <div
                                className="h-full bg-orange-500/70"
                                style={{
                                  width: `${Math.min(100, Math.max(0, share))}%`,
                                }}
                              />
                            </div>
                            <div className="text-[12px] font-semibold text-slate-700 w-[60px] text-right">
                              {formatPct(share)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="text-[12px] text-slate-500">
              Later: show void/override counts (Phase 2 audit analytics).
            </div>
          </div>
        </Card>
      </div>

      {/* Recent activity (kept) */}
      <Card>
        <div className="p-[16px] space-y-[10px]">
          <div className="flex items-center justify-between gap-[10px] flex-wrap">
            <div>
              <div className="text-[15px] font-semibold text-slate-900">
                Recent activity
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                This will come from audit logs later.
              </div>
            </div>
            <Button icon="history">View all</Button>
          </div>

          <div className="space-y-[8px]">
            {audit.map((a) => (
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
    </div>
  );
}
