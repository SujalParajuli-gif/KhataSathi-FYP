import PaginationBar from "~/components/ui/PaginationBar";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { formatBillingMoney } from "~/lib/billingWorkspace";
import React, { useEffect, useRef, useState } from "react";
import Icon from "~/components/ui/Icon";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import BillingInvoicePreview from "./BillingInvoicePreview";
import { getCustomerInvoiceEventsApi, type CustomerInvoiceEventItem, type CustomerInvoiceEventsSummary } from "~/lib/api/endpoints";
import { shopToday } from "~/lib/billingWorkspace";
import type { CustomerOption } from "./BillingCustomerSummary";
import type { CartTableItem } from "./BillingCartTable";
export type HistoryNavigation = { scope: "INVOICES" | "CART_ITEMS"; payment: "ALL" | "OUTSTANDING"; revision: number; invoiceId?: string };
interface Props { selectedCustomer: CustomerOption | null; cart: CartTableItem[]; onReturnToBilling: () => void; onChangeCustomer: () => void; visible: boolean; navigation: HistoryNavigation; }
const TYPES = ["ALL", "PURCHASE", "RETURN", "REPLACEMENT"] as const;
export default function BillingPurchaseHistoryV2(p: Props) {
  const [scope, setScope] = useState<"INVOICES" | "CART_ITEMS">("INVOICES");
  const [payment, setPayment] = useState("ALL"); const [type, setType] = useState<typeof TYPES[number]>("ALL");
  const [search, setSearch] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [preset, setPreset] = useState("ALL"); const [page, setPage] = useState(1); const [pageSize,setPageSize]=useState(15);
  const [events, setEvents] = useState<CustomerInvoiceEventItem[]>([]); const [summary, setSummary] = useState<CustomerInvoiceEventsSummary | null>(null);
  const [total, setTotal] = useState(0); const [pages, setPages] = useState(1); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const cartIds = [...new Set(p.cart.map(line => line.productId))].sort().join(",");
  useEffect(() => { setScope(p.navigation.scope); setPayment(p.navigation.payment); setPage(1); setDetailId(p.navigation.invoiceId || null); }, [p.navigation.revision]);
  useEffect(() => { setPage(1); setDetailId(null); }, [p.selectedCustomer?.id]);
  useEffect(() => {
    if (!p.visible) return;
    const controller = new AbortController(); const version = ++request.current;
    if (!p.selectedCustomer?.id || (scope === "CART_ITEMS" && !cartIds)) { setEvents([]); setSummary(null); setTotal(0); setLoading(false); return; }
    setLoading(true); setError(null); setSummary(null);
    const timer = setTimeout(async () => {
      try {
        const result = await getCustomerInvoiceEventsApi(p.selectedCustomer!.id, { page, pageSize, q: search.trim() || undefined, type, paymentStatus: payment as any, from: from || undefined, to: to || undefined, productIds: scope === "CART_ITEMS" ? cartIds : undefined }, { signal: controller.signal });
        if (controller.signal.aborted || version !== request.current) return;
        if (page > Math.max(1, result.totalPages)) { setPage(Math.max(1, result.totalPages)); return; }
        setEvents(result.events); setSummary(result.summary); setTotal(result.total); setPages(Math.max(1, result.totalPages));
      } catch (e: any) { if (!controller.signal.aborted && version === request.current) setError(e?.message || "Could not load history. Your cart is preserved."); }
      finally { if (!controller.signal.aborted && version === request.current) setLoading(false); }
    }, search ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [p.visible, p.selectedCustomer?.id, cartIds, scope, search, type, payment, from, to, page, pageSize]);
  const reset = () => { setSearch(""); setFrom(""); setTo(""); setPreset("ALL"); setType("ALL"); setPayment("ALL"); setPage(1); };
  const choosePreset = (value: string) => { setPreset(value); setPage(1); if (value === "ALL") { setFrom(""); setTo(""); return; } const today = shopToday(); const date = new Date(`${today}T12:00:00Z`); if(value === "WEEK") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay()+6)%7)); else if(value === "MONTH") date.setUTCDate(1); else date.setUTCDate(date.getUTCDate() - (value === "7D" ? 6 : value === "30D" ? 29 : value === "6M" ? 182 : 0)); setFrom(date.toISOString().slice(0, 10)); setTo(today); };
  return <section className="billing-history" aria-label="Purchase History">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3"><div className="billing-history-title"><Icon name="history" sizePx={32}/><div><h1>Purchase History{p.selectedCustomer ? ` · ${p.selectedCustomer.name}` : ""}</h1><p className="mt-1 text-sm text-muted">This customer’s past purchases, returns and related invoices.</p></div></div><button type="button" onClick={p.onReturnToBilling} className="rounded-lg border border-control-line bg-white px-3 py-2 text-sm">Return to active cart</button></header>
    <div className="billing-history-scope-bar"><div className="billing-history-context"><p>{[p.selectedCustomer?.address,p.selectedCustomer?.phone,p.selectedCustomer?.panNo&&`PAN: ${p.selectedCustomer.panNo}`].filter(Boolean).join(" · ")||(!p.selectedCustomer?"Choose a customer to view history.":"")}</p><button type="button" className="billing-customer-action" onClick={p.onChangeCustomer}>Change customer</button></div>
    <div className="flex shrink-0 flex-wrap gap-2" role="tablist" aria-label="History scope">{(["INVOICES", "CART_ITEMS"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={scope === value} onClick={() => { setScope(value); setPage(1); }} className={`rounded-lg border border-control-line px-5 py-2 text-sm font-medium ${scope === value ? "bg-action text-white" : "bg-white"}`}>{value === "INVOICES" ? "Customer Invoices" : "Current Cart Items"}</button>)}</div>
    </div><div className="billing-history-results flex min-h-0 flex-col rounded-lg border border-line bg-white p-3">
      <div className="billing-history-filters">
       <div className="billing-history-date-group"><span>Date range</span><div><ProjectDateInput className="rounded-none border-0 bg-transparent shadow-none" aria-label="Start date" value={from} onChange={e=>{setFrom(e.target.value);setPreset("CUSTOM");setPage(1);}}/><span aria-hidden="true">–</span><ProjectDateInput className="rounded-none border-0 bg-transparent shadow-none" aria-label="End date" value={to} onChange={e=>{setTo(e.target.value);setPreset("CUSTOM");setPage(1);}}/></div></div>
       <div className="billing-history-preset-group"><span>Quick filters</span><div>{[["TODAY","Today"],["WEEK","This Week"],["MONTH","This Month"],["ALL","All Time"]].map(([value,label])=><button type="button" key={value} aria-pressed={preset===value} onClick={()=>choosePreset(value)}>{label}</button>)}</div></div>
       <label className="billing-history-search"><span>Search</span><input placeholder="Search invoices, products or notes…" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label>
       <label className="billing-history-payment"><span>Payment status</span><ProjectSelect aria-label="Payment filter" value={payment} onChange={e=>{setPayment(e.target.value);setPage(1);}}><option value="ALL">All payments</option><option value="PAID">Paid</option><option value="PARTIALLY_PAID">Partial</option><option value="UNPAID">Unpaid</option><option value="OUTSTANDING">Outstanding due</option></ProjectSelect></label>
       <button type="button" onClick={reset} className="billing-history-reset"><Icon name="restart_alt" sizePx={18}/>Reset</button>
      </div>
      <div className="my-3 flex shrink-0 flex-wrap items-center justify-between gap-2"><div className="flex gap-1">{TYPES.map(value => <button key={value} type="button" onClick={() => { setType(value); setPage(1); }} className={`billing-history-type ${type === value ? "is-active" : ""}`}>{({ ALL: "All", PURCHASE: "Purchases", RETURN: "Returns", REPLACEMENT: "Replacements" })[value]}</button>)}</div>
      </div>
      {summary && <div className="billing-history-stats"><div><span className="billing-stat-icon"><Icon name="description" sizePx={26}/></span><dl><dt>Matching records</dt><dd>{summary.totalEvents}</dd></dl></div><div><span className="billing-stat-icon"><Icon name="inventory_2" sizePx={26}/></span><dl><dt>Unique products</dt><dd>{summary.uniqueProducts}</dd></dl></div><div><span className="billing-stat-icon"><Icon name="calendar_month" sizePx={26}/></span><dl><dt>Latest purchase</dt><dd>{summary.latestPurchaseDate ? new Date(summary.latestPurchaseDate).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu" }) : "—"}</dd></dl></div></div>}
      <div className="billing-history-list">
        {loading ? <p className="p-8 text-center text-sm text-muted" role="status">Loading purchase history…</p> : error ? <p className="p-6 text-sm text-rose-700" role="alert">{error}</p> : !events.length ? <p className="p-10 text-center text-sm text-muted">{!p.selectedCustomer ? "Choose a customer to view history." : scope === "CART_ITEMS" && !cartIds ? "Add cart items to inspect their history." : "No records match these filters."}</p> : <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-inset text-xs text-muted"><tr><th className="p-2">Date</th><th className="p-2">Type</th><th className="p-2">Invoice / Ref</th><th className="p-2">{scope==="CART_ITEMS"?"Invoice items":"Items"}</th><th className="p-2 text-right">{scope === "CART_ITEMS" ? "Invoice total (रु)" : "Total (रु)"}</th><th className="p-2">Payment</th><th className="p-2">Method</th><th className="p-2">Note</th></tr></thead><tbody>{events.map(event => <tr key={event.id} className="border-b border-line hover:bg-inset">
        <td className="px-2 whitespace-nowrap"><strong>{new Date(event.date).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu" })}</strong><small className="billing-history-time">{new Date(event.date).toLocaleTimeString("en-GB",{timeZone:"Asia/Kathmandu",hour:"2-digit",minute:"2-digit"})}</small></td><td className="px-2"><span className={`billing-history-badge ${event.eventType === "RETURN" ? "bg-rose-50 text-rose-700" : event.eventType === "REPLACEMENT" ? "bg-violet-50 text-violet-700" : "bg-inset text-ink"}`}>{event.eventType.charAt(0)+event.eventType.slice(1).toLowerCase()}</span></td>
        <td className="px-2"><button type="button" onClick={() => setDetailId(event.invoiceId || event.id)} className="billing-invoice-link">{event.invoiceNo}</button></td><td className="px-2">{event.itemCount}</td>
        <td className="px-2 text-right whitespace-nowrap font-bold text-black">{event.totalAmount === null ? "Unavailable" : formatBillingMoney(event.totalAmount)}</td><td className="px-2"><span className={`billing-history-badge ${event.paymentStatus === "PAID" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-800"}`}>{({PAID:"Paid",PARTIALLY_PAID:"Partial",UNPAID:"Unpaid",PENDING:"Pending",CANCELLED:"Cancelled"} as Record<string,string>)[event.paymentStatus]||event.paymentStatus}</span>{event.eventType !== "RETURN" && (event.dueAmount === null ? <p className="mt-1 text-xs text-amber-800">Due needs review</p> : event.dueAmount > 0 ? <p className="mt-1 text-xs text-amber-800">Due {formatBillingMoney(event.dueAmount)}</p> : null)}</td><td className="px-2 text-xs">{event.paymentMethods.length?event.paymentMethods.map(m=><span className={`billing-method-badge ${m==="CASH"?"is-cash":""}`} key={m}><Icon name={m==="BANK_TRANSFER"?"account_balance":"payments"} sizePx={16}/>{({CASH:"Cash",BANK_TRANSFER:"Bank transfer",FONEPAY:"Fonepay",ESEWA:"eSewa"} as Record<string,string>)[m]||m.replaceAll("_"," ")}</span>):"—"}</td><td className="max-w-48 px-2 text-xs text-muted"><span className="line-clamp-2" title={event.notes || undefined}>{event.notes || "—"}</span></td>
        </tr>)}</tbody></table>}
      </div>
      <fieldset disabled={loading} aria-label="History pagination"><PaginationBar className="billing-history-pagination" page={page} totalPages={pages} total={total} start={(page-1)*pageSize} end={Math.min(page*pageSize,total)} label="records" pageSize={pageSize} pageSizeOptions={[10,15,25,50]} onPageChange={setPage} onPageSizeChange={value=>{setPageSize(value);setPage(1);}} showSinglePageControls/></fieldset>

    </div>
    <BillingInvoicePreview invoiceId={p.visible ? detailId : null} onClose={() => setDetailId(null)} />
  </section>;
}
