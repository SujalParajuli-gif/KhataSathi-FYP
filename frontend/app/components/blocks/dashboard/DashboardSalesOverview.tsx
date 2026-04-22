import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import CardShell from "~/components/ui/CardShell";
import SectionTitle from "~/components/ui/SectionTitle";
import { formatNpr } from "~/lib/invoices";

export type RangeKey = "today" | "week" | "month";

export type DashboardActivityPoint = {
  label: string;
  invoices: number;
  itemsSold: number;
  revenue: number;
};

function compact(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

// dynamically resizing the chart frame based on window/parent width changes
// recharts requires exact pixel dimensions sometimes to behave well in complex flex layouts
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
    <div className={className}>
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

// the dashboard sales overview component — shows an interactive chart of invoice activity
// it allows switching between "today", "week", and "month" views
export default function DashboardSalesOverview({
  range,
  onRangeChange,
  data,
  loading,
  error,
}: {
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  data: DashboardActivityPoint[];
  loading?: boolean;
  error?: string;
}) {
  // calculate total sums for the top summary stats row
  const totals = useMemo(() => {
    const totalInvoices = data.reduce((sum, point) => sum + point.invoices, 0);
    const totalItems = data.reduce((sum, point) => sum + point.itemsSold, 0);
    const totalRevenue = data.reduce((sum, point) => sum + point.revenue, 0);
    return {
      totalInvoices,
      totalItems,
      totalRevenue,
      averageInvoices: data.length
        ? Math.round(totalInvoices / data.length)
        : 0,
    };
  }, [data]);

  return (
    <CardShell className="overflow-hidden">
      <div className="px-[20px] py-[18px] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SectionTitle title="Invoice Activity" />
          <span className="text-[11px] font-bold text-slate-400 uppercase ">
            Operational
          </span>
        </div>

        <div className="flex rounded-xl border border-[#CFCFD3] bg-[#F3F4F6] p-1">
          {(["today", "week", "month"] as RangeKey[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r)}
              className={`px-3 py-1.5 text-[11px] font-bold rounded-lg capitalize transition-all ${
                range === r
                  ? "bg-white text-[#000000] "
                  : "text-[#8C8889] hover:text-[#000000]"
              }`}
              aria-pressed={range === r}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="px-[20px] -mt-2 pb-[20px] flex flex-wrap items-center gap-2 text-[11px] font-bold">
        <span className="text-slate-500">
          Avg invoices:{" "}
          <span className="text-slate-900">{totals.averageInvoices}</span>
        </span>
        <span className="text-slate-300">|</span>
        <span className="text-slate-500">
          Items sold:{" "}
          <span className="text-slate-900">{totals.totalItems}</span>
        </span>
        <span className="text-slate-300">|</span>
        <span className="text-slate-500">
          Revenue:{" "}
          <span className="text-slate-900">
            {formatNpr(totals.totalRevenue)}
          </span>
        </span>
      </div>

      <div className="px-[20px] pb-[30px]">
        {loading ? (
          <div className="h-[240px] animate-pulse rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70" />
        ) : error ? (
          <div className="h-[240px] rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-6 text-[13px] font-semibold text-rose-700">
            {error}
          </div>
        ) : data.length === 0 ? (
          <div className="h-[240px] rounded-[16px] border border-dashed border-[#CFCFD3] bg-[#F3F4F6]/70 px-4 py-6 text-[13px] font-semibold text-[#8C8889]">
            No invoice activity was recorded for this range.
          </div>
        ) : (
          <SafeChartFrame className="h-[240px] rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/55 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 8, right: 18, left: 0, bottom: 8 }}
              >
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickLine={{ stroke: "#cbd5e1" }}
                />
                <YAxis
                  yAxisId="count"
                  tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickLine={{ stroke: "#cbd5e1" }}
                />
                <YAxis
                  yAxisId="items"
                  orientation="right"
                  tickFormatter={(value) => compact(value)}
                  tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickLine={{ stroke: "#cbd5e1" }}
                />
                <Tooltip
                  content={({ active, payload, label }) =>
                    active && payload?.[0]?.payload ? (
                      <div className="rounded-[14px] border border-slate-200 bg-white px-3 py-2 ">
                        <div className="text-[12px] font-extrabold text-slate-900">
                          {label}
                        </div>
                        <div className="mt-1 text-[12px] font-semibold text-slate-600">
                          Invoices: {payload[0].payload.invoices}
                        </div>
                        <div className="text-[12px] font-semibold text-slate-600">
                          Items sold: {payload[0].payload.itemsSold}
                        </div>
                        <div className="text-[12px] font-semibold text-slate-600">
                          Revenue: {formatNpr(payload[0].payload.revenue)}
                        </div>
                      </div>
                    ) : null
                  }
                />
                <Legend
                  wrapperStyle={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#475569",
                  }}
                />
                <Bar
                  yAxisId="count"
                  dataKey="invoices"
                  name="Invoices"
                  fill="#11120d"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={26}
                />
                <Line
                  yAxisId="items"
                  type="monotone"
                  dataKey="itemsSold"
                  name="Items sold"
                  stroke="#179b4d"
                  strokeWidth={3}
                  dot={{ r: 3, fill: "#179b4d" }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </SafeChartFrame>
        )}
      </div>
    </CardShell>
  );
}
