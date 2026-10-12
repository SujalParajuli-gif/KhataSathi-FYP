export type DrawerCashBasis = {
  kind: "CURRENT_SOURCE_ROWS" | "CLOSED_CAPTURE";
  asOf: string;
  legacyCashRefundCount: number | null;
};

export default function CashDrawerBasis({ basis, compact = false }: { basis?: DrawerCashBasis; compact?: boolean }) {
  return <div className="mt-3 space-y-1 text-xs leading-relaxed text-muted">
    <p>{basis?.kind === "CURRENT_SOURCE_ROWS" ? "Current source totals" : basis?.kind === "CLOSED_CAPTURE" ? "Saved closing totals; later changes are not recalculated." : "Cash basis unavailable; these figures are not verified current totals."}</p>
    {!compact && <><p>Opening float + recorded cash charges + cash in − cash out. Customer credit transfers add no cash.</p>
    <p>Legacy refunds are not deducted automatically: a manual cash-out may already record the handover. Historical cash attribution remains unverified.</p></>}
    {!!basis?.legacyCashRefundCount && <p>{basis.legacyCashRefundCount} recorded cash refund {basis.legacyCashRefundCount === 1 ? "entry" : "entries"} in this cashier period; drawer attribution is unknown.</p>}
  </div>;
}
