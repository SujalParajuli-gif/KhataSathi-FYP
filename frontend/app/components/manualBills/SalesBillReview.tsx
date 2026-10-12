import { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import { getAuthUser } from "~/lib/auth";
import { fetchSalesEvidenceBlob, type SalesEvidenceRecord } from "~/lib/api/manualBills";
import { getSalesReview, extractSalesReview, saveSalesReview, salesMatches, type CorrectedSale, type Matches, type ReviewResponse, type SalesMatch } from "~/lib/api/salesReview";

const blank = (): CorrectedSale => ({ billNumber: null, customerName: null, billDate: null, total: null, lines: [] });
const errorText = (e: any) => e?.response?.data?.error || "The request could not be confirmed. Your entered corrections are retained. Refresh the saved review before retrying.";
const fieldClass = "min-h-11 w-full rounded-xl border border-control-line bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";
const buttonClass = "min-h-11 rounded-xl border border-control-line px-3 py-2 text-sm font-semibold hover:bg-control-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";

export default function SalesBillReview({ document, onClose, onDecision }: { document: SalesEvidenceRecord; onClose: () => void;
  onDecision: (kind: "attach" | "create" | "archive", document: SalesEvidenceRecord, corrected: CorrectedSale, candidate?: SalesMatch) => void }) {
  const [current, setCurrent] = useState<ReviewResponse | null>(null), [form, setForm] = useState<CorrectedSale>(blank);
  const [busy, setBusy] = useState("loading"), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [url, setUrl] = useState(""), [previewError, setPreviewError] = useState("");
  const [matches, setMatches] = useState<Matches | null>(null), [query, setQuery] = useState(""), [lineIndex, setLineIndex] = useState(0), [rebase, setRebase] = useState(false);
  const alive = useRef(true), pendingRead = useRef<{ operationKey: string; expectedRevision: string | null } | null>(null);
  const baseline: CorrectedSale = current?.review?.corrected || (current?.review ? { ...current.review.observations, lines: current.review.observations.lines.map(l => ({ ...l, productId: null })) } : blank());
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const editable = current?.document.saleRecoveryStatus === "UNRESOLVED";
  const ready = !!current?.review?.corrected && !dirty && !rebase && editable && !busy;
  const decisionReady = ready && !!matches;
  const manager = getAuthUser()?.role?.toUpperCase() === "MANAGER";
  async function load(preserve: boolean) {
    setBusy("loading"); setError("");
    try {
      const next = await getSalesReview(document.id);
      if (!alive.current) return;
      setCurrent(next); setMatches(null); pendingRead.current = null;
      if (preserve) { setRebase(true); setNotice("Current saved review and outcome loaded. Compare the raw observations, then explicitly keep your entered edits or use the saved corrections."); }
      else setForm(next.review?.corrected || (next.review ? { ...next.review.observations, lines: next.review.observations.lines.map(l => ({ ...l, productId: null })) } : blank()));
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(""); }
  }
  useEffect(() => {
    alive.current = true; void load(false); let released = false, objectUrl = "";
    fetchSalesEvidenceBlob(document.id, "file").then(blob => {
      if (released) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (!released) setPreviewError("Source preview is unavailable. Close and reopen to retry; saved corrections remain available."); });
    return () => { alive.current = false; released = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [document.id]);
  async function read() {
    if (!current || dirty || rebase) return;
    setBusy("reading"); setError(""); setNotice("");
    const input = pendingRead.current || { operationKey: crypto.randomUUID(), expectedRevision: current.review?.revision || null }; pendingRead.current = input;
    try {
      const next = await extractSalesReview(document.id, input); if (!alive.current) return;
      setCurrent(next); setForm(next.review?.corrected || { ...next.review!.observations, lines: next.review!.observations.lines.map(l => ({ ...l, productId: null })) });
      setMatches(null); pendingRead.current = null; setNotice("Untrusted observations read. Correct every uncertain field and choose products yourself before saving.");
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(""); }
  }
  async function save() {
    if (!current || rebase) return; setBusy("saving"); setError(""); setNotice("");
    try {
      const next = await saveSalesReview(document.id, current.review?.revision || null, form); if (!alive.current) return;
      setCurrent(next); setForm(next.review!.corrected!); setMatches(null); pendingRead.current = null; setNotice("Human corrections saved. No sale, stock or payment was posted.");
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(""); }
  }
  async function find(q?: string) {
    setBusy("matching"); setError("");
    try { const result = await salesMatches(document.id, q); if (alive.current) setMatches(result); }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(""); }
  }
  function lineEdit(index: number, key: string, value: string | null) { setForm(v => ({ ...v, lines: v.lines.map((l, i) => i === index ? { ...l, [key]: value } : l) })); }
  function decide(kind: "attach" | "create" | "archive", candidate?: SalesMatch) { if (decisionReady && current) onDecision(kind, current.document, form, candidate); }
  return <ModalFrame open title="Review sales bill" maxWidthClass="max-w-6xl" mobileFullScreen onClose={() => {
    if (busy) return; if (!dirty || window.confirm("Discard unsaved corrections and close this review?")) onClose();
  }} description="Read the retained source, correct printed facts, compare possible sales, then choose a human-reviewed outcome.">
    <div className="space-y-4 text-left">
      <p className="text-sm text-secondary">OCR suggestions never authorize posting or establish tax, payment or product identity. Unknown facts may stay blank. The source has no verified exact-region coordinates.</p>
      {error && <p role="alert" className="rounded-xl border border-control-line p-3 text-sm">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {busy && <p role="status" className="text-sm">{busy === "reading" ? "Reading the source; manual corrections remain separate…" : `${busy}…`}</p>}
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <section className="min-w-0 space-y-2" aria-label="Retained source">
          <h3 className="font-semibold">{document.title || document.fileName}</h3>
          {previewError && <p role="alert" className="text-sm">{previewError}</p>}
          {url && (document.mimeType === "application/pdf" ? <iframe title="Sales bill PDF" src={url} className="h-[55vh] w-full rounded-xl border border-control-line" /> : <img alt="Retained sales bill source" src={url} className="max-h-[65vh] w-full rounded-xl border border-control-line object-contain" />)}
          {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm underline">Open full source in a new tab</a>}
          {current?.review && <details className="rounded-xl border border-control-line p-3"><summary className="min-h-10 cursor-pointer font-semibold">Raw observations ({current.review.model})</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify(current.review.observations, null, 2)}</pre></details>}
        </section>
        <section aria-label="Human corrections" className="min-w-0 space-y-3">
          <h3 className="font-semibold">Human corrections</h3>
          {current && <p className="text-sm">Current source outcome: {current.document.saleRecoveryStatus}. {!editable && "Review is retained; this source cannot be edited or resolved again."}</p>}
          <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!editable || !!busy || dirty || rebase} onClick={read}>{current?.review ? "Read again (keep saved corrections)" : "Read bill with OCR"}</button><button type="button" className={buttonClass} disabled={!!busy} onClick={() => load(!!current)}>Refresh saved review and outcome</button></div>
          {rebase && <div className="space-y-2 rounded-xl border border-control-line p-3"><p className="text-sm">Your entered corrections are still here. Review the refreshed facts before saving over the current revision.</p><div className="flex flex-wrap gap-2"><button className={buttonClass} onClick={() => { setRebase(false); setNotice("Entered edits kept against the refreshed revision. Review them before saving."); }}>Keep my entered edits</button><button className={buttonClass} onClick={() => { setForm(baseline); setRebase(false); }}>Use saved corrections</button></div></div>}
          <fieldset disabled={!editable || !!busy || rebase} className="space-y-3 disabled:opacity-70">
            <div className="grid gap-3 sm:grid-cols-2">{([['billNumber', 'Printed bill reference'], ['customerName', 'Printed customer name'], ['total', 'Printed total (NPR)']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-sm"><span>{label}</span><input className={fieldClass} value={form[key] || ""} onChange={e => setForm(v => ({ ...v, [key]: e.target.value || null }))} maxLength={key === "total" ? 60 : 300} inputMode={key === "total" ? "decimal" : undefined} /></label>)}<label className="space-y-1 text-sm"><span>Explicit Gregorian bill date</span><ProjectDateInput aria-label="Explicit Gregorian bill date" value={form.billDate || ""} onChange={e => setForm(v => ({ ...v, billDate: e.target.value || null }))} /></label></div>
            {form.lines.map((line, i) => <div key={i} className="space-y-2 rounded-xl border border-control-line p-3"><h4 className="font-semibold">Line {i + 1}</h4><div className="grid gap-2 sm:grid-cols-2">{([['name', 'Printed item name'], ['code', 'Printed item code'], ['unit', 'Printed unit'], ['quantity', 'Printed quantity'], ['unitPrice', 'Printed unit price']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-sm"><span>{label}</span><input aria-label={`${label} line ${i + 1}`} className={fieldClass} value={line[key] || ""} maxLength={key === "quantity" || key === "unitPrice" ? 60 : 300} onChange={e => lineEdit(i, key, key === "name" ? e.target.value : e.target.value || null)} /></label>)}</div><p className="break-all text-sm">Chosen product: {line.productId || "Unresolved; no product is selected"}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={() => { setLineIndex(i); setQuery(line.code || line.name); void find(line.code || line.name); }}>Find product for line {i + 1}</button><button type="button" className={buttonClass} onClick={() => lineEdit(i, "productId", null)}>Leave product unresolved</button><button type="button" className={buttonClass} onClick={() => setForm(v => ({ ...v, lines: v.lines.filter((_, n) => n !== i) }))}>Remove line {i + 1}</button></div></div>)}
            <button type="button" className={buttonClass} disabled={form.lines.length >= 100} onClick={() => setForm(v => ({ ...v, lines: [...v.lines, { name: "", code: null, unit: null, quantity: null, unitPrice: null, productId: null }] }))}>Add printed line manually</button>
            <button type="button" className={`${buttonClass} ml-2 bg-action text-white`} onClick={save}>Save human corrections</button>
          </fieldset>
          {!!matches?.products.length && <div className="space-y-2"><h4 className="font-semibold">Product suggestions for line {lineIndex + 1}</h4><p className="text-sm">Compare brand, unit and pack. Suggestions never select a product for you.</p>{matches.products.map(p => <button key={p.id} type="button" disabled={!editable || !!busy || !form.lines[lineIndex]} className={`${buttonClass} block w-full text-left`} onClick={() => lineEdit(lineIndex, "productId", p.id)}>{p.name} · {p.sku || "No code"} · {p.brand.name} · {p.saleUnit} / {p.packageQuantity || "unknown pack"} {p.packageUnit}</button>)}</div>}
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void find(query); }}><input aria-label="Product search for selected line" className={fieldClass} value={query} onChange={e => setQuery(e.target.value)} maxLength={160} /><button className={buttonClass} disabled={!!busy || !editable || !form.lines[lineIndex]}>Search products</button></form>
        </section>
      </div>
      <section className="space-y-3 border-t border-control-line pt-4" aria-label="Possible sales and outcomes">
        <h3 className="font-semibold">Compare possible existing sales</h3><p className="text-sm">Save your corrections before comparing or choosing an outcome. Printed prices are observations; protected checkout recalculates and requires a separate human payment assessment.</p>
        <button type="button" className={buttonClass} disabled={!ready} onClick={() => find()}>Compare saved review with sales</button>
        {matches && <><p className="text-sm">{matches.warning}</p>{!matches.searched && <p className="text-sm">No search signals saved. Add an explicit reference, customer, date, total or chosen product; no missing-sale conclusion is available.</p>}{matches.searched && !matches.candidates.length && <p className="text-sm">No candidates in this bounded search. This does not establish that the sale is missing.</p>}{matches.duplicates.map(d => <p key={d.id} role="status" className="break-words text-sm">Possible duplicate source: {d.title || d.fileName} ({d.saleRecoveryStatus}){d.linkedEntityId && ` · linked sale ${d.linkedEntityId}`}. Compare the retained proof before any decision.</p>)}{matches.candidates.map(c => <article key={c.id} className="space-y-1 rounded-xl border border-control-line p-3 text-sm"><h4 className="font-semibold">{c.invoiceNo} · NPR {c.netTotal}</h4><p>{c.customerName || "Unknown customer"} · {c.externalBillNo || "No printed reference"} · {c.externalBillDate || "No printed date"}</p><p>{c.warning}</p>{c.differences.map(d => <p key={d}>{d}</p>)}<button type="button" className={buttonClass} disabled={!ready || !c.eligible} onClick={() => decide("attach", c)}>Review attachment to {c.invoiceNo}</button></article>)}</>}
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!decisionReady} onClick={() => decide("attach")}>Open existing attach review</button><button type="button" className={buttonClass} disabled={!decisionReady || !manager} onClick={() => decide("create")}>Review missing-sale checkout (manager)</button><button type="button" className={buttonClass} disabled={!decisionReady} onClick={() => decide("archive")}>Review archive without posting</button></div>
        {!manager && <p className="text-sm">A manager must perform missing-sale checkout. Administrative review does not bypass checkout permissions.</p>}
      </section>
    </div>
  </ModalFrame>;
}
