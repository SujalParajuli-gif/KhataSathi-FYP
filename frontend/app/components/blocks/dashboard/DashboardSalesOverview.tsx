// frontend/app/components/blocks/dashboard/DashboardSalesOverview.tsx
import React, { useMemo } from "react";
import CardShell from "~/components/ui/CardShell";
import SectionTitle from "~/components/ui/SectionTitle";

export type RangeKey = "today" | "week" | "month";

function toFiniteNumber(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function DashboardSalesOverview({
  range,
  onRangeChange,
  salesBars,
}: {
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  salesBars: number[];
}) {
  const labels = useMemo(() => {
    return range === "today"
      ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]
      : range === "week"
        ? [
            "Mon",
            "Tue",
            "Wed",
            "Thu",
            "Fri",
            "Sat",
            "Sun",
            "W2",
            "W3",
            "W4",
            "W5",
            "W6",
          ]
        : [
            "W1",
            "W2",
            "W3",
            "W4",
            "W5",
            "W6",
            "W7",
            "W8",
            "W9",
            "W10",
            "W11",
            "W12",
          ];
  }, [range]);

  const safeBars = useMemo(() => {
    const cleaned = Array.isArray(salesBars)
      ? salesBars.map(toFiniteNumber)
      : [];
    const targetLen = labels.length;

    if (cleaned.length === targetLen) return cleaned;
    if (cleaned.length > targetLen) return cleaned.slice(0, targetLen);

    const padded = cleaned.slice();
    while (padded.length < targetLen) padded.push(0);
    return padded;
  }, [salesBars, labels.length]);

  const max = useMemo(() => {
    const m = safeBars.length ? Math.max(...safeBars) : 0;
    return Number.isFinite(m) ? m : 0;
  }, [safeBars]);

  const avg = useMemo(() => {
    if (!safeBars.length) return 0;
    const sum = safeBars.reduce((s, v) => s + v, 0);
    const a = Math.round(sum / safeBars.length);
    return Number.isFinite(a) ? a : 0;
  }, [safeBars]);

  const peakIndex = useMemo(() => {
    if (!safeBars.length) return 0;
    const idx = safeBars.findIndex((v) => v === max);
    return idx >= 0 ? idx : 0;
  }, [safeBars, max]);

  const yMaxPx = 200;

  return (
    <CardShell>
      <div className="px-[20px] py-[18px] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SectionTitle title="Sales Overview" />
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
            {range === "today"
              ? "Hourly"
              : range === "week"
                ? "Daily"
                : "Weekly"}
          </span>
        </div>

        <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/50">
          {(["today", "week", "month"] as RangeKey[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r)}
              className={`px-3 py-1.5 text-[11px] font-bold rounded-lg capitalize transition-all ${
                range === r
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
              aria-pressed={range === r}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="px-[20px] -mt-2 pb-[10px] flex flex-wrap items-center gap-2 text-[11px] font-bold">
        <span className="text-slate-500">
          Avg: <span className="text-slate-900">{avg}</span>
        </span>
        <span className="text-slate-300">•</span>
        <span className="text-slate-500">
          Peak: <span className="text-slate-900">{max}</span>{" "}
          <span className="text-slate-400">
            ({range === "today" ? "Slot" : range === "week" ? "Day" : "Week"}{" "}
            {peakIndex + 1})
          </span>
        </span>
        <span className="text-slate-300">•</span>
        <span className="text-slate-400">Hover a bar for value</span>
      </div>

      <div className="px-[20px] pb-[20px]">
        <div className="h-[240px] rounded-[16px] bg-slate-50/50 border border-dashed border-slate-200 p-4">
          <div className="relative h-[200px] flex items-end justify-between gap-2">
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-t border-slate-200/60" />
              ))}
            </div>

            {safeBars.map((h, idx) => {
              const safeH = toFiniteNumber(h);
              const pct = max <= 0 ? 0 : Math.round((safeH / max) * 100);
              const heightPx =
                max <= 0 ? 0 : Math.round((safeH / max) * yMaxPx);

              return (
                <div
                  key={idx}
                  className="relative flex-1 h-full flex flex-col justify-end"
                >
                  <div className="relative h-full flex items-end group">
                    <div
                      className={`w-full rounded-t-md transition-all duration-500 hover:opacity-90 ${
                        idx % 3 === 1 ? "bg-orange-500" : "bg-orange-200"
                      }`}
                      style={{ height: `${heightPx}px` }}
                      title={`${labels[idx]} • Value: ${safeH}`}
                      aria-label={`${labels[idx]} value ${safeH}`}
                    />

                    <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="rounded-xl bg-slate-900 text-white px-2.5 py-1.5 text-[11px] font-bold shadow-lg whitespace-nowrap">
                        {labels[idx]}: {safeH}{" "}
                        <span className="text-slate-300">({pct}%)</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 text-center text-[10px] font-bold text-slate-400 select-none">
                    {labels[idx]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </CardShell>
  );
}
