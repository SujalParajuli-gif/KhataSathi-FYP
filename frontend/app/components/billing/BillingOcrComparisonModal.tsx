import { formatBillingMoney } from "~/lib/billingWorkspace";
import Icon from "~/components/ui/Icon";
import React, { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import { scanBillPreviewApi, type BillScanObservations } from "~/lib/api/manualBills";
import { compareBillLines, observationNumber } from "~/lib/billComparison";
import { validPaperDate } from "~/lib/billingWorkspace";

import type { CartTableItem } from "./BillingCartTable";
interface Props {
  presentation?: "default" | "billing";
  open: boolean; onClose: () => void; cart: CartTableItem[]; payableTotal: number | null;
  currentBillNo: string; currentBillDate: string; onApplyReference: (billNo: string, billDate: string) => void;
  sourceFile?: File | null; sourceObservations?: BillScanObservations | null; fingerprint?: string; savedSale?: boolean;
  onRetainSource?: (file: File, observations: BillScanObservations | null, checked: boolean, fingerprint: string) => void;
}
export default function BillingOcrComparisonModal(p: Props) {
  const [zoom,setZoom]=useState(100);
  const [picked, setPicked] = useState<File | null>(null); const file = p.sourceFile || picked;
  const [observations, setObservations] = useState<BillScanObservations | null>(p.sourceObservations || null);
  const [scanning, setScanning] = useState(false); const [error, setError] = useState<string | null>(null); const [url, setUrl] = useState<string | null>(null);
  const [checkedFingerprint, setCheckedFingerprint] = useState<string | null>(null); const generation = useRef(0);
  const fingerprint = p.fingerprint || JSON.stringify([p.cart, p.payableTotal, p.currentBillNo, p.currentBillDate]);
  useEffect(() => { if (!file) { setUrl(null); return; } const objectUrl = URL.createObjectURL(file); setUrl(objectUrl); return () => URL.revokeObjectURL(objectUrl); }, [file]);
  useEffect(() => {
    if (!p.open || !file) return;
    const controller = new AbortController(); const version = ++generation.current;
    setCheckedFingerprint(null); setError(null);
    if (p.sourceObservations) { setObservations(p.sourceObservations); setScanning(false); return; }
    setObservations(null); setScanning(true); p.onRetainSource?.(file, null, false, fingerprint);
    scanBillPreviewApi(file, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || version !== generation.current) return;
      setObservations(result.observations); p.onRetainSource?.(file, result.observations, false, fingerprint);
    }).catch(e => { if (!controller.signal.aborted && version === generation.current) setError(e?.message || "OCR could not read this bill. Compare the original manually."); })
      .finally(() => { if (!controller.signal.aborted && version === generation.current) setScanning(false); });
    return () => controller.abort();
  }, [p.open, file]);
  useEffect(() => { setCheckedFingerprint(null); if (file) p.onRetainSource?.(file, observations, false, fingerprint); }, [fingerprint]);
  const lines = observations ? compareBillLines(observations, p.cart) : [];
  const total = observations ? observationNumber(observations.total) : null;
  const missing = p.cart.filter(item => !lines.some(result => result.item?.productId === item.productId));
  // Keep the existing Manual Bills consumer presentation until global approval.
  if (p.presentation !== "billing") {
  return <ModalFrame open={p.open} onClose={p.onClose} title={p.savedSale ? "Compare original bill with recorded sale" : "Compare manual bill with Worksheet"} description="OCR is a reading aid. Confirm against the original; handwriting and matching can be wrong." maxWidthClass="max-w-[1100px]" mobileFullScreen>
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="min-w-0"><label className="block text-sm font-medium">Original image or PDF<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const selected = e.target.files?.[0]; if (selected) { setPicked(selected); setObservations(null); setCheckedFingerprint(null); p.onRetainSource?.(selected, null, false, fingerprint); } }} className="mt-2 block w-full text-sm" /></label>
        {url && file && <div className="mt-3 h-[360px] overflow-auto rounded-lg border border-line bg-inset">{file.type === "application/pdf" ? <iframe title="Original paper bill" src={url} className="h-full w-full" /> : <img src={url} alt="Original manual bill for human comparison" className="h-full w-full object-contain" />}</div>}
        {file && <p className="mt-2 break-words text-xs text-muted">{file.name} · original source retained for attachment</p>}
      </section>
      <section className="min-w-0 space-y-3">
        {scanning && <p role="status" className="rounded-lg bg-inset p-3 text-sm">Reading the bill… You can inspect the original while this runs.</p>}
        {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error} Manual verification remains available.</p>}
        {observations && <><dl className="space-y-2 rounded-lg border border-line p-3 text-sm"><div className="flex justify-between gap-3"><dt>Bill number · extracted / entered</dt><dd>{observations.billNumber || "Unreadable"} / {p.currentBillNo || "Not entered"}</dd></div><div className="flex justify-between gap-3"><dt>Bill date · extracted / entered</dt><dd>{observations.billDate || "Unreadable"} / {p.currentBillDate || "Not entered"}</dd></div><div className="flex justify-between gap-3"><dt>Total · extracted / digital</dt><dd>{total === null ? "Unreadable" : formatBillingMoney(total)} / {p.payableTotal === null ? "No digital sale selected" : formatBillingMoney(p.payableTotal)}</dd></div></dl>
          <p className={`rounded-lg p-2 text-sm ${total === null || p.payableTotal === null ? "bg-inset text-muted" : total === p.payableTotal ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>{p.payableTotal === null ? "Select a recorded sale before comparing amounts." : total === null ? "Total requires manual checking." : total === p.payableTotal ? "Extracted total matches; this does not verify payment." : "Total differs. Check the writing and digital entries."}</p>
          {p.cart.length ? <div className="max-h-[280px] overflow-auto rounded-lg border border-line">{lines.map((result, index) => <div key={index} className="border-b border-line p-3 text-sm"><div className="flex justify-between gap-2"><p className="font-medium">{result.line.name || "Unreadable item"}</p><span className={`rounded px-2 py-0.5 text-xs ${result.status === "MATCH" ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>{({MATCH:"Values match",DIFFER:"Values differ",UNREADABLE:"Manual check",UNMATCHED:"No unique match"})[result.status]}</span></div><p className="mt-1 text-xs text-muted">Paper: qty {result.line.quantity || "?"} · rate {result.line.unitPrice || "?"} · {result.line.unit || "unit unreadable"}</p><p className="mt-1 text-xs">Digital: {result.item ? `${result.item.name} · qty ${result.item.qty} · ${formatBillingMoney(result.item.appliedUnitPrice)} / ${result.item.saleUnit || "unit"}` : "Select/identify the correct item manually; no automatic match."}</p></div>)}</div> : <p className="text-sm text-muted">No digital sale is selected. Extraction is reference information only.</p>}
          {missing.length > 0 && <p className="text-sm text-amber-900">Not identified in OCR: {missing.map(item => item.name).join(", ")}. Check the original manually.</p>}
          {!p.savedSale && <button type="button" disabled={!observations.billNumber && !validPaperDate(observations.billDate || "")} onClick={() => p.onApplyReference(observations.billNumber?.trim() || p.currentBillNo, validPaperDate(observations.billDate || "") ? observations.billDate! : p.currentBillDate)} className="rounded-lg border border-control-line px-3 py-2 text-sm">Use extracted reference fields</button>}
        </>}
        {file && <label className="flex items-start gap-2 rounded-lg border border-line bg-inset p-3 text-sm"><input type="checkbox" checked={checkedFingerprint === fingerprint} disabled={scanning} onChange={e => { const checked = e.target.checked; setCheckedFingerprint(checked ? fingerprint : null); p.onRetainSource?.(file, observations, checked, fingerprint); }} className="mt-1" /><span>I compared the original with the digital values.<span className="mt-1 block text-xs text-muted">Resolve writing or entry errors manually. OCR never changes prices, quantities, payments or saved financial facts.</span></span></label>}
      </section>
    </div>
  </ModalFrame>;
  }
  return <ModalFrame presentation={p.presentation} dismissOnBackdrop={false} dialogClassName={p.presentation==="billing"?"billing-ocr-dialog":undefined} footer={<div className="billing-ocr-footer">{file && <label className="flex items-start gap-2 rounded-lg border border-line bg-inset p-3 text-sm"><input type="checkbox" checked={checkedFingerprint === fingerprint} disabled={scanning} onChange={e => { const checked = e.target.checked; setCheckedFingerprint(checked ? fingerprint : null); p.onRetainSource?.(file, observations, checked, fingerprint); }} className="mt-1" /><span>I compared the original with the digital values.<span className="mt-1 block text-xs text-muted">Resolve writing or entry errors manually. OCR never changes prices, quantities, payments or saved financial facts.</span></span></label>}<button type="button" className="billing-dialog-primary" disabled={!file||scanning||checkedFingerprint!==fingerprint} onClick={p.onClose}>Confirm & Continue</button></div>} open={p.open} onClose={p.onClose} title={p.savedSale ? "Compare original bill with recorded sale" : "Compare manual bill with Worksheet"} description="OCR is a reading aid. Confirm against the original; handwriting and matching can be wrong." maxWidthClass="max-w-[1100px]" mobileFullScreen>
    <div className="billing-ocr-columns grid gap-4 lg:grid-cols-2">
      <section className="min-w-0"><label className="block text-sm font-medium">Original image or PDF<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const selected = e.target.files?.[0]; if (selected) { setZoom(100); setPicked(selected); setObservations(null); setCheckedFingerprint(null); p.onRetainSource?.(selected, null, false, fingerprint); } }} className="mt-2 block w-full text-sm" /></label>
        {url && file && <><div className="billing-ocr-preview-controls"><span>Inspect original</span>{file.type === "application/pdf" ? <span>Use the PDF viewer controls to zoom.</span> : <><button type="button" aria-label="Zoom out original bill" disabled={zoom<=100} onClick={()=>setZoom(v=>Math.max(100,v-25))}><Icon name="remove" sizePx={18}/></button><span>{zoom}%</span><button type="button" aria-label="Zoom in original bill" disabled={zoom>=300} onClick={()=>setZoom(v=>Math.min(300,v+25))}><Icon name="add" sizePx={18}/></button><button type="button" onClick={()=>setZoom(100)}>Reset</button></>}</div><div className="billing-ocr-preview mt-3 overflow-auto rounded-lg border border-line bg-inset">{file.type === "application/pdf" ? <iframe title="Original paper bill" src={url} className="h-full w-full" /> : <img src={url} alt="Original manual bill for human comparison" style={{width:`${zoom}%`,maxWidth:"none",height:zoom===100?"100%":"auto"}} className="object-contain" />}</div></>}
        {file && <p className="mt-2 break-words text-xs text-muted">{file.name} · original source retained for attachment</p>}
      </section>
      <section className="min-w-0 space-y-3">
        {scanning && <p role="status" className="rounded-lg bg-inset p-3 text-sm">Reading the bill… You can inspect the original while this runs.</p>}
        {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error} Manual verification remains available.</p>}
        {observations && <><table className="billing-ocr-comparison"><caption>Extracted vs Entered Details</caption><thead><tr><th>Field</th><th>Extracted (OCR)</th><th>Digital (entered)</th></tr></thead><tbody>{[
["Bill number",observations.billNumber||"Unreadable",p.currentBillNo||"Not entered",observations.billNumber!==p.currentBillNo],
["Bill date",observations.billDate||"Unreadable",p.currentBillDate||"Not entered",observations.billDate!==p.currentBillDate],
["Total",total===null?"Unreadable":formatBillingMoney(total),p.payableTotal===null?"No sale selected":formatBillingMoney(p.payableTotal),total===null||total!==p.payableTotal],
].map(([label,extracted,entered,different])=><tr key={String(label)}><th>{label}</th><td>{extracted}</td><td><span className={different?"billing-ocr-difference":""}>{different&&<Icon name="warning" sizePx={14}/>} {entered}</span></td></tr>)}</tbody></table>
          <p className={`rounded-lg p-2 text-sm ${total === null || p.payableTotal === null ? "bg-inset text-muted" : total === p.payableTotal ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>{p.payableTotal === null ? "Select a recorded sale before comparing amounts." : total === null ? "Total requires manual checking." : total === p.payableTotal ? "Extracted total matches; this does not verify payment." : "Total differs. Check the writing and digital entries."}</p>
          {p.cart.length ? <div className="max-h-[280px] overflow-auto rounded-lg border border-line">{lines.map((result, index) => <div key={index} className="border-b border-line p-3 text-sm"><div className="flex justify-between gap-2"><p className="font-medium">{result.line.name || "Unreadable item"}</p><span className={`rounded px-2 py-0.5 text-xs ${result.status === "MATCH" ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"}`}>{({MATCH:"Values match",DIFFER:"Values differ",UNREADABLE:"Manual check",UNMATCHED:"No unique match"})[result.status]}</span></div><p className="mt-1 text-xs text-muted">Paper: qty {result.line.quantity || "?"} · rate {result.line.unitPrice || "?"} · {result.line.unit || "unit unreadable"}</p><p className="mt-1 text-xs">Digital: {result.item ? `${result.item.name} · qty ${result.item.qty} · ${formatBillingMoney(result.item.appliedUnitPrice)} / ${result.item.saleUnit || "unit"}` : "Select/identify the correct item manually; no automatic match."}</p></div>)}</div> : <p className="text-sm text-muted">No digital sale is selected. Extraction is reference information only.</p>}
          {missing.length > 0 && <p className="text-sm text-amber-900">Not identified in OCR: {missing.map(item => item.name).join(", ")}. Check the original manually.</p>}
          {!p.savedSale && <button type="button" disabled={!observations.billNumber && !validPaperDate(observations.billDate || "")} onClick={() => p.onApplyReference(observations.billNumber?.trim() || p.currentBillNo, validPaperDate(observations.billDate || "") ? observations.billDate! : p.currentBillDate)} className="rounded-lg border border-control-line px-3 py-2 text-sm">Use extracted reference fields</button>}
        </>}

      </section>
    </div>
  </ModalFrame>;
}
