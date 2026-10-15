import { formatBillingMoney } from "~/lib/billingWorkspace";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { latestComparablePurchase } from "~/lib/billingWorkspace";
import type { CustomerProductPurchaseHistoryItem } from "~/lib/api/endpoints";
import type { CartTableItem } from "./BillingCartTable";
interface Props { open: boolean; onClose: () => void; item: CartTableItem | null; pastPurchases: CustomerProductPurchaseHistoryItem[]; anchor?: HTMLElement | null; onApplyPastPrice?: (price: number) => void; }
export default function BillingPriceDifferPopover(p: Props) {
  const panel = useRef<HTMLDivElement>(null); const [position, setPosition] = useState({top: 80, left: 20});
  const latest = latestComparablePurchase(p.pastPurchases, p.item?.saleUnit);
  const close = (restore = false) => { p.onClose(); if (restore) p.anchor?.focus(); };
  useEffect(() => {
    if (!p.open) return;
    const place = () => { const rect = p.anchor?.getBoundingClientRect(); if (!rect) return; const height = panel.current?.offsetHeight || 220; setPosition({ left: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 352)), top: Math.max(12, Math.min(rect.top > height + 12 ? rect.top - height - 8 : rect.bottom + 8, window.innerHeight - height - 12)) }); };
    place(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node) && !p.anchor?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", key, true); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [p.open, p.anchor]);
  if (!p.open || !p.item || typeof document === "undefined") return null;
  const delta = latest ? p.item.appliedUnitPrice - latest.appliedUnitPrice : 0;
  return createPortal(<div ref={panel} role="dialog" aria-modal="false" aria-label="Unit price comparison" style={{...position, width:"min(340px, calc(100vw - 24px))"}} className="fixed z-[80] rounded-xl border border-line bg-white p-4 text-sm text-ink shadow-lg">
    <header className="mb-3 flex items-start justify-between gap-3"><div><h2 className="font-semibold">Unit price comparison</h2><p className="mt-1 text-xs text-muted">{p.item.name}</p></div><button type="button" aria-label="Close price comparison" onClick={() => close(true)} className="h-7 w-7 rounded-md hover:bg-inset">×</button></header>
    <dl className="space-y-2"><div className="flex justify-between gap-3"><dt>Current cart rate</dt><dd className="font-medium">{formatBillingMoney(p.item.appliedUnitPrice)}</dd></div><div className="flex justify-between gap-3"><dt>Last purchased</dt><dd>{latest ? formatBillingMoney(latest.appliedUnitPrice) : "No comparable rate"}</dd></div></dl>
    {latest && <><p className="mt-2 text-xs text-muted">{latest.invoiceDate ? new Date(latest.invoiceDate).toLocaleDateString("en-GB",{timeZone:"Asia/Kathmandu"}) : "Date unavailable"} · {latest.saleUnit || "Historical unit not captured"}</p><p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{delta === 0 ? "Same as the last purchased rate." : `${formatBillingMoney(Math.abs(delta))} ${delta > 0 ? "higher" : "lower"} per ${p.item.saleUnit || "unit"}.`} Historical rates are advisory.</p>{p.onApplyPastPrice && delta !== 0 && <button type="button" onClick={() => { p.onApplyPastPrice!(latest.appliedUnitPrice); p.onClose(); }} className="mt-3 rounded-lg border border-control-line px-3 py-2 text-xs font-medium">Request this rate through price override</button>}</>}
  </div>, document.body);
}
