import { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import PurchaseDocuments from "./PurchaseDocuments";
import { purchaseError } from "~/lib/api/purchases";
import { getBillReview, extractBill, saveBillReview, billCandidates, billDuplicates, type CorrectedBill, type ReviewResponse, type Candidate, type Duplicate } from "~/lib/api/purchaseReview";

function CandidatePicker({ source, q, kind, selected, onSelect, disabled }: { source: string; q: string; kind: "supplier" | "product"; selected: string | null; onSelect: (id: string | null) => void; disabled: boolean }) {
  const [rows, setRows] = useState<Candidate[]>([]); const [error, setError] = useState("");
  useEffect(() => { const c = new AbortController(); setRows([]); setError("");
    billCandidates(source, q, kind, c.signal).then(r => { if (!c.signal.aborted) setRows(r); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }); return () => c.abort();
  }, [source, q, kind]);
  return <div className="space-y-1"><p className="text-xs text-muted">{rows.length > 1 ? "Multiple candidates — choose explicitly" : "Candidate only — no automatic match"}</p>
    <ProjectSelect aria-label={`Choose ${kind}`} value={selected || ""} disabled={disabled} onChange={e => onSelect(e.target.value || null)}><option value="">Unresolved</option>{selected && !rows.some(r => r.id === selected) && <option value={selected}>Selected identity ({selected})</option>}{rows.map(r => <option key={r.id} value={r.id}>{r.name}{r.sku ? ` · ${r.sku}` : ""}</option>)}</ProjectSelect>
    {kind === "product" && rows.filter(r => r.id === selected).map(r => <p key={r.id} className="text-xs text-muted">Catalog unit: {r.saleUnit}; package: {r.packageQuantity ?? "unknown"} {r.packageUnit}. No conversion is inferred from reader text.</p>)}
    {error && <p role="alert" className="text-xs">{error}</p>}</div>;
}

export default function PurchaseBillReview({ onClose }: { onClose: () => void }) {
  const [ids, setIds] = useState<string[]>([]); const [id, setId] = useState("");
  const [response, setResponse] = useState<ReviewResponse | null>(null); const [draft, setDraft] = useState<CorrectedBill | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0); const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const generation = useRef(0); const request = useRef<AbortController | null>(null); const frozen = useRef<{ id: string; key: string; revision: string | null } | null>(null);
  function apply(r: ReviewResponse) { setResponse(r); const v = r.review; setDraft(v ? v.corrected || { ...v.observations, supplierId: null, lines: v.observations.lines.map(l => ({ ...l, productId: null })) } : null); setReplaceConfirmed(false); }
  useEffect(() => {
    const current = ++generation.current; request.current?.abort(); const c = new AbortController(); request.current = c;
    setResponse(null); setDraft(null); setDuplicates([]); setError(""); setNotice(""); setBusy(false); frozen.current = null;
    if (id) { setBusy(true); getBillReview(id, c.signal).then(r => { if (!c.signal.aborted && current === generation.current) apply(r); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }).finally(() => { if (!c.signal.aborted) setBusy(false); }); }
    return () => { c.abort(); generation.current++; };
  }, [id, reload]);
  useEffect(() => { const c = new AbortController(); setDuplicates([]); if (id && response?.review) billDuplicates(id, c.signal).then(r => { if (!c.signal.aborted) setDuplicates(r); }).catch(e => { if (!c.signal.aborted) setError(purchaseError(e)); }); return () => c.abort(); }, [id, response?.review?.revision]);
  async function mutate(kind: "extract" | "save") {
    if (busy || !response || (kind === "save" && (!draft || !response.review))) return;
    setBusy(true); setError(""); setNotice(""); const current = generation.current; const c = new AbortController(); request.current = c;
    try {
      if (kind === "extract" && !frozen.current) frozen.current = { id, key: crypto.randomUUID(), revision: response.review?.revision || null };
      const r = kind === "extract" ? await extractBill(id, frozen.current!.key, frozen.current!.revision, c.signal) : await saveBillReview(id, response.review!.revision, draft!, c.signal);
      if (!c.signal.aborted && current === generation.current) { apply(r); frozen.current = null; setNotice(kind === "save" ? "Review saved. No stock, payment or receipt was posted." : "Read complete. Correct uncertain values and choose identities explicitly."); }
    } catch (e) { if (!c.signal.aborted && current === generation.current) setError(purchaseError(e)); }
    finally { if (!c.signal.aborted && current === generation.current) setBusy(false); }
  }
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";
  const value = (v: string) => v.trim() || null;
  return <ModalFrame open onClose={onClose} title="Review purchase bill" description="Reading and saving a review never posts stock or payments." maxWidthClass="max-w-6xl" footer={<div className="flex flex-wrap justify-end gap-3"><button type="button" onClick={onClose}>Close</button><button type="button" disabled={!draft || busy} className="rounded-lg bg-action px-4 py-2 text-white disabled:opacity-50" onClick={() => void mutate("save")}>Save review</button></div>}>
    <div className="space-y-4">
      <PurchaseDocuments ids={ids} disabled={busy} onChange={next => { setIds(next); if (!next.includes(id)) setId(next[0] || ""); }} />
      {ids.length > 0 && <label className="block">Source to review<ProjectSelect aria-label="Review source" disabled={busy} value={id} onChange={e => setId(e.target.value)}>{ids.map(v => <option key={v} value={v}>{v}</option>)}</ProjectSelect></label>}
      {response && <div className="flex flex-wrap items-center gap-3"><button type="button" className="rounded-lg border border-line px-3 py-2" disabled={busy || !!response.review && !replaceConfirmed && !frozen.current} onClick={() => void mutate("extract")}>{frozen.current ? "Retry same read" : response.review ? "Read again" : "Read bill"}</button>{response.review && <label className="text-sm"><input type="checkbox" checked={replaceConfirmed} disabled={busy} onChange={e => setReplaceConfirmed(e.target.checked)} /> Reading again replaces this draft; prior saved evidence remains audited.</label>}
        <button type="button" disabled={busy} className="text-sm underline" onClick={() => { if (!draft || window.confirm("Reload current review and discard unsaved edits?")) setReload(v => v + 1); }}>Reload saved review</button></div>}
      {busy && <p role="status">Working… your source is retained.</p>}{error && <p role="alert" className="text-sm text-error">{error} Your edits are preserved.</p>}{notice && <p role="status">{notice}</p>}
      {response && <div className="grid min-w-0 gap-4 lg:grid-cols-2"><section className="min-w-0 space-y-3"><h3 className="font-semibold">Source: {response.document.title}</h3>{response.document.mimeType === "application/pdf" ? <iframe title="Purchase bill source" src={response.document.fileUrl} className="h-[500px] w-full rounded-lg border border-line" /> : <img alt="Purchase bill source" src={response.document.fileUrl} className="max-h-[600px] w-full rounded-lg border border-line object-contain" />}
        {response.review && <><p className="text-xs text-muted">Untrusted reader observations · {response.review.model} · {new Date(response.review.extractedAt).toLocaleString()}</p><details><summary>Original extracted observations</summary><pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-inset p-3 text-xs">{JSON.stringify(response.review.observations, null, 2)}</pre></details></>}</section>
        <section className="min-w-0 space-y-4"><h3 className="font-semibold">Human review</h3>{!draft ? <p>Read this source to begin. Missing fields and matches remain unresolved.</p> : <fieldset disabled={busy} className="space-y-3">
          {!!response.review?.warnings.length && <ul className="list-inside list-disc rounded-lg bg-inset p-3 text-sm">{response.review.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          <label className="block">Supplier text<input aria-label="Reviewed supplier text" className={field} value={draft.supplierName || ""} maxLength={300} onChange={e => setDraft({ ...draft, supplierName: value(e.target.value) })} /></label><CandidatePicker source={id} kind="supplier" q={draft.supplierName || ""} selected={draft.supplierId} disabled={busy} onSelect={v => setDraft({ ...draft, supplierId: v })} />
          <label className="block">Bill reference<input aria-label="Reviewed bill reference" className={field} value={draft.billNumber || ""} maxLength={300} onChange={e => setDraft({ ...draft, billNumber: value(e.target.value) })} /></label>
          <label className="block">Bill date<ProjectDateInput aria-label="Reviewed bill date" value={draft.billDate || ""} onChange={e => setDraft({ ...draft, billDate: value(e.target.value) })} /></label>
          <label className="block">Printed payable (NPR)<input aria-label="Reviewed payable" className={field} inputMode="decimal" value={draft.payable || ""} maxLength={60} onChange={e => setDraft({ ...draft, payable: value(e.target.value) })} /></label>
          {draft.lines.map((l, i) => <div key={i} className="space-y-2 rounded-lg border border-line p-3"><label>Line {i + 1} text<input aria-label={`Reviewed line ${i + 1} name`} className={field} value={l.name} maxLength={300} onChange={e => setDraft({ ...draft, lines: draft.lines.map((v, j) => j === i ? { ...v, name: e.target.value, productId: null } : v) })} /></label>
            <label>Printed code<input aria-label={`Reviewed line ${i + 1} code`} className={field} value={l.code || ""} maxLength={300} onChange={e => setDraft({ ...draft, lines: draft.lines.map((v, j) => j === i ? { ...v, code: value(e.target.value), productId: null } : v) })} /></label><CandidatePicker source={id} kind="product" q={l.code || l.name} selected={l.productId} disabled={busy} onSelect={v => setDraft({ ...draft, lines: draft.lines.map((x, j) => j === i ? { ...x, productId: v } : x) })} />
            <div className="grid gap-2 sm:grid-cols-3">{(["unit", "quantity", "cost"] as const).map(k => <label key={k} className="text-sm">{k}<input aria-label={`Reviewed line ${i + 1} ${k}`} className={field} value={l[k] || ""} maxLength={k === "unit" ? 300 : 60} onChange={e => setDraft({ ...draft, lines: draft.lines.map((v, j) => j === i ? { ...v, [k]: value(e.target.value) } : v) })} /></label>)}</div>
            <button type="button" className="text-sm underline" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>Remove observation {i + 1}</button></div>)}
          <button type="button" disabled={draft.lines.length >= 100} className="text-sm underline" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { name: "", code: null, unit: null, quantity: null, cost: null, productId: null }] })}>Add missing line</button>
          <p className="text-sm text-muted">Unresolved identities, dates and amounts can be saved. This is a review draft, not posting authority.</p>
        </fieldset>}
        <aside className="rounded-lg border border-line bg-inset p-3"><h4 className="font-semibold">Possible existing receipts</h4><p className="text-xs text-muted">Candidates use saved review/reference and source identity. No automatic link or duplicate posting.</p>{duplicates.map(d => <p key={d.id} className="mt-2 text-sm">{d.billNumber || "Reference unknown"} · {d.supplierName || "Supplier text unknown"} · {d.reason}{d.knownPayable ? "" : " · legacy financial authority unknown"}<br />Receipt {d.id}</p>)}{!duplicates.length && <p className="mt-2 text-sm">No candidates found; this does not prove uniqueness.</p>}</aside>
        </section></div>}
    </div>
  </ModalFrame>;
}
